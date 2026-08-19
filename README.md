# bioconductor-infrastructure

Documentation for the infrastructure behind bioconductor.org: what runs today,
what replaces it, and the contracts between the repos that do the work.

The rendered site is the point — this repo is its source. It is deliberately
separate from the repos it documents, so that no one of them is the privileged
place where the estate gets described.

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
