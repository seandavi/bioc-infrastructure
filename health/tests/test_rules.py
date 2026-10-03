from datetime import date, datetime, timedelta, timezone

import pytest

from bioc_health import rules
from bioc_health.model import Status

OK, INFO, WARN, FAIL = Status.OK, Status.INFO, Status.WARN, Status.FAIL
NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("expr,hours", [
    ("17 6 * * *", 24), ("37 7 * * 1", 168), ("7,37 * * * *", 1), ("0 0 1 * *", 744),
])
def test_cron_period_hours(expr, hours):
    assert rules.cron_period_hours(expr) == hours


@pytest.mark.parametrize("age,stale", [
    (timedelta(hours=2 * 24 + 6), False),
    (timedelta(hours=2 * 24 + 6, minutes=1), True),
    (None, True),
])
def test_schedule_stale(age, stale):
    newest = None if age is None else NOW - age
    assert rules.schedule_stale(newest, NOW, 24, 6) is stale


@pytest.mark.parametrize("conclusion,experimental,want", [
    ("failure", False, FAIL), ("failure", True, WARN), ("cancelled", False, WARN),
    ("success", False, OK), (None, False, INFO),
])
def test_actions_status(conclusion, experimental, want):
    assert rules.actions_status(conclusion, experimental) == want


@pytest.mark.parametrize("state,last,failures,want", [
    ("failed", "failed", 3, FAIL),
    ("inactive", "failed", 1, FAIL),
    ("inactive", "done", 2, WARN),
    ("activating", "done", 0, INFO),
    ("inactive", "done", 0, OK),
])
def test_unit_status(state, last, failures, want):
    assert rules.unit_status(state, last, failures)[0] == want


@pytest.mark.parametrize("lag,want", [(1, OK), (2, WARN), (3, WARN), (4, FAIL)])
def test_parquet_lag_status(lag, want, th):
    assert rules.parquet_lag_status(lag, th) == want


@pytest.mark.parametrize("n,median,want", [
    (0, 1000, FAIL), (290, 1000, WARN), (300, 1000, OK), (3010, 1000, WARN), (500, None, INFO),
])
def test_volume_status(n, median, want, th):
    assert rules.volume_status(n, median, th) == want


def _totals(n=100_000, n5xx=0, n404=15_000, hit=50_000, hitmiss=100_000, p95=1.0):
    return {"n": n, "n5xx": n5xx, "n404": n404, "hit": hit, "hitmiss": hitmiss, "p95": p95}


def _checks(cur, base, hourly, th):
    return {check: st for st, check, _ in rules.traffic_quality(cur, base, hourly, th)}


@pytest.mark.parametrize("n5xx,want", [(990, WARN), (1000, FAIL), (90, OK)])
def test_traffic_quality_5xx_share(n5xx, want, th):
    assert _checks(_totals(n5xx=n5xx), _totals(), [], th)["5xx"] == want


@pytest.mark.parametrize("hour_n,want", [(999, OK), (1000, WARN)])
def test_traffic_quality_5xx_hot_hour(hour_n, want, th):
    # 1.5% of one hour, but the 24 h share stays under the warn line.
    hourly = [{"n": hour_n, "n5xx": round(hour_n * 0.015)}]
    assert _checks(_totals(n5xx=15), _totals(), hourly, th)["5xx"] == want


@pytest.mark.parametrize("cur_hit,want", [(40_000, WARN), (40_100, OK)])
def test_traffic_quality_hit_ratio_drop(cur_hit, want, th):
    # Baseline 55%; 40% is a 15-point drop, 40.1% a 14.9-point drop.
    assert _checks(_totals(hit=cur_hit), _totals(hit=55_000), [], th)["cache"] == want


def test_traffic_quality_404_rise_and_latency(th):
    got = _checks(_totals(n404=25_000, p95=2.1), _totals(n404=15_000, p95=1.0), [], th)
    assert (got["404"], got["latency"]) == (WARN, WARN)


def test_traffic_quality_empty_baseline_keeps_only_absolute_5xx(th):
    got = rules.traffic_quality(_totals(n5xx=2000, hit=0), None, [], th)
    assert got[0][:2] == (FAIL, "5xx")
    assert {(st, check) for st, check, _ in got[1:]} == {(INFO, "cache"), (INFO, "404"), (INFO, "latency")}


@pytest.mark.parametrize("age,want", [(0.4, OK), (0.6, WARN), (1.1, FAIL)])
def test_rollup_age_status(age, want, th):
    assert rules.rollup_age_status("minute", age, th) == want


@pytest.mark.parametrize("days,want", [(0, OK), (1, OK), (2, WARN), (3, FAIL)])
def test_stats_as_of_status(days, want, th):
    today = date(2026, 10, 3)
    assert rules.stats_as_of_status(today - timedelta(days=days), today, th) == want


@pytest.mark.parametrize("branch,head,tip,dirty,want", [
    ("feature/x", "a", "a", 0, FAIL),
    (None, "a", "a", 0, FAIL),
    ("main", "a", "b", 0, WARN),
    ("main", "a", "a", 2, WARN),
    ("main", "a", "a", 0, OK),
])
def test_checkout_status(branch, head, tip, dirty, want):
    assert rules.checkout_status(branch, "main", head, tip, dirty)[0] == want


def test_pr_checks_failing_reads_runs_and_contexts():
    rollup = [
        {"__typename": "CheckRun", "name": "test", "conclusion": "SUCCESS"},
        {"__typename": "CheckRun", "name": "lint", "conclusion": "TIMED_OUT"},
        {"__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR"},
        {"__typename": "StatusContext", "context": "ci/ok", "state": "SUCCESS"},
    ]
    assert rules.pr_checks_failing(rollup) == ["lint", "ci/legacy"]


@pytest.mark.parametrize("failing,mergeable,age,draft,want", [
    ([], "CONFLICTING", 1, False, WARN),
    (rules.pr_checks_failing([{"context": "ci", "state": "ERROR"}]), "MERGEABLE", 1, False, WARN),
    ([], "MERGEABLE", 15, False, INFO),
    ([], "MERGEABLE", 15, True, OK),
])
def test_pr_status(failing, mergeable, age, draft, want, th):
    assert rules.pr_status(failing, mergeable, age, draft, th)[0] == want


@pytest.mark.parametrize("ep,status,body,ms,want", [
    ({"expect_status": 200}, 404, b"", 10, FAIL),
    ({"expect_status": 200, "expect_body_prefix": "Package:"}, 200, b"\n  Package: a\n", 10, OK),
    ({"expect_status": 200, "expect_body_prefix": "Package:"}, 200, b"<html>", 10, FAIL),
    ({"expect_status": 404, "expect_body_contains": "<title>"}, 404, b"Not Found", 10, FAIL),
    ({"expect_status": 200}, 200, b"", 5001, WARN),
])
def test_endpoint_status(ep, status, body, ms, want, th):
    assert rules.endpoint_status(ep, status, body, ms, None, th)[0] == want


def test_endpoint_status_network_error(th):
    assert rules.endpoint_status({"expect_status": 200}, None, b"", 0, "timed out", th)[0] == FAIL


@pytest.mark.parametrize("free,want", [(4.9, FAIL), (5, WARN), (15, OK)])
def test_disk_status(free, want, th):
    assert rules.disk_status(free, th) == want
