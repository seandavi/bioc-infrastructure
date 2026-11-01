# 0006 — 33 of 35 releases, and checkResults for them, are archival

- **Status:** Accepted
- **Date:** 2026-08-07

## Context

[Issue #66](https://github.com/seandavi/bioc-cloudflare/issues/66) asked whether the 33 releases
other than 3.23/3.24 are *sourced* or *frozen* — `astro/data/` holds all 35 releases but is
gitignored, only 3.23/3.24 carry a `provenance.json`, and `just data` only fetches those two.
Undeclared was the one answer [0005](0005-completeness-is-measured-by-origin-not-page-type.md)
rules out: those 33 releases score as unsolved under an origin test that never asked whether
they are still changing.

The same shape applies to `checkResults/` for the same releases. `rsync-filter` kept only
3.23/3.24 `*-LATEST` (251,078 of 2,607,459 files) specifically because those builds run nightly
and R2 bills per operation — the cost the filter was written against is *churn*, not size. The
2,102,552 files for releases ≤3.21 were dropped by the same rule, but the map already recorded
them as "inert since 2025" ([#58](https://github.com/seandavi/bioc-cloudflare/issues/58)) — the
churn the filter exists to avoid does not apply to them.

## Decision

**Releases other than the current release and devel are archival — frozen, not reproduced —
and so is checkResults for those same releases.**

- Terminal state for the 33 non-live releases: **freeze**. Nothing regenerates them; the
  snapshot in `astro/data/` (or a committed successor to it) is the record.
- `checkResults/` for releases ≤3.22 gets the same terminal state, and therefore the same
  treatment already given the OSN archive ([#6](https://github.com/seandavi/bioc-cloudflare/issues/6)):
  a one-time load into R2, not an ongoing sync. `rsync-filter` no longer excludes them.
- 3.23 and 3.24 are unaffected — both still churn nightly and still sync on every run,
  regardless of this decision.

## Consequences

- `rsync-filter`'s checkResults section collapses from an enumerated allow-list per version to
  one rule: the version-specific carve-outs it existed to express no longer apply once every
  release is either live (3.23/3.24, unchanged) or archival (everything else, now included
  outright).
- The resolvability check in [#65](https://github.com/seandavi/bioc-cloudflare/issues/65)
  gains ~2.1M more in-scope files once the next sync runs; they were previously excluded by
  design, not unresolved.
- This does not answer *how* the 33 releases' package data gets reproduced if `astro/data/` is
  lost — it answers that the current state (a snapshot, not a pipeline) is the accepted terminal
  state, not a gap to close. A frozen snapshot still needs to exist somewhere durable; that is
  tracked, not solved, by this decision.
- One-time cost, not zero cost: ~2.1M objects still have to land in R2 once. That is a bulk load
  to schedule deliberately, the same caution 0002/0004 gave the archive transfer, not something
  the nightly sync should absorb inside a normal run.

## Alternatives considered

**Leave checkResults ≤3.22 excluded and revisit only if a maintainer complains.** Rejected: the
map already carries this as an explicit gap, and the cost the exclusion was written to avoid
(nightly churn) doesn't apply to inert data — there is no ongoing reason left to keep it out.

**Reproduce all 35 releases' package data from source before calling any of this done.** Rejected
for the 33 archival releases: they aren't changing, so "sourced" buys reproducibility for data
that will never need to be reproduced. Freeze is the cheaper, equally correct terminal state —
the same reasoning [0004](0004-download-statistics-are-generated-static-files.md) applied to
statistics before them.
