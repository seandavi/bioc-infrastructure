# bioconductor-infrastructure

Documentation for the infrastructure behind bioconductor.org: what runs today,
what replaces it, and the contracts between the repos that do the work.

The rendered site is the point. Since [ADR 0014](adr/0014-one-platform-repo-the-website-build-and-manifest-stay-separate.md)
this repo also holds the platform's code: `packages/registry`, `packages/edge` and
`packages/traffic`, with one issue tracker for all of it. bioc-website, bioc-build and
bioc-manifest stay separate repos.

## Status

Every status light across the repo family, in one place. **Green means the
check ran and its blocking assertions passed — not that there were no
findings.** The one report-only check (accessibility on bioc-website PRs,
non-blocking until its baseline is clean) stays green while carrying
findings; each run's step summary shows them, and the link/a11y checks also
upload a full report artifact. Everything else — including the install
canary's random-sample leg — is blocking: red means broken or stale, click
through for the failing run.

| Repo | What it watches | Badges | Reports |
|---|---|---|---|
| [bioc-website](https://github.com/seandavi/bioc-website) | build + deploy to R2; PR link/a11y checks ride along | [![site](https://github.com/seandavi/bioc-website/actions/workflows/site.yml/badge.svg)](https://github.com/seandavi/bioc-website/actions/workflows/site.yml) | [a11y latest](https://nightly.link/seandavi/bioc-website/workflows/site/main/a11y-report.zip)¹ · [per-PR](https://github.com/seandavi/bioc-website/actions/workflows/site.yml?query=event%3Apull_request) |
| [bioc-website](https://github.com/seandavi/bioc-website) | daily link-rot check of the maintained pages, against the served site | [![links](https://github.com/seandavi/bioc-website/actions/workflows/links.yml/badge.svg)](https://github.com/seandavi/bioc-website/actions/workflows/links.yml) | [latest report](https://nightly.link/seandavi/bioc-website/workflows/links/main/links-report.zip)¹ |
| [bioc-registry](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/registry) | tests | [![test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-test.yml) | |
| [bioc-registry](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/registry) | daily: worker up, observations fresh | [![freshness](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-freshness.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-freshness.yml) | |
| [bioc-registry](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/registry) | daily: packages actually install | [![install](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-install.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-install.yml) | [run summaries](https://github.com/seandavi/bioc-infrastructure/actions/workflows/registry-install.yml) |
| [bioc-edge](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/edge) | tests | [![test](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-test.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-test.yml) | |
| [bioc-edge](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/edge) | daily black-box serving probe | [![health](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-health.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-health.yml) | |
| [bioc-edge](https://github.com/seandavi/bioc-infrastructure/tree/main/packages/edge) | daily parity vs bioconductor.org (dies at cutover) | [![parity](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-parity.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/edge-parity.yml) | |
| bioc-infrastructure | docs render + publish | [![docs](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs.yml/badge.svg)](https://github.com/seandavi/bioc-infrastructure/actions/workflows/docs.yml) | |

¹ Direct artifact download via [nightly.link](https://nightly.link) (GitHub has
no stable latest-artifact URL). If it's ever down, the artifact is on the
latest run under the links badge.

## Rendering locally

```sh
quarto preview     # live reload on :4200
quarto render      # static build -> _site/
```

Nothing else is required: no credentials, no services, no data fetch. Every
page is prose and diagrams.

## Layout

| Path | What it is |
|---|---|
| `index.qmd` | The estate map — start here |
| `adr/` | Architecture decision records: why things are the way they are |
| `_quarto.yml` | Site structure; the sidebar is the table of contents |

## Publishing

`.github/workflows/docs.yml` renders and deploys to GitHub Pages on every push
to `main`. There is no draft state: **writing here is writing in public.**

That was true before this repo existed — the site was public while its source
repo was private — and it stays true now for a simpler reason. See
[`adr/0001`](adr/0001-public-docs-site-with-a-publication-boundary.md).

## License

[CC BY 4.0](LICENSE). Use it, quote it, build on it — with attribution.
