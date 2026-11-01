# 0008 — Split by audience into three repositories; migrate by strangling behind the Worker

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

This project is about to change shape. Until now it has mirrored a site someone else builds:
one bash script pulls the docroot the upstream build system produces, and the Worker serves the
result. Ownership of both the website and the interface to the package build system is moving
here soon. That changes the question from "how do we mirror faithfully" to "where does each
piece live and who changes it."

Three things with different audiences and different change rates are currently fused into one
docroot by the upstream nanoc build:

1. **Content** — markdown pages, events and courses YAML, news. Changed by community pull
   request; being publicly editable is the point.
2. **Data** — package landing pages, check results, download statistics. Changed nightly or
   continuously, by machines, and not produced by the site generator at all: separate upstream
   pipelines deposit them into the same docroot, which is why a nightly data refresh means
   resyncing a website — and why replacing them needs new templates, not a port of existing
   ones.
3. **Operations** — the serving Worker, storage, request logging, monitoring, runbooks. Changed
   rarely, by one operator, and carrying exactly the specifics [ADR 0001](0001-public-docs-site-with-a-publication-boundary.md)
   exists to keep off the public record.

The future data source sharpens the split: check results and landing-page data will come from
the r-universe/bioc-prop-experiment build system rather than from files the site build bakes
in. A planned redesign (Astro replacing nanoc) and a desire for a real test/dev tier land at
the same time. Deciding the layout once, before four things get wired four different ways, is
the cheap moment — the same reasoning as `DATAPLANE.md`.

One more force: the publication boundary is currently enforced by review — every edit to
`docs/` is checked against "does this name a bucket or a token." Discipline that lives in
review erodes; the 2026-08 redaction commits are the evidence.

## Decision

**Three repositories, split by audience, where the repository boundary is the public/private
boundary.**

- **The site repo** (public, under the Bioconductor org): the Astro application, markdown
  content, events/courses YAML, page templates, and the public-safe documentation. Community
  PRs land here. Per-PR preview deployments come from here.
- **The data-plane repo** (public code, private configuration): pipelines that turn build-system
  output into versioned, normalized artifacts — package metadata, check results, statistics
  aggregates. Scheduled ingestion, not site builds. Credentials live in deployment
  configuration, never in-repo, so fork PRs run CI without touching them.
- **This repo** (private): the serving Worker, routing, storage and logging operations,
  monitoring, runbooks, and the ADRs that carry operational specifics.

A page is **rendered by change rate, not uniformly**: content pages are statically built
(they change by PR); landing pages and check pages render from data-plane artifacts at request
time (they change nightly, across tens of thousands of pages — a nightly full static rebuild
would be the nanoc architecture re-implemented in Astro).

**Migration is a strangler behind the Worker**, which already fronts every request: each path
prefix routes to either the legacy mirror or the new system, flipped one route at a time with
instant rollback. Nanoc and Astro never need to agree on anything. The ordering:

1. **Cut over serving first.** The prerequisites [ADR 0003](0003-request-logging-after-the-cloudflare-cutover.md)
   set are met; the cutover is orthogonal to the redesign and puts every later step behind a
   front door this project controls.
2. **Move the site build into CI**, pushing built output to storage directly — removing the
   origin-host rsync dependency for content and replacing the first systemd timer with a
   serverless equivalent.
3. **Stand up the data plane** on the scheduled-execution machinery [ADR 0007](0007-cloudflare-workflows-for-the-release-roll-guard.md)
   piloted; retire the checkResults rsync. Because the site generator never built these pages,
   their renderer is new work: the first data-driven slice of the new templates co-delivers
   with the artifacts rather than waiting for the redesign.
4. **Redesign route by route**, flipping Worker routes as Astro pages land.
5. **Retire the sync host** from the pipeline. Archival releases are already static in the
   bucket ([ADR 0006](0006-old-releases-and-their-checkresults-are-archival.md)); when content
   comes from CI and data from scheduled ingestion, nothing periodic remains that must run on
   one particular machine.

The dev tier is the existing staging hostname bound to `main`, plus per-PR previews from the
site repo — three tiers (preview → staging → production) with no new infrastructure.

## Consequences

- The publication boundary becomes structural. Nothing in a public repo needs redacting,
  because the private repo is where private things live. ADR 0001's review discipline shrinks
  to "which repo does this belong in."
- Public-safe documentation moves to (or is mirrored into) the site repo, which also resolves
  the currently broken docs deploy — this repo went private and its Pages site with it.
- Three repos means cross-repo coordination: a template change in the site repo can depend on
  an artifact-shape change in the data plane. Versioned artifacts with additive evolution are
  the contract; a breaking artifact change is a two-repo PR, which is the honest cost of the
  boundary.
- Rendering from artifacts at request time makes the data plane's availability part of the
  serving path for those routes. Mitigated by serving from the last-good artifact — the same
  property the static mirror has today.
- Each strangler flip is small and reversible, but the route table becomes real operational
  state in the Worker: it needs to be visible, tested, and boring.
- The sync host outlives its pipeline role only as long as phases 2–3 take; its 453 GB mirror
  stops being load-bearing once the bucket plus upstream are the sources of record.

## Alternatives considered

**One monorepo.** Simplest coordination, one CI. Rejected: community contributors and
operational secrets in one tree re-creates the redaction problem at PR scale, fork-PR CI with
credentials present is a standing hazard, and site governance (Bioconductor org) and ops
control do not want the same owner set.

**Two repos — site and data plane merged.** Viable start; fewer moving parts. Rejected as the
target because the site repo's CI becomes a mix of "build pages" and "run credentialed
ingestion," and the build-system interface is expected to grow into a real system once owned.
Starting merged and splitting later is cheap, so this remains the fallback if the data plane
stays trivially small.

**Static-generate everything, no request-time rendering.** One deployment artifact, no runtime
data dependency. Rejected: tens of thousands of nightly-churning pages force either full
nightly rebuilds (the current architecture's defining cost) or incremental-build machinery more
complex than rendering from an artifact.

**Keep nanoc.** Not a real candidate — the redesign is wanted on its own merits — but noted:
nothing in this layout depends on Astro specifically; the split would be the same with any
generator.

## Wayfinding

Tracking issue: [#82](https://github.com/seandavi/bioc-cloudflare/issues/82). Phases:
[#76](https://github.com/seandavi/bioc-cloudflare/issues/76) cutover ·
[#81](https://github.com/seandavi/bioc-cloudflare/issues/81) repo layout ·
[#77](https://github.com/seandavi/bioc-cloudflare/issues/77) site build in CI ·
[#78](https://github.com/seandavi/bioc-cloudflare/issues/78) data plane ·
[#79](https://github.com/seandavi/bioc-cloudflare/issues/79) Astro route-by-route ·
[#80](https://github.com/seandavi/bioc-cloudflare/issues/80) retire the sync host.
