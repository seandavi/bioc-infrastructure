# bioc-registry-next

The next registry, built beside the current one ([`packages/registry`](../registry)) and
running as a shadow until it replaces it. Design and plan:
[#213](https://github.com/seandavi/bioc-infrastructure/issues/213).

**Status: shadow.** Nothing reads from it yet. The current registry keeps serving
`bioc-registry.seandavi.workers.dev` and is not changed by anything here.

What differs from the current registry:

- **State is in Postgres** (PlanetScale, through Cloudflare Hyperdrive), not in JSON objects that
  several code paths read, change and write back. A publication is one transaction.
- **R2 holds bytes and published files only**: `cas/{sha256}` for every artifact, and the
  repository indexes written from the database. Readers still need nothing but HTTP.
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
| `src/testdb.ts` | a fresh migrated database per test file |
| `src/*.test.ts` | `node:test` suites; database tests need `DATABASE_URL` |

## API

The OpenAPI document at `/openapi.json` is generated from the route definitions. Public routes
send `access-control-allow-origin: *`. `{bioc_version}` is a number (`3.24`) or `release` /
`devel`, resolved through the `bioc_versions` table.

| Route | What |
|---|---|
| `POST /gate` | Read-only: would these candidates propagate, and if not why. Body `{bioc_version, repo, candidates, config?}`; same decision and response shape as the current registry's `/gate`. `config.gating_r` defaults to the version's R line; 400 when the version is unknown and none is given. |
| `GET /api/v1/packages/{bioc_version}/{repo}/{package}` | One package in `bioc`, `data/annotation`, `data/experiment` or `workflows`: its current publication, history and latest gate decisions. 404 if never published there. |
| `GET /api/v1/cas/{sha256}` | One stored object and every publication that references it, as source or binary. |
| `POST /admin/migrate` | Applies pending migrations. Needs `x-maint-key`. |

### Repository files

`materialize(bucket, sql, bioc_version, repo)` writes, under `packages/{bioc_version}/{repo}/`:
`src/contrib/` and every `bin/windows/contrib/{r}/` and `bin/macosx/{dir}/contrib/{r}/` that has a
binary (`PACKAGES`, `PACKAGES.gz`, `PACKAGES.rds`), `VIEWS` and `index.json`.
`materializeVersions` writes `packages/versions.json`:
`{ release, devel, versions: { "3.24": { r_minor, role } } }`. An object is written only when its
md5 differs from the stored etag, so unchanged files keep their etag. The files are never edited
by hand and never read back to decide anything.

`index.json` is an object keyed by package name; each value is the package's current `RepoRow`
(`src/store.ts`): `publication_id`, `package`, `version`, `origin`, `bioccheck`, `archs`,
`published_at`, `description`, `files`, `meta`, `git_url`, `git_branch`, `git_commit`,
`git_commit_at`, `source` and `binaries` (each with `os`, `r_minor`, `arch`, `distro`,
`filename`, `sha256`, `md5`, `size_bytes`). Fields may be added; none will be renamed.

`GET`/`HEAD /packages/{version}/{repo}/…` serves them, `version` being a number or
`release`/`devel`. Index files come from R2 as stored (`etag`, 304 on `if-none-match`, five
minutes of cache). A package file name is resolved through `index.json` to `cas/{sha256}` and
streamed, with `Range` support and an immutable cache header.
`src/contrib/Archive/{package}/{package}_{version}.tar.gz` serves a superseded source and is
the one route that queries the database.

Publishing over HTTP is not here yet. `publish()` in `src/store.ts` takes a per-package lock,
re-checks the version rule against the current row, and supersedes it, all in one transaction.
Two producers publishing the same package at once end with one current row, never a downgrade.

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

[Apache License 2.0](LICENSE)
