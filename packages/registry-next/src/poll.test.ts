import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FIELDS, poll } from "./poll.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
after(() => db.close());

const { bucket, objects } = testBucket();
const env = { BUCKET: bucket };
let body = "", status = 200;
const urls: string[] = [];
const ru = (async (u: string) => (urls.push(u), new Response(body, { status }))) as typeof fetch;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const rows = async () => (await db.sql`select digest, r2_key, obs_ts, processed_at, recorded_at from observations
  where universe = 'bioc' order by obs_ts`).map((r) => ({ ...r }));
const tick = () => new Promise((res) => setTimeout(res, 5));

test("poll: a changed body is archived as sent, unparsed, and an unchanged one is not", async () => {
  body = "[{\"Package\": not even JSON";
  const p = await poll(env, db.sql, "bioc", ru);
  assert.equal(urls[0], `https://bioc.r-universe.dev/api/packages?limit=100000&fields=${FIELDS}`);
  assert.equal(p.status, "archived");
  assert.equal(p.digest, digest(body));
  assert.match(p.key!, new RegExp(`^obs/bioc/dt=\\d{4}-\\d{2}-\\d{2}/\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z-${p.digest.slice(0, 12)}\\.json$`));
  assert.equal(new TextDecoder().decode(objects.get(p.key!)!.bytes), body);
  const [row] = await rows();
  assert.deepEqual([row.digest, row.r2_key, row.processed_at, row.recorded_at], [p.digest, p.key, null, null]);
  assert.equal(row.obs_ts.toISOString().slice(0, 10), p.key!.slice(12, 22));

  const before = objects.size;
  assert.deepEqual(await poll(env, db.sql, "bioc", ru), { status: "unchanged", digest: p.digest });
  assert.equal(objects.size, before);
  assert.equal((await rows()).length, 1);
});

test("poll: an HTTP error writes nothing", async () => {
  const before = objects.size;
  status = 503;
  await assert.rejects(poll(env, db.sql, "bioc", ru), /bioc: HTTP 503/);
  status = 200;
  assert.equal(objects.size, before);
  assert.equal((await rows()).length, 1);
});

test("poll: a body that reverts to an older observation is archived again and its row reset", async () => {
  const a = body;
  await db.sql`update observations set processed_at = now(), recorded_at = now()`;
  await tick();
  body = "[]";
  const b = await poll(env, db.sql, "bioc", ru);
  assert.equal(b.status, "archived");
  await tick();
  body = a;
  const again = await poll(env, db.sql, "bioc", ru);
  assert.equal(again.status, "archived", "differs from the newest, though seen before");
  const [older, newest] = await rows();
  assert.equal(older.digest, b.digest);
  assert.deepEqual([newest.digest, newest.r2_key, newest.processed_at, newest.recorded_at], [digest(a), again.key, null, null]);
  assert.ok(objects.has(again.key!));
  assert.deepEqual(await poll(env, db.sql, "bioc", ru), { status: "unchanged", digest: digest(a) });
});
