// The maintenance routes, mounted at /admin behind the key check in index.ts, and the cron that
// drives the same work.
import { Hono } from "hono";
import type { Sql } from "postgres";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { migrate } from "./migrations.ts";
import { UNIVERSES, observe, refresh } from "./observe.ts";
import { status } from "./store.ts";

const admin = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

admin.post("/migrate", async (c) => c.json({ applied: await migrate(c.get("sql")) }));

admin.post("/refresh", async (c) => c.json(await refresh(c.get("sql"))));

admin.post("/observe", async (c) => {
  const universe = c.req.query("universe") ?? "";
  if (!(UNIVERSES as readonly string[]).includes(universe))
    return c.json({ error: `universe must be one of ${UNIVERSES.join(", ")}` }, 400);
  const limit = Number(c.req.query("limit") ?? 10);
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) return c.json({ error: "limit must be 0..500" }, 400);
  return c.json(await observe(c.env, c.get("sql"), universe, { limit }));
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
    if (v.stale) console.log("refresh", JSON.stringify(await refresh(sql)));
    for (const u of UNIVERSES) {
      // One universe failing must not stop the other.
      const r = await observe(env, sql, u, { limit }).catch((e: Error) => ({ error: e.message }));
      console.log("observe", u, JSON.stringify(r));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
