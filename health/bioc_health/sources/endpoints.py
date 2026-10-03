"""Black-box probes of bioconductor.org; the same six as bioc-edge health.yml."""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from datetime import datetime

from .. import rules
from ..model import Finding, SourceResult

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
    return SourceResult(NAME, findings, {"endpoints": rows})
