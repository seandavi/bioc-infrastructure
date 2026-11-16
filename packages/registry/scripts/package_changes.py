# /// script
# dependencies = ["duckdb==2.0.0"]
# ///
"""Build history/package_changes.parquet: one row each time a package's r-universe
record or the registry's gate decision on it changes, or the package disappears,
diffed from the archived snapshots in obs/ and the wave decisions in prop/*/decisions/.

    uv run scripts/package_changes.py                 # R2: needs R2_ACCOUNT_ID,
                                                      # R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    uv run scripts/package_changes.py --limit 500     # at most 500 snapshots per universe this run
    uv run scripts/package_changes.py --root DIR      # local tree laid out like the bucket
    uv run scripts/package_changes.py --selftest

Incremental: each run reads the current file, takes the snapshots newer than the
newest obs_ts it holds, and rewrites the file. Rerunning over the same snapshots adds
nothing. The schema is documented in docs/DATAPLANE.md.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb

UNIVERSES = ["bioc", "bioc-release"]
EMPTY = str(Path(tempfile.mkdtemp()) / "0.json")
Path(EMPTY).write_text("[]")
OUT_KEY = "history/package_changes.parquet"
# A snapshot is ~31MB of JSON, and a batch is parsed whole: 35 at once peaked at
# 7.2GB, 8 fit under a 2GB memory limit.
BATCH = 8
TS = re.compile(r"/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-([0-9a-f]+)\.json$")
# A snapshot's wave writes its decisions minutes after the snapshot lands. Younger
# snapshots wait for the next run, so a wave still running isn't read as "no decision".
# ponytail: a wave stuck longer than this leaves its snapshot's decision null for good.
SETTLE = timedelta(hours=1)

SCHEMA = """
CREATE TABLE changes (
  universe VARCHAR, obs_ts TIMESTAMPTZ, package VARCHAR, version VARCHAR,
  sha256 VARCHAR, record_md5 VARCHAR, removed BOOLEAN,
  -- VARCHAR rather than JSON: parquet's JSON type reaches arrow readers as an
  -- extension type, and a plain string reads the same everywhere.
  record VARCHAR,
  -- the gate's decision in the wave for this snapshot; null before decisions were
  -- recorded (2026-11) and on removals
  decision VARCHAR
)"""

# One universe, one batch of snapshots. A package's rows are numbered by snapshot
# (seq), with its latest row from earlier runs as seq 0. A snapshot row is a change
# when the record or the decision differs from the previous snapshot's or the package
# was absent from it; a package is removed at seq+1 when it is missing from the next
# snapshot. A snapshot's decisions file shares its digest.
DIFF = """
CREATE OR REPLACE TEMP TABLE snaps AS
SELECT strptime(regexp_extract(filename, '(\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z)-[0-9a-f]+\\.json$', 1),
                '%Y-%m-%dT%H:%M:%S.%gZ')::TIMESTAMPTZ AS obs_ts,
       regexp_extract(filename, '-([0-9a-f]+)\\.json$', 1) AS digest,
       json->>'Package' AS package, md5(json::VARCHAR) AS record_md5, json AS record
FROM read_json_objects($files, format = 'array', filename = true);

CREATE OR REPLACE TEMP TABLE decided AS
SELECT regexp_extract(filename, '([0-9a-f]+)\\.json$', 1) AS digest, json->>'package' AS package,
       json_merge_patch(json, '{"package": null}')::VARCHAR AS decision
FROM read_json_objects($dfiles, format = 'array', filename = true);

CREATE OR REPLACE TEMP TABLE snaps AS
SELECT s.*, d.decision FROM snaps s LEFT JOIN decided d USING (digest, package);

CREATE OR REPLACE TEMP TABLE seqs AS
SELECT obs_ts, row_number() OVER (ORDER BY obs_ts) AS seq FROM (SELECT DISTINCT obs_ts FROM snaps);

CREATE OR REPLACE TEMP TABLE present AS
SELECT 0 AS seq, package, record_md5, decision FROM changes
WHERE universe = $u
QUALIFY row_number() OVER (PARTITION BY package ORDER BY obs_ts DESC) = 1 AND NOT removed
UNION ALL
SELECT seq, package, record_md5, decision FROM snaps JOIN seqs USING (obs_ts);

CREATE OR REPLACE TEMP TABLE walked AS
SELECT *, lag(seq) OVER w AS prev_seq, lag(record_md5) OVER w AS prev_md5,
       lag(decision) OVER w AS prev_decision, lead(seq) OVER w AS next_seq
FROM present WINDOW w AS (PARTITION BY package ORDER BY seq);

INSERT INTO changes
SELECT $u, s.obs_ts, s.package, s.record->>'Version', s.record->>'_sha256', s.record_md5, false, s.record::VARCHAR,
       s.decision
FROM walked w JOIN seqs q ON q.seq = w.seq JOIN snaps s ON s.obs_ts = q.obs_ts AND s.package = w.package
WHERE w.seq > 0 AND (w.prev_seq IS DISTINCT FROM w.seq - 1 OR w.prev_md5 IS DISTINCT FROM w.record_md5
                     OR w.prev_decision IS DISTINCT FROM w.decision)
UNION ALL
SELECT $u, q.obs_ts, w.package, NULL, NULL, NULL, true, NULL, NULL
FROM walked w JOIN seqs q ON q.seq = w.seq + 1
WHERE w.next_seq IS DISTINCT FROM w.seq + 1;
"""


def connect(root: str | None) -> tuple[duckdb.DuckDBPyConnection, str]:
    # Isolated: ~/.duckdb/stored_secrets on onclappc02 breaks clients that lack its secret types.
    db = duckdb.connect(config={"secret_directory": tempfile.mkdtemp()})
    # obs keys are UTC; without this a TIMESTAMPTZ cast reads them as local time.
    db.execute("SET TimeZone = 'UTC'")
    # Uncapped, DuckDB takes most of the machine; at 2GB a batch still fits.
    db.execute("SET memory_limit = '4GB'")
    if root:
        return db, root.rstrip("/")
    db.execute(
        "CREATE SECRET r2 (TYPE r2, KEY_ID ?, SECRET ?, ACCOUNT_ID ?)",
        [os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"], os.environ["R2_ACCOUNT_ID"]],
    )
    return db, "r2://bioc-prop"


def run(root: str | None, limit: int | None) -> None:
    db, base = connect(root)
    out = f"{base}/{OUT_KEY}"
    db.execute(SCHEMA)
    try:
        # BY NAME: files written before a column was added read it as null
        db.execute(f"INSERT INTO changes BY NAME SELECT * FROM read_parquet('{out}')")
    except duckdb.IOException:
        print(f"no {out} yet: starting from the first snapshot", file=sys.stderr)

    added = 0
    settled = (datetime.now(timezone.utc) - SETTLE).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for u in UNIVERSES:
        (last,) = db.execute(
            "SELECT strftime(max(obs_ts) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') FROM changes WHERE universe = ?",
            [u],
        ).fetchone()
        keys = sorted(
            f for (f,) in db.execute(f"SELECT file FROM glob('{base}/obs/{u}/dt=*/*.json')").fetchall()
            if (m := TS.search(f)) and (last is None or m.group(1) > last) and m.group(1) < settled
        )
        keys = keys[:limit]
        decisions = {
            Path(f).stem: f for (f,) in db.execute(f"SELECT file FROM glob('{base}/prop/{u}/decisions/*.json')").fetchall()
        }
        for i in range(0, len(keys), BATCH):
            batch = keys[i : i + BATCH]
            before = db.execute("SELECT count(*) FROM changes").fetchone()[0]
            dfiles = [decisions[d] for k in batch if (d := TS.search(k).group(2)) in decisions]
            # read_json_objects needs at least one file; an empty array stands in
            params = {"files": batch, "u": u, "dfiles": dfiles or [EMPTY]}
            for stmt in filter(str.strip, DIFF.split(";\n")):
                db.execute(stmt, {k: v for k, v in params.items() if f"${k}" in stmt})
            n = db.execute("SELECT count(*) FROM changes").fetchone()[0] - before
            added += n
            print(f"{u} {TS.search(batch[0]).group(1)}: {len(batch)} snapshots, {n} rows", file=sys.stderr)

    if not added:
        print("nothing new", file=sys.stderr)
        return
    if root:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
    # Sorted so a reader after one package touches only that package's row groups;
    # small row groups because a record is ~10KB of JSON.
    db.execute(
        f"COPY (SELECT * FROM changes ORDER BY universe, package, obs_ts) TO '{out}'"
        " (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 4096)"
    )
    print(f"wrote {out}: +{added} rows", file=sys.stderr)


def selftest() -> None:
    root = Path(tempfile.mkdtemp())

    def snap(ts: str, pkgs: list[dict], digest: str = "abcdef012345", decisions: list[dict] | None = None) -> None:
        d = root / "obs" / "bioc" / f"dt={ts[:10]}"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{ts}-{digest}.json").write_text(json.dumps(pkgs))
        if decisions is not None:
            (root / "prop" / "bioc" / "decisions").mkdir(parents=True, exist_ok=True)
            (root / "prop" / "bioc" / "decisions" / f"{digest}.json").write_text(json.dumps(decisions))

    a1 = {"Package": "A", "Version": "1.0", "_jobs": [{"job": 1, "check": "OK"}]}
    a2 = {"Package": "A", "Version": "1.0", "_jobs": [{"job": 2, "check": "OK"}]}  # a rerun
    b = {"Package": "B", "Version": "2.0"}
    c = {"Package": "C", "_type": "failure", "_failure": {"job": None}}  # never built
    snap("2026-08-08T00:00:00.000Z", [a1, b])
    snap("2026-08-08T00:15:00.000Z", [a1, b, c])
    snap("2026-08-09T00:00:00.000Z", [a2, c])  # B gone
    run(str(root), limit=2)  # two runs, so state has to carry across them
    run(str(root), limit=None)
    run(str(root), limit=None)  # nothing new: must add nothing
    snap("2026-08-10T00:00:00.000Z", [a2, b, c])  # B back
    run(str(root), limit=None)
    yes = {"package": "A", "version": "1.0", "published": None, "propagate": True, "archs": [], "reasons": []}
    unneeded = {**yes, "published": "1.0", "propagate": False}
    snap("2026-08-11T00:00:00.000Z", [a2, b, c], "000000000011", [yes])  # A's first decision
    snap("2026-08-12T00:00:00.000Z", [a2, b, c], "000000000012", [yes])  # same decision: no row
    snap("2026-08-13T00:00:00.000Z", [a2, b, c], "000000000013", [unneeded])  # published since
    snap(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), [a2], "000000000014", None)  # unsettled
    run(str(root), limit=None)

    db = duckdb.connect()
    db.execute("SET TimeZone = 'UTC'")
    got = db.execute(
        f"SELECT strftime(obs_ts AT TIME ZONE 'UTC', '%dT%H:%M'), package, removed, record->>'$._jobs[0].job',"
        f" decision->>'propagate'"
        f" FROM '{root}/{OUT_KEY}' ORDER BY obs_ts, package"
    ).fetchall()
    assert got == [
        ("08T00:00", "A", False, "1", None),
        ("08T00:00", "B", False, None, None),
        ("08T00:15", "C", False, None, None),
        ("09T00:00", "A", False, "2", None),
        ("09T00:00", "B", True, None, None),
        ("10T00:00", "B", False, None, None),
        ("11T00:00", "A", False, "2", "true"),
        ("13T00:00", "A", False, "2", "false"),
    ], got
    print("selftest ok", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", help="local directory laid out like the bucket")
    ap.add_argument("--limit", type=int, help="at most this many snapshots per universe")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    selftest() if a.selftest else run(a.root, a.limit)
