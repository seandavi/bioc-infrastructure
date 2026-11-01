# 0007 — Cloudflare Workflows carries the human-approval gate, starting with the release roll

- **Status:** Accepted
- **Date:** 2026-08-08

## Context

[Issue #34](https://github.com/seandavi/bioc-cloudflare/issues/34) named two hardcoded version
pairs that a Bioconductor release roll (~2×/year) invalidates, and one hazard behind them: a roll
changes sync *scope*, and `sync.sh` runs `rclone delete --files-from "$gone"` with no count check
at all. The issue measured ~129,000 objects in one such run — enough to blow past `PURGE_MAX` into
a full-zone purge, unattended, from an hourly timer. Its own conclusion was to automate the
detection and keep a human on the deletion.

One half of that has already changed underneath it. [ADR 0006](0006-old-releases-and-their-checkresults-are-archival.md)
(2026-08-07) removed the per-version `checkResults` carve-outs from `rsync-filter`; checkResults is
now mirrored in full for every release, so a roll no longer drops a version from scope and no
longer produces that particular 129k deletion. What survives is (a) `gen-redirects.ts`'s hardcoded
`v <= 24` container-binaries bound, whose failure mode is a silent 404 on the new release's
container binaries, and (b) the unguarded delete itself, which was never specific to release rolls
— a filter edit, an upstream reorganisation, or a partial rsync reaching the delete path all get
there too. A third hardcoded pair the issue does not list has since turned up in `justfile`
(`releases := "3.23,3.24"`, and `bioc="3.23"` defaults on `data-packages`/`data-tree`), which is
the argument for a detector rather than a longer checklist.

Nothing in this repo runs scheduled logic today except systemd timers on one host, whose own
hardcoded paths broke silently for 4.5 hours on 2026-08-08 — including the failure-alert path.
Adding "detect the roll, then wait for a person" to that host would put the guard behind the same
single point of failure it is guarding against.

A survey of durable-execution options (Temporal/Temporal Cloud, Restate, Inngest, Trigger.dev, AWS
Step Functions, Prefect, and Durable Objects directly) is summarised in `DATAPLANE.md`.

## Decision

**Pilot Cloudflare Workflows for the release-roll guard: detect drift unattended, then block on an
explicit human approval before anything destructive runs.** Not DO-first, not a managed
alternative.

- `worker/src/workflows/release-roll.ts` holds the pure decision logic; the `WorkflowEntrypoint`
  class and the `scheduled()` handler live in `worker/src/index.ts`, because a Workflow class must
  be exported from wrangler's `main` and the logic module is also loaded by `node --test`, which
  cannot resolve `cloudflare:workers`.
- The clock is a 15-minute Cron Trigger, not a long-lived sleeping instance. An instance that
  loops on `step.sleep()` at that cadence burns ~192 steps/day against a 10,000-step default
  ceiling — exhausted in under two months, with "poller silently stops" as the failure mode.
  Cron fires, the handler does the two 4-byte fetches inline, and only a detected drift creates
  an instance.
- The instance ID is derived from the observed version pair (`rollInstanceId`), so the trigger is
  idempotent per distinct upstream state: a cron re-fire, a retry, or a manual replay of the same
  pair finds the existing instance and creates nothing. The flip side is deliberate — a refused or
  timed-out instance is not re-raised every 15 minutes; the same pair alerts once per 30-day
  retention window.
- Detection reads `bioc-version` and `bioc-devel-version` (4 bytes each) over plain HTTP from the
  live origin. That answers #34's chicken-and-egg — the version must be known *before* deciding
  what to sync — without needing bioc-web, which is rrsync-locked and has no HTTP surface.
- The pinned bound is derived from the shipped `redirects.json` rather than kept as a second copy
  of `gen-redirects.ts`'s loop bound. Two copies of a number is how the first one went stale.
- Approval is `step.waitForEvent()`. Approving requires acknowledging a specific delete count; a
  plan that grew between alert and approval is refused rather than applied.
- Timeout and rejection are the same outcome: alert, do not apply. An unanswered alert is not
  consent.

Three properties of the platform shaped this and were the reason to choose it over writing the
same gate by hand:

1. **`waitForEvent` buffers an event sent before the instance reaches the wait step.** An operator
   who approves the instant the alert arrives does not race the workflow. Hand-rolling a gate on a
   queue or a webhook means building that buffer, and getting it wrong looks like a lost approval.
2. **Step outputs and event payloads cap at 1 MiB.** 129,000 keys do not fit. The enumerated
   delete list is written to R2 and only `{manifestKey, count}` crosses a step boundary. This is a
   constraint that had to be designed around, not a feature — but it is a documented, enforced one
   rather than a surprise at 3am.
3. **Sleeping costs nothing.** A twice-yearly job that spends 72 hours waiting for a person is
   effectively free, which removes the usual argument for cramming this into an existing cron.

## Consequences

- The guard does not live on the sync host, so it survives that host's failure modes — which is
  most of the point.
- **Applying is a record, not an action.** The workflow writes `_ops/release-roll/approved.json`
  to R2; nothing reads it yet. `sync.sh` gaining a gate on that object is a separate change, and
  until it exists the pilot detects and alerts but does not actually prevent the deletion. Stating
  this plainly because a half-wired guard that looks wired is worse than none.
- The alert path is a webhook POST behind `NOTIFY_URL`, defaulting to log-only. `bioc-notify@.service`
  files a GitHub issue for the host-side units; a Workflow has no systemd to hang `OnFailure=` off,
  and putting a GitHub token in a Worker secret is a decision to take on its own rather than a
  detail to settle here.
- The `^4` range on `@cloudflare/workers-types` already resolves to a Workflows-aware version
  (4.20260702 installed), so the entrypoint imports `WorkflowEntrypoint` from `cloudflare:workers`
  directly — no structural type declarations.
- Two known platform gaps are accepted rather than mitigated, both because the cadence is ~2×/year:
  **in-flight versioning against a new deploy is undocumented** (an instance can sit in
  `waitForEvent` for days across a Worker deploy with no stated compatibility story), and
  **there is no graceful cancellation** — a terminated instance runs no cleanup. Both are survivable
  here specifically because the correct response to a confused instance is "kill it and re-run
  detection", which costs two 4-byte fetches. Neither would be acceptable for a workflow that had
  already started mutating state, which is a further reason the destructive step is a human's to
  take.
- Local `wrangler dev` does not enforce production limits, and a twice-yearly trigger means a bug
  surfaces six months after it ships. The pure logic is therefore separated from the workflow body
  and unit-tested directly (`worker/test-release-roll.ts`), the same split `worker/src/keys.ts`
  already keeps from the `fetch` handler.

## Alternatives considered

**Durable Objects directly, with an alarm for the timeout.** Rejected for this. A DO gives
single-threaded consistency and a timer, but retries, step memoisation and event buffering would
all be hand-written — and Workflows V1 *was* a Durable Object, so this is reimplementing the thing
rather than avoiding it. DO stays the right answer for run-state that outlives a workflow instance
(Workflows retains completed-instance history for 30 days), which `DATAPLANE.md` treats as a later,
separate need.

**Temporal, Restate, Inngest or Trigger.dev.** Rejected on operational cost against the actual
shape: one linear flow, one wait, ~2 runs/year. Temporal needs a worker fleet for a job that runs
twice a year; the others add a second vendor and a second failure surface to a stack already
entirely on Workers and R2. The heuristic that decides this is in `DATAPLANE.md`: already-on-Workers
plus low volume plus a simple linear flow favours Workflows, while cross-language work, child
workflows, compensation, or instances that must survive months of deploys favour Temporal or
Restate. If the data plane later grows those, this decision should be revisited rather than
stretched.

**Bash in `sync.sh`: compare the versions, `exit 1` on mismatch (#34's option 3).** Rejected as the
*only* mechanism, not as a bad idea — a count guard in `sync.sh` is worth having regardless and is
the first item on the roadmap in `DATAPLANE.md`. But it inherits the host's failure modes, has
nowhere to hold "a human said yes to exactly this plan" between runs, and turns every roll into a
sync that is simply broken until someone notices, which is the silence the issue was written about.

**Fully automate the roll.** Rejected, per the issue's own conclusion. Detection is safe to
automate; a mass deletion is a deliberate, announced operation.
