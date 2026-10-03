"""Open issues and PRs, plus what closed and merged in the activity window, per repo."""

from __future__ import annotations

from datetime import datetime, timedelta

from .. import rules
from ..model import Finding, SourceResult, Status
from ..run import gh_json

NAME = "issues"
ISSUE_LIMIT = 200


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _age_days(s: str, now: datetime) -> float:
    return round((now - _ts(s)).total_seconds() / 86400, 1)


def _repo(cfg: dict, repo: str, now: datetime, since: str) -> tuple[dict, list[Finding]]:
    slug = f"{cfg['owner']}/{repo}"
    th = cfg["thresholds"]
    raw = gh_json("issue", "list", "-R", slug, "--state", "open", "--limit", str(ISSUE_LIMIT),
                  "--json", "number,title,labels,createdAt,updatedAt,author,url,comments")
    issues = [{
        "number": i["number"], "title": i["title"], "url": i["url"],
        "labels": [lab["name"] for lab in i["labels"]],
        "author": (i.get("author") or {}).get("login"),
        "created_at": i["createdAt"], "updated_at": i["updatedAt"],
        "comments": len(i["comments"]),
        "last_comment_at": max((c["createdAt"] for c in i["comments"]), default=None),
    } for i in raw]
    closed = gh_json("issue", "list", "-R", slug, "--state", "closed", "--search", f"closed:>={since}",
                     "--limit", "100", "--json", "number,title,closedAt,url")
    raw_prs = gh_json("pr", "list", "-R", slug, "--state", "open", "--limit", "100", "--json",
                      "number,title,isDraft,mergeable,reviewDecision,statusCheckRollup,createdAt,"
                      "updatedAt,author,url,headRefName")
    merged = gh_json("pr", "list", "-R", slug, "--state", "merged", "--search", f"merged:>={since}",
                     "--limit", "100", "--json", "number,title,mergedAt,url")

    findings: list[Finding] = []
    prs = []
    for p in raw_prs:
        failing = rules.pr_checks_failing(p["statusCheckRollup"])
        upd_age = _age_days(p["updatedAt"], now)
        st, title = rules.pr_status(failing, p["mergeable"], upd_age, p["isDraft"], th)
        pr = {
            "number": p["number"], "title": p["title"], "url": p["url"], "is_draft": p["isDraft"],
            "mergeable": p["mergeable"], "review_decision": p["reviewDecision"] or None,
            "failing_checks": failing, "age_days": _age_days(p["createdAt"], now),
            "updated_age_days": upd_age, "author": (p.get("author") or {}).get("login"),
            "head_ref": p["headRefName"], "status": str(st),
        }
        prs.append(pr)
        if st != Status.OK:
            findings.append(Finding(f"{NAME}/{repo}#{p['number']}/pr", NAME, st,
                                    f"{repo}#{p['number']} {p['title']}: {title}",
                                    evidence=pr, refs=[p["url"]]))

    new = [i for i in issues if i["created_at"][:10] >= since]
    if new:
        findings.append(Finding(
            f"{NAME}/{repo}/new", NAME, Status.INFO,
            f"{repo}: {len(new)} issue(s) opened since {since}",
            detail="\n".join(f"#{i['number']} {i['title']}" for i in new),
            refs=[i["url"] for i in new],
        ))
    stale = [i for i in issues if _age_days(i["updated_at"], now) > th["issue_stale_days"]]
    if stale:
        findings.append(Finding(
            f"{NAME}/{repo}/stale", NAME, Status.INFO,
            f"{repo}: {len(stale)} open issue(s) untouched for {th['issue_stale_days']}+ days",
            evidence={"numbers": [i["number"] for i in stale]},
        ))
    data = {"issues": issues, "closed": closed, "prs": prs, "merged": merged,
            "truncated": len(raw) == ISSUE_LIMIT, "new": len(new)}
    return data, findings


def collect(cfg: dict, now: datetime) -> SourceResult:
    since = (now - timedelta(days=cfg["activity_window_days"])).date().isoformat()
    repos, findings = {}, []
    for repo in cfg["repos"]:
        try:
            repos[repo], f = _repo(cfg, repo, now, since)
            findings += f
        except Exception as exc:  # one bad repo must not hide the others
            repos[repo] = {"error": str(exc)}
            findings.append(Finding(f"{NAME}/{repo}/fetch", NAME, Status.ERROR,
                                    f"{repo}: cannot read issues/PRs: {exc}"))
    return SourceResult(NAME, findings, {"repos": repos, "since": since})
