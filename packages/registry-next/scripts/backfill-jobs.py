# /// script
# dependencies = ["duckdb", "httpx"]
# ///
"""Backfill job_runs and capture_queue from the current registry's package history.

    rclone lsf -R --files-only <remote>:bioc-registry/logs > captured.txt
    rclone lsf -R --files-only <remote>:bioc-registry/checks >> captured.txt
    MAINT_KEY=... uv run --with duckdb --with httpx scripts/backfill-jobs.py \\
        history/package_changes.parquet --captured captured.txt --base https://<worker>

Every job in record._jobs, and a newer commit's failed build in record._failure.job, becomes
one row with the first and last obs_ts it was seen at, POSTed to /admin/import-jobs in batches.
A key in the captured listing (bioc/123.txt is a log, bioc/123.json a check) marks that capture
done; the Worker marks an uncaptured one gone when its artifact has expired. Safe to re-run:
the route only widens what it has. --dry-run prints counts and sends nothing.
"""
import argparse
import os
import re
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone

import duckdb
import httpx

JOB = '{"job":"BIGINT","config":"VARCHAR","r":"VARCHAR","check":"VARCHAR","time":"DOUBLE","artifact":"VARCHAR"}'

# Times come out as epoch milliseconds: DuckDB returns TIMESTAMPTZ to Python only with pytz.
# ponytail: HEAD (devel) has no bioc_version here, since which version devel was at each obs_ts
# is not in the file; RELEASE_x_y is x.y.
QUERY = f"""
with recs as (
  select universe, obs_ts, package, sha256, record::json as rec
  from read_parquet(?) where not removed and record is not null),
j as (
  select universe, obs_ts, package, rec->>'Version' as version, sha256 as src_sha256,
    rec->>'RemoteSha' as commit, rec->>'RemoteRef' as ref, rec->>'_created' as built_at,
    rec->>'_expires' as expires_at, false as failure,
    unnest(from_json(rec->'_jobs', '[{JOB}]')) as jb
  from recs where json_type(rec->'_jobs') = 'ARRAY'
  union all by name
  select universe, obs_ts, package, rec->'_failure'->>'version' as version, null as src_sha256,
    rec->'_failure'->'commit'->>'id' as commit, rec->>'RemoteRef' as ref, null as built_at,
    null as expires_at, true as failure, from_json(rec->'_failure'->'job', '{JOB}') as jb
  from recs where json_type(rec->'_failure'->'job') = 'OBJECT')
select universe, jb.job as job, package, version, src_sha256, jb.config as config, jb.r as r,
  jb."check" as "check", round(jb.time)::integer as time_s, nullif(jb.artifact, '') as artifact,
  case when regexp_matches(ref, '^RELEASE_[0-9]+_[0-9]+$') then replace(ref[9:], '_', '.') end as bioc_version,
  commit, failure, built_at, expires_at,
  epoch_ms(min(obs_ts) over (partition by universe, jb.job)) as first_ms,
  epoch_ms(max(obs_ts) over (partition by universe, jb.job)) as last_ms
from j where jb.job is not null
qualify row_number() over (partition by universe, jb.job order by obs_ts, failure) = 1
order by universe, job
"""


def iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def iso(s: str | None) -> str | None:
    """r-universe's own time strings, normalized; None for anything unreadable."""
    try:
        d = datetime.fromisoformat(s) if s else None
    except ValueError:
        return None
    if d is None:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()


def captured(path: str | None) -> set[tuple[str, int, str]]:
    keys: set[tuple[str, int, str]] = set()
    if not path:
        return keys
    for line in open(path):
        m = re.search(r"(?:^|/)(bioc|bioc-release)/(\d+)\.(txt|json)$", line.strip())
        if m:
            keys.add((m[1], int(m[2]), "log" if m[3] == "txt" else "check"))
    return keys


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parquet", help="history/package_changes.parquet, a path or a URL")
    ap.add_argument("--captured", help="rclone lsf -R listing of logs/ and checks/")
    ap.add_argument("--base", help="the Worker's base URL")
    ap.add_argument("--batch", type=int, default=5000, help="rows per request, at most 5000")
    ap.add_argument("--dry-run", action="store_true", help="print counts, send nothing")
    a = ap.parse_args()
    key = os.environ.get("MAINT_KEY", "").strip()
    if not a.dry_run and (not a.base or not key):
        sys.exit("--base and the MAINT_KEY environment variable are needed unless --dry-run")
    if not 0 < a.batch <= 5000:
        sys.exit("--batch must be 1..5000")

    have = captured(a.captured)
    # Isolated: a stored secret of a type this client lacks would fail every query.
    with tempfile.TemporaryDirectory() as tmp:
        db = duckdb.connect(config={"secret_directory": tmp})
        cur = db.execute(QUERY, [a.parquet])
        cols = [d[0] for d in cur.description]
        rows = []
        for t in cur.fetchall():
            r = dict(zip(cols, t))
            first, last = r.pop("first_ms"), r.pop("last_ms")
            rows.append({**r, "built_at": iso(r["built_at"]), "expires_at": iso(r["expires_at"]),
                         "first_obs_ts": iso_ms(first), "last_obs_ts": iso_ms(last),
                         "log_captured": (r["universe"], r["job"], "log") in have,
                         "check_captured": (r["universe"], r["job"], "check") in have})

    per = Counter(r["universe"] for r in rows)
    print(f"{len(rows)} jobs ({', '.join(f'{u} {n}' for u, n in sorted(per.items()))}); "
          f"{sum(r['failure'] for r in rows)} failed builds; {sum(r['artifact'] is not None for r in rows)} with an artifact; "
          f"captured: {sum(r['log_captured'] for r in rows)} logs, {sum(r['check_captured'] for r in rows)} checks; "
          f"{-(-len(rows) // a.batch)} batches", file=sys.stderr)
    if a.dry_run:
        return

    total: Counter = Counter()
    with httpx.Client(headers={"x-maint-key": key, "user-agent": "bioc-registry-next-backfill"}, timeout=300) as http:
        for i in range(0, len(rows), a.batch):
            res = http.post(f"{a.base.rstrip('/')}/admin/import-jobs", json={"rows": rows[i:i + a.batch]})
            if res.status_code != 200:
                sys.exit(f"batch at row {i}: HTTP {res.status_code} {res.text[:500]}")
            out = res.json()
            total.update({"inserted": out["inserted"], "updated": out["updated"],
                          **{f"capture_{k}": v for k, v in out["capture"].items()}})
            print(f"rows {i}..{i + len(rows[i:i + a.batch]) - 1}: {out}", file=sys.stderr)
    print(dict(total))


if __name__ == "__main__":
    main()
