"""Cross-check bioc-notify@ failure issues against live unit state.

bioc-notify@ (bioc-edge/notify-failure.sh) files "<unit> is failing" issues in
`failure_issue_repo` and nothing closes them on recovery, so the tracker and the
units drift apart. Pure over the `issues` and `systemd` results' data.
"""

from __future__ import annotations

import re
from datetime import datetime

from .model import Finding, SourceResult, Status

NAME = "crossref"
TITLE = re.compile(r"^(\S+\.service) is failing$")


def collect(results: dict[str, SourceResult], cfg: dict, now: datetime) -> list[Finding]:
    issues, systemd = results.get("issues"), results.get("systemd")
    if issues is None or systemd is None or issues.error or systemd.error:
        return []
    repo = issues.data["repos"].get(cfg["failure_issue_repo"])
    if not repo or "error" in repo:
        return []
    services = systemd.data["services"]
    state_findings = {f.id: f for f in systemd.findings}

    filed: dict[str, dict] = {}
    for issue in repo["issues"]:
        m = TITLE.match(issue["title"])
        if m:
            filed.setdefault(m.group(1), issue)

    out: list[Finding] = []
    for unit, issue in sorted(filed.items()):
        svc = services.get(unit)
        if svc is None:
            out.append(Finding(
                f"{NAME}/{unit}/unknown-unit", NAME, Status.INFO,
                f"#{issue['number']} names {unit}, which is not a loaded unit here",
                refs=[issue["url"]],
            ))
        elif svc["status"] == str(Status.FAIL):
            f = state_findings.get(f"systemd/{unit}/state")
            if f is not None and issue["url"] not in f.refs:
                f.refs.append(issue["url"])
        elif svc["status"] in (str(Status.OK), str(Status.WARN)) or (
            # Running now (info), and the last completed run succeeded: recovered too.
            # bioc-sync is mid-run most of the time, so without this it never qualifies.
            svc["status"] == str(Status.INFO) and svc["last_job_result"] == "done"
        ):
            out.append(Finding(
                f"{NAME}/{unit}/stale-issue", NAME, Status.WARN,
                f"{unit} recovered; close #{issue['number']} by hand",
                refs=[issue["url"]],
            ))

    for unit, svc in sorted(services.items()):
        if svc["status"] == str(Status.FAIL) and unit not in filed and not unit.startswith("bioc-notify@"):
            out.append(Finding(
                f"{NAME}/{unit}/unfiled", NAME, Status.WARN,
                f"{unit} failing but no '{unit} is failing' issue — bioc-notify@ may not have fired",
            ))
    return out
