# 0014 — One platform repo; the website, build and manifest stay separate

- **Status:** Proposed
- **Date:** 2026-10-16, revised 2026-10-30
- **Revisits:** [ADR 0008](0008-three-repos-and-a-strangler-migration.md) (repo layout only; its
  strangler migration stands) and [ADR 0010](0010-two-new-repos-for-the-build-system-and-the-manifest-name.md)
  (one argument corrected below)

## Context

The new stack is eight public repos under `seandavi/`. Two kinds of problem come from that
layout.

**For the maintainer, changes cross repo boundaries.** The download-stats fix of 2026-10-16
([#114](https://github.com/seandavi/bioc-infrastructure/issues/114)) touched four repos and
four issue trackers to change one thing. The R2 key layout between bioc-traffic's uploader and
bioc-edge's `statsKey()` was written down only in the instructions given to the agents changing
each side, and nothing tested the two against each other. An issue sat in the wrong tracker
(bioc-registry#26 said statistics would be generated there; the work happened in
bioc-traffic#11). The build-results tracking issue of 2026-10-30
([#128](https://github.com/seandavi/bioc-infrastructure/issues/128)) had to link issues in three
trackers.

**For the core team, it is unclear what does what.** In
[#123](https://github.com/seandavi/bioc-infrastructure/issues/123), the questions were whether
build products sync automatically and whether symlinks are generated or manual. The answers
differed between the old and new systems. That confusion is about tasks ("what is mine on
release day"), not about where code lives, and no repo layout fixes it on its own. What the
layout can do is make the platform one thing that works, which a task-shaped start page then
describes.

The two problems point the same way. The core team wants the website: what pages say and look
like is theirs, and they already edit the content in `Bioconductor/bioconductor.org`. They do
not need to work on the Workers, the log pipeline or the registry; they need those to work, and
to consume the registry's data. So the split is by **who changes it**: the website is the core
team's product; everything that makes it and the package repositories work is one platform,
maintained together.

### What ADR 0008's objections were, and what holds now

ADR 0008 rejected one monorepo for three reasons. On 2026-10-16 none of them held:

| ADR 0008's premise | Measured 2026-10-16 |
|---|---|
| This repo is private; the repo boundary is the public/private boundary | All eight repos are public. [ADR 0001](0001-public-docs-site-with-a-publication-boundary.md)'s publication boundary is kept by review again |
| Community contributors would share a tree with operational secrets, and fork-PR CI would run near credentials | Every repo has 0 forks, and every merged PR has one author. Community prose PRs land upstream in `Bioconductor/bioconductor.org`; they never touch these repos |
| Site governance and operations want different owner sets | True **for the website only**, from 2026-10-30: it goes to the core team (below). The platform repos keep one owner |

Actions secrets exist in two repos only: bioc-website (3: an R2 key for the whole `bioc-site`
bucket) and bioc-registry (4). The other six hold none.

### Coupling

References to another repo's issues in commit messages since 2026-08-15 (pattern
`(seandavi/)?bioc-(infrastructure|edge|traffic|website|registry|manifest|build|intelligence|cloudflare)#[0-9]+`,
excluding a repo's own name):

| Repo | Commits | References to other repos' issues |
|---|---|---|
| bioc-infrastructure | 107 | 13 |
| bioc-website | (refresh clone) | 17 |
| bioc-traffic | 17 | 5 |
| bioc-edge | 44 | 4 |
| bioc-manifest | 4 | 2 |
| bioc-registry | 41 | 0 |
| bioc-build | 61 | 0 |
| bioc-intelligence | 58 | 0 |

The October 16 draft kept bioc-registry out on its 0. That count is commit messages only and is
already out of date in substance: the website's `/next/` pages read the registry, the registry
switch makes it the source of the package pages, and the October 30 work (the propagation gate
vs what bioconductor.org serves; build results for BiocBuildReporter) sits on the registry's
seams with the edge and the website. Nothing binds to the registry's *repo* name: bioc-build's
dispatch and Rprofile reach it by the Worker's URL (`bioc-registry.seandavi.workers.dev`), and
the registry polls bioc-build on its own cron and verifies bioc-build's attestation, not its own.

One argument in ADR 0010 needs correcting: it says bioc-registry's "name is its public URL".
The public URL comes from the Worker's `name` in `wrangler.jsonc`, not from the repo name;
bioc-edge already deploys a Worker named `bioc-site`.

## Decision (proposed)

**1. One platform repo: this one.** bioc-registry, bioc-edge and bioc-traffic move in as
`packages/registry`, `packages/edge` and `packages/traffic`, beside the docs, `health/` and the
host automation (systemd units, refresh and sync scripts), with their history kept
(`git filter-repo` into a subdirectory, then merged). The old repos are archived with a pointer.
This repo's tracker is the one tracker for all of it, with `area:<package>` labels; issues are
turned off in the archived repos.

**2. bioc-website stays separate and goes to the core team.** It is a consumer: it renders
content from `Bioconductor/bioconductor.org` and data from the platform, and publishes builds.
It keeps its own tracker, because that is where its people work. Before anyone else gets write
access, its credentials are narrowed (Consequences).

**3. Separate, unchanged:**

- **bioc-build**: the untrusted build identity. The attestation that the registry verifies names
  this repo and workflow; it holds no secrets and must not share a tree with anything that does.
- **bioc-manifest**: the governance trust root, pinned by commit from build and registry. Kept
  separate so its write access and branch protection can differ from everything else, and so a
  new `manifest_commit` still means "the manifest changed".
- **bioc-intelligence**: an unrelated enrichment pipeline.

## The seams, and what keeps them clear

A shared tree makes it easy for one package to reach into another's internals. The seams are
kept by mechanism, not by repo boundaries:

- **No source imports between packages.** Packages meet only through R2 keys and HTTP artifacts
  that are documented. A CI check fails a PR in which one package imports another's source.
- **A contract test per seam**, run in the PR that changes either side: the stats key layout
  (traffic → edge), the registry's published shapes against the website's loaders
  (`astro/src/lib/prop.js`), the route table and site pointer (website → edge).
- **The registry's data surface is declared in two tiers.** People consuming registry data is
  the goal, so all of it stays readable; what changes is the promise.
  - **Stable:** `prop/<universe>/index.json`, the export in BiocBuildReporter's shape
    (bioc-registry#72) and the documented API routes (`/pkg`, `/logs`, `/checks`, `/builds`,
    `/repo`). Versioned schema in `DATAPLANE.md`; changes announced.
  - **Raw:** `obs/`, `parquet/jobs/`, and everything else under `/data/<r2-key>`. Public and
    queryable (`/sql`, DuckDB), layout may change without notice.
  The website, BiocBuildReporter and biocUniTools build on the stable tier.

| Seam | What crosses it | After this decision |
|---|---|---|
| manifest → build | `manifest_ref`, a 40-hex commit of bioc-manifest | Unchanged (both separate) |
| manifest → registry | `packages/<pkg>.yaml` fetched from `raw.githubusercontent.com/seandavi/bioc-manifest/<commit>/` | Unchanged: the URL names the manifest repo, which does not move |
| build → registry | A GitHub Actions artifact plus its build-provenance attestation, verified by `publish.yml` against bioc-build's identity | Unchanged: `publish.yml` moves with the registry and still verifies bioc-build |
| registry → build | `state/bioc-build/attempts.json`, the `/repo` CRAN repositories | Unchanged: HTTP, by Worker URL |
| traffic → edge | Stats files and their R2 key layout | Inside the platform repo, held by a contract test |
| registry → edge | The software repositories, at the [registry switch](../registry-switch.qmd) | Inside the platform repo, held by a contract test |
| registry → website | The stable tier | Across repos, held by the declared schema and a contract test against fixtures |
| website → edge | Builds under `site/<build>/`, the `site/latest` pointer | Across repos; the website writes only its own bucket, the edge owns the route table |

## Consequences

- **The website's credentials are narrowed before the handover.** Today its R2 key can write the
  whole `bioc-site` bucket: the master mirror, `_routes.json` and `_symlinks.json`, and its
  preview step runs `aws s3 sync --delete`. Site builds and previews move to their own bucket
  ([#70](https://github.com/seandavi/bioc-infrastructure/issues/70)), the website's key is scoped
  to it, and the edge reads builds from there. This is a precondition for granting write access
  to bioc-website.
- **Secrets are scoped per package.** The registry's 4 secrets move into a GitHub environment that
  only its publish and deploy jobs can read. Workflows move with path filters
  (`packages/registry/**` and so on); the docs deploy (`docs.yml`) is filtered to the docs.
- **Host plumbing moves with the code.** On onclappc02: unit files symlinked from the
  bioc-traffic checkout (16) and the `bioc-site-refresh` clone of bioc-website (4), and
  `ExecStart` paths into the bioc-edge (10) and bioc-traffic (11) checkouts. Each is repointed in
  the same change that moves its package, and the units are restarted one at a time. This is
  also the point to separate ops checkouts from dev checkouts
  ([#43](https://github.com/seandavi/bioc-infrastructure/issues/43)).
- **Notifier and health check.** bioc-edge's failure notifier files issues in bioc-edge, and the
  health collector reads issues per repo; both are repointed at this repo.
- **Transferred issues.** Before transferring in bulk, transfer one and confirm that its comments
  survive and that the old URL redirects. Cross-repo `#N` references in old commit messages keep
  pointing at the archived repos.
- **The registry's public routes and Worker URL do not change.** Consumers (bioc-build, the
  website, BiocBuildReporter, bioc-mcp) need no changes.
- **The manifest's protection** is set up as a follow-up whatever is decided here: branch
  protection on `main` and a `CODEOWNERS` file, so the trust root is enforced rather than
  conventional.
- **DATAPLANE.md's producer table is stale** (it names a private infra repo for download
  statistics and `bioconductor-website` for site data). Correct it when it moves.
- **A task-shaped start page for the core team** ("on release day, these steps are yours and
  these are automatic"; "why isn't package X available"; "where do build results go") is written
  alongside, because it, not the layout, answers #123.
- **Rollback.** Unarchive the old repos; history is kept on both sides. A package can be
  extracted again with `git filter-repo` if it ever needs a different owner set.

## Order

1. Narrow the website's credentials (#70). Declare the registry's two tiers.
2. One tracker: transfer platform issues here with `area:` labels, starting with one as a test.
3. Move bioc-traffic and bioc-edge, with the stats contract test.
4. Move bioc-registry, with the no-imports check, its environment and the website contract test
   in place first.
5. Hand bioc-website to the core team.

## Alternatives considered

**Operated stack only (edge, traffic, website), registry separate.** The October 16 draft.
Superseded: it would put the core team's product in a tree with the production Worker and the
log pipeline, and give write access to both; and it leaves the registry's seams with the edge
and website across repo boundaries just as they start to carry the package pages.

**Everything in one repo.** Rejected: bioc-build's untrusted identity cannot share a tree with R2
secrets, and the manifest loses both its separate write access and the meaning of its commit pin.

**Status quo, plus a GitHub Project board across repos.** One view of the issues without moving
them. Issues still have to be filed in the right repo, which is the mistake seen, and it does
nothing for contract tests.

## Open questions

- Whether `health/` becomes `packages/health` for symmetry.
- Which GitHub org bioc-website lives under once it is handed over.

## Wayfinding

Discussion: [#119](https://github.com/seandavi/bioc-infrastructure/issues/119). Evidence: #114,
#123, #128, bioc-traffic #26, #28, #29, #30, bioc-edge #66.
