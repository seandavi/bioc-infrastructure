#!/usr/bin/env -S uv run --quiet --with duckdb python3
"""Markdown report over the GA4 duckdb. Usage: ./ga_report.py [ga.duckdb] > report.md

Rates are derived here (engagedSessions/sessions), never read from storage --
see SCHEMA.md for why.
"""
import sys, duckdb

con = duckdb.connect(sys.argv[1] if len(sys.argv) > 1 else "ga.duckdb", read_only=True)
W = 90  # trailing window, days

# referrer -> (host, path); bioconductor hosts are "internal"
HOST = "regexp_extract(pageReferrer, 'https?://([^/]+)', 1)"
RPATH = "coalesce(nullif(regexp_extract(pageReferrer, 'https?://[^/]+(/[^?#]*)', 1), ''), '/')"
INTERNAL = f"{HOST} ILIKE '%bioconductor.org%'"


def table(title, sql, headers, note=None):
    try:
        rows = con.execute(sql).fetchall()
    except duckdb.Error as e:
        print(f"\n## {title}\n\n_unavailable: {str(e).splitlines()[0]}_")
        return
    print(f"\n## {title}\n")
    if note:
        print(f"{note}\n")
    if not rows:
        print("_no rows_")
        return
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join([":---" if i == 0 else "---:" for i in range(len(headers))]) + "|")
    for r in rows:
        print("| " + " | ".join(f"{v:,.0f}" if isinstance(v, float) and abs(v) >= 1000
                                else (f"{v:,.1f}" if isinstance(v, float) else str(v))
                                for v in r) + " |")


span = con.execute("SELECT min(date), max(date), count(*) FROM totals").fetchone()
print(f"# bioconductor.org — GA4 report\n\nProperty 388188354. Data **{span[0]} → {span[1]}** "
      f"({span[2]} days). Trailing-window sections cover the last {W} days.\n")
print("> Engagement and bounce are derived as `engagedSessions/sessions`. `activeUsers` is "
      "never summed across days — see `users_rolling` for true uniques.")

# ---------------------------------------------------------------- traffic
table("Traffic by month",
      """SELECT strftime(date,'%Y-%m') AS month, sum(screenPageViews), sum(sessions),
                sum(newUsers),
                100*sum(engagedSessions)/nullif(sum(sessions),0),
                sum(userEngagementDuration)/nullif(sum(sessions),0)
         FROM totals GROUP BY 1 ORDER BY 1""",
      ["Month", "Pageviews", "Sessions", "New users", "Engaged %", "Sec/session"])

table("Unique users (correctly counted)",
      """SELECT strftime(date,'%Y-%m') AS month, round(avg(active1DayUsers)),
                round(avg(active7DayUsers)), round(avg(active28DayUsers))
         FROM users_rolling GROUP BY 1 ORDER BY 1""",
      ["Month", "Avg daily", "Avg 7-day", "Avg 28-day"],
      note="Averages of GA's own rolling windows. These are the only trustworthy unique counts.")

# ---------------------------------------------------------------- content
table(f"Top pages — last {W} days",
      f"""SELECT pagePath, sum(screenPageViews) AS v, sum(sessions),
                 sum(userEngagementDuration)/nullif(sum(sessions),0)
          FROM pages WHERE date >= current_date - {W}
          GROUP BY 1 ORDER BY v DESC LIMIT 40""",
      ["Page", "Pageviews", "Sessions", "Sec/session"])

table("Top pages — all time",
      """SELECT pagePath, sum(screenPageViews) AS v, count(DISTINCT date)
         FROM pages GROUP BY 1 ORDER BY v DESC LIMIT 30""",
      ["Page", "Pageviews", "Days seen"])

table(f"Top package pages — last {W} days",
      f"""SELECT regexp_extract(pagePath,'/packages/[^/]+/[^/]+/html/([^/]+)\\.html',1) AS pkg,
                 sum(screenPageViews) AS v, sum(sessions)
          FROM pages WHERE date >= current_date - {W} AND pagePath LIKE '/packages/%/html/%'
          GROUP BY 1 HAVING pkg <> '' ORDER BY v DESC LIMIT 30""",
      ["Package", "Pageviews", "Sessions"])

table(f"Site search — what people can't find (last {W} days)",
      f"""SELECT searchTerm, sum(eventCount) AS n
          FROM search WHERE date >= current_date - {W} AND searchTerm NOT IN ('','(not set)')
          GROUP BY 1 ORDER BY n DESC LIMIT 30""",
      ["Search term", "Searches"],
      note="Highest-signal cube for a docs site: a direct record of unmet intent.")

table(f"Events — last {W} days",
      f"""SELECT eventName, sum(eventCount) AS n FROM events
          WHERE date >= current_date - {W} GROUP BY 1 ORDER BY n DESC LIMIT 20""",
      ["Event", "Count"])

# ---------------------------------------------------------------- journeys
table(f"Entry points — last {W} days",
      f"""SELECT landingPage, sum(sessions) AS s,
                 100*sum(engagedSessions)/nullif(sum(sessions),0)
          FROM landing WHERE date >= current_date - {W}
          GROUP BY 1 ORDER BY s DESC LIMIT 25""",
      ["Landing page", "Sessions", "Engaged %"])

table(f"Journeys: top internal hops — last {W} days",
      f"""SELECT {RPATH} AS frm, pagePath, sum(screenPageViews) AS v
          FROM edges WHERE date >= current_date - {W} AND {INTERNAL} AND {RPATH} <> pagePath
          GROUP BY 1,2 ORDER BY v DESC LIMIT 40""",
      ["From", "To", "Views"],
      note="A hop = a pageview whose referrer was another bioconductor.org page. "
           "This is a real navigation graph.")

table(f"Journeys: two-hop paths — last {W} days",
      f"""WITH e AS (
            SELECT {RPATH} AS frm, pagePath AS to_, sum(screenPageViews) AS v
            FROM edges WHERE date >= current_date - {W} AND {INTERNAL} AND {RPATH} <> pagePath
            GROUP BY 1,2)
          SELECT a.frm, a.to_, b.to_, least(a.v, b.v) AS w
          FROM e a JOIN e b ON a.to_ = b.frm
          WHERE a.frm <> b.to_ ORDER BY w DESC LIMIT 25""",
      ["Step 1", "Step 2", "Step 3", "Min hop views"],
      note="**Approximation.** GA4's API exposes no session-level paths, so these chains are "
           "inferred by joining hops, not by following real sessions. Directional only.")

# ---------------------------------------------------------------- audience
table(f"How they arrive — channels, last {W} days",
      f"""SELECT sessionDefaultChannelGroup, sum(sessions) AS s,
                 100*sum(engagedSessions)/nullif(sum(sessions),0)
          FROM channels WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC""",
      ["Channel", "Sessions", "Engaged %"])

table(f"Top sources — last {W} days",
      f"""SELECT sessionSourceMedium, sum(sessions) AS s,
                 100*sum(engagedSessions)/nullif(sum(sessions),0)
          FROM sources WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC LIMIT 20""",
      ["Source / medium", "Sessions", "Engaged %"])

table(f"Off-site referrers — last {W} days",
      f"""SELECT {HOST} AS h, sum(screenPageViews) AS v
          FROM edges WHERE date >= current_date - {W} AND NOT {INTERNAL} AND {HOST} <> ''
          GROUP BY 1 ORDER BY v DESC LIMIT 20""",
      ["Referring host", "Views"])

table(f"Countries — last {W} days",
      f"""SELECT country, sum(sessions) AS s,
                 100*sum(engagedSessions)/nullif(sum(sessions),0)
          FROM countries WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC LIMIT 20""",
      ["Country", "Sessions", "Engaged %"])

table(f"Cities — last {W} days",
      f"""SELECT city || ', ' || country AS place, sum(sessions) AS s
          FROM cities WHERE date >= current_date - {W} AND city NOT IN ('','(not set)')
          GROUP BY 1 ORDER BY s DESC LIMIT 20""",
      ["City", "Sessions"])

table(f"Technology — last {W} days",
      f"""SELECT deviceCategory || ' / ' || operatingSystem || ' / ' || browser AS stack,
                 sum(sessions) AS s, 100*sum(engagedSessions)/nullif(sum(sessions),0)
          FROM tech WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC LIMIT 20""",
      ["Device / OS / Browser", "Sessions", "Engaged %"])

table(f"Device split — last {W} days",
      f"""SELECT deviceCategory, sum(sessions) AS s, sum(screenPageViews)
          FROM tech WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC""",
      ["Device", "Sessions", "Pageviews"])

table(f"Languages — last {W} days",
      f"""SELECT language, sum(sessions) AS s FROM languages
          WHERE date >= current_date - {W} GROUP BY 1 ORDER BY s DESC LIMIT 15""",
      ["Language", "Sessions"])

# ------------------------------------------------------------ integrity
table("Data quality: new vs returning by month",
      """SELECT strftime(date,'%Y-%m') AS month, sum(sessions),
                100*sum(CASE WHEN newVsReturning='new' THEN sessions END)/nullif(sum(sessions),0)
         FROM new_returning GROUP BY 1 ORDER BY 1""",
      ["Month", "Sessions", "New %"],
      note="A healthy docs site retains regulars. Sustained ~100% new is a bot signature.")

table(f"Data quality: traffic by hour of day (last {W} days)",
      f"""SELECT hour, sum(sessions) AS s, sum(screenPageViews)
          FROM hourly WHERE date >= current_date - {W} GROUP BY 1 ORDER BY hour""",
      ["Hour (property TZ)", "Sessions", "Pageviews"],
      note="Humans show a diurnal curve. A flat profile means automated traffic.")

table("Data quality: days where users exceed pageviews",
      """SELECT strftime(date,'%Y-%m') AS month, count(*) AS days,
                sum(activeUsers), sum(screenPageViews)
         FROM totals WHERE activeUsers > screenPageViews GROUP BY 1 ORDER BY 1""",
      ["Month", "Days", "Active users", "Pageviews"],
      note="A real visitor cannot view fewer than one page, so these days carry inflated "
           "user counts — bots, or a tag firing without page_view.")

con.close()
