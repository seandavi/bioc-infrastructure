"""GitHub Actions on each repo's default branch: latest result, failure streak, schedules."""

from __future__ import annotations

import base64
import re
from datetime import datetime

from .. import rules
from ..model import Finding, SourceResult, Status
from ..run import CommandError, gh_json, run

NAME = "actions"
# Same pattern as ci-inventory.py (which runs on import, so it is copied, not imported).
CRON = re.compile(r'cron:\s*["\']([^"\']+)["\']')
ANSI = re.compile(r"\x1b\[[0-9;]*m")
LOG_LINES, LOG_BYTES = 60, 8192


def _ts(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def _failure_evidence(slug: str, run_id: int) -> dict:
    ev: dict = {}
    jobs = gh_json("run", "view", str(run_id), "-R", slug, "--json", "jobs")["jobs"]
    ev["failed_jobs"] = [j["name"] for j in jobs if j.get("conclusion") == "failure"]
    ev["failed_steps"] = [f"{j['name']} / {s['name']}" for j in jobs for s in j.get("steps", [])
                          if s.get("conclusion") == "failure"]
    try:
        lines = ANSI.sub("", run(["gh", "run", "view", str(run_id), "-R", slug, "--log-failed"])).splitlines()
        # Post-job cleanup trails the failure; end the tail at the last ##[error] line.
        errs = [i for i, line in enumerate(lines) if "##[error]" in line]
        if errs:
            lines = lines[: errs[-1] + 1]
        ev["log_tail"] = "\n".join(lines[-LOG_LINES:])[-LOG_BYTES:]
    except CommandError as exc:
        ev["log_tail"] = f"log unavailable: {exc.stderr.strip()}"
    return ev


def _workflow(cfg: dict, repo: str, slug: str, default: str, wf: dict, now: datetime) -> tuple[dict, list[Finding]]:
    th = cfg["thresholds"]
    file = wf["path"].rsplit("/", 1)[-1]
    fid = f"{NAME}/{repo}/{file}"
    yml = base64.b64decode(gh_json("api", f"repos/{slug}/contents/{wf['path']}")["content"]).decode()
    w = {"file": file, "name": wf["name"], "path": wf["path"], "state": wf["state"],
         "crons": CRON.findall(yml), "latest_conclusion": None, "latest_url": None, "streak": 0,
         "last_success_at": None, "newest_run_at": None, "schedule_stale": False}
    if wf["state"] != "active":
        return w, [Finding(f"{fid}/disabled", NAME, Status.WARN,
                           f"{repo}/{file} is {wf['state']}", refs=[wf.get("html_url", "")])]

    runs = gh_json("run", "list", "-R", slug, "-w", file, "-b", default, "-L", "20", "--json",
                   "databaseId,conclusion,status,event,headBranch,createdAt,url,displayTitle")
    completed = [r for r in runs if r["status"] == "completed"]
    latest = completed[0] if completed else None
    for r in completed:
        if r["conclusion"] not in rules.FAILED_CONCLUSIONS:
            break
        w["streak"] += 1
    w["last_success_at"] = next((r["createdAt"] for r in completed if r["conclusion"] == "success"), None)
    w["newest_run_at"] = runs[0]["createdAt"] if runs else None
    if latest:
        w["latest_conclusion"], w["latest_url"] = latest["conclusion"], latest["url"]

    findings: list[Finding] = []
    st = rules.actions_status(w["latest_conclusion"], repo in cfg["experimental_repos"])
    ev = {k: w[k] for k in ("latest_conclusion", "streak", "last_success_at", "newest_run_at")}
    if latest is None:
        title = f"{repo}/{file}: no completed runs on {default}"
    else:
        title = f"{repo}/{file}: latest {latest['conclusion']}" + (
            f" ({w['streak']} in a row)" if w["streak"] > 1 else "")
        if st in (Status.FAIL, Status.WARN):
            ev |= {"run": latest["displayTitle"], "event": latest["event"]} | _failure_evidence(slug, latest["databaseId"])
    findings.append(Finding(f"{fid}/latest", NAME, st, title, evidence=ev,
                            refs=[latest["url"]] if latest else []))

    if w["crons"]:
        period = min(rules.cron_period_hours(c) for c in w["crons"])
        w["schedule_stale"] = rules.schedule_stale(_ts(w["newest_run_at"]), now, period,
                                                   th["actions_cron_grace_hours"])
        if w["schedule_stale"]:
            since = w["newest_run_at"] or "never"
            findings.append(Finding(f"{fid}/schedule", NAME, Status.WARN,
                                    f"{repo}/{file}: scheduled workflow has not run since {since}",
                                    evidence={"crons": w["crons"], "newest_run_at": w["newest_run_at"]}))
    return w, findings


def _repo(cfg: dict, repo: str, now: datetime) -> tuple[dict, list[Finding]]:
    slug = f"{cfg['owner']}/{repo}"
    default = gh_json("api", f"repos/{slug}")["default_branch"]
    wfs = gh_json("api", f"repos/{slug}/actions/workflows?per_page=100")["workflows"]
    # Dynamic Pages/Copilot workflows have no file in .github/workflows/; skip them as
    # ci-inventory.py does.
    wfs = [w for w in wfs if w["path"].startswith(".github/workflows/")]
    out, findings = [], []
    for wf in sorted(wfs, key=lambda w: w["path"]):
        w, f = _workflow(cfg, repo, slug, default, wf, now)
        out.append(w)
        findings += f
    return {"default_branch": default, "workflows": out}, findings


def collect(cfg: dict, now: datetime) -> SourceResult:
    repos, findings = {}, []
    for repo in cfg["repos"]:
        try:
            repos[repo], f = _repo(cfg, repo, now)
            findings += f
        except Exception as exc:  # one bad repo must not hide the others
            repos[repo] = {"error": str(exc)}
            findings.append(Finding(f"{NAME}/{repo}/fetch", NAME, Status.ERROR,
                                    f"{repo}: cannot read Actions: {exc}"))
    return SourceResult(NAME, findings, {"repos": repos})
