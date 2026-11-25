import { test, after } from "node:test";
import assert from "node:assert/strict";
import app from "./index.ts";
import { MIGRATIONS } from "./migrations.ts";
import { testDb } from "./testdb.ts";

const db = await testDb();
after(() => db.close());
const env = { HYPERDRIVE: { connectionString: db.url }, MAINT_KEY: "k" };

test("migrations apply once and are idempotent through the route", async () => {
  const post = (key?: string) =>
    app.request("/admin/migrate", { method: "POST", headers: key ? { "x-maint-key": key } : {} }, env);
  assert.equal((await post()).status, 403);
  assert.equal((await post("wrong")).status, 403);
  // testDb() already migrated, so the route finds nothing to do.
  assert.deepEqual(await (await post("k")).json(), { applied: [] });
  const rows = await db.sql`select id from schema_migrations order by id`;
  assert.deepEqual(rows.map((r) => r.id), MIGRATIONS.map((m) => m.id));
});

test("an unset maintenance key closes the admin routes", async () => {
  const res = await app.request("/admin/migrate", { method: "POST", headers: { "x-maint-key": "" } },
    { HYPERDRIVE: env.HYPERDRIVE });
  assert.equal(res.status, 403);
});

test("one current publication per package and repository", async () => {
  const sha = "a".repeat(64);
  await db.sql`insert into cas_objects (sha256, size_bytes) values (${sha}, 1)`;
  await db.sql`insert into package_versions (src_sha256, package, version, description)
    values (${sha}, 'limma', '4.0.0', '{}')`;
  const pub = () => db.sql`insert into publications (bioc_version, repo, package, version, src_sha256, origin)
    values ('3.24', 'bioc', 'limma', '4.0.0', ${sha}, 'r-universe')`;
  await pub();
  await assert.rejects(pub(), /publications_current/);
});
