from datetime import datetime, timezone

import pytest

from bioc_health.model import Status
from bioc_health.sources import endpoints

URL = "https://example.org/bioc_{year}_stats.tab"
HEAD = "Year\tMonth\tNb_of_distinct_IPs\tNb_of_downloads\n"


def at(y, m, d):
    return datetime(y, m, d, 12, tzinfo=timezone.utc)


def fake(monkeypatch, answers):
    """answers: url -> (status, body) or an error string. Records the URLs fetched."""
    seen = []

    def probe(ep):
        seen.append(ep["url"])
        a = answers[ep["url"]]
        if isinstance(a, str):
            return {"status": None, "body": b"", "error": a}
        return {"status": a[0], "body": a[1].encode(), "error": None}
    monkeypatch.setattr(endpoints, "_probe", probe)
    return seen


def test_january_reads_both_years(monkeypatch, th):
    seen = fake(monkeypatch, {
        URL.format(year=2025): (200, HEAD + "2025\tDec\t1\t3100\n2025\tall\t1\t3100"),
        URL.format(year=2026): (200, HEAD + "2026\tJan\t1\t800\n2026\tFeb\t0\t0"),
    })
    f = endpoints._stats_month(URL, at(2026, 1, 9), th)
    assert seen == [URL.format(year=2025), URL.format(year=2026)]
    assert f.status == Status.OK and f.id == "endpoints/published-stats/month"


def test_too_early_does_not_fetch(monkeypatch, th):
    seen = fake(monkeypatch, {})  # a new year's file that does not exist yet
    assert endpoints._stats_month(URL, at(2027, 1, 2), th).status == Status.OK
    assert seen == []


@pytest.mark.parametrize("answer,want", [
    ((404, "Not Found"), Status.FAIL),
    ("timed out", Status.ERROR),
    ((200, HEAD + "2026\tOct\tx\ty"), Status.FAIL),  # malformed
])
def test_fetch_failures(monkeypatch, th, answer, want):
    fake(monkeypatch, {URL.format(year=2026): answer})
    assert endpoints._stats_month(URL, at(2026, 10, 15), th).status == want
