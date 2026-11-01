"""Black-box probes of bioconductor.org: the same six as bioc-edge health.yml, and the
published download stats' current month."""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from .. import rules
from ..model import Finding, SourceResult, Status

NAME = "endpoints"
USER_AGENT = "bioc-health/1 (+https://github.com/seandavi/bioc-infrastructure)"
TIMEOUT_S = 20
MAX_BODY = 64 * 1024


def _probe(ep: dict) -> dict:
    headers = {"User-Agent": USER_AGENT}
    if ep.get("range"):
        headers["Range"] = ep["range"]
    req = urllib.request.Request(ep["url"], headers=headers)
    t0 = time.monotonic()
    status, body, hdrs, error = None, b"", {}, None
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            status, body, hdrs = resp.status, resp.read(MAX_BODY), resp.headers
    except urllib.error.HTTPError as exc:  # a 404 probe is a response, not a failure
        status, body, hdrs = exc.code, exc.read(MAX_BODY), exc.headers
    except (urllib.error.URLError, OSError) as exc:
        error = str(getattr(exc, "reason", exc))
    elapsed_ms = (time.monotonic() - t0) * 1000
    return {
        "status": status,
        "body": body,
        "elapsed_ms": elapsed_ms,
        "error": error,
        "cf_cache_status": hdrs.get("cf-cache-status") if hdrs else None,
        "x_bioc_build": hdrs.get("x-bioc-build") if hdrs else None,
    }


def collect(cfg: dict, now: datetime) -> SourceResult:
    th = cfg["thresholds"]
    findings, rows = [], []
    for ep in cfg.get("endpoints", []):
        r = _probe(ep)
        st, reason = rules.endpoint_status(ep, r["status"], r["body"], r["elapsed_ms"], r["error"], th)
        row = {k: v for k, v in r.items() if k != "body"}
        row |= {"name": ep["name"], "url": ep["url"]}
        rows.append(row)
        findings.append(Finding(
            f"{NAME}/{ep['name']}/probe", NAME, st, f"{ep['name']}: {reason}",
            evidence=row, refs=[ep["url"]],
        ))
    if cfg.get("published_stats"):
        findings.append(_stats_month(cfg["published_stats"]["url"], now, th))
    return SourceResult(NAME, findings, {"endpoints": rows})


def _stats_month(template: str, now: datetime, th: dict) -> Finding:
    today = now.date()
    fid, title = f"{NAME}/published-stats/month", "published download stats"
    # Before fetching: on 1-2 January the new year's file may not exist yet.
    if rules.stats_month_too_early(today, th):
        return Finding(fid, NAME, Status.OK, f"{title}: day {today.day}: too early in the month to compare")
    urls = [template.format(year=y) for y in sorted({today.year, (today.replace(day=1) - timedelta(days=1)).year})]
    downloads = {}
    for url in urls:
        r = _probe({"url": url})
        if r["error"] is not None:  # the check could not run
            return Finding(fid, NAME, Status.ERROR, f"{title}: request failed: {r['error']}", refs=[url])
        if r["status"] != 200:
            return Finding(fid, NAME, Status.FAIL, f"{title}: HTTP {r['status']}", refs=[url])
        try:
            downloads |= rules.parse_stats_tab(r["body"].decode("utf-8", "replace"))
        except ValueError as exc:
            return Finding(fid, NAME, Status.FAIL, f"{title}: malformed .tab: {exc}", refs=[url])
    st, reason = rules.stats_month_status(downloads, today, th)
    return Finding(fid, NAME, st, f"{title}: {reason}", refs=urls)
