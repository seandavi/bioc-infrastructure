# 0004 — Download statistics are generated static files, not a live service

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

`/packages/stats/` is today a live Python application (`Server: waitress`) on a VPC-private
host, reachable only because master's Apache reverse-proxies to it. It is one of **only two**
things master proxies rather than serves from disk — Solr is the other — so it is one of the two
reasons master's Apache cannot yet be retired.

That architecture has three costs, all observed rather than theorised:

- **Its failure mode is an outage.** If that host stops, the pages stop. Retiring master takes
  the statistics offline while the application carries on running, because the *path* dies even
  though the *service* lives.
- **Nobody owns it.** Host ownership is still an open question on the decommission plan, and a
  quarter of June 2026 went missing from the published series without anyone noticing.
- **It makes `Rank` undeliverable.** Every package landing page carries `Rank`, sourced from
  this service, which is why the origin map recorded download statistics as having "an
  independent origin but no independent path".

Meanwhile the numbers themselves are a **lagging metric by construction**. The live service
already stamps its own pages "Data as of \<yesterday\>", and the legacy pipeline publishes
weekly. Nobody consumes download counts in real time, and nothing would behave differently if
they were a day older.

We now hold the inputs directly ([0002](0002-mirror-access-logs-unfiltered.md)), and have both
DuckDB and a StarRocks cluster available for computing over them.

## Decision

**Analytical databases are build-time infrastructure, not serving infrastructure.**

StarRocks and DuckDB compute aggregates over the log mirror and **emit static files**, which are
synced to R2 and served by the Worker exactly like every other class of file on the site.
Nothing queries a database at request time.

This follows from the property the numbers actually have: a metric that is already a day stale
by design does not need a live query path.

Consequences of that framing:

- **No HA.** A single StarRocks node is sufficient. If it stops, generation stops.
- **The failure mode becomes staleness, not an outage.** Pages continue to serve from R2 at
  whatever age they were last generated. That is strictly better than today, where the same
  failure returns 500s.
- **The output contract is preserved.** Generation reproduces the existing paths and formats —
  `/packages/stats/bioc/<pkg>/<pkg>_stats.tab`, the per-year variants, the category indexes — so
  every existing consumer, including the site build that reads `Rank`, keeps working unchanged.
- **Statistics become just another generated surface**, alongside package pages and biocViews,
  produced by a generator and synced to R2. That is the same shape as everything else in the
  migration rather than a special case.

**Staleness must be bounded and visible.** The current service already stamps each page
"Data as of \<date\>"; generation must preserve that stamp, and **its age must be monitored**.
Tolerating a few days of staleness is a decision; not knowing you are stale is the failure this
project keeps finding. An alert on stamp age is the one guard this design requires.

## Consequences

- Master's Apache loses one of its two proxy dependencies, leaving only Solr. This is a direct
  contribution to the decommission plan.
- The statistics gain an independent path, closing the structural problem recorded in the origin
  map: the output is files, and files can be pushed to R2 by anything.
- Freezing or retiring `/packages/oldstats/` becomes trivial, since it is then just another
  static tree rather than the output of a running pipeline.
- Generation must be **deterministic** — the same logs must produce the same files — because
  re-running is now the recovery mechanism for any defect. The mirror-plus-view design of 0002
  gives that: fixed input, explicit view, no hidden state.
- Roughly 280,000 small files per refresh must be synced. The existing R2 sync already handles
  3.7M files, so this is within known limits, but it is not free and argues for regenerating
  only what changed.
- The database becomes a dependency of the *build*, not of the site. It can be rebuilt, moved,
  or replaced without a migration or a maintenance window.

## Alternatives considered

**Live view with static fallback** — the Worker queries StarRocks and falls back to the static
files when it is unavailable. Rejected, though it is the most tempting option.

It reintroduces at request time exactly the dependency this decision removes, and buys very
little: the freshness delta between "live" and "regenerated daily" is close to zero for a metric
that is already stamped a day old. Against that it costs three things. The serving path acquires
two modes, and the fallback is the one that is almost never exercised, which makes it the one
that rots undetected. The same URL can return different numbers depending on cluster health,
with nothing telling the reader which they got — genuinely confusing for published statistics
that people compare. And every request carries a timeout budget or a health check that the
static path does not need.

The underlying want is real, though, and is better met by **splitting the surface rather than
the request**: publish the canonical series as static files, and put live querying on a separate
internal analytics surface where arbitrary questions — journeys, content value, bot pressure —
are the point and staleness genuinely matters. That gives the live capability without making the
canonical numbers non-deterministic.

**Highly available StarRocks serving the pages directly.** Rejected: operating a cluster to
production standard for a metric nobody reads in real time, and it repeats the current mistake
of putting the published series behind a service that must stay up.

**Keep bio-web-stats as-is.** Rejected: it has no independent path, its host is unowned, and it
silently lost a quarter of a month's data.
