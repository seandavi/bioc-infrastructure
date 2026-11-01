# docs

The documentation site for the bioc-infrastructure platform, published at
<https://seandavi.github.io/bioc-infrastructure/>: what runs today, what it replaced, how the
pieces fit, and the decisions behind them.

## Rendering locally

```sh
cd packages/docs
quarto preview     # live reload on :4200
quarto render      # static build -> _site/
```

Every page is prose and diagrams, with one exception: the CI page includes `ci-inventory.md`,
which is generated, and the render fails without it. Generate it first (needs a GitHub token):

```sh
GH_TOKEN=$(gh auth token) python3 ci-inventory.py
```

## Layout

| Path | What it is |
|---|---|
| `index.qmd` | The estate map; start here |
| `*.qmd` | Reference pages, runbooks, plans and migration records (see [CONTRIBUTING](../../CONTRIBUTING.md) for which is which) |
| `adr/` | Architecture decision records: why things are the way they are |
| `adr/0014/` | The scripts and records from merging the platform repos (not rendered) |
| `_quarto.yml` | Site structure; the sidebar is the table of contents |
| `mirror-sync.sh` | The script mirror operators download from `mirror-how-to.qmd`; `test-mirror-sync.sh` tests it |
| `ci-inventory.py` | Builds the CI page's workflow table from the GitHub API |
| `docs-check.sh` | Weekly stale-content check (`docs-check` workflow) |
| `audit/`, `dns/`, `evidence/`, `diagrams/` | Sources and data behind specific pages |

## Publishing

`docs.yml` renders and deploys to GitHub Pages on every push to `main` that touches
`packages/docs` or a workflow. There is no draft state: **writing here is writing in public.**
See [ADR 0001](adr/0001-public-docs-site-with-a-publication-boundary.md).

Page URLs come from paths relative to this directory, so moving this package did not change
them. Link to ADRs by their published URL rather than their GitHub path: the published URL
survives file moves.

## License

[CC BY 4.0](LICENSE). Use it, quote it, build on it, with attribution.
