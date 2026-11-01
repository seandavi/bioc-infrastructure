#!/usr/bin/env -S uv run --quiet --with google-auth --with requests --with duckdb python3
"""Pull bioconductor.org GA4 into a local duckdb at daily granularity.

Usage: ./ga_pull.py [ga.duckdb]

The GA4 Data API only serves *aggregates* -- there is no event-level export
without BigQuery -- so this warehouses a set of date-partitioned cubes rather
than a raw event log. Every table is keyed by `date`, so re-running fetches
only missing days; the trailing REFRESH_DAYS are always re-pulled because GA4
keeps revising recent days for ~48h. Safe to run from cron.

SCHEMA CONVENTIONS
  * Only additive metrics are stored. Rates (engagementRate, bounceRate) are
    deliberately NOT stored -- they cannot be summed across days or rows.
    Derive them: engagedSessions/sessions, and bounce = 1 - that.
  * `activeUsers` IS stored but is NOT additive: summing it over dates or
    dimensions double-counts anyone who returns. For true unique counts over a
    window, use the users_rolling table (active1/7/28DayUsers).
  * userEngagementDuration is in seconds and IS additive.
  * High-cardinality cubes are capped per month, ordered by the first metric
    descending, so truncation drops the smallest rows. Any truncation prints a
    [TRUNCATED] marker -- silent under-counting is worse than a loud cap.
"""
import sys, datetime as dt, duckdb, requests, google.auth.transport.requests
from google.oauth2 import service_account

KEY = "/home/davsean/.google/cdsci-infra-ga-admin.json"
PROP = "properties/388188354"  # www.bioconductor.org - GA4
DB = sys.argv[1] if len(sys.argv) > 1 else "ga.duckdb"
EPOCH = dt.date(2023, 6, 22)  # first day this property has data
REFRESH_DAYS = 3

# name: (dimensions, metrics, max rows per month). `date` is prepended to every
# dimension list. Grouped by question answered.
REPORTS = {
    # -- how much traffic, and is it real --------------------------------
    "totals":        ([], ["sessions", "engagedSessions", "screenPageViews", "activeUsers",
                           "newUsers", "totalUsers", "userEngagementDuration", "eventCount"], 400),
    "users_rolling": ([], ["active1DayUsers", "active7DayUsers", "active28DayUsers",
                           "totalUsers", "newUsers"], 400),
    "hourly":        (["hour"], ["sessions", "screenPageViews", "activeUsers"], 5000),
    "new_returning": (["newVsReturning"], ["sessions", "engagedSessions", "activeUsers",
                                           "screenPageViews"], 5000),

    # -- who they are ----------------------------------------------------
    "countries":     (["country"], ["sessions", "engagedSessions", "activeUsers", "screenPageViews"], 30000),
    "cities":        (["country", "region", "city"], ["sessions", "activeUsers", "screenPageViews"], 200000),
    "languages":     (["language"], ["sessions", "activeUsers"], 20000),
    "tech":          (["deviceCategory", "operatingSystem", "browser"],
                      ["sessions", "engagedSessions", "activeUsers", "screenPageViews"], 50000),

    # -- how they got here -----------------------------------------------
    "channels":      (["sessionDefaultChannelGroup"], ["sessions", "engagedSessions", "activeUsers"], 5000),
    "sources":       (["sessionSourceMedium"], ["sessions", "engagedSessions", "activeUsers"], 50000),
    "first_touch":   (["firstUserSourceMedium"], ["activeUsers", "newUsers", "sessions"], 50000),

    # -- what they did ---------------------------------------------------
    "pages":         (["pagePath"], ["screenPageViews", "sessions", "activeUsers",
                                     "userEngagementDuration"], 400000),
    "landing":       (["landingPage"], ["sessions", "engagedSessions", "activeUsers",
                                        "screenPageViews"], 100000),
    "edges":         (["pageReferrer", "pagePath"], ["screenPageViews"], 300000),
    "events":        (["eventName"], ["eventCount", "activeUsers"], 50000),
    "search":        (["searchTerm"], ["eventCount", "activeUsers"], 50000),
    "hosts":         (["hostName"], ["screenPageViews", "sessions"], 10000),
}

# Probed as empty or degenerate on this property -- intentionally NOT collected:
#   userAgeBracket / userGender / brandingInterest  -> 0 rows (Google Signals off)
#   contentGroup                                    -> "(not set)", never configured
#   sessionCampaignName                             -> no campaigns run
#   platform / audienceName / fileExtension /
#   linkUrl / signedInWithUserId                    -> single constant value


def session():
    """Auto-refreshing session: a full backfill outlives the 1h token lifetime."""
    c = service_account.Credentials.from_service_account_file(
        KEY, scopes=["https://www.googleapis.com/auth/analytics.readonly"])
    return google.auth.transport.requests.AuthorizedSession(c)


def months(start, end):
    """[(first, last)] calendar-month windows covering start..end inclusive."""
    cur = start
    while cur <= end:
        nxt = (cur.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        yield cur, min(nxt - dt.timedelta(days=1), end)
        cur = nxt


def run(ses, dims, mets, lo, hi, cap):
    """Paged runReport over one window. Returns (rows, truncated).

    The whole window is accumulated before the caller inserts it, so a failure
    mid-pagination leaves the month absent rather than half-loaded -- that is
    what makes resume-from-max(date) correct.
    """
    rows, offset, total = [], 0, 0
    while offset < cap:
        page = min(100000, cap - offset)
        r = ses.post(f"https://analyticsdata.googleapis.com/v1beta/{PROP}:runReport",
                     json={
                              "dateRanges": [{"startDate": lo.isoformat(), "endDate": hi.isoformat()}],
                              "dimensions": [{"name": d} for d in ["date"] + dims],
                              "metrics": [{"name": m} for m in mets],
                              "orderBys": [{"metric": {"metricName": mets[0]}, "desc": True}],
                              "limit": page, "offset": offset})
        r.raise_for_status()
        body = r.json()
        got = body.get("rows", [])
        total = body.get("rowCount", 0)
        for x in got:
            dv = [d["value"] for d in x["dimensionValues"]]
            day = dt.date(int(dv[0][:4]), int(dv[0][4:6]), int(dv[0][6:]))
            rows.append((day, *dv[1:], *(float(m["value"]) for m in x["metricValues"])))
        offset += len(got)
        if len(got) < page:
            return rows, False
    return rows, total > cap


def main():
    ses = session()
    con = duckdb.connect(DB)
    end = dt.date.today() - dt.timedelta(days=1)

    for name, (dims, mets, cap) in REPORTS.items():
        cols = ", ".join(['"date" DATE'] + [f'"{d}" VARCHAR' for d in dims] + [f'"{m}" DOUBLE' for m in mets])
        con.execute(f"CREATE TABLE IF NOT EXISTS {name} ({cols})")
        have = con.execute(f"SELECT max(date) FROM {name}").fetchone()[0]
        start = max(EPOCH, have - dt.timedelta(days=REFRESH_DAYS - 1)) if have else EPOCH
        if start > end:
            print(f"{name}: up to date", flush=True)
            continue

        n, clipped, purged = 0, [], False
        ph = ",".join("?" * (1 + len(dims) + len(mets)))
        try:
            for lo, hi in months(start, end):
                rows, trunc = run(ses, dims, mets, lo, hi, cap)
                if trunc:
                    # A month-wide cap is ordered by metric across the whole month, so
                    # busy days get their rows eaten by quieter ones -- that skews the
                    # series, not just the tail. Re-fetch day by day so the cap applies
                    # per day and coverage stays uniform.
                    rows, trunc, d = [], False, lo
                    while d <= hi:
                        r2, t2 = run(ses, dims, mets, d, d, cap)
                        rows += r2
                        trunc = trunc or t2
                        d += dt.timedelta(days=1)
                if not purged:  # drop the stale refresh window only once we know the pull works
                    con.execute(f"DELETE FROM {name} WHERE date >= ?", [start])
                    purged = True
                if rows:
                    con.executemany(f"INSERT INTO {name} VALUES ({ph})", rows)
                n += len(rows)
                if trunc:
                    clipped.append(lo.strftime("%Y-%m"))
        except requests.HTTPError as e:
            # incompatible dim/metric combo, or quota -- keep the other cubes
            print(f"{name}: SKIPPED after {n} rows -- {e.response.status_code} "
                  f"{e.response.text[:120]}", flush=True)
            continue
        print(f"{name}: {n} rows from {start}" +
              (f"  [TRUNCATED at {cap}/mo: {', '.join(clipped)}]" if clipped else ""), flush=True)

    con.close()


if __name__ == "__main__":
    main()
