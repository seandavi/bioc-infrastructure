# AGENTS.md

The bioc-infrastructure platform: `packages/registry`, `packages/edge`, `packages/traffic`,
`packages/health` and the documentation site `packages/docs`. `README.md` maps the repository;
each package's own `AGENTS.md` or `README.md` covers that package. These rules apply everywhere.

- **Work in a git worktree**, never in the main checkout, and never in the operations clone at
  `/data/davsean/bioc-ops/bioc-infrastructure`, which production units run from.
- **Packages meet only through documented R2 keys and HTTP artifacts.** Don't import or name
  another package's source; `./check-seams.sh` must pass. A contract change updates the
  producer, the consumer and the contract's documentation in the same pull request.
- **Everything here is public**, and merging to `main` publishes `packages/docs` immediately.
  No credentials or secret values, internal hostnames, or people's informal remarks (ADR
  0001, `packages/docs/adr/0001-public-docs-site-with-a-publication-boundary.md`).
- **One issue tracker: this repository's**, with `area:<package>` labels.
- **Workflows** are `.github/workflows/<package>-<name>.yml`, path-filtered to their package.
  A workflow that checks out the repository sets `defaults.run.working-directory:
  packages/<package>`; one that doesn't, mustn't.
- **CI never deploys a Worker.** Deploys are manual, by the maintainer.
- **Link ADRs by their published URL**
  (`https://seandavi.github.io/bioc-infrastructure/adr/…html`), which survives file moves.
