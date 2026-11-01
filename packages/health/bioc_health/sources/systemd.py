"""State, 24 h job history and timers of the bioc-* systemd --user units."""

from __future__ import annotations

import fnmatch
import json
from datetime import datetime, timedelta, timezone

from .. import rules
from ..model import Finding, SourceResult, Status
from ..run import run, run_json

NAME = "systemd"
SHOW_PROPS = "ActiveState,SubState,Result,ExecMainStatus,InvocationID,WorkingDirectory,Description"


def list_units(cfg: dict) -> list[dict]:
    return run_json(["systemctl", "--user", "list-units", "--all", "--output=json", "--no-pager",
                     *cfg["systemd"]["unit_globs"]])


def discover_units(cfg: dict) -> list[str]:
    """Loaded services matching the configured globs."""
    return sorted(u["unit"] for u in list_units(cfg) if u["unit"].endswith(".service"))


def show(unit: str, props: str) -> dict[str, str]:
    out = run(["systemctl", "--user", "show", "--no-pager", unit, "-p", props])
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def _iso_us(us: str | int | None) -> str | None:
    if not us:
        return None
    return datetime.fromtimestamp(int(us) / 1e6, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _job_history(services: set[str], window_hours: int) -> dict[str, dict]:
    """Per service: completed start jobs in the window, from one journal read."""
    out = run(["journalctl", "--user", "JOB_TYPE=start", "--since", f"-{window_hours}h",
               "-o", "json", "--no-pager"])
    hist = {s: {"failures": 0, "successes": 0, "last_job_result": None, "last_job_at": None,
                "last_success_at": None, "last_failed_invocation": None} for s in services}
    for line in out.splitlines():
        e = json.loads(line)
        unit, result = e.get("USER_UNIT"), e.get("JOB_RESULT")
        if unit not in hist or result is None:  # "Starting ..." lines carry no result
            continue
        h = hist[unit]
        at = _iso_us(e["__REALTIME_TIMESTAMP"])
        if result == "failed":
            h["failures"] += 1
            h["last_failed_invocation"] = e.get("USER_INVOCATION_ID")
        elif result == "done":
            h["successes"] += 1
            h["last_success_at"] = at
        h["last_job_result"], h["last_job_at"] = result, at  # journal is oldest first
    return hist


def _journal_tail(invocation: str, lines: int) -> str:
    out = run(["journalctl", "--user", f"_SYSTEMD_INVOCATION_ID={invocation}", "+",
               f"USER_INVOCATION_ID={invocation}", "-o", "short-iso", "--no-pager"])
    return "\n".join(out.splitlines()[-lines:])


def collect(cfg: dict, now: datetime) -> SourceResult:
    globs = cfg["systemd"]["unit_globs"]
    units = list_units(cfg)
    services = sorted(u["unit"] for u in units if u["unit"].endswith(".service"))
    timer_active = {u["unit"]: u["active"] for u in units if u["unit"].endswith(".timer")}

    timers = {}
    for t in run_json(["systemctl", "--user", "list-timers", "--all", "--output=json", "--no-pager"]):
        if any(fnmatch.fnmatch(t["unit"], g) for g in globs):
            timers[t["unit"]] = {"activates": t["activates"], "active_state": timer_active.get(t["unit"]),
                                 "last_us": t.get("last") or None, "next_us": t.get("next") or None}
    for unit, active in timer_active.items():  # loaded but not in list-timers
        timers.setdefault(unit, {"activates": None, "active_state": active, "last_us": None, "next_us": None})
    by_service = {t["activates"]: (unit, t) for unit, t in timers.items() if t["activates"]}

    hist = _job_history(set(services), cfg["systemd"]["window_hours"])
    findings: list[Finding] = []
    data_services = {}
    for svc in services:
        p = show(svc, SHOW_PROPS)
        h = hist[svc]
        st, title = rules.unit_status(p.get("ActiveState", ""), h["last_job_result"], h["failures"])
        if st == Status.FAIL and svc.startswith("bioc-notify@"):
            title = "alerting broken: " + title
        timer = None
        if svc in by_service:
            tunit, t = by_service[svc]
            timer = {"unit": tunit, "last_us": t["last_us"], "next_us": t["next_us"]}
        entry = {
            "status": str(st),
            "active_state": p.get("ActiveState"),
            "sub_state": p.get("SubState"),
            "result": p.get("Result"),
            "exit_status": p.get("ExecMainStatus"),
            "working_directory": p.get("WorkingDirectory", "").lstrip("!-") or None,
            "description": p.get("Description"),
            "invocation_id": p.get("InvocationID") or None,
            **{k: v for k, v in h.items() if k != "last_failed_invocation"},
            "timer": timer,
        }
        data_services[svc] = entry
        evidence = {k: v for k, v in entry.items() if k not in ("status", "description")}
        if st == Status.FAIL:
            inv = h["last_failed_invocation"] or entry["invocation_id"]
            if inv:
                evidence["journal_tail"] = _journal_tail(inv, cfg["systemd"]["journal_tail_lines"])
        findings.append(Finding(f"{NAME}/{svc}/state", NAME, st, f"{svc}: {title}",
                                detail=p.get("Description"), evidence=evidence))

    for tunit, t in sorted(timers.items()):
        active = t["active_state"] == "active"
        target = t["activates"] or tunit.removesuffix(".timer") + ".service"
        title = f"{tunit}: active" if active else f"{tunit} is {t['active_state']}: nothing schedules {target}"
        findings.append(Finding(f"{NAME}/{tunit}/state", NAME, rules.timer_status(active), title,
                                evidence=t))

    return SourceResult(NAME, findings, {"services": data_services, "timers": timers})
