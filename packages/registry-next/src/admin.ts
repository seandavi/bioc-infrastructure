// The maintenance routes, mounted at /admin behind the key check in index.ts, and the cron that
// drives the same work.
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { CHECKS_PER_TICK, DRAIN_SUBREQUESTS, LOGS_PER_TICK, SUBREQUESTS, SUBREQUEST_MARGIN, drain, metered } from "./capture.ts";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { materialize, materializeVersions } from "./materialize.ts";
import { migrate } from "./migrations.ts";
import { UNIVERSES, observe, refresh } from "./observe.ts";
import { poll } from "./poll.ts";
import { REPOS, biocVersion, status } from "./store.ts";

const admin = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

admin.post("/migrate", async (c) => c.json({ applied: await migrate(c.get("sql")) }));

// The repository files are written right after the work that changes them, never on a read.
async function write(env: Env, sql: Sql, touched: [string, string][] = []): Promise<string[]> {
  const written: string[] = [];
  for (const [v, repo] of touched) written.push(...await materialize(env.BUCKET, sql, v, repo));
  return written;
}

// A limit given as digits, or the default when absent. Infinity for anything else, so that
// "limit=" is a 400 rather than 0.
const count = (raw: string | undefined, dflt: number) =>
  raw === undefined ? dflt : /^\d+$/.test(raw) ? Number(raw) : Infinity;

admin.post("/refresh", async (c) => {
  const r = await refresh(c.get("sql"));
  return c.json({ ...r, written: await materializeVersions(c.env.BUCKET, c.get("sql")) });
});

const isUniverse = (u: string) => (UNIVERSES as readonly string[]).includes(u);
const UNIVERSE_ERROR = { error: `universe must be one of ${UNIVERSES.join(", ")}` };

// What the cron does each tick: r-universe's records, archived and recorded when they changed.
admin.post("/poll", async (c) => {
  const universe = c.req.query("universe") ?? "";
  if (!isUniverse(universe)) return c.json(UNIVERSE_ERROR, 400);
  return c.json(await poll(c.env, c.get("sql"), universe));
});

admin.post("/observe", async (c) => {
  const universe = c.req.query("universe") ?? "";
  if (!isUniverse(universe)) return c.json(UNIVERSE_ERROR, 400);
  const limit = count(c.req.query("limit"), 10);
  if (limit > 500) return c.json({ error: "limit must be 0..500" }, 400);
  const r = await observe(c.env, c.get("sql"), universe, { limit, write: (t) => write(c.env, c.get("sql"), t) });
  return c.json({ ...r, written: r.written ?? [] });
});

// What the cron does after observing: due captures copied from GitHub, within `budget`
// subrequests of the Worker's per-invocation limit (capture.ts).
const BUDGET_MAX = SUBREQUESTS - SUBREQUEST_MARGIN;
admin.post("/capture", async (c) => {
  const logs = count(c.req.query("logs"), LOGS_PER_TICK), checks = count(c.req.query("checks"), CHECKS_PER_TICK);
  const budget = count(c.req.query("budget"), DRAIN_SUBREQUESTS);
  if (logs > 200 || checks > 100 || budget > BUDGET_MAX)
    return c.json({ error: `logs must be 0..200, checks 0..100 and budget 0..${BUDGET_MAX}` }, 400);
  return c.json(await drain(c.env, c.get("sql"), { logs, checks, budget }));
});

// The operator's backfill of job_runs from the current registry's history (scripts/backfill-jobs.py).
// The same columns as job_runs, plus whether each capture was copied in already.
const str = z.string().nullish().transform((v) => v ?? null);
const ts = z.iso.datetime({ offset: true });
const ImportRow = z.object({
  builder: z.literal("r-universe").default("r-universe"), universe: z.enum(UNIVERSES), job: z.number().int().nonnegative(),
  package: str, version: str, src_sha256: str, config: str, r: str, check: str,
  time_s: z.number().int().nullish().transform((v) => v ?? null), artifact: str, bioc_version: str, commit: str,
  failure: z.boolean().default(false), built_at: ts.nullish().transform((v) => v ?? null),
  expires_at: ts.nullish().transform((v) => v ?? null), first_obs_ts: ts, last_obs_ts: ts,
  log_captured: z.boolean().default(false), check_captured: z.boolean().default(false),
});
const ImportBody = z.object({
  rows: z.array(ImportRow).max(5000)
    .refine((rs) => new Set(rs.map((r) => `${r.universe}/${r.job}`)).size === rs.length, "a job appears twice"),
});

// job_runs widened to cover what each row saw (a job seen before keeps its other columns), and
// its captures queued: done when copied in, gone when the artifact expired uncaptured, else
// pending. An existing done row is never downgraded, and a pending one is not reset.
admin.post("/import-jobs", async (c) => {
  const parsed = ImportBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
  const sql = c.get("sql"), rows = parsed.data.rows;
  return c.json(await sql.begin(async (tx) => {
    const [runs] = await tx`with x as (
        select * from jsonb_to_recordset(${tx.json(rows as never)}) as x(builder text, universe text, job bigint,
          package text, version text, src_sha256 text, config text, r text, "check" text, time_s integer,
          artifact text, bioc_version text, commit text, failure boolean, built_at timestamptz,
          expires_at timestamptz, first_obs_ts timestamptz, last_obs_ts timestamptz)),
      up as (insert into job_runs (builder, universe, job, package, version, src_sha256, config, r, "check",
          time_s, artifact, bioc_version, commit, failure, built_at, expires_at, first_obs_ts, last_obs_ts)
        select builder, universe, job, package, version, src_sha256, config, r, "check", time_s, artifact,
          bioc_version, commit, failure, built_at, expires_at, first_obs_ts, last_obs_ts from x
        on conflict (builder, universe, job) do update set
          first_obs_ts = least(job_runs.first_obs_ts, excluded.first_obs_ts),
          last_obs_ts = greatest(job_runs.last_obs_ts, excluded.last_obs_ts)
        returning xmax = 0 as fresh)
      select count(*) filter (where fresh)::int as inserted, count(*) filter (where not fresh)::int as updated from up`;
    const queued = await tx`with x as (
        select * from jsonb_to_recordset(${tx.json(rows as never)}) as x(builder text, universe text, job bigint,
          artifact text, expires_at timestamptz, log_captured boolean, check_captured boolean)),
      want as (
        select builder, universe, job, 'log' as kind, null as artifact, expires_at, log_captured as captured from x
        union all
        select builder, universe, job, 'check', artifact, expires_at, check_captured from x where artifact is not null),
      st as (select *, case when captured then 'done' when expires_at < now() then 'gone' else 'pending' end as status
        from want)
      insert into capture_queue (builder, universe, job, kind, artifact, expires_at, status, done_at)
      select builder, universe, job, kind, artifact, expires_at, status,
        case when status = 'pending' then null else now() end from st
      on conflict (builder, universe, job, kind) do update set status = excluded.status, done_at = excluded.done_at,
        lease = null
        where capture_queue.status <> 'done' and excluded.status not in ('pending', capture_queue.status)
      returning status`;
    const capture = { pending: 0, done: 0, gone: 0 } as Record<string, number>;
    for (const q of queued) capture[q.status]++;
    return { rows: rows.length, ...runs, capture };
  }));
});

// Rewrite one repository's files from the database, e.g. after a change to how they are rendered.
admin.post("/materialize", async (c) => {
  const v = await biocVersion(c.get("sql"), c.req.query("bioc_version") ?? "");
  const repo = c.req.query("repo") ?? "";
  if (!v || !(REPOS as readonly string[]).includes(repo))
    return c.json({ error: `bioc_version must be known and repo one of ${REPOS.join(", ")}` }, 400);
  return c.json({ written: await materialize(c.env.BUCKET, c.get("sql"), v.bioc_version, repo) });
});

admin.get("/status", async (c) => c.json(await status(c.get("sql"))));

export default admin;

// ponytail: no Workflows. A 15-minute cron observing a bounded
// batch per tick covers steady state (0 to 50 changed packages per observation); the first
// backfill is driven by calling POST /admin/observe in a loop.
export async function cron(base: Env, limit = 5): Promise<void> {
  const sql = connect(base);
  // Counted, so the drain is given what poll and observe left of the subrequest limit.
  const m = metered(base.BUCKET, globalThis.fetch);
  const env = { ...base, BUCKET: m.bucket }, f = m.fetch;
  try {
    const [v] = await sql`select coalesce(max(updated_at) < now() - interval '1 day', true) as stale
      from bioc_versions`;
    // Neither a failed refresh nor a failed write stops observation; versions.json is written
    // whenever it differs, so one that failed is retried on the next tick.
    if (v.stale)
      console.log("refresh", JSON.stringify(await refresh(sql, { fetch: f }).catch((e: Error) => ({ error: e.message }))));
    console.log("versions", JSON.stringify(await materializeVersions(env.BUCKET, sql).catch((e: Error) => ({ error: e.message }))));
    for (const u of UNIVERSES) {
      // One universe failing must not stop the other, and a failed poll still observes what the
      // last one archived.
      console.log("poll", u, JSON.stringify(await poll(env, sql, u, f).catch((e: Error) => ({ error: e.message }))));
      const r = await observe(env, sql, u, { limit, fetch: f, write: (t) => write(env, sql, t) })
        .catch((e: Error) => ({ error: e.message }));
      console.log("observe", u, JSON.stringify(r));
    }
    const budget = Math.max(0, SUBREQUESTS - SUBREQUEST_MARGIN - m.used());
    console.log("capture", budget, JSON.stringify(await drain(base, sql, { budget }).catch((e: Error) => ({ error: e.message }))));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
