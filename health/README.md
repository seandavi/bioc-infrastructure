# bioc-health

On-demand, read-only health check of the bioc-* stack: bioc-edge (sync, R2, Worker),
bioc-traffic (Logpush → hourly Parquet → rollups and download stats) and the
seandavi/bioc-* repos. The collector gathers every signal into `bundle.json` and
`report.md`; the `bioc-health` agent skill (`.agents/skills/bioc-health/`) runs it
and turns the report into a triaged assessment. Nothing is posted, filed or restarted.
This is the detectors-plus-digest slice of #43.

Run it on onclappc02, where the units, the Parquet and the checkouts live.

```sh
./health/collect.py                          # every source
./health/collect.py --only systemd,issues    # a subset
./health/collect.py --now 2026-10-03T12:00Z  # pretend time, for reproducible reruns
./health/collect.py --config my.toml --out /some/dir
```

It is a `uv run --script` (Python ≥ 3.11, duckdb). Output goes to
`$TMPDIR/bioc-health/<UTC stamp>/` (`/tmp` when `TMPDIR` is unset), never into a
repo: this repo is public. The last stdout line is the absolute path of `report.md`.

| Exit | Meaning |
|---|---|
| 0 | nothing worse than warn |
| 1 | at least one fail or error finding |
| 2 | bad command line or config; no source ran |

## Sources

Every threshold lives in `config.toml`. Statuses, worst first: error (the check itself
broke), fail, warn, info, ok.

| Source | Checks |
|---|---|
| `issues` | Per repo: open issues and PRs, issues closed and PRs merged in the activity window. A PR with failing checks or merge conflicts warns; a non-draft PR idle past `pr_stale_days` is info. Info lists of new and stale issues. |
| `actions` | Per workflow on the default branch: latest conclusion (fail, or warn in `experimental_repos`), failure streak, last success, failed jobs and a log tail; disabled workflows; scheduled workflows that have not run in twice their cron period plus `actions_cron_grace_hours`. |
| `systemd` | Every `systemd --user` unit matching `unit_globs`: state, start-job results in the last `window_hours`, the journal tail of a failed run, and timers that are not active. |
| `checkouts` | The git tree each unit runs (its `WorkingDirectory`): on the default branch (else fail), at GitHub's tip and clean (else warn). Never fetches. |
| `access_logs` | Hourly Parquet freshness and gaps; per-hour volume against the median of the same hour on earlier days; 24 h 5xx share, hit ratio, 404 share and p95 latency against that baseline, with top 5xx/404 paths; rollup and download-stats freshness. Aggregates and paths only, never per-client columns. |
| `host` | Free space on `disk_paths`; accumulated sync logs. |
| `endpoints` | The six bioc-edge `health.yml` probes of bioconductor.org: status, body check, latency. |

Cross-references (`bioc_health/crossref.py`) compare `<unit> is failing` issues filed by
`bioc-notify@` in `failure_issue_repo` with live unit state: an issue whose unit has
recovered (`stale-issue`, close it by hand), a failing unit with no issue (`unfiled`),
and an issue naming a unit that is not loaded (`unknown-unit`). An issue for a unit that
is still failing is attached to that unit's finding as a ref.

## Layout

- `collect.py`: CLI; runs the selected sources concurrently. A source that raises becomes
  one error finding; the others still report.
- `bioc_health/rules.py`: every classification, as pure functions; `tests/` pins their
  boundaries against the shipped `config.toml`.
- `bioc_health/sources/<name>.py`: one module per source, each `collect(cfg, now) -> SourceResult`.
- `bioc_health/report.py`: renders `bundle.json` to `report.md`.

Tests: `uv run --python 3.12 --with pytest pytest health/tests -q` (also the `health` job
in `.github/workflows/test.yml`).
