# bioc-infrastructure

The platform behind the new bioconductor.org: the services that serve the site and the
package repositories, the package registry, the access-log pipeline, and the documentation
and decisions for all of it. The documentation is published at
<https://seandavi.github.io/bioc-infrastructure/>.

## What's here

| Package | What it does | Runs on |
|---|---|---|
| [`packages/registry`](packages/registry) | The package registry: watches r-universe, archives every build observation, decides what propagates (the gate), and serves the result as an API, CRAN-style repositories and a Parquet archive | Cloudflare Worker `bioc-registry`; publisher on GitHub Actions |
| [`packages/edge`](packages/edge) | Serves bioconductor.org: the Worker in front of R2, and the sync that mirrors master's docroot into R2 | Cloudflare Worker `bioc-site`; systemd units on onclappc02 |
| [`packages/traffic`](packages/traffic) | Access logs to Parquet, dashboard rollups, and the download statistics | systemd units on onclappc02 |
| [`packages/health`](packages/health) | A read-only health check across the whole stack | On demand (the `bioc-health` agent skill) |
| [`packages/docs`](packages/docs) | The documentation site and the architecture decision records ([`adr/`](packages/docs/adr)) | GitHub Pages |

Kept in their own repositories, because something about them has to differ
([ADR 0014](https://seandavi.github.io/bioc-infrastructure/adr/0014-one-platform-repo-the-website-build-and-manifest-stay-separate.html)):

- [bioc-website](https://github.com/seandavi/bioc-website): the site's renderer, to be handed to
  the Bioconductor core team. It reads registry data like any other consumer.
- [bioc-build](https://github.com/seandavi/bioc-build): the untrusted build workflows, whose
  identity the registry verifies.
- [bioc-manifest](https://github.com/seandavi/bioc-manifest): the governance trust root, pinned
  by commit.

## Status

**Green means the check ran and its blocking assertions passed, not that there were no
findings.** The one report-only check (accessibility on bioc-website PRs, non-blocking until
its baseline is clean) stays green while carrying findings; its step summary lists them.
Everything else is blocking: red means broken or stale.

| Package | What it watches | Badge |
|---|---|---|
| registry | tests | [![registry / test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-test.yml) |
| registry | daily: Worker up, observations fresh | [![registry / freshness](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-freshness.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-freshness.yml) |
| registry | daily: packages actually install | [![registry / install](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-install.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-install.yml) |
| registry | every 30 min: publish bioc-build results | [![registry / publish](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-publish.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-publish.yml) |
| edge | tests | [![edge / test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-test.yml) |
| edge | daily black-box probe of bioconductor.org | [![edge / health](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-health.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-health.yml) |
| edge | daily parity with master.bioconductor.org, until master retires | [![edge / parity](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-parity.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-parity.yml) |
| traffic | script self-checks | [![traffic / test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/traffic-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/traffic-test.yml) |
| health | collector rules | [![health / test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/health-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/health-test.yml) |
| docs | render and publish | [![docs](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs.yml) |
| docs | `mirror-sync.sh`, the script mirror operators download | [![docs / test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs-test.yml) |
| all | no package reaches into another's source | [![seams](https://github.com/seandavi/bioc-infrastructure/actions/workflows/seams.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/seams.yml) |
| bioc-website | build and deploy to R2 | [![site](https://github.com/seandavi/bioc-website/actions/workflows/site.yml/badge.svg)](https://github.com/seandavi/bioc-website/actions/workflows/site.yml) |
| bioc-website | daily link check of the served site | [![links](https://github.com/seandavi/bioc-website/actions/workflows/links.yml/badge.svg)](https://github.com/seandavi/bioc-website/actions/workflows/links.yml) |

Every workflow, with its trigger and purpose, is listed on the docs site's
[CI page](https://seandavi.github.io/bioc-infrastructure/ci.html).

## Working here

- **One issue tracker.** File issues here, with an `area:<package>` label.
- **Each package stands alone.** It has its own README, tests and CI. A package's workflows
  are `.github/workflows/<package>-<name>.yml` and run only when that package changes.
- **Packages meet only through published data**: documented R2 keys and HTTP artifacts, never
  each other's source. `check-seams.sh` enforces it and the `seams` workflow runs it on every
  change. Consumers of registry data should build on its stable tier
  ([#167](https://github.com/seandavi/bioc-infrastructure/issues/167)).
- **This repository is public, and so is the docs site.** Merging to `main` publishes it. See
  [ADR 0001](https://seandavi.github.io/bioc-infrastructure/adr/0001-public-docs-site-with-a-publication-boundary.html)
  for what must never be written here.

| Package | Tests |
|---|---|
| registry | `cd packages/registry && npm ci && npm test` |
| edge | `cd packages/edge && node --test worker/test.ts && ./test-itemize.sh` (the full list is in its CONTRIBUTING) |
| traffic | `cd packages/traffic && ./download-stats.py --self-check` (each script has `--self-check`) |
| health | `cd packages/health && uv run --python 3.12 --with pytest pytest tests -q` |
| docs | `cd packages/docs && quarto preview` |

## Deploying

| What | How |
|---|---|
| Registry and edge Workers | By hand, by the maintainer: `npx wrangler deploy` from `packages/registry` or `packages/edge/worker`. CI never deploys a Worker |
| edge and traffic units on onclappc02 | They run from an operations clone of `main` at `/data/davsean/bioc-ops/bioc-infrastructure`, never from a development checkout. Deploy: `git -C /data/davsean/bioc-ops/bioc-infrastructure pull`, then restart the affected units |
| Registry publisher | A GitHub Actions cron; its secrets are in the `registry` environment, available to `main` only |
| Docs site | Automatic, on every push to `main` that touches `packages/docs` or a workflow |

## History

Until 2026-11-01 the registry, edge and traffic were separate repositories:
`seandavi/bioc-registry`, `seandavi/bioc-edge` and `seandavi/bioc-traffic`, now archived. Their
history was carried into `packages/`. Their open issues moved here; the old→new numbers are in
[`packages/docs/adr/0014/issue-map.tsv`](packages/docs/adr/0014/issue-map.tsv). Closed issues
remain readable in the archived repositories.

## License

- Code in `packages/registry`, `packages/edge` and `packages/traffic`: [Apache 2.0](packages/registry/LICENSE),
  in each package's `LICENSE`.
- The documentation in `packages/docs`: [CC BY 4.0](packages/docs/LICENSE).

[Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md)
