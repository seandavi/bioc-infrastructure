# 0013 — A redirect lands on the content, or it goes

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

The Worker reproduces production's redirects from a snapshot of master's Apache config
(`inventory/htaccess-20260730.conf` in bioc-edge, compiled to `worker/src/redirects.json` by
`gen-redirects.ts`). Porting them all was the right default for the cutover: it kept behavior
identical and made the comparison against production mechanical.

Not every rule is worth keeping, and the first production logs show what one can cost. In the
first 19 minutes after the switch (2026-09-28), **75% of all requests** (84,414) came from one
crawler. It was walking garbage paths under `/talks/`, and our catch-all rule
`^talks.*$ → /help/course-materials/` fed it. That page has 392 relative links; the crawler
resolved them against the URL it asked for, not the redirect target, so each redirect gave it
392 new `/talks/...` URLs to request. Nobody else requested `/talks` in that window. And the
rule never sent anyone to the talk they wanted: it discards the path and lands every old link on
the same index page, which is a soft 404.

There are two kinds of URL on this site, and they need different promises:

- **Machine-facing:** package repositories (`/packages/<ver>/…/src/contrib/`, `bin/`,
  `PACKAGES*`, `VIEWS`), package landing pages and short URLs, `/checkResults/`, archives,
  `config.yaml`, `bioc-version`. `BiocManager`, `install.packages()`, mirrors, CI and old
  scripts are built on these, and they break without warning when a URL changes.
- **Human-readable:** talks, course materials, conference pages, docs and how-tos. They're read
  by people, who can search when a link is dead, and they go stale on their own.

## Decision

**A redirect is kept only if it lands the reader on the content they asked for, or on its
direct replacement.** One old page mapped to one new page (for example
`/developers/how-to/version-numbering` → `contributions.bioconductor.org/versionnum.html`) stays.

**A catch-all that sends a whole subtree to an index or landing page is dropped, and those
paths answer 404.** It's a soft 404 that costs requests, and as `/talks` showed, it can do
worse.

**Machine-facing URLs are kept regardless.** Anything a package client, mirror or script might
request keeps working, redirecting or failing exactly as it did, whatever this ADR says about
human pages. When in doubt about which kind a path is, treat it as machine-facing.

**Human-readable content has no permanent-URL guarantee.** We don't have to maintain old
links to talks, courses, conferences and docs forever. Good one-to-one redirects are cheap
and worth keeping, but carrying dead links isn't an obligation.

Mechanics: dropped rules go in the SKIP table in `gen-redirects.ts`, each with its reason,
so regenerating from the Apache snapshot doesn't bring them back.

## Consequences

- The edge deliberately diverges from production on the dropped paths: 404 instead of 301.
  Comparisons against production (`cutover-diff.sh`, the parity probe) have to expect this.
- Old links to talks and similar pages that used to land on an index now land on the 404 page.
  The 404 page should give readers a way on, such as search and links to the main sections.
- 404, not 410. A 410 would tell crawlers to forget the URLs faster, but needs a code path;
  plain 404 falls out of removing the rule. Revisit if dropped paths keep drawing traffic.
- The remaining fixed-target catch-alls are reviewed against this rule (seandavi/bioc-edge#33).
  `/talks` is the first case (seandavi/bioc-edge#32).
