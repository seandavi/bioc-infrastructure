from datetime import datetime, timezone

from bioc_health import crossref
from bioc_health.model import Finding, SourceResult, Status

CFG = {"failure_issue_repo": "bioc-edge"}
NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)


def _issue(n: int, title: str) -> dict:
    return {"number": n, "title": title, "url": f"https://github.com/seandavi/bioc-edge/issues/{n}"}


def _results(issues: list[dict], services: dict[str, tuple[Status, str | None]]) -> dict:
    data = {u: {"status": str(st), "last_job_result": last} for u, (st, last) in services.items()}
    findings = [Finding(f"systemd/{u}/state", "systemd", st, u) for u, (st, _) in services.items()]
    return {
        "issues": SourceResult("issues", [], {"repos": {"bioc-edge": {"issues": issues}}}),
        "systemd": SourceResult("systemd", findings, {"services": data}),
    }


def _by_id(findings):
    return {f.id: f.status for f in findings}


def test_open_issue_for_recovered_unit_is_stale():
    res = _results([_issue(8, "bioc-sync.service is failing")],
                   {"bioc-sync.service": (Status.WARN, "done")})
    assert _by_id(crossref.collect(res, CFG, NOW)) == {"crossref/bioc-sync.service/stale-issue": Status.WARN}


def test_open_issue_for_running_unit_whose_last_run_succeeded_is_stale():
    res = _results([_issue(8, "bioc-sync.service is failing")],
                   {"bioc-sync.service": (Status.INFO, "done")})
    assert "crossref/bioc-sync.service/stale-issue" in _by_id(crossref.collect(res, CFG, NOW))


def test_open_issue_for_failing_unit_becomes_a_ref_not_a_finding():
    res = _results([_issue(57, "bioc-rollup-minute.service is failing")],
                   {"bioc-rollup-minute.service": (Status.FAIL, "failed")})
    assert crossref.collect(res, CFG, NOW) == []
    assert res["systemd"].findings[0].refs == ["https://github.com/seandavi/bioc-edge/issues/57"]


def test_failing_unit_without_issue_is_unfiled_except_notify_instances():
    res = _results([], {
        "bioc-rollup-day.service": (Status.FAIL, "failed"),
        "bioc-notify@bioc-sync.service": (Status.FAIL, "failed"),
    })
    assert _by_id(crossref.collect(res, CFG, NOW)) == {"crossref/bioc-rollup-day.service/unfiled": Status.WARN}


def test_issue_naming_unknown_unit_is_info():
    res = _results([_issue(3, "bioc-gone.service is failing"), _issue(4, "unrelated bug")], {})
    assert _by_id(crossref.collect(res, CFG, NOW)) == {"crossref/bioc-gone.service/unknown-unit": Status.INFO}


def test_missing_or_errored_source_yields_nothing():
    res = _results([_issue(8, "bioc-sync.service is failing")], {})
    assert crossref.collect({"issues": res["issues"]}, CFG, NOW) == []
    res["systemd"].error = "boom"
    assert crossref.collect(res, CFG, NOW) == []
