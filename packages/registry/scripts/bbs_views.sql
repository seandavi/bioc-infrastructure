-- BiocBuildDB-shaped views over the registry's package history (r-universe builds).
--
-- build_summary and info have BiocBuildReporter's columns, in its order, with extra
-- columns on the right. current_summary is build_summary limited to each package's
-- current jobs. Mapping and caveats: docs/api.md, "BiocBuildDB-shaped views".
--
-- DuckDB:  .read bbs_views.sql
-- R:       see docs/api.md (the R client needs httpfs, json and icu loaded first)
--
-- Statements end with ";" at the end of a line, so a client can split on that.

CREATE OR REPLACE VIEW ru_changes AS
SELECT *,
  -- branch: RemoteRef when r-universe reports it (HEAD = devel); otherwise the universe's last known ref
  coalesce(
    CASE record->>'RemoteRef' WHEN 'HEAD' THEN 'devel' ELSE record->>'RemoteRef' END,
    CASE universe WHEN 'bioc' THEN 'devel' END,
    last_value(record->>'RemoteRef' IGNORE NULLS) OVER (PARTITION BY universe ORDER BY obs_ts
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
    first_value(record->>'RemoteRef' IGNORE NULLS) OVER (PARTITION BY universe ORDER BY obs_ts
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
  ) AS git_branch
FROM 'https://bioc-registry.seandavi.workers.dev/data/history/package_changes.parquet'
WHERE NOT removed;

-- One row per r-universe job (= one run of one config). A record repeats every job until it is
-- rerun, so each job is kept once, at the first snapshot that showed it.
CREATE OR REPLACE VIEW ru_jobs AS
WITH x AS (
  SELECT universe, obs_ts, package, record_md5, git_branch,
         record->>'Version' AS version, unnest(from_json(record->'_jobs',
           '[{"job":"BIGINT","time":"INTEGER","config":"VARCHAR","r":"VARCHAR","check":"VARCHAR"}]')) AS jb
  FROM ru_changes
  UNION ALL  -- failed build of a newer commit: its own version, outside _jobs
  SELECT universe, obs_ts, package, record_md5, git_branch,
         record->'_failure'->>'version',
         from_json(record->'_failure'->'job',
           '{"job":"BIGINT","time":"INTEGER","config":"VARCHAR","r":"VARCHAR","check":"VARCHAR"}')
  FROM ru_changes WHERE (record->'_failure'->'job') IS NOT NULL
)
SELECT universe, package, version, git_branch, jb.*, obs_ts, record_md5
FROM x
QUALIFY row_number() OVER (PARTITION BY universe, jb.job ORDER BY obs_ts, version IS NULL) = 1;

CREATE OR REPLACE VIEW build_summary AS
SELECT
  package,
  config AS node,                                 -- a platform config, not a machine
  CASE WHEN config = 'source' THEN 'buildsrc'
       WHEN config = 'bioc-checks' THEN 'bioccheck'
       WHEN config LIKE 'wasm-%' THEN 'buildbin'
       ELSE 'checksrc' END AS stage,
  version,
  CASE "check" WHEN 'OK' THEN 'OK' WHEN 'NOTE' THEN 'OK' WHEN 'WARNING' THEN 'WARNINGS'
       ELSE 'ERROR' END AS status,                -- ERROR, FAIL, FAILURE -> ERROR
  -- approximate: r-universe gives duration only; endedat = first snapshot showing the job
  obs_ts - to_seconds("time") AS startedat,
  obs_ts AS endedat,
  NULL::VARCHAR AS command,
  record_md5 AS report_md5,
  -- extras
  'r-universe' AS source, universe, "check", r AS r_version, job,
  'https://bioc-registry.seandavi.workers.dev/logs/' || universe || '/' || job AS log_url
FROM ru_jobs;

CREATE OR REPLACE VIEW info AS
SELECT DISTINCT ON (universe, package, record_md5)
  package AS "Package",
  coalesce(record->>'Version', record->'_failure'->>'version') AS "Version",
  trim(regexp_extract(record->>'Maintainer', '^([^<]*)', 1)) AS "Maintainer",
  replace(regexp_extract(record->>'Maintainer', '<([^>]*)>', 1), '@', ' at ') AS "MaintainerEmail",
  'https://git.bioconductor.org/packages/' || package AS git_url,
  git_branch,
  left(record->'_commit'->>'id', 7) AS git_last_commit,
  to_timestamp((record->'_commit'->>'time')::BIGINT) AS git_last_commit_date,
  record_md5 AS report_md5,
  'r-universe' AS source, universe, obs_ts
FROM ru_changes;

-- Current state: each package's newest record (packages since removed are dropped), and its jobs.
CREATE OR REPLACE VIEW latest_records AS
SELECT * FROM 'https://bioc-registry.seandavi.workers.dev/data/history/package_changes.parquet'
QUALIFY row_number() OVER (PARTITION BY universe, package ORDER BY obs_ts DESC) = 1;

CREATE OR REPLACE VIEW current_summary AS
SELECT b.* FROM build_summary b
JOIN (SELECT universe, package, unnest(from_json(record->'_jobs', '["JSON"]'))->>'job' AS job
      FROM latest_records WHERE NOT removed
      UNION ALL
      SELECT universe, package, record->'_failure'->'job'->>'job'
      FROM latest_records WHERE NOT removed AND (record->'_failure'->'job') IS NOT NULL) c
  ON b.universe = c.universe AND b.job = c.job::BIGINT;
