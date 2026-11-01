# 0002 — Mirror the access logs unfiltered; interpret with views

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Bioconductor's download statistics are produced by two pipelines
(`Bioconductor/download_stats` and `Bioconductor/bio-web-stats`), both fed by the same
CloudFront access logs in S3. Both **filter at ingest**, and they do it twice over:

- **Columns.** Each projects down to a handful of fields. `cs(User-Agent)` and
  `x-forwarded-for` are discarded before anything is stored.
- **Rows.** Each keeps only requests matching a package-tarball URL pattern — roughly 3% of
  log lines.

Those two decisions are the direct cause of every limitation we found:

- **Neither can filter bots, and neither can be made to.** The legacy code contains a
  crawler list and a build-node list with the exclusion checks commented out; the current
  system's Athena view does not select the user-agent column at all. The August–September 2025
  traffic spike — downloads 4× while distinct IPs stayed flat, concentrated in the base
  dependency closure — is unfiltered automated traffic sitting in every published number, and
  cannot be removed retroactively from either series.
- **The counting policy is frozen.** Whether redirects count, whether `206` counts, whether
  `HEAD` counts, whether proxied clients are deduplicated — all are baked into the ingest
  filter. Revisiting any of them means re-reading six years of logs from S3.
- **97% of the data is gone.** Every content page, vignette, manual and crawler request is
  discarded. Questions about user journeys, the value of the content corpus, or bot pressure
  against documentation cannot be asked at all.

The economics that produced this are real: on S3, each full reprocessing pass costs roughly
$50 in egress, which is exactly the pressure that makes filtering at ingest look prudent.

Measurements that bear on the decision:

- The archive is **913,579 objects / 564 GB**, reaching back to **2020-01-01** — not the six
  months the current system's design notes claim. No lifecycle expiry is in evidence.
- Parquet at full fidelity lands at **roughly parity with the gzipped source**, not the ~30×
  a row count suggests, because columnar zstd on repetitive log fields compresses about as
  well as gzip does row-wise. July 2026: 175,314,722 rows, 12 GB.
- The data is **already sorted by date**. All 1,416 row groups in a month file span ≤1 day; a
  single-day query touches 2.8% of them. This is a side effect of S3 keys sorting
  chronologically and being read in key order.

## Decision

**Mirror the logs. Do not interpret them on the way in.**

- **Every row and every column.** All 33 CloudFront fields, named, VARCHAR exactly as logged
  apart from `date`. No row filter of any kind.
- **Interpretation lives in views.** The download definition — package tarball or binary under
  `/packages/`, status in 200/301/302/307/308, `HEAD` excluded — is a `DOWNLOADS_SQL` view over
  the mirror, reproducing both published pipelines' conventions so output stays comparable.
- **Partition `year=YYYY/month=M/`, one file per month.** Two levels so pruning works on year
  alone; a month per file gives ~80 files of tens of MB rather than ~2,400 of ~1 MB.
- **Do not sort.** The read order already delivers date clustering; an explicit sort would
  spend a spilling sort of ~175M rows per month to reproduce what exists for free.
- **The raw gzip is the system of record**; the Parquet is a derived, disposable query layer.
- **Both live in R2.** R2 egress is free, so re-deriving the query layer costs nothing — which
  is what makes "keep everything, decide the policy later" hold in practice rather than only
  in principle.

## Consequences

- Storage is ~564 GB of gzip plus ~530 GB of Parquet, against ~15–20 GB for a downloads-only
  extract. That is the price of the option value, and on current hardware it is cheap.
- **Any future ingest must not filter.** The extraction script's self-check asserts this: it
  fails if the mirror grows a `WHERE` clause or a derived column. Filtering belongs in views.
- The column mapping is **positional**, and the reader skips the `#Fields:` header, so an
  upstream format change would silently shift every column. The script asserts the field count
  per month. The header was verified byte-identical at 2020, 2023 and 2026.
- **The privacy footprint is larger than the published statistics imply.** The mirror retains
  raw client IP addresses for all site traffic, not only downloads, back to 2020. The current
  system's design notes proposed encrypting them and that was never implemented. A written
  retention and access policy is owed, independent of who owns the data.
- Free date clustering is a side effect, not a guarantee. If a future DuckDB parallelises reads
  differently, clustering could degrade silently — queries would get slower, nothing would
  fail. The row-group span check is worth re-running after each build.
- Sorting for one access pattern would break another: journey reconstruction wants clustering
  by client IP, which would destroy the date clustering. Derived tables, not a reorganised
  mirror, are the answer if that becomes a hot path.

## Addendum, 2026-08-05: Iceberg over the mirror, at no copy cost

This ADR originally implied Iceberg was not worth it for the mirror. That reasoning was wrong:
it assumed adopting the data meant rewriting it. It does not.

Iceberg can **adopt existing Parquet files as a metadata operation**. All 80 monthly files —
7,123,972,770 rows — were registered as `biocr2.cloudfront.access_logs` in **47 seconds**, with
no data copied and no second storage cost. A DuckDB rewrite of the same data was measured at
**15 hours**. The table sits over the same objects, which remain directly readable by anything
that does not speak Iceberg.

So the mirror is now *both*: plain Hive-partitioned Parquet, and an Iceberg table over those
same bytes. That costs nothing and keeps every engine viable, which was the point of the
original decision rather than a departure from it.

Two constraints worth carrying: Trino's `add_files` refuses partitioned tables (PyIceberg's does
not), and R2 Data Catalog access cannot be scoped to a bucket — see `ANALYTICS.md`, which has
consequences for who can be given access to the raw mirror.

## Alternatives considered

**Filter rows to package downloads at ingest** (~15–20 GB instead of ~530 GB). This is what
both existing pipelines do. Rejected: it discards 97% of the data, forecloses every question
outside download counting, and bakes in the counting policies that are themselves disputed.
The saving is storage, which is cheap; the cost is another six-year re-read, which is not.

**Keep only the columns the statistics need.** Rejected for the same reason, and with a
concrete demonstration of the cost: it is precisely why neither published series can filter
bots today.

**Stage nothing; convert directly from S3.** Rejected once the hardware was known. Reading S3
is latency-bound on ~30k small objects per month (~22 MB/s); `rclone --transfers 128` sustains
~290 MB/s, and converting from local disk runs ~3× faster per byte. Staging pays the AWS
egress once and leaves a verified copy that costs nothing to re-read.

**Sort by date/time inside each file.** Rejected on measurement — the data is already clustered
to ≤1 day per row group, so the sort would buy a few percent at the cost of hours.

**Rely on the S3 bucket rather than mirroring.** Rejected: it is currently the only copy of the
2020-onward logs, with no versioning or lifecycle protection in evidence, and 2009–2019
statistics already exist nowhere but the legacy pipeline's own databases.
