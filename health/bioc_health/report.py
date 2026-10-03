"""Render bundle.json (as a dict) to report.md."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

STATUS_ORDER = ["error", "fail", "warn", "info", "ok"]
EVIDENCE_KEYS = ("journal_tail", "log_tail")


def _cell(v) -> str:
    if v is None:
        return "–"
    return str(v).replace("|", "\\|").replace("\n", " ")


def _table(headers: list[str], rows: list[list]) -> str:
    if not rows:
        return "_none_\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(_cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def _us(us: int | None) -> str | None:
    if not us:
        return None
    return datetime.fromtimestamp(us / 1e6, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _short(ts: str | None) -> str | None:
    return ts[:16].replace("T", " ") if ts else None


def _pct(x: float | None, places: int = 2) -> str | None:
    return None if x is None else f"{100 * x:.{places}f}%"


# --- per-source sections ------------------------------------------------------------


def _host(d: dict) -> str:
    s = _table(
        ["path", "free %", "free GiB"],
        [[x["path"], f"{x['free_pct']:.1f}", f"{x['free'] / 2**30:.0f}"] for x in d["disks"]],
    )
    s += "\n" + _table(
        ["log glob", "files", "MiB"],
        [[x["glob"], x["files"], f"{x['bytes'] / 2**20:.0f}"] for x in d["logs"]],
    )
    return s


def _endpoints(d: dict) -> str:
    return _table(
        ["name", "status", "ms", "cache status"],
        [[e["name"], e["status"] if e["error"] is None else f"error: {e['error']}",
          f"{e['elapsed_ms']:.0f}", e["cf_cache_status"]] for e in d["endpoints"]],
    )


def _systemd(d: dict) -> str:
    rows = []
    for unit, s in sorted(d["services"].items()):
        t = s.get("timer") or {}
        rows.append([
            unit, f"{s['active_state']}/{s['sub_state']}", _short(s["last_job_at"]),
            # A failed unit's Result (exit-code, timeout, ...) says more than its job result,
            # which is "done" for any Type=simple service that merely started.
            s["result"] if s["active_state"] == "failed" else s["last_job_result"] or s["result"],
            f"{s['failures']}/{s['successes']}",
            _us(t.get("next_us")),
        ])
    return _table(["unit", "state", "last run (UTC)", "result", "fails/succ (24h)", "next run"], rows)


def _checkouts(d: dict) -> str:
    rows = []
    for c in d["checkouts"]:
        if c.get("head") is None:
            rows.append([c["dir"], "not a git checkout", None, None])
            continue
        vs = "at tip" if c["head"] == c["tip"] else f"{c['head'][:8]} vs {(c['tip'] or '?')[:8]}"
        rows.append([c["dir"], c["branch"] or "(detached)", c["dirty"], vs])
    return _table(["dir", "branch", "dirty", "HEAD vs tip"], rows)


def _issues(d: dict) -> str:
    out = []
    for repo, r in d["repos"].items():
        if "error" in r:
            out.append(f"**{repo}**: fetch failed\n")
            continue
        trunc = " (truncated at 200)" if r["truncated"] else ""
        out.append(
            f"**{repo}**: {len(r['issues'])} open{trunc}, {r['new']} new, "
            f"{len(r['closed'])} closed, {len(r['merged'])} PRs merged in window\n"
        )
        if r["prs"]:
            out.append(_table(
                ["#", "title", "age (d)", "checks", "mergeable"],
                [[f"[{p['number']}]({p['url']})", p["title"], p["age_days"],
                  ", ".join(p["failing_checks"]) or "ok", p["mergeable"]] for p in r["prs"]],
            ))
    return "\n".join(out)


def _actions(d: dict) -> str:
    rows = []
    for repo, r in d["repos"].items():
        if "error" in r:
            rows.append([repo, "fetch failed", None, None, None, None])
            continue
        for w in r["workflows"]:
            if w["state"] != "active":
                sched = w["state"]
            elif not w["crons"]:
                sched = "–"
            else:
                sched = ("STALE " if w["schedule_stale"] else "") + ", ".join(w["crons"])
            rows.append([repo, w["file"], w["latest_conclusion"], w["streak"],
                         _short(w["last_success_at"]), sched])
    return _table(["repo", "workflow", "latest", "fail streak", "last success", "schedule"], rows)


def _access_logs(d: dict) -> str:
    out = [f"Newest hourly Parquet: **{d.get('newest_hour')}** (lag {d.get('lag_hours')} h)\n"]
    missing = d.get("missing_hours") or []
    out.append(f"Missing hours (last 48): {', '.join(missing) if missing else 'none'}\n")
    cur, base = d.get("current"), d.get("baseline")
    if cur:
        def row(label, t):
            if not t or not t.get("n"):
                return [label, 0, None, None, None, None]
            return [label, t["n"], _pct(t["n5xx"] / t["n"], 3), _pct(t["n404"] / t["n"], 1),
                    _pct(t["hit"] / t["hitmiss"], 1) if t["hitmiss"] else None,
                    f"{t['p95']:.2f}s" if t.get("p95") is not None else None]
        days = base.get("days_used") if base else None
        out.append(_table(
            ["window", "requests", "5xx", "404", "hit", "p95"],
            [row("last 24h", cur), row(f"baseline per 24h ({days} days)", _per_day(base))],
        ))
    for key, label in (("top_5xx", "Top 5xx paths"), ("top_404", "Top 404 paths")):
        if d.get(key) is not None:
            out.append(f"**{label}** (24h vs baseline daily average)\n")
            out.append(_table(["path", "24h", "baseline/day"],
                              [[p["path"], p["n"], p["baseline_daily"]] for p in d[key]]))
    if d.get("rollups"):
        out.append(_table(["rollup", "newest", "age (h)"],
                          [[g, r["max"], r["age_h"]] for g, r in d["rollups"].items()]))
    out.append(f"Download stats as of: **{d.get('stats_as_of')}**\n")
    return "\n".join(out)


def _per_day(base: dict | None) -> dict | None:
    """Baseline totals scaled to one day, so the table compares like with like."""
    if not base or not base.get("n") or not base.get("files"):
        return base
    k = base["files"] / 24
    scaled = {key: round(base[key] / k) for key in ("n", "n5xx", "n404", "hit", "hitmiss")}
    return scaled | {"p95": base.get("p95")}


SECTIONS = {
    "host": _host, "endpoints": _endpoints, "systemd": _systemd, "checkouts": _checkouts,
    "issues": _issues, "actions": _actions, "access_logs": _access_logs,
}


def render(bundle: dict) -> str:
    findings = bundle["findings"]
    counts = Counter(f["status"] for f in findings)
    n_err = sum(1 for s in bundle["sources"].values() if s["error"])
    out = [
        f"# bioc stack health — {bundle['generated_at']} — {bundle['overall'].upper()}\n",
        f"Host `{bundle['host']}` · {len(bundle['sources'])} sources run · {n_err} source errors · "
        + ", ".join(f"{counts.get(s, 0)} {s}" for s in STATUS_ORDER) + "\n",
        "## Findings\n",
    ]
    listed = sorted(
        (f for f in findings if f["status"] != "ok"),
        key=lambda f: (STATUS_ORDER.index(f["status"]), f["id"]),
    )
    out.append(_table(
        ["Status", "Source", "Finding", "Refs"],
        [[f["status"].upper(), f["source"], f"`{f['id']}` {f['title']}",
          " ".join(f"<{r}>" for r in f["refs"])] for f in listed],
    ))

    for name, src in bundle["sources"].items():
        out.append(f"## {name} — {src['status']} ({src['duration_s']:.1f}s)\n")
        if src["error"]:
            out.append(f"Collector failed: `{src['error']}`\n")
            continue
        out.append(SECTIONS[name](src["data"]))

    out.append("## Evidence\n")
    blocks = 0
    for f in listed:
        for key in EVIDENCE_KEYS:
            if f["evidence"].get(key):
                out.append(f"### {f['id']} ({key})\n\n```\n{f['evidence'][key].rstrip()}\n```\n")
                blocks += 1
    if not blocks:
        out.append("_none_\n")
    return "\n".join(out)
