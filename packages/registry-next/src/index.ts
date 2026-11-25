import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { migrate } from "./migrations.ts";

const app = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

// A client per request, closed after the response. Connecting is lazy, so a route that
// never queries costs nothing.
app.use(async (c, next) => {
  const sql = connect(c.env);
  c.set("sql", sql);
  try {
    await next();
  } finally {
    const done = sql.end({ timeout: 5 });
    try {
      c.executionCtx.waitUntil(done);
    } catch {
      await done; // no ExecutionContext under app.request() in tests
    }
  }
});

// Everything that writes needs the maintenance key. Unset means closed, not open.
const sha = (s: string) => createHash("sha256").update(s).digest();
app.use("/admin/*", async (c, next) => {
  const key = c.env.MAINT_KEY;
  if (!key || !timingSafeEqual(sha(c.req.header("x-maint-key") ?? ""), sha(key)))
    return c.json({ error: "forbidden" }, 403);
  await next();
});

app.get("/", (c) => c.json({ service: "bioc-registry-next", status: "shadow" }));

app.post("/admin/migrate", async (c) => c.json({ applied: await migrate(c.get("sql")) }));

export default app;
