"""Pure classification functions. No I/O and no duckdb, so tests need neither.

`th` is always the `[thresholds]` table of config.toml.
"""

from __future__ import annotations

import re
from datetime import date, datetime

from .model import Status

# Float comparisons on derived ratios (0.55 - 0.40 = 0.15000000000000002) must not
# flip a boundary; compare after rounding to this many places.
_PLACES = 9


def _ge(a: float, b: float) -> bool:
    return round(a, _PLACES) >= round(b, _PLACES)


# --- host ---------------------------------------------------------------------------


def disk_status(free_pct: float, th: dict) -> Status:
    if free_pct < th["disk_free_fail_pct"]:
        return Status.FAIL
    if free_pct < th["disk_free_warn_pct"]:
        return Status.WARN
    return Status.OK


def log_accumulation_status(n_files: int, n_bytes: int, th: dict) -> Status:
    if n_files > th["log_files_warn"] or n_bytes > th["log_bytes_warn"]:
        return Status.WARN
    return Status.OK


# --- endpoints ----------------------------------------------------------------------


def endpoint_status(
    ep: dict, status: int | None, body: bytes, elapsed_ms: float, error: str | None, th: dict
) -> tuple[Status, str]:
    """Classify one probe of a `[[endpoints]]` entry; returns (status, reason)."""
    if error is not None:
        return Status.FAIL, f"request failed: {error}"
    if status != ep["expect_status"]:
        return Status.FAIL, f"HTTP {status}, expected {ep['expect_status']}"
    text = body.decode("utf-8", "replace")
    prefix = ep.get("expect_body_prefix")
    if prefix is not None and not text.lstrip().startswith(prefix):
        return Status.FAIL, f"body does not start with {prefix!r}"
    contains = ep.get("expect_body_contains")
    if contains is not None and contains not in text:
        return Status.FAIL, f"body does not contain {contains!r}"
    if elapsed_ms > th["endpoint_slow_ms"]:
        return Status.WARN, f"slow: {elapsed_ms:.0f} ms"
    return Status.OK, f"HTTP {status} in {elapsed_ms:.0f} ms"


# --- systemd ------------------------------------------------------------------------


def unit_status(
    active_state: str, last_job_result: str | None, failures: int
) -> tuple[Status, str]:
    """(status, title) for a service. The title omits the unit name."""
    if active_state == "failed" or last_job_result == "failed":
        return Status.FAIL, f"failed (state {active_state}, last job {last_job_result})"
    if active_state in ("activating", "reloading"):
        return Status.INFO, f"running ({active_state})"
    if failures > 0:
        return Status.WARN, f"recovered: {failures} failures in last 24h"
    return Status.OK, f"ok ({active_state})"


def timer_status(active: bool) -> Status:
    return Status.OK if active else Status.FAIL


# --- checkouts ----------------------------------------------------------------------


def checkout_status(
    branch: str | None, default: str, head: str, tip: str, dirty: int
) -> tuple[Status, str]:
    if not branch:
        return Status.FAIL, f"detached HEAD; units run this tree, expected {default}"
    if branch != default:
        return Status.FAIL, f"on branch {branch}, not {default}; units run this tree"
    if head != tip:
        return Status.WARN, f"HEAD differs from GitHub {default} tip"
    if dirty > 0:
        return Status.WARN, f"{dirty} uncommitted changes to tracked files"
    return Status.OK, f"on {default} at GitHub tip, clean"


# --- issues / PRs -------------------------------------------------------------------

_BAD_CHECK = {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}


def pr_checks_failing(rollup: list[dict] | None) -> list[str]:
    """Names of failing checks in a `statusCheckRollup` (CheckRuns and StatusContexts)."""
    out = []
    for c in rollup or []:
        verdict = c.get("conclusion") or c.get("state") or ""
        if verdict.upper() in _BAD_CHECK:
            out.append(c.get("name") or c.get("context") or "?")
    return out


def pr_status(
    failing_checks: list[str], mergeable: str | None, updated_age_days: float, is_draft: bool,
    th: dict,
) -> tuple[Status, str]:
    problems = []
    if failing_checks:
        problems.append("failing checks: " + ", ".join(failing_checks))
    if mergeable == "CONFLICTING":
        problems.append("merge conflicts")
    if problems:
        return Status.WARN, "; ".join(problems)
    if not is_draft and updated_age_days > th["pr_stale_days"]:
        return Status.INFO, f"no activity for {updated_age_days:.0f} days"
    return Status.OK, "ok"


# --- actions ------------------------------------------------------------------------

FAILED_CONCLUSIONS = {"failure", "timed_out", "startup_failure"}


def actions_status(conclusion: str | None, experimental: bool) -> Status:
    if conclusion is None:
        return Status.INFO
    if conclusion in ("success", "skipped", "neutral"):
        return Status.OK
    if conclusion in FAILED_CONCLUSIONS:
        return Status.WARN if experimental else Status.FAIL
    return Status.WARN  # cancelled, action_required, anything new


def cron_period_hours(expr: str) -> float:
    """Coarse period of a five-field cron. Errs short, which only makes staleness stricter."""
    _m, h, dom, _mon, dow = expr.split()
    if dow != "*":
        return 168
    if dom != "*":
        return 744
    if re.fullmatch(r"\d+", h):
        return 24
    return 1


def schedule_stale(
    newest_run_at: datetime | None, now: datetime, period_h: float, grace_h: float
) -> bool:
    if newest_run_at is None:
        return True
    return (now - newest_run_at).total_seconds() / 3600 > 2 * period_h + grace_h


# --- access logs --------------------------------------------------------------------


def parquet_lag_status(lag_hours: float, th: dict) -> Status:
    if lag_hours >= th["parquet_lag_fail_hours"]:
        return Status.FAIL
    if lag_hours >= th["parquet_lag_warn_hours"]:
        return Status.WARN
    return Status.OK


def volume_status(n: int, baseline_median: float | None, th: dict) -> Status:
    if n == 0:
        return Status.FAIL
    if not baseline_median:
        return Status.INFO
    ratio = n / baseline_median
    if ratio < th["volume_ratio_low"] or ratio > th["volume_ratio_high"]:
        return Status.WARN
    return Status.OK


def _share(num: int, den: int) -> float | None:
    return num / den if den else None


def traffic_quality(
    cur: dict, base: dict | None, hourly: list[dict], th: dict
) -> list[tuple[Status, str, str]]:
    """24 h quality against the baseline: (status, check id, title) per check.

    `cur`/`base` carry totals n, n5xx, n404, hit, hitmiss and p95; `hourly` carries
    per-hour n and n5xx. An empty baseline leaves only the absolute 5xx rule.
    """
    out: list[tuple[Status, str, str]] = []

    s5 = _share(cur["n5xx"], cur["n"]) or 0.0
    hot = [
        h for h in hourly
        if h["n"] >= th["err5xx_hour_min_requests"]
        and _ge(h["n5xx"] / h["n"], th["err5xx_hour_share_warn"])
    ]
    if _ge(s5, th["err5xx_share_fail"]):
        out.append((Status.FAIL, "5xx", f"5xx share {s5:.3%} over 24h"))
    elif _ge(s5, th["err5xx_share_warn"]):
        out.append((Status.WARN, "5xx", f"5xx share {s5:.3%} over 24h"))
    elif hot:
        out.append((Status.WARN, "5xx", f"5xx share >= {th['err5xx_hour_share_warn']:.0%} in {len(hot)} hour(s)"))
    else:
        out.append((Status.OK, "5xx", f"5xx share {s5:.3%} over 24h"))

    if not base or not base.get("n"):
        for check in ("cache", "404", "latency"):
            out.append((Status.INFO, check, "no baseline"))
        return out

    cur_hit, base_hit = _share(cur["hit"], cur["hitmiss"]), _share(base["hit"], base["hitmiss"])
    if cur_hit is None or base_hit is None:
        out.append((Status.INFO, "cache", "no HIT/MISS requests to compare"))
    else:
        drop = (base_hit - cur_hit) * 100
        st = Status.WARN if _ge(drop, th["hit_ratio_drop_points"]) else Status.OK
        out.append((st, "cache", f"hit ratio {cur_hit:.1%} vs baseline {base_hit:.1%}"))

    c404, b404 = cur["n404"] / cur["n"], base["n404"] / base["n"]
    rise = (c404 - b404) * 100
    st = Status.WARN if _ge(rise, th["share404_rise_points"]) else Status.OK
    out.append((st, "404", f"404 share {c404:.1%} vs baseline {b404:.1%}"))

    cp, bp = cur.get("p95"), base.get("p95")
    if cp is None or not bp:
        out.append((Status.INFO, "latency", "no p95 to compare"))
    else:
        st = Status.WARN if cp > th["p95_ratio_warn"] * bp else Status.OK
        out.append((st, "latency", f"p95 time_taken {cp:.2f}s vs baseline {bp:.2f}s"))
    return out


def rollup_age_status(grain: str, age_h: float, th: dict) -> Status:
    warn, fail = th["rollup_age_hours"][grain]
    if age_h >= fail:
        return Status.FAIL
    if age_h >= warn:
        return Status.WARN
    return Status.OK


def stats_as_of_status(as_of: date, today: date, th: dict) -> Status:
    age = (today - as_of).days
    if age > th["stats_as_of_fail_days"]:
        return Status.FAIL
    if age > th["stats_as_of_warn_days"]:
        return Status.WARN
    return Status.OK
