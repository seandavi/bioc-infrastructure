# registry-next parity with `packages.json`

Evidence for [#213](https://github.com/seandavi/bioc-infrastructure/issues/213): how much of the
website's `packages.json` can be produced from the new registry's `index.json` alone, field by
field, and what has to come from somewhere else.

`parity.py` reads, for each Bioconductor version and repository present on both sides,

- the registry's `packages/{version}/{repo}/index.json` (GET only), and
- the snapshot the website is built from, `https://bioconductor.org/_ci/site-data.tar.zst`
  (downloaded and extracted with `zstd` and `tar`; or `--snapshot-dir` for an extracted copy).

For packages at the same `Version` on both sides it derives each `packages.json` field from the
`index.json` entry and counts, per field: compared, equal, equal after whitespace normalization,
different, and absent on one side. Where the right rule is not known (`hasNEWS` and the other
`has*` flags, the vignette list) several candidate rules are computed side by side so the data
picks one. A snapshot binary that is an older version than its own source, while the registry's
is current, is counted apart (`binary trails source`) rather than as a difference.

It also computes reverse dependencies from the registry's indexes across the version's
repositories and says how much of the snapshot's lists that recovers, splitting what is missing
into Bioconductor packages the registry does not hold yet (the backfill) and packages that are
not Bioconductor (CRAN). It lists the snapshot fields with no source in `index.json`, and up
to five examples per field with differences.

```bash
uv run parity.py                       # Markdown report on stdout
uv run parity.py --json parity.json    # and the same numbers as JSON
uv run parity.py --versions 3.24       # other versions; --snapshot-dir DIR to skip the download
```

The registry is a moving target while it backfills: the report states the coverage of the run
(the first table), and every figure is over the packages present on both sides. Rerun it as the
backfill progresses; read agreement rates only against that table.
