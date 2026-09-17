# 0012 — Client addresses are stored raw; de-identification is a view

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes:** [0009](0009-client-addresses-are-hashed-at-the-edge.md)

## Context

[ADR 0009](0009-client-addresses-are-hashed-at-the-edge.md) decided the Worker would hash the
client address before emitting the record, so raw addresses never reached the archive. It was
never deployed: the implementing commit sat on a branch, and every record delivered since the
cutover is `v: 1` with `c_ip` populated. The archive already holds raw addresses for the whole
Cloudflare era, as it does for the whole CloudFront era.

Meanwhile the question the logs are expected to answer has changed. Traffic classification —
separating humans, package clients, mirrors, CI, search crawlers, AI crawlers and scrapers, and
explaining the intermittent spikes — needs the address itself, not a pseudonym of it: grouping
by `/24` and `/48`, reverse DNS, joining abuse and cloud-provider range lists, and reconstructing
a client's session where ASN is too coarse. A salted hash preserves "same client" and destroys
everything else. ADR 0009 accepted that loss on the grounds that "no abuse-investigation use
case has been raised". One has.

ADR 0009's exposure argument was about a shared analytical store. There is no such store: the
delivery bucket and the query layer are read by one person with one credential, and the
publication boundary ([ADR 0001](0001-public-docs-site-with-a-publication-boundary.md),
`monode/infrastructure/PUBLISHING.md`) is where data leaves that scope.

## Decision

**The record keeps the raw client address. De-identification is an interpretation, and per
[ADR 0002](0002-mirror-access-logs-unfiltered.md) interpretation lives in views.**

- The Worker emits `c_ip` and `x_forwarded_for` as CloudFront did. The record stays `v: 1`.
  Column parity with CloudFront is intact, and the ingest has nothing to branch on.
- `client_id = sha256(salt || c_ip)` is computed in the normalising view, with the same salt and
  the same text encoding as the historical CloudFront projection, so both eras share one id
  space. It may also be materialised as an *additional* column in a derived table. It never
  replaces `c_ip` in the record.
- Anything that crosses the publication boundary carries `client_id` and not `c_ip`. Dropping
  the address is a projection at publish time, not a property of the archive.

## What is traded away

**The archive is exactly as sensitive as it was.** Raw addresses are retained indefinitely, and
the access control is the store's own: GCP IAM today, an R2 token if delivery moves back. This
is the arrangement ADR 0003 called "inherited because nobody chose otherwise". It is now chosen,
for the reason above, and it holds only while the store has a single reader. **If a
collaborator is ever given direct read access to the delivery bucket or the row-level table,
this ADR is void and the question reopens** — at that point the answer is a bucket-scoped token
over a de-identified derived table, not a change to the record.

**The salt still matters.** The subtlety in ADR 0009 — a 64-character hex string used as text,
GSM copy with a trailing newline, verified identical across DuckDB, node and WebCrypto — applies
unchanged to the view. The view is now the only implementation, which removes the cross-era
drift risk the Worker test existed to catch.

## Consequences

- The edge-hashing commit is reverted on its branch; the Worker never learns the salt, and the
  `BIOC_LOGS_IP_SALT` secret is not deployed.
- ADR 0009's "no IPv4-shaped value anywhere in the record" test goes with it; the property is
  now the opposite.
- The batch de-identification in `ANALYTICS.md` is no longer a one-off for the CloudFront era.
  It is the definition of `client_id` for both eras, in the view.
- The bot-classification work this enables is a view over the same record, versioned so that
  history can be recomputed when the rules improve.
