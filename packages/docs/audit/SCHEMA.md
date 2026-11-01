# GA4 analytics warehouse — schema

Local duckdb (`ga.duckdb`) built by `ga_pull.py` from the GA4 Data API for
property `388188354` (www.bioconductor.org). Data begins **2023-06-22**.

## The one structural constraint

The GA4 **Data API serves aggregates only**. There is no event-level or
session-level export through it — that requires the BigQuery export, which is a
separate GA4 admin integration. Everything here is therefore a set of
**date-partitioned cubes**, not a raw event log.

Two consequences worth internalising before designing queries:

- **You cannot reconstruct real user journeys.** Session-scoped path data is
  not exposed. The `edges` cube (referrer → page) is the closest available
  substitute and is a genuine navigation graph, but chaining hops into paths is
  a Markov approximation, not session replay.
- **You cannot re-cut a cube you didn't collect.** Unlike a warehouse over raw
  events, adding a dimension means a new API pull. Cubes are cheap; add them to
  `REPORTS` and re-run — existing tables are untouched.

## Metric conventions

| Rule | Why |
|:---|:---|
| Only **additive** metrics are stored | so `sum()` over any grouping is correct |
| Rates are **not** stored — derive them | `engagementRate` averaged over days is wrong; `sum(engagedSessions)/sum(sessions)` is right |
| `activeUsers` is stored but **not additive** | summing over dates double-counts returning visitors |
| True uniques come from `users_rolling` | `active1DayUsers` / `active7DayUsers` / `active28DayUsers` are computed by GA over the window |
| `userEngagementDuration` is seconds, additive | per-session engagement = `sum(duration)/sum(sessions)` |

Bounce rate = `1 - sum(engagedSessions)/sum(sessions)`.

## Cubes

All tables have `date DATE` as the first column. Grain below is the dimension
set beyond `date`.

### Traffic and integrity
| Table | Grain | Metrics |
|:---|:---|:---|
| `totals` | — | sessions, engagedSessions, screenPageViews, activeUsers, newUsers, totalUsers, userEngagementDuration, eventCount |
| `users_rolling` | — | active1DayUsers, active7DayUsers, active28DayUsers, totalUsers, newUsers |
| `hourly` | hour | sessions, screenPageViews, activeUsers |
| `new_returning` | newVsReturning | sessions, engagedSessions, activeUsers, screenPageViews |

`hourly` and `new_returning` are the bot-detection cubes: automated traffic is
flat across the 24h clock and ~100% "new".

### Audience
| Table | Grain | Metrics |
|:---|:---|:---|
| `countries` | country | sessions, engagedSessions, activeUsers, screenPageViews |
| `cities` | country, region, city | sessions, activeUsers, screenPageViews |
| `languages` | language | sessions, activeUsers |
| `tech` | deviceCategory, operatingSystem, browser | sessions, engagedSessions, activeUsers, screenPageViews |

### Acquisition
| Table | Grain | Metrics |
|:---|:---|:---|
| `channels` | sessionDefaultChannelGroup | sessions, engagedSessions, activeUsers |
| `sources` | sessionSourceMedium | sessions, engagedSessions, activeUsers |
| `first_touch` | firstUserSourceMedium | activeUsers, newUsers, sessions |

`sources` is session-scoped (how *this visit* started); `first_touch` is
user-scoped (how the person *first ever* found the site). Do not compare their
totals directly.

### Content and behaviour
| Table | Grain | Metrics |
|:---|:---|:---|
| `pages` | pagePath | screenPageViews, sessions, activeUsers, userEngagementDuration |
| `landing` | landingPage | sessions, engagedSessions, activeUsers, screenPageViews |
| `edges` | pageReferrer, pagePath | screenPageViews |
| `events` | eventName | eventCount, activeUsers |
| `search` | searchTerm | eventCount, activeUsers |
| `hosts` | hostName | screenPageViews, sessions |

`search` is the highest-value cube for a documentation site: it is a direct
record of what people could not find.

## Deliberately not collected

Each was probed against the live property and returned nothing usable. They are
listed so nobody re-derives the same dead ends.

| Dimension | Result | To enable |
|:---|:---|:---|
| `userAgeBracket`, `userGender`, `brandingInterest` | **0 rows** | Requires **Google Signals**, currently off. See caveat below. |
| `contentGroup` | `(not set)` | Requires `content_group` on the page tag |
| `sessionCampaignName` | only `(direct)`/`(organic)`/`(referral)` | Requires UTM-tagged campaigns |
| `platform`, `audienceName`, `fileExtension`, `linkUrl`, `signedInWithUserId` | single constant value | Not applicable to this site |

### Caveat on demographics

Age, gender and interest data is unavailable because Google Signals is not
enabled. Turning it on is an **admin and policy decision, not a technical one**:
it activates cross-device tracking tied to signed-in Google accounts, carries
GDPR/consent obligations for a site with substantial EU traffic, and GA
withholds any row below a threshold to prevent re-identification — so small
segments stay blank regardless. For a scientific software site the analytical
payoff is likely low. That is the Bioconductor project's call to make, not one
to flip on for completeness.

## Cardinality and truncation

High-cardinality cubes are capped, ordered by the leading metric descending.
Caps live in `REPORTS`.

Fetches are chunked by month, but **a month that hits its cap is automatically
re-fetched day by day**, so the cap then applies per day. This matters more
than it sounds: a month-wide cap sorts by metric across the entire month, so
busy days get their rows cannibalised by quieter ones. Observed on 2026-06
before the fix — days 1–15 complete, days 16–30 down to 15% of actual
pageviews. That skews the time series rather than trimming a harmless tail.
Day-chunking costs ~30 extra requests, paid only for months that bind.

When a cap still binds *after* day-chunking, `ga_pull.py` prints
`[TRUNCATED at N/mo: 2024-03, ...]`.

Verify with `./ga_check.py`, which reconciles every dimensioned cube against
`totals` (which, having no dimensions, cannot be truncated) and fails on any
month below 98% coverage.

GA4 itself also buckets beyond-cardinality values into `(other)` server-side —
if you see `(other)` in a cube, that loss happened upstream and cannot be
recovered by raising a cap.

`pagePath` is the pressure point: ~374k distinct paths in 90 days, inflated by
per-package and per-release URLs.

## Refresh

```sh
./ga_pull.py ga.duckdb     # incremental; re-pulls trailing 3 days
```

Only days after each table's `max(date)` are fetched, minus a 3-day
re-pull window because GA4 revises recent data for ~48h. Adding a new cube
backfills it to 2023-06-22 without touching existing tables.
