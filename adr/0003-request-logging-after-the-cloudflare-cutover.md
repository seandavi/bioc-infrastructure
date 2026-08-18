# 0003 — Request logging after the Cloudflare cutover

- **Status:** Accepted; amended 2026-08-10 (delivery destination moved to Google Cloud Storage)
- **Date:** 2026-08-04

## Context

Every published download statistic, and the `Rank` field on every package landing page, is
derived from **CloudFront access logs**. Both pipelines that produce them read the same S3
bucket, and the legacy pipeline's other historical inputs — Squid logs from the old FHCRC
proxies, Apache logs from master — are commented out of its crontab.

**Serving from Cloudflare stops those logs being produced.** There is no second source. On the
day traffic moves, both pipelines stop accruing at once, whatever else has been migrated. This
is a prerequisite for the cutover, not a follow-up item.

The obvious replacement is not available. **Cloudflare's Logpush HTTP requests dataset is
Enterprise-only, and Bioconductor is not on Enterprise.** That rules out the direct analogue of
CloudFront-to-S3 and forces the design.

What is available on the Workers Paid plan:

- **Workers Trace Events Logpush** — ships Worker execution events, including `console.log`
  output and request/response metadata, to a destination including R2. Combined `logs` and
  `exceptions` fields are truncated past 16,384 characters. Sampling is configurable.
- **Tail Workers** — a Worker with a `tail()` handler consuming the same event stream, with
  code in the middle. Billed on CPU time rather than request volume.
- **Workers Analytics Engine** — `writeDataPoint` from a Worker, SQL query API,
  unlimited cardinality. **Data is retained for three months.**

The site is already served by a Worker, so the Worker is in the request path by construction.

## Decision

**The Worker emits one structured JSON record per request via `console.log`, and Workers Trace
Events Logpush delivers it to R2.**

No Enterprise plan, no bespoke queue-and-batch infrastructure, and the 16,384-character limit
is ample for a single record.

Three constraints, each carried directly from what went wrong with the existing pipelines
(see [0002](0002-mirror-access-logs-unfiltered.md)):

1. **All fields, no sampling.** Logpush offers field selection and a sampling rate. Using
   either is the same mistake that left both current pipelines unable to filter bots. Emit the
   full record.
2. **Monitor the push.** Logpush **cannot backfill** — a failed or disabled job is permanent
   loss for that window, and it fails silently. S3 was forgiving because the bucket *was* the
   artifact; here the push is the fragile link. Alert on daily record-count gaps.
3. **Overlap the cutover deliberately.** Run CloudFront and Cloudflare logging concurrently for
   at least a month. The only reason any of this could be validated is that two stats pipelines
   happened to overlap for two years by accident; do it on purpose this time, because it is the
   only way to calibrate the discontinuity.

**Analytics Engine is a dashboard, never the record.** Three-month retention against a series
reaching back to 2009 disqualifies it for anything durable.

**Field names differ between the two eras** (`ClientIP` against `c-ip`, `EdgeResponseStatus`
against `sc-status`, `ClientRequestURI` against `cs-uri-stem`). Normalising at ingest would
repeat the mistake 0002 exists to prevent. Keep the eras in separate partitions of the mirror
and put a normalising view on top.

## Consequences

- The Worker acquires a logging responsibility it did not have. A malformed or oversized record
  degrades the log rather than the response, but the coupling is real and worth a test.
- Silent gaps are the dominant failure mode, and they are unrecoverable. Monitoring is not
  optional; without it the first symptom is a hole discovered months later, which is exactly
  how the current system lost a quarter of June 2026 unnoticed.
- The record shape is now ours to choose rather than CloudFront's to dictate. That is an
  opportunity and a hazard: it invites trimming the record to what today's questions need,
  which is the failure mode 0002 documents.
- A retention and access decision for client IP addresses should be made at the cutover rather
  than inherited. The current arrangement retains raw IPs indefinitely because nobody chose
  otherwise.
- Because the mirror lives in R2 with free egress, re-deriving statistics across the era
  boundary costs nothing, so the normalising view can be revised freely.

## Alternatives considered

**Logpush HTTP requests dataset → R2.** The direct analogue, needing no Worker code. Rejected:
Enterprise-only, and we are not on Enterprise. Worth revisiting if the plan ever changes, since
it removes the Worker from the logging path entirely.

**Tail Worker writing to R2.** Consumes the same event stream with full control over shaping
and batching. Rejected as the system of record: the documentation does not state delivery
guarantees, sampling under load, or overload behaviour — precisely what must be pinned down for
a record of truth — and CPU-time billing is a real per-request cost at this volume that Logpush
does not carry. Reasonable as a supplement if shaping Logpush cannot express is needed.

**Workers Analytics Engine as the store.** Rejected on retention: three months.

**Worker → Cloudflare Queue → batching consumer → R2.** Full control, at the cost of real
infrastructure to build and operate, for something Trace Events Logpush already does. Rejected
as unnecessary unless Logpush proves inadequate in practice.

**Upgrade to Enterprise.** Not evaluated; a commercial decision rather than a technical one.

## Amendment — 2026-08-10: delivery destination moved to Google Cloud Storage

**Logpush now delivers to a Google Cloud Storage bucket rather than R2**, through Logpush's
S3-compatible delivery ([bioc-on-ice#31](https://github.com/seandavi/bioc-on-ice/issues/31)).
Two reasons:

- **Isolate logging output from operational data.** The serving account's R2 buckets are
  operational surface; access logs — raw client IPs included — should not share it. The other
  isolation mechanism, a second Cloudflare account, was rejected on billing and administrative
  cost, not technical grounds.
- **Querying.** BigQuery external tables sit directly over the delivered objects, and the
  historical CloudFront Parquet mirror was copied into the same bucket, so both eras are
  queryable side by side. The normalising-view obligation above carries over unchanged.

Everything else in the decision stands: the Worker emits one full record per request via
`console.log`, Workers Trace Events Logpush ships it, all fields, no sampling, monitor the
push, overlap the cutover. The monitoring consequence is now closed (2026-08-11): a daily
scheduled check (`systemd/bioc-logpush-check.*`) verifies yesterday's delivery landed and
alerts through the same failure channel as the sync timers. What it does not catch is the
scheduler itself silently not running — the known dead-man's-switch gap, accepted for now.

Operational specifics — bucket layout, job IDs, table names, credentials — live in
`ANALYTICS.md`, which is not published.
