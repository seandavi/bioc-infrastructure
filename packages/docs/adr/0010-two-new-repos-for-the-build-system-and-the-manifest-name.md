# 0010 — Two new repos for the parallel build system; the governance file is the manifest, not a registry

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

A standalone build system for the packages r-universe will not build (data-experiment,
data-annotation, workflows — see the [size audit](../data-packages-in-r-universe.qmd)) is
being designed as a set of component specs, drafted in
[bioc-build/specs](https://github.com/seandavi/bioc-build/tree/main/specs). The specs describe
a modular estate: a human-governed list of authorized packages and a policy file; untrusted
build workflows on GitHub Actions; a single trusted publisher that verifies, stores, and
serves; and an event archive. Each seam is a file in git, an object in R2, or an event
record. No component calls another's code.

[ADR 0008](0008-three-repos-and-a-strangler-migration.md) already split the estate by
audience into three repos plus this one, and bioc-registry's `DATAPLANE.md` already states
the same seam discipline. So the question was not "what architecture" but "which of the
specs' components already have a home, which need one, and what are they called."

Three facts shaped the answer:

1. **The publisher's upload service authorizes by OIDC claim**: exact repository plus
   workflow path. Everything in the repo that holds the build workflows runs as the
   untrusted identity. The maintainer self-test is a reusable-workflow reference, which is a
   repo path by construction.
2. **The governance files are what the publisher checks builds *against*.** They cannot sit
   in the untrusted build repo, and they are reviewed by Bioconductor people through
   CODEOWNERS, so they do not belong inside a TypeScript Worker repo.
3. **Two names collide.** The specs call the governance list "the registry", but
   [bioc-registry](https://github.com/seandavi/bioc-registry) is the live data plane — the
   propagation gate, content-addressed store, served repository, Parquet archive, and HTTP
   API — and its name is its public URL. The specs use `bioc-builder` as the system and org
   name; a dead 2019 repo under the same owner already holds that name, and the Bioconductor
   org has BBS, BiocPropagate, packagebuilder and bioc2u-builder, so "builder" is a crowded
   word there too.

## Decision

**Two new repos, both small. Everything else already exists.**

| Repo | Role | Trust domain | Status |
|---|---|---|---|
| bioc-infrastructure | docs, ADRs, coordination status | none | exists |
| **bioc-manifest** | one YAML per authorized package, the policy file, validation CI | trust root; changes by human PR | **new** |
| **bioc-build** | reusable build and self-test workflows; the component specs while they are drafted | untrusted; public; holds no secrets | **[created 2026-09-03](https://github.com/seandavi/bioc-build)** |
| bioc-registry | presign service, publisher, dispatcher, gate, store, serving, API | trusted writer | exists; grows |
| bioc-website, bioc-edge | unchanged | | exist |

**The governance list is called the manifest.** That is the word Bioconductor already uses
for exactly this role — the list of packages the build system is authorized to build for a
release — and the spec's founding content is imported from the existing manifests. Fields
rename with it: `registry_commit` becomes `manifest_commit`. bioc-registry keeps its name; it
is a registry in the sense every package ecosystem uses the word.

**The build repo is `bioc-build`, under `seandavi/` like the other four.** The 2019
`bioc-builder` repo is archived. No new GitHub org.

**Schemas live with the repo that enforces them.** Manifest and policy schemas in
bioc-manifest; ledger and event schemas in bioc-registry. The specs are drafted in bioc-build
so that their revisions do not land in this repo's history; decisions they settle are
recorded here as ADRs.

**The Workers in the specs (upload service, publisher, dispatcher, event ingest) land in
bioc-registry**, which already holds the R2 bindings and already implements the gate, the
store and the serving layer. R2 prefixes stay the contract inside it.

## Consequences

- The specs are edited to use these names and to say which components bioc-registry already
  provides rather than re-specifying them. That is a spec change, not a code change.
- bioc-registry's publisher budget in the specs (≲ 2k lines) is measured against what is
  added, not the whole Worker.
- `bioc-r-universe-build-db` is a record-only historical archive of r-universe builds, using
  a git data branch as storage. It is not a data-plane producer and is left to be archived;
  bioc-registry's observation archive is the live record.
- This repo remains the coordination surface: roadmap milestones, umbrella issues, and
  [issue #11](https://github.com/seandavi/bioc-infrastructure/issues/11), which explains the
  component split to the Bioconductor core team.
