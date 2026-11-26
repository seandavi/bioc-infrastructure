// The maintenance routes, mounted at /admin behind the key check in index.ts, and the cron that
// drives the same work.
import { Hono } from "hono";
import type { Sql } from "postgres";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { materialize, materializeVersions } from "./materialize.ts";
import { migrate } from "./migrations.ts";
import { UNIVERSES, observe, refresh } from "./observe.ts";
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

admin.post("/observe", async (c) => {
  const universe = c.req.query("universe") ?? "";
  if (!(UNIVERSES as readonly string[]).includes(universe))
    return c.json({ error: `universe must be one of ${UNIVERSES.join(", ")}` }, 400);
  const limit = count(c.req.query("limit"), 10);
  if (limit > 500) return c.json({ error: "limit must be 0..500" }, 400);
  const r = await observe(c.env, c.get("sql"), universe, { limit, write: (t) => write(c.env, c.get("sql"), t) });
  return c.json({ ...r, written: r.written ?? [] });
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

// ponytail: no Workflows and no queue. A 15-minute cron draining a bounded batch per tick covers
// steady state (0 to 50 changed packages per observation); the first backfill is driven by
// calling POST /admin/observe in a loop.
export async function cron(env: Env, limit = 5): Promise<void> {
  const sql = connect(env);
  try {
    const [v] = await sql`select coalesce(max(updated_at) < now() - interval '1 day', true) as stale
      from bioc_versions`;
    // Neither a failed refresh nor a failed write stops observation; versions.json is written
    // whenever it differs, so one that failed is retried on the next tick.
    if (v.stale)
      console.log("refresh", JSON.stringify(await refresh(sql).catch((e: Error) => ({ error: e.message }))));
    console.log("versions", JSON.stringify(await materializeVersions(env.BUCKET, sql).catch((e: Error) => ({ error: e.message }))));
    for (const u of UNIVERSES) {
      // One universe failing must not stop the other.
      const r = await observe(env, sql, u, { limit, write: (t) => write(env, sql, t) })
        .catch((e: Error) => ({ error: e.message }));
      console.log("observe", u, JSON.stringify(r));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
