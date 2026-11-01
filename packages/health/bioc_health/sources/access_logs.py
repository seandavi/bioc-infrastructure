"""Access-log pipeline health: hourly Parquet freshness, traffic volume and quality
against a same-hour baseline, rollup freshness, download-stats freshness.

Aggregates and paths only: never select c_ip, client_id, cs_user_agent or any other
per-client column. Every read_parquet gets an explicit file list, never a glob; globbing
the partition tree is what exhausts file descriptors in bioc-traffic.
"""

from __future__ import annotations

import os
import statistics
from datetime import date, datetime, timedelta, timezone

import duckdb

from .. import rules
from ..model import Finding, SourceResult, Status

NAME = "access_logs"
FRESHNESS_SCAN_H = 72
MISSING_WINDOW = range(2, 50)  # hours back from now_hour; the last two may still be filling
CURRENT_WINDOW = range(2, 26)
GRAINS = {"minute": "t", "hour": "t", "day": "t", "overall_day": "day"}

COUNTS_SQL = """
SELECT filename, count(*) AS n,
       count(*) FILTER (WHERE sc_status LIKE '5%') AS n5xx,
       count(*) FILTER (WHERE sc_status = '404') AS n404,
       count(*) FILTER (WHERE x_edge_result_type = 'HIT') AS hit,
       count(*) FILTER (WHERE x_edge_result_type IN ('HIT','MISS')) AS hitmiss
FROM read_parquet($files, filename = true, hive_partitioning = false)
GROUP BY filename
"""
P95_SQL = "SELECT approx_quantile(TRY_CAST(time_taken AS DOUBLE), 0.95) FROM read_parquet($files)"
TOP_SQL = """
SELECT cs_uri_stem, count(*) AS n FROM read_parquet($files)
WHERE {cond} GROUP BY 1 ORDER BY n DESC, cs_uri_stem LIMIT $k
"""
BASE_PATHS_SQL = """
SELECT cs_uri_stem, count(*) AS n FROM read_parquet($files)
WHERE {cond} AND list_contains($paths, cs_uri_stem) GROUP BY 1
"""
CONDS = {"5xx": "sc_status LIKE '5%'", "404": "sc_status = '404'"}
TOTALS = ("n", "n5xx", "n404", "hit", "hitmiss")


def hour_path(root: str, dt: datetime) -> str:
    return f"{root}/year={dt.year}/month={dt.month}/day={dt.day}/hour={dt.hour}/logs.parquet"


def _label(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:00Z")


def _totals(rows: list[dict]) -> dict:
    return {k: sum(r[k] for r in rows) for k in TOTALS}


def _top_paths(con, cur_files: list[str], base_files: list[str], cond: str, k: int) -> list[dict]:
    top = con.execute(TOP_SQL.format(cond=cond), {"files": cur_files, "k": k}).fetchall()
    base = {}
    if top and base_files:
        base = dict(con.execute(BASE_PATHS_SQL.format(cond=cond),
                                {"files": base_files, "paths": [p for p, _ in top]}).fetchall())
    per_day = len(base_files) / 24
    return [{"path": p, "n": n,
             "baseline_daily": round(base.get(p, 0) / per_day, 1) if per_day else None}
            for p, n in top]


def collect(cfg: dict, now: datetime) -> SourceResult:
    ac, th = cfg["access_logs"], cfg["thresholds"]
    root = ac["parquet_root"]
    now_hour = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    exists = lambda dt: os.path.exists(hour_path(root, dt))  # noqa: E731
    findings: list[Finding] = []
    data: dict = {}
    con = duckdb.connect()

    # 1. Continuity and freshness.
    newest = next((now_hour - timedelta(hours=k) for k in range(FRESHNESS_SCAN_H + 1)
                   if exists(now_hour - timedelta(hours=k))), None)
    if newest is None:
        findings.append(Finding(f"{NAME}/parquet/freshness", NAME, Status.FAIL,
                                f"no hourly Parquet in {FRESHNESS_SCAN_H}h under {root}"))
        data |= {"newest_hour": None, "lag_hours": None}
    else:
        lag = int((now_hour - newest).total_seconds() // 3600)
        data |= {"newest_hour": _label(newest), "newest_path": hour_path(root, newest), "lag_hours": lag}
        findings.append(Finding(f"{NAME}/parquet/freshness", NAME, rules.parquet_lag_status(lag, th),
                                f"newest hourly Parquet {_label(newest)}, {lag}h behind"))
    missing = [_label(now_hour - timedelta(hours=k)) for k in MISSING_WINDOW
               if not exists(now_hour - timedelta(hours=k))]
    data["missing_hours"] = missing
    if missing:
        findings.append(Finding(f"{NAME}/parquet/missing", NAME, Status.WARN,
                                f"{len(missing)} hourly Parquet file(s) missing in the last 48h",
                                detail=", ".join(missing), evidence={"hours": missing}))

    if newest is not None:
        # 2. Volume per hour against the same hour on earlier days.
        floor = date.fromisoformat(ac["baseline_floor"])
        current = [h for h in (now_hour - timedelta(hours=k) for k in CURRENT_WINDOW) if exists(h)]
        baseline_of = {
            h: [b for b in (h - timedelta(days=d) for d in range(1, ac["baseline_days"] + 1))
                if b.date() >= floor and exists(b)]
            for h in current
        }
        cur_files = [hour_path(root, h) for h in current]
        base_files = sorted({hour_path(root, b) for bs in baseline_of.values() for b in bs})
        rows = {}
        if cur_files:
            cols = ("filename",) + TOTALS
            for r in con.execute(COUNTS_SQL, {"files": cur_files + base_files}).fetchall():
                rows[r[0]] = dict(zip(cols, r))
        zero = dict.fromkeys(TOTALS, 0)

        hourly, worst_vol, offenders = [], Status.OK, []
        for h in current:
            r = rows.get(hour_path(root, h), zero)
            ns = [rows.get(hour_path(root, b), zero)["n"] for b in baseline_of[h]]
            med = statistics.median(ns) if ns else None
            st = rules.volume_status(r["n"], med, th)
            ratio = round(r["n"] / med, 3) if med else None
            hourly.append({"hour": _label(h), "n": r["n"], "baseline_median": med, "ratio": ratio,
                           "n5xx": r["n5xx"]})
            worst_vol = max(worst_vol, st)
            if st in (Status.WARN, Status.FAIL):
                offenders.append(f"{_label(h)} n={r['n']} ratio={ratio}")
        data["hourly"] = hourly
        if current:
            title = (f"{len(offenders)} hour(s) outside {th['volume_ratio_low']}–{th['volume_ratio_high']}x "
                     "of baseline" if offenders else
                     "no baseline for hourly volume" if worst_vol == Status.INFO else
                     f"hourly volume within {th['volume_ratio_low']}–{th['volume_ratio_high']}x of baseline")
            findings.append(Finding(f"{NAME}/volume", NAME, worst_vol, title,
                                    detail="\n".join(offenders) or None,
                                    evidence={"offending_hours": offenders}))

        # 3. 24 h traffic quality against the baseline.
        if cur_files:
            cur = _totals([rows.get(f, zero) for f in cur_files])
            cur["p95"] = con.execute(P95_SQL, {"files": cur_files}).fetchone()[0]
            cur["files"] = len(cur_files)
            base = None
            if base_files:
                base = _totals([rows.get(f, zero) for f in base_files])
                base["p95"] = con.execute(P95_SQL, {"files": base_files}).fetchone()[0]
                base["files"] = len(base_files)
                base["days_used"] = len({f.split("/hour=")[0] for f in base_files})
            data["current"], data["baseline"] = cur, base
            tops = {kind: _top_paths(con, cur_files, base_files, cond, ac["top_paths"])
                    for kind, cond in CONDS.items()}
            data["top_5xx"], data["top_404"] = tops["5xx"], tops["404"]
            for st, check, title in rules.traffic_quality(cur, base, hourly, th):
                ev = {"top_paths": tops[check]} if check in tops else {}
                findings.append(Finding(f"{NAME}/traffic/{check}", NAME, st, title, evidence=ev))

    # 4. Rollup freshness.
    now_naive = now.astimezone(timezone.utc).replace(tzinfo=None)
    data["rollups"] = {}
    for grain, col in GRAINS.items():
        path = os.path.join(ac["rollups_dir"], f"{grain}.parquet")
        fid = f"{NAME}/rollup/{grain}"
        if not os.path.exists(path):
            findings.append(Finding(fid, NAME, Status.FAIL, f"{grain} rollup missing: {path}"))
            continue
        newest_t = con.execute(f'SELECT max("{col}") FROM read_parquet($p)', {"p": path}).fetchone()[0]
        if isinstance(newest_t, date) and not isinstance(newest_t, datetime):
            newest_t = datetime.combine(newest_t, datetime.min.time())
        age_h = round((now_naive - newest_t).total_seconds() / 3600, 1)
        data["rollups"][grain] = {"max": newest_t.isoformat(sep=" "), "age_h": age_h}
        findings.append(Finding(fid, NAME, rules.rollup_age_status(grain, age_h, th),
                                f"{grain} rollup newest {newest_t:%Y-%m-%d %H:%M}, {age_h}h old",
                                evidence=data["rollups"][grain]))

    # 5. Download stats.
    fid = f"{NAME}/stats/as-of"
    try:
        with open(ac["stats_as_of"]) as fh:
            as_of = date.fromisoformat(fh.read().strip())
    except FileNotFoundError:
        data["stats_as_of"] = None
        findings.append(Finding(fid, NAME, Status.FAIL, f"download stats DATA_AS_OF missing: {ac['stats_as_of']}"))
    else:
        data["stats_as_of"] = as_of.isoformat()
        findings.append(Finding(fid, NAME, rules.stats_as_of_status(as_of, now_naive.date(), th),
                                f"download stats as of {as_of}"))

    return SourceResult(NAME, findings, data)
