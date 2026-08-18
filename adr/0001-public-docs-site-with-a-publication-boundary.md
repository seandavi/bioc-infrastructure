# 0001 — The docs site is public, with a publication boundary

- **Status:** Superseded by [ADR 0008](0008-three-repos-and-a-strangler-migration.md) and by this
  repo's extraction into a public repository of its own
- **Date:** 2026-08-04

::: {.callout-note}
## Superseded — what survives

0001's *mechanism* — one private repo, a public Pages site, and a Quarto render-list excluding
`agents/` and `adr/` — is replaced by a repo-boundary mechanism: public-safe content lives in a
public repo by construction, rather than being selectively excluded from render inside a private
one. These ADRs render because they are here.

0001's **four-category test still governs** what may cross into a public repo: credentials and the
paths that point at them, internal hosts and private ops config, named attribution of individuals'
informal remarks, and anything received in confidence. It was applied file-by-file when this repo
was extracted. What moves is the enforcement point — from render-list-and-review to a placement
decision made at authoring time.

The core value is unchanged: publication is the default, and redaction is deliberate.
:::

## Context

The Quarto site under `docs/` is deployed to GitHub Pages by `.github/workflows/docs.yml` on
every push to `main` that touches `docs/**`. The repository itself is **private**, but Pages
for it is configured `public: true`, so
[`https://seandavi.github.io/bioc-cloudflare/`](https://seandavi.github.io/bioc-cloudflare/)
is readable by anyone with the URL, unauthenticated.

That combination is easy to misread as an accident — a private repo whose output leaks. It is
not. This work only matters if the people affected by it can see it: Bioconductor core team
members, mirror operators, and anyone weighing the migration. Requiring a GitHub account and
an invitation to read a status document defeats its purpose.

The investigation behind these pages did, however, touch genuinely private material —
credentials in production config, internal host addresses, and colleagues' informal remarks in
conversation. Publishing by default while researching in private means the boundary has to be
explicit, because the *default* is publication.

## Decision

**The docs site stays public**, and every page under `docs/*.qmd` is treated as published the
moment it lands on `main`.

**Secrets and truly private material must not reach `docs/`.** Specifically, none of the
following belongs in any file the site renders:

- Credentials of any kind, and **the paths of files that contain them**. A path is a pointer to
  a secret; naming it on a public page is a smaller version of publishing the secret.
- Internal-only host addresses, ports, and private ops configuration not already public.
- Named attribution of individuals' informal remarks. Paraphrase the substance and attribute
  it to a role ("a Bioconductor core team member"). Named citation of *published* work —
  repos, issues, release notes, blog posts — is fine and preferred.
- Anything received in confidence, whatever its form.

Such material belongs in the session memory directory or a private channel, and the
corresponding public page should say that a finding exists without restating it, where saying
so is useful.

**Agent-facing files are not part of the site.** `docs/agents/` and `docs/adr/` live under
`docs/` for tooling reasons, not to be published. Quarto renders every input file it finds by
default, so `_quarto.yml` carries an explicit `project.render` list limiting the site to
`**/*.qmd` and excluding `agents/` and `adr/`. **That exclusion is load-bearing** — without it,
these files publish silently.

## Consequences

- Writing for `docs/` is writing in public. There is no draft state on `main`.
- The redaction decision has to be made at authoring time, not at review time. A finding that
  cannot be stated safely gets stated at a level of abstraction that can be — see the
  "what could not be determined" sections, which record that a question is open without
  exposing what was seen while investigating it.
- Removing something from the site does not unpublish it. Pages is crawlable and the URL may
  have been shared, so a leak is corrected forward — assume it was seen.
- Adding a new file type under `docs/` requires checking it against the render list. Anything
  matching `**/*.qmd` outside `agents/` and `adr/` goes live on the next push.
- This is documentation, not enforcement. Nothing currently *prevents* a secret reaching a
  `.qmd`. A deny-list check in `docs.yml` over the rendered `_site` would close that gap and is
  not yet built.

## Alternatives considered

**Make Pages private.** Restricts readership to GitHub accounts with repo access, which
excludes most of the stakeholders the site exists for. Rejected.

**Keep a separate public and private docs set.** Two sites, two build paths, and a standing
question of which one a given fact belongs to. The single-site rule with an explicit boundary
is less machinery and fails more obviously. Rejected.
