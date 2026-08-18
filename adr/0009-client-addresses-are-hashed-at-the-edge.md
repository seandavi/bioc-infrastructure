# 0009 — Client addresses are hashed at the edge, not de-identified downstream

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

[ADR 0003](0003-request-logging-after-the-cloudflare-cutover.md) decided the Worker emits one full
record per request and Logpush ships it, and left one thing open in its own consequences: "a
retention and access decision for client IP addresses should be made at the cutover rather than
inherited. The current arrangement retains raw IPs indefinitely because nobody chose otherwise."

That decision is now forced, because the destination changed. Under
[ADR 0003's amendment](0003-request-logging-after-the-cloudflare-cutover.md) and `bioc-on-ice`
ADR 0010, records land in the GCS delivery bucket (named in `ANALYTICS.md`, which is not
published), and the access control for raw addresses became GCP IAM. `ANALYTICS.md` carries a de-identification design — salted SHA-256 of `c_ip`, drop the
sparse IP-bearing fields — that was started 2026-08-05 and torn down unbuilt, pending an
account-scoping question that ADR 0010 has since settled.

The obvious place to apply that design is at ingest, when logs are read out of GCS into the
analytical store. The obvious place is wrong.

## Decision

**The Worker hashes the client address before the record is ever emitted. Raw addresses do not
leave the edge.**

- `c_ip` is replaced, in the same position, by `client_id = sha256(salt || ip)`, keyed with
  a salt held in Secret Manager (named in `ANALYTICS.md`, which is not published).
- `x_forwarded_for` stops being collected and becomes an explicit `null`.
- The record version goes to **`v: 2`**. Column parity with CloudFront is deliberately broken in
  exactly those two places and nowhere else; ingest branches on the version.

## Why at the edge rather than at ingest

**Hashing at ingest does not remove the exposure, it relocates it.** Objects in GCS would still
hold raw addresses, permanently, and Logpush objects cannot be rewritten. De-identification
downstream protects the derived table and leaves the archive exactly as sensitive as before.

**It deletes a pipeline stage instead of adding one.** The daily ingest becomes a copy rather
than a transform, and the salt exists in one fewer place. ADR 0004's framing applies: the cheapest
component is the one that does not exist.

**`x_forwarded_for` is why "hash `c_ip`" is not the whole fix.** It carries a *chain* of raw
addresses. Hashing one field while writing the other would de-identify nothing — the address
lands in the archive anyway, one field over. Measured at 0.5% populated across the CloudFront
era, so dropping it costs almost nothing, and the same drop applies to the historical backfill.

## What is traded away

**The raw address is unrecoverable.** Accepted: the record already carries `cf_country`,
`cf_asn` and `cf_as_organization`, which cover every geographic and network question the download
statistics have ever asked, and no abuse-investigation use case has been raised. If one appears
later, it cannot be served retroactively — that is the real cost, and it is the point.

**This is pseudonymous, not anonymous.** The same client maps to the same id, which is exactly
what makes distinct-client counts meaningful and is also the residual risk. Consequently the
row-level table stays in the private DuckLake and is never published behind anonymous read; see
`monode/infrastructure/PUBLISHING.md`.

**The salt must not be rotated.** Rotating it splits the id space and breaks every longitudinal
distinct-client count. It is deliberately stable, which means it is a permanent secret rather
than a rotatable one.

## The subtlety that will cause the bug

The salt is stored as a **64-character lowercase hex string, and the GSM copy carries a trailing
newline.** It is used as *text*, not decoded to its 32 bytes.

Both eras must agree or the id space silently splits at the cutover: the Worker computes
`SHA-256(TextEncoder(salt + ip))`, the CloudFront backfill computes DuckDB's
`sha256(salt || c_ip)`. Verified identical across DuckDB 1.5.5, node `crypto` and WebCrypto —
`sha256('deadbeef' || '203.0.113.7')` is `9134dc80…` in all three. That literal is asserted in
`worker/test.ts`, which is the only thing standing between the two implementations drifting apart.

**Trim the newline.** A stray `\n` reads as a perfectly working system and produces two disjoint
id spaces, discoverable only much later as an unexplained discontinuity in distinct-client counts
— the same failure shape that cost the live statistics a quarter of June 2026 unnoticed.

## Consequences

- ADR 0003's open IP question is closed.
- The Worker takes a small amount of new work per request: one `crypto.subtle.digest`. It is
  awaited on the response path rather than deferred to `ctx.waitUntil`, because whether a
  `console.log` inside `waitUntil` is captured by the trace event is precisely the kind of
  assumption whose failure mode is months of silently missing records.
- `BIOC_LOGS_IP_SALT` unset means every `client_id` is `null`. Distinct-client counts break for
  that window, visibly, and no raw address is ever written. Chosen over throwing, which would
  turn a logging misconfiguration into an outage.
- The batch de-identification in `ANALYTICS.md` survives only for the historical CloudFront era,
  where it runs once.
- The `cf` object is still spliced in verbatim, so a future Cloudflare field carrying an address
  would land in the archive silently. `worker/test.ts` asserts no IPv4-shaped value appears
  anywhere in the record, which is what would catch it.
