# bioc-registry-next

The next registry, built beside the current one ([`packages/registry`](../registry)) and
running as a shadow until it replaces it. Design and plan:
[#213](https://github.com/seandavi/bioc-infrastructure/issues/213).

**Status: shadow**, deployed at <https://bioc-registry-next.seandavi.workers.dev> since 2026-11-25.
Nothing reads from it yet. The current registry keeps serving
`bioc-registry.seandavi.workers.dev` and is not changed by anything here. Nothing here depends on
the current registry, and the Worker has no binding to its bucket
([#233](https://github.com/seandavi/bioc-infrastructure/issues/233)): this one polls r-universe,
keeps its own record of every build job and copies their logs itself.

What differs from the current registry:

- **State is in Postgres** (PlanetScale, through Cloudflare Hyperdrive), not in JSON objects that
  several code paths read, change and write back. A publication is one transaction.
- **R2 holds bytes and published files only**: `cas/{sha256}` for every artifact, the
  repository indexes written from the database, the r-universe snapshots (`obs/`) and the
  captured build output (`logs/`, `checks/`, `builds/`). Readers still need nothing but HTTP.
- **Repositories are keyed by Bioconductor version and repository** (`3.24` + `bioc`), not by
  r-universe universe name.
- **Package metadata is read from the source tarball** when it enters the store, so it describes
  the published version whatever a builder reports later.

## Layout

| path | what |
|---|---|
| `src/migrations.ts` | the schema, as append-only migrations, and `migrate()` |
| `src/db.ts` | bindings and the database client |
| `src/index.ts` | the Worker: a Hono app whose routes also generate `/openapi.json` |
| `src/gate.ts` | the propagation gate ([ADR 0011](https://seandavi.github.io/bioc-infrastructure/adr/0011-one-propagation-gate-for-every-producer.html)), pure |
| `src/store.ts` | every query, including `publish()`, the one write path for a publication |
| `src/dcf.ts` | `PACKAGES` and `VIEWS` rendered from the current publications, pure |
| `src/materialize.ts` | writes a repository's files to R2 from the database, only when their bytes changed |
| `src/repo.ts` | serves those files at `/packages/{version}/{repo}/…`; reads R2 only, except `Archive/` |
| `src/ingest.ts` | bytes into `cas/{sha256}`, and a source tarball's facts and documents out of it |
| `src/poll.ts` | the sweep: r-universe's package records archived to `obs/` and recorded in `observations` when they changed |
| `src/observe.ts` | an r-universe observation turned into publications (`planWave()` is the pure part) and into the build record (`jobRuns()`), and `refresh()` of versions and known names |
| `src/capture.ts` | job logs, check output and build environments copied from GitHub, draining `capture_queue` |
| `src/admin.ts` | the `/admin/*` routes and the cron |
| `scripts/backfill-jobs.py` | one-time: the current registry's job history into `job_runs` and `capture_queue` |
| `src/testdb.ts` | a fresh database per test file, migrated unless asked not to be |
| `src/*.test.ts` | `node:test` suites; database tests need `DATABASE_URL` |

## API

The OpenAPI document at `/openapi.json` is generated from the route definitions. Public routes
send `access-control-allow-origin: *`. `{bioc_version}` is a number (`3.24`) or `release` /
`devel`, resolved through the `bioc_versions` table.

| Route | What |
|---|---|
| `POST /gate` | Read-only: would these candidates propagate, and if not why. Body `{bioc_version, repo, candidates, config?}`; same decision and response shape as the current registry's `/gate`. `config.gating_r` defaults to the version's R line; 400 when the version is unknown and none is given, or a candidate's package is not an R package name or appears twice. Every error, here and on `/api`, is `{error}` JSON. |
| `GET /api/v1/packages/{bioc_version}/{repo}/{package}` | One package in `bioc`, `data/annotation`, `data/experiment`, `workflows` or `books`: its current publication, history and latest gate decisions. 404 if never published there. |
| `GET /api/v1/cas/{sha256}` | One stored object and every publication that references it, as source or binary. |
| `GET /logs/{universe}/{job}` | One build job's GitHub Actions log, `text/plain`, at the current registry's path. `universe` is `bioc` or `bioc-release`, `job` a job id from `job_runs` (r-universe's `_jobs[].job` or `_failure.job.job`). 404 `{error}` until captured; 400 for another universe or a `job` that is not digits. |
| `GET /checks/{universe}/{job}` | That job's check output (`00check.log`, `00install.out`, test transcripts, …) as JSON keyed by file name. Same rules. |
| `GET /builds/{universe}/{job}` | That job's build environment, `{image, repos, deps}`, read from its log: the image digest or runner and every dependency version installed. Same rules; absent when the log has no install section. |
| `POST /admin/migrate` | Applies pending migrations. Needs `x-maint-key`, as every `/admin` route does. |
| `POST /admin/refresh` | Reads bioconductor.org's `config.yaml` into `bioc_versions`, then the package names CRAN and Bioconductor's other repositories publish into `known_external_deps`, per version r-universe builds. Per version, every source must list packages (or all four Bioconductor ones 404: no names yet); otherwise the previous names are kept. |
| `POST /admin/poll?universe=bioc\|bioc-release` | Fetches the universe's records from r-universe and, when they differ from the newest observation, archives them to `obs/` and records the observation. Returns `{status: "archived"\|"unchanged", digest, key?}`. |
| `POST /admin/observe?universe=bioc\|bioc-release&limit=10` | Brings the database and the store up to date with the newest observation `poll` archived, at most `limit` publications and top-ups per call. Returns `{status, digest, published, topped_up, failed, remaining, touched, written}`. The files a call changed are written before the observation is marked processed, and the call that completes it rewrites every repository of its versions. |
| `POST /admin/capture?logs=50&checks=50&budget=1500` | Copies at most `logs` (0..200) logs and `checks` (0..100) check outputs from GitHub, soonest to expire first, within `budget` (0..9500) subrequests. Returns `{status: "drained"\|"stopped"\|"out_of_subrequests", done, gone, present, stopped?, released?}`, or `{status: "skipped"}` without `GITHUB_TOKEN`. See [Build record and capture](#build-record-and-capture). |
| `POST /admin/import-jobs` | Body `{rows: [...]}`, at most 5,000: `job_runs` rows (`universe`, `job`, `first_obs_ts`, `last_obs_ts` required) with optional `log_captured` and `check_captured`. A known job only widens its first and last `obs_ts`. Captures are queued `done` when captured, `gone` when not and `expires_at` has passed, else `pending`; a `done` capture is never downgraded. Returns `{rows, inserted, updated, capture: {pending, done, gone}}`. For `scripts/backfill-jobs.py`. |
| `POST /admin/materialize?bioc_version=3.24&repo=bioc` | Rewrites one repository's files from the database. `observe` and `refresh` already write what they change; this is for a change to how the files are rendered. |
| `GET /admin/status` | Current publications per version, repository and origin; stored objects and bytes; the latest observation per universe. |

### Repository files

`materialize(bucket, sql, bioc_version, repo)` writes, under `packages/{bioc_version}/{repo}/`:
`src/contrib/` and every `bin/windows/contrib/{r}/` and `bin/macosx/{dir}/contrib/{r}/` that has a
binary (`PACKAGES`, `PACKAGES.gz`, `PACKAGES.rds`), `VIEWS` and `index.json`.
`materializeVersions` writes `packages/versions.json`:
`{ release, devel, versions: { "3.24": { r_minor, role } } }`. An object is written only when its
md5 differs from the stored etag, so unchanged files keep their etag. `index.json` is written
first, so `PACKAGES` and `VIEWS` never name a file the Worker cannot resolve. The files are never edited
by hand and never read back to decide anything.

`index.json` is an object keyed by package name; each value is the package's current `RepoRow`
(`src/store.ts`): `publication_id`, `package`, `version`, `origin`, `bioccheck`, `archs`,
`published_at`, `description`, `files`, `meta`, `git_url`, `git_branch`, `git_commit`,
`git_commit_at`, `source` and `binaries` (each with `os`, `r_minor`, `arch`, `distro`,
`filename`, `sha256`, `md5`, `size_bytes`). Fields may be added; none will be renamed.

`GET`/`HEAD /packages/{version}/{repo}/…` serves them, `version` being a number or
`release`/`devel`. Index files come from R2 as stored (`etag`, 304 on `if-none-match`, five
minutes of cache). A package file name is resolved through `index.json` to `cas/{sha256}` and
streamed. One well-formed byte `Range` is a 206 and an unsatisfiable one a 416; any other `Range`
gets the whole file. The cache header is immutable only at a numbered version's path for a file
that is not a seed (a build replaces a seed under the same name); `release`/`devel` paths and
seeds get five minutes.
`src/contrib/Archive/{package}/{package}_{version}.tar.gz` serves a superseded source and is
the one route that queries the database.

Publishing over HTTP is not here yet. `publish()` in `src/store.ts` takes a per-package lock,
re-checks the version rule against the current row, and supersedes it, all in one transaction.
Two producers publishing the same package at once end with one current row, never a downgrade.

## Observing r-universe

Every 15 minutes `poll()` fetches each universe's records from
`https://{universe}.r-universe.dev/api/packages`, with the build-relevant fields only (`FIELDS` in
`src/poll.ts`: volatile ones such as `_score` would change the digest on every poll). The body is
hashed, not parsed. When its sha256 differs from the universe's newest observation it goes to
`obs/{universe}/dt={YYYY-MM-DD}/{ts}-{digest12}.json`, the current registry's key shape, and a row
into `observations`. A body that reverts to an older observation's digest is archived again and
that row is reset to it, so it is planned and recorded again as the newest.

`observe()` then reads the newest observation back from the bucket. Its records map to
Bioconductor versions by branch (`RELEASE_3_24` is 3.24, `HEAD` is whatever the `bioc` universe
builds) and to repositories by `_bioc[0].repository`. The first call on an observation records its
jobs (below). Each call re-plans from the database, gates each version's records against its
publications across every repository, publishes in dependency order, and tops up binaries a
published version gained since. Source and binary bytes are copied from r-universe's store
(`r2.ropensci.org/{sha256}`). Every step is safe to repeat, so the first backfill is a loop:

```bash
until curl -sf -X POST -H "x-maint-key: …" "https://<worker>/admin/observe?universe=bioc-release&limit=20" \
  | tee /dev/stderr | grep -Eq '"status":"(processed|unchanged)"'; do :; done
```

Run one universe at a time. Each call parses a 30 MB observation, and two calls that land in the
same isolate exceed its memory: both fail with error 1102 (seen on 2026-11-25; the loop above just
retries). Measured on the first backfill with `limit=25`: about 3.5 seconds a package when its
bytes were already stored, 6.5 when they had to be copied.

A candidate whose source bytes are gone keeps `remaining` above 0 (it is retried, and only what
depends on it waits), so watch `failed` rather than loop blindly.

The cron refreshes `config.yaml` when it is a day old, rewrites `versions.json` if it differs,
then polls and observes each universe with a small limit, which covers steady state, and drains
the capture queue. A failed step is logged and does not stop the next; a failed poll still
observes what the last one archived.

Seeding from bioconductor.org was removed (#233). The publications it made (`origin:
"bioconductor"`) stay, and an r-universe build of that version or a newer one still replaces one.

## Build record and capture

`job_runs` holds every build job ever seen, append only: one row per `(builder, universe, job)`,
with the package, version, source sha256, config, R version, verdict, time, artifact id,
Bioconductor version, commit, `_created` as `built_at` and `_expires` as `expires_at`. A newer
commit's failed build, which r-universe shows only in `_failure`, is a row with `failure` true and
its own version and commit. A row is inserted on first sight; afterwards only `last_obs_ts` moves.
`jobs` stays the newest observation's verdict per package and config.

Each new job queues a `log` capture, and a `check` capture when it has an artifact, in the same
transaction (`capture_queue`). `drain()` takes due rows, soonest `expires_at` first, and copies:

- the GitHub Actions job log to `logs/{universe}/{job}.txt` (streamed above 16 MB), and the build
  environment read from it to `builds/{universe}/{job}.json`;
- the check artifact's text entries, fetched by range out of the zip, to
  `checks/{universe}/{job}.json`.

A row whose object is already in the bucket is done without a GitHub call. A job or artifact
gone upstream (404/410 from the API) is `gone`, as is an artifact with no length or a zip that
does not parse. Any other failure, at any hop, a rate limit or a bad token included, stops the
drain: that row waits 15 minutes, doubling per attempt up to a day, and the rest are left for
the next drain. A log GitHub sends without a length is such a failure, not read as text.

A drain leases what it claims for ten minutes, under a token of its own, and writes a row only
while it still holds that lease and the row is pending; a drain that outlives its lease changes
nothing that another drain or `/admin/import-jobs` has since settled.

Every fetch (each redirect hop included) and every R2 call is a subrequest, and Workers Paid
allows 10,000 an invocation (`limits.subrequests` is not set in `wrangler.jsonc`). A drain counts
its own against a budget and stops short of it, releasing the rest of its batch with no attempt
counted (`out_of_subrequests`). The cron counts what refresh, poll and observe spent and gives
the drain the rest, less a margin of 500; by hand the default is 1,500. The cron drains 50 logs and 50 checks a tick, about 400 GitHub API calls an hour,
next to the current registry's ~2,400 on the same token (GitHub allows 5,000).

Capture needs the read-only GitHub token as the Worker secret `GITHUB_TOKEN`; without it the
drain does nothing and says so.

### Backfill from the current registry

Done on 2026-11-26, from an operator's machine (the Worker has no binding to the current
registry's bucket). Kept because every step is safe to repeat: re-run the copy and the import once
more just before the current registry stops, to pick up what it captured in between. `r2:` below is an rclone remote for the Cloudflare
account's R2.

1. Deploy, then `POST /admin/migrate` (0006 adds `job_runs` and `capture_queue`).
2. Copy the current registry's snapshots, captures and history into this bucket, server side:

   ```bash
   for p in obs logs checks builds history; do rclone copy "r2:bioc-prop/$p" "r2:bioc-registry/$p"; done
   ```

   `obs/` comes first: observations recorded before this change point at keys there.
3. Import the job history, marking what was copied as captured:

   ```bash
   rclone lsf -R --files-only r2:bioc-registry/logs > captured.txt
   rclone lsf -R --files-only r2:bioc-registry/checks >> captured.txt
   rclone copyto r2:bioc-registry/history/package_changes.parquet package_changes.parquet
   uv run --with duckdb --with httpx scripts/backfill-jobs.py package_changes.parquet --captured captured.txt --dry-run
   MAINT_KEY=… uv run --with duckdb --with httpx scripts/backfill-jobs.py package_changes.parquet \
     --captured captured.txt --base https://<worker>
   ```

   The key is read from the environment only, never from the command line. `HEAD` jobs get no
   `bioc_version` (the file does not say which version devel was then).
4. Set the GitHub token, so the cron captures what is still pending:

   ```bash
   gcloud secrets versions access latest --secret=cdsci-github-actions-read-token --project=cdsci-infra \
     | tr -d '\r\n' | npx wrangler secret put GITHUB_TOKEN
   ```

## Development

```bash
docker run -d --name regnext-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18
export DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
npm ci
npm test            # each test file creates and drops its own database
npm run typecheck
```

`npm run dev` needs the same URL as
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, and `MAINT_KEY` in `.dev.vars`.

## Operations

Deploys are manual, by the maintainer (`npx wrangler deploy`). The schema is applied by the
Worker itself: `curl -X POST -H "x-maint-key: …" https://<worker>/admin/migrate`.

| Resource | Name |
|---|---|
| Worker | `bioc-registry-next` |
| R2 bucket | `bioc-registry` |
| Hyperdrive config | `bioc-registry-db` (query caching disabled) |
| Database | `bioc_registry`, on the shared PlanetScale Postgres cluster |
| Database URL | Google Secret Manager, `cdsci-bioc-registry-database-url` |
| Maintenance key | Google Secret Manager, `cdsci-bioc-registry-next-maint-key`; the Worker secret `MAINT_KEY` |
| GitHub token (read-only) | Google Secret Manager, `cdsci-github-actions-read-token`; the Worker secret `GITHUB_TOKEN` |

The database answers on the Postgres ports only. A network that blocks outbound 5432 cannot reach
it with `psql`; the Worker always can, through Hyperdrive, and Google Cloud Shell works for
ad hoc SQL.

[Apache License 2.0](LICENSE)
