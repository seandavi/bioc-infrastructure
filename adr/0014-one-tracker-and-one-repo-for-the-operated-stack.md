# 0014 — One issue tracker, and one repo for the operated stack; build, manifest and registry stay separate

- **Status:** Proposed
- **Date:** 2026-10-16
- **Revisits:** [ADR 0008](0008-three-repos-and-a-strangler-migration.md) (repo layout only; its
  strangler migration stands) and [ADR 0010](0010-two-new-repos-for-the-build-system-and-the-manifest-name.md)
  (one argument corrected below)

## Context

The new stack is eight public repos under `seandavi/`. The download-stats fix of 2026-10-16
([#114](https://github.com/seandavi/bioc-infrastructure/issues/114)) touched four of them and
four issue trackers to change one thing: bioc-traffic generates and uploads the `.tab` files,
bioc-edge serves them, and this repo holds the docs and the health check. Three of the session's
problems came from the boundaries rather than the code:

- **The R2 key layout between bioc-traffic's uploader and bioc-edge's `statsKey()` was written
  down only in the instructions given to the two people (here, agents) changing each side.** A
  gap in it (the `<cat>.html` listing pages) was found by one side after the other had shipped
  against the incomplete version. Nothing tests the two sides against each other.
- **An issue sat in the wrong tracker.** bioc-registry#26 said statistics would be generated
  there; the work happened in bioc-traffic#11, and two pages of this site repeated the wrong
  owner until they were corrected.
- **bioc-traffic has no CI.** Its `--self-check` runs only by hand, so a rebase that broke it
  reached a pushed branch before anyone ran it.

ADR 0008 considered one monorepo and rejected it for three reasons. Each is a premise that can
be checked, and on 2026-10-16 none of them held:

| ADR 0008's premise | Measured 2026-10-16 |
|---|---|
| This repo is private; the repo boundary is the public/private boundary | All eight repos are public. [ADR 0001](0001-public-docs-site-with-a-publication-boundary.md)'s publication boundary is kept by review again |
| Community contributors would share a tree with operational secrets, and fork-PR CI would run near credentials | Every repo has 0 forks, and every merged PR has one author. Community prose PRs land upstream in `Bioconductor/bioconductor.org`, which bioc-website snapshots; they never touch these repos |
| Site governance (Bioconductor org) and operations want different owner sets | bioc-website is under `seandavi/`, not the Bioconductor org, with the same single owner as the rest |

Actions secrets exist in two repos only: bioc-website (3) and bioc-registry (4). The other six
hold none.

What does still separate the repos is **coupling**. Counting references to another repo's
issues in commit messages since 2026-08-15 (pattern
`(seandavi/)?bioc-(infrastructure|edge|traffic|website|registry|manifest|build|intelligence|cloudflare)#[0-9]+`,
excluding a repo's own name; commit messages only, so PR bodies, issue comments and URL links
are not counted):

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

The first four change together. The last three do not.

One argument in ADR 0010 needs correcting: it says bioc-registry's "name is its public URL".
The public URL comes from the Worker's `name` in `wrangler.jsonc`, not from the repo name;
bioc-edge already deploys a Worker named `bioc-site`. A repo name does not bind a URL.

## The seams that stay

The repos that stay separate do so because something outside the repo **binds to the repo's
identity**, or because nothing couples them. Each seam, what crosses it, and what binds it:

| Seam | What crosses it | What binds it today | What merging would cost |
|---|---|---|---|
| **manifest → build** | `manifest_ref`, a 40-hex commit of bioc-manifest | bioc-build `build-package.yml` (`manifest_ref` input, resolved to `manifest_commit`) | In a shared repo every unrelated commit moves the SHA, so a new `manifest_commit` would no longer mean "the manifest changed". Provenance records lose that meaning |
| **manifest → registry** | `packages/<pkg>.yaml` at that commit | bioc-registry `src/index.ts` fetches `raw.githubusercontent.com/seandavi/bioc-manifest/<commit>/packages/<pkg>.yaml`; `scripts/publish.sh` names the repo | The repo path is in code in two repos; moving it is a coordinated change |
| **build → registry** | A GitHub Actions artifact from one `build.yml` run, plus its build-provenance attestation | bioc-registry `publish.yml` runs `gh attestation verify` against bioc-build's repo and workflow identity | The repo that holds untrusted build workflows must not also hold R2 write secrets. The attestation identity *is* the repo; this seam cannot move into a shared repo |
| **registry → build** | `state/bioc-build/attempts.json` over HTTP | bioc-build `dispatch.yml` reads it from `bioc-registry.seandavi.workers.dev` | None: an HTTP artifact under the [data-plane contract](https://github.com/seandavi/bioc-registry/blob/main/docs/DATAPLANE.md) |
| **registry → website, edge** | Propagated-package data for the site snapshot's `/next/` pages; later, the software repositories ([registry switch](../registry-switch.qmd)) | HTTP artifacts only; no bioc-edge code reads the registry today | Its 4 secrets would sit beside bioc-website's 3 unless scoped by GitHub environment. 0 measured coupling, so nothing is gained yet |

**The manifest's trust boundary is a convention today.** bioc-manifest has no `CODEOWNERS`, no
branch protection and no rulesets, and one collaborator. Its write set is the same as every
other repo's. What a separate repo still buys is the ability to make that boundary structural
later: GitHub grants write access per repo, not per path, so Bioconductor reviewers can be
given the manifest without being given the Workers, and branch protection there constrains only
the trust root. A path inside a shared repo can require a code-owner review, but anyone with
write access to the repo can still merge, and the pins above lose their meaning.

## Decision (proposed)

**1. One issue tracker: this repo, now.** Every issue for edge, traffic, website, registry,
manifest, build and the docs is filed here, with an `area:<repo>` label. Code repos keep their
pull requests, which reference issues here (`Refs seandavi/bioc-infrastructure#N`). Open issues
in the other repos are transferred; issues are then turned off there. This is cheap and
reversible, and it fixes the misplaced-issue problem on its own.

**2. One repo for the operated stack, after [bioc-traffic#28](https://github.com/seandavi/bioc-traffic/issues/28) lands.**
bioc-edge, bioc-traffic and bioc-website move into this repo as `packages/edge`,
`packages/traffic` and `packages/website`, beside the docs and `health/`, with their history
kept (`git filter-repo` into a subdirectory, then merged). The old repos are archived with a
pointer. These four run on one host, deploy to one Cloudflare account, share one R2 bucket, and
reference each other's issues; one PR can then change a producer and its consumer together, and
a contract test can hold the two sides of a seam like the stats key layout.

**3. Separate repos, unchanged:**

- **bioc-build** — the untrusted build identity. The attestation that bioc-registry verifies
  names this repo and workflow; it holds no secrets and must not share a tree with anything
  that does.
- **bioc-manifest** — the governance trust root, pinned by commit from build and registry.
  Kept separate so its write access and branch protection can differ from everything else.
- **bioc-registry** — the trusted writer for the build system, with its own Worker, Workflow,
  bucket and secrets, and no measured coupling to the operated stack. Revisit when the registry
  switch makes bioc-edge serve its repositories.
- **bioc-intelligence** — an unrelated enrichment pipeline.

## Which fix addresses which problem

| Problem seen | Single tracker | Operated-stack monorepo | Cheaper fix without either |
|---|---|---|---|
| Issue in the wrong tracker (bioc-registry#26) | yes | — | — |
| R2 key contract known only to the agents | — | yes: one PR, a contract test | document the keys as an API (data-plane contract rule 2) |
| bioc-traffic has no CI | — | yes: shared CI | a ten-line workflow running `--self-check` |
| A worktree created in the wrong repo | — | partly: fewer repos to choose from | — |

The monorepo is not required for every fix. Its value is that cross-cutting changes stop being
multi-repo by default.

## Consequences

- **Host plumbing moves with the code.** On onclappc02: unit files symlinked from the
  bioc-traffic checkout (16) and the `bioc-site-refresh` clone of bioc-website (4), and
  `ExecStart` paths into the bioc-edge (10) and bioc-traffic (11) checkouts. Each is repointed
  in the same change that moves its package, and the units are restarted one at a time.
- **Notifier and health check.** bioc-edge's failure notifier files issues in bioc-edge, and
  the health collector reads issues per repo; both are repointed at this repo with step 1.
- **CI per package.** Workflows move with path filters (`packages/edge/**` and so on). The docs
  deploy (`docs.yml`) is filtered to the docs. bioc-website's 3 secrets move into GitHub
  environments so that only its deploy job can read them.
- **Transferred issues.** Before transferring in bulk, transfer one and confirm that its
  comments survive and that the old URL redirects. Cross-repo `#N` references in old commit
  messages keep pointing at the archived repos.
- **The manifest's protection** is set up as a follow-up whatever is decided here: branch
  protection on `main` and a `CODEOWNERS` file, so the trust root is enforced rather than
  conventional.
- **DATAPLANE.md's producer table is stale** (it names a private infra repo for download
  statistics and `bioconductor-website` for site data). Correct it in bioc-registry as a
  follow-up.
- **Rollback.** Step 1 is reversed by transferring issues back. Step 2 is reversed by
  unarchiving the old repos; history is kept on both sides.

## Alternatives considered

**Everything in one repo.** Rejected: bioc-build's untrusted identity cannot share a tree with
R2 secrets, and the manifest loses both its separate write access and the meaning of its
commit pin.

**Status quo, plus a GitHub Project board across repos.** One view of the issues without moving
them. Cheaper than step 1, but issues still have to be filed in the right repo, which is the
mistake seen here; and it does nothing for contract tests.

**Merge bioc-registry into the operated-stack repo as well.** Not now: 0 measured coupling,
and its secrets would share the repo with bioc-website's. The registry switch is the point to
revisit, because that is when bioc-edge starts serving what the registry publishes.

## Open questions

- The combined repo's name. `bioc-infrastructure` is the existing coordination surface and
  docs site; keeping its name avoids moving the docs URL.
- Whether `health/` becomes `packages/health` for symmetry.

## Wayfinding

Discussion: the issue that links this ADR's pull request. Session evidence: #114,
bioc-traffic #26, #28, #29, #30, bioc-edge #66.
