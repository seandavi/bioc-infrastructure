# Site audit (July 2026)

Research that preceded the next-gen site work, rescued from a local scratch
workspace (`bioconductor-site/`, never a git repo). Two parts:

- `review/` — six audit documents on the legacy www.bioconductor.org site
  (architecture, design system, findability, link health, perf/a11y, UX/IA),
  with the raw crawl data (`review/data/`) and screenshots that back them.
  The crawl is a point-in-time snapshot of the old site and is not
  regenerable once the legacy site is decommissioned.
- `ga_pull.py`, `ga_check.py`, `ga_report.py`, `ga-report.md`, `SCHEMA.md` —
  Google Analytics 4 pull for property 388188354 (www.bioconductor.org) and
  the traffic report built from it. The 574 MB DuckDB warehouse
  (`ga.duckdb`) was deliberately not kept; rerun `ga_pull.py` to rebuild it
  from the GA4 Data API.

None of this is rendered into the Quarto site (`_quarto.yml` renders an
explicit allowlist); it is archived source material, cited by the pages that
drew on it.
