# 0005 — Completeness is measured by origin, not by page type

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

The obvious way to measure progress on serving bioconductor.org without staging and master is
to count files by page type. Measured against the live docroot — 3,710,600 files,
`inventory/bioc-web-latest.txt.gz`, 2026-07-30 — roughly **85% is not built by any renderer**:
vignettes, reference manuals, checkResults, source tarballs, binaries, NEWS.

That figure invites a conclusion that is wrong in a way that is hard to see: R2 already serves
all of it, so it must be solved.

It is not solved. **Every one of those files reached R2 by being crawled from master.** The
mirror holds a copy, but no source. If master is retired, nothing can regenerate them — the
copy survives only until it needs to change. This is the same circular dependency
`docs/decommission-plan.qmd` already records for the site build, which reads its own published
output from bioconductor.org; it simply applies to the mirrored artifacts too, where it is
less visible because nothing appears to be running.

A count by page type measures **where bytes currently sit**. The migration's actual risk is
**where bytes can be produced from**. Those are different questions, and only the second one
determines whether a host can be switched off.

## Decision

**Progress is tracked per class of file by its real origin, and a class counts as complete only
when it can be produced without staging or master in the loop.**

- The unit of tracking is a **class of file with a producer**, not a page type or a percentage
  of the docroot.
- "It is already in R2" is **not** evidence of completeness. If the only path by which those
  bytes exist is a crawl of master, the class is unsolved and is recorded as unsolved.
- A class is complete when its producer is a **primary source** — a package tarball, a build
  machine, r-universe, the site's own git repository, or logs we hold — reachable without the
  hosts being retired.
- Reaching the end of the map means no class is left whose only origin is "it was crawled from
  master", at which point the hosts can be retired without losing the ability to regenerate the
  site.

The origin map in the tracking issue is the artifact that carries this, and it is organised by
origin for exactly this reason.

## Consequences

- Headline completion percentages by page type are actively misleading and should not be
  quoted as progress. 85% of files being "already served" coexists with the largest classes
  being unsolved.
- Work that appears redundant — building a generator for content R2 already serves — is not
  redundant. It is the whole task. The bytes are already there; the *producer* is what is
  missing.
- Verification means checking the generated artifact against the served one, not checking that
  the served one exists. This has been done where claimed: what the site serves at
  `/packages/3.23/bioc/vignettes/limma/inst/doc/usersguide.pdf` is byte-identical (1,300,176 B)
  to the same path inside the source tarball.
- Some tickets under this map build things rather than decide things, which is a deliberate
  departure from a plan-don't-do default. That follows from the decision: a class is only
  proven to have an independent origin once something has actually produced it.
- The same test applies to classes that look finished for other reasons. Download statistics
  had "an independent origin but no independent path" — a live service whose output could not
  be reached without master proxying to it — and were correctly recorded as unsolved until the
  inputs were held directly. See
  [0002](0002-mirror-access-logs-unfiltered.md) and
  [0004](0004-download-statistics-are-generated-static-files.md).

## Alternatives considered

**Track by page type or percentage of files.** Rejected: it reports the migration as ~85%
complete while every large class is still bootstrapped from a host we intend to switch off. It
measures storage, not reproducibility.

**Treat the R2 mirror as the source of truth and retire the hosts.** Rejected: it converts a
recoverable situation into an unrecoverable one. The mirror cannot regenerate, so any future
change, correction, or new release has no producer. It also silently freezes content that is
supposed to be live.

**Track by "does it render", i.e. does a generator exist for each page type.** Rejected as too
weak: a generator that reads bioconductor.org for its inputs satisfies it while still depending
on master. Origin, not rendering, is the property that matters.
