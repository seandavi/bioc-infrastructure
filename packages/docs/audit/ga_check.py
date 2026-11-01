#!/usr/bin/env -S uv run --quiet --with duckdb python3
"""Integrity check for the GA4 warehouse. Usage: ./ga_check.py [ga.duckdb]

`totals` is the ground truth: it has no dimensions, so it cannot be truncated.
Every dimensioned cube must reconcile against it. A cube that silently loses
rows to a cardinality cap shows up here as a coverage shortfall -- which is
exactly how the month-cap skew was found.

Exits non-zero if any month falls below TOL coverage.
"""
import sys, duckdb

TOL = 0.98  # cubes must cover >=98% of ground-truth volume per month
DB = sys.argv[1] if len(sys.argv) > 1 else "ga.duckdb"
con = duckdb.connect(DB, read_only=True)

# cube -> (metric in cube, matching metric in totals)
CUBES = {
    "pages":     ("screenPageViews", "screenPageViews"),
    "landing":   ("sessions", "sessions"),
    "countries": ("sessions", "sessions"),
    "cities":    ("sessions", "sessions"),
    "tech":      ("sessions", "sessions"),
    "channels":  ("sessions", "sessions"),
    "sources":   ("sessions", "sessions"),
    "languages": ("sessions", "sessions"),
    "hourly":    ("sessions", "sessions"),
    "hosts":     ("screenPageViews", "screenPageViews"),
}

bad = []
for cube, (m, tm) in CUBES.items():
    rows = con.execute(f"""
        SELECT strftime(c.date,'%Y-%m') AS month, sum(c."{m}") AS got, any_value(t.tot) AS want
        FROM {cube} c
        JOIN (SELECT strftime(date,'%Y-%m') AS month, sum("{tm}") AS tot
              FROM totals GROUP BY 1) t ON strftime(c.date,'%Y-%m') = t.month
        GROUP BY 1 ORDER BY 1""").fetchall()
    worst = min(((g / w if w else 1.0), mo) for mo, g, w in rows)
    flag = "ok " if worst[0] >= TOL else "LOW"
    print(f"{flag} {cube:<10} worst month {worst[1]} at {100*worst[0]:5.1f}%  ({len(rows)} months)")
    if worst[0] < TOL:
        bad += [(cube, mo, 100 * g / w) for mo, g, w in rows if w and g / w < TOL]

# sessions are not comparable across scopes; users are not additive. Only the
# checks above are meaningful -- do not add an activeUsers reconciliation here.
print()
if bad:
    print(f"FAIL: {len(bad)} cube-months below {100*TOL:.0f}% coverage")
    for cube, mo, pct in bad[:20]:
        print(f"  {cube} {mo} {pct:.1f}%")
    sys.exit(1)
print(f"PASS: all cubes >= {100*TOL:.0f}% coverage against totals")
