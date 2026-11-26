import { test, after } from "node:test";
import assert from "node:assert/strict";
import app from "./index.ts";
import { MIGRATIONS } from "./migrations.ts";
import { publish, putCasObject, putPackageVersion, setBiocVersions } from "./store.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
const fresh = await testDb({ migrate: false });
after(async () => { await db.close(); await fresh.close(); });
const env = { HYPERDRIVE: { connectionString: db.url }, MAINT_KEY: "k" };

// Fixtures go in before the first test() so the after() hook cannot run ahead of them.
const CONFIG = `release_version: "3.24"\ndevel_version: "3.25"\nr_ver_for_bioc_ver:\n  "3.24": "4.6"\n  "3.25": "4.6"\n`;
await setBiocVersions(db.sql, CONFIG);
const S4 = "b".repeat(64);
await putCasObject(db.sql, { sha256: S4, md5: "c".repeat(32), size_bytes: 1 });
await putPackageVersion(db.sql, { src_sha256: S4, package: "S4Vectors", version: "0.50.1",
  description: { Package: "S4Vectors", Version: "0.50.1", License: "Artistic-2.0" } });
await publish(db.sql, { bioc_version: "3.24", repo: "bioc", src_sha256: S4, origin: "r-universe", archs: ["linux"] });

test("migrations apply once and are idempotent through the route", async () => {
  const post = (key?: string) => app.request("/admin/migrate", { method: "POST", headers: key ? { "x-maint-key": key } : {} },
    { ...env, HYPERDRIVE: { connectionString: fresh.url } });
  assert.equal((await post()).status, 403);
  assert.equal((await post("wrong")).status, 403);
  assert.deepEqual(await (await post("k")).json(), { applied: MIGRATIONS.map((m) => m.id) });
  assert.deepEqual(await (await post("k")).json(), { applied: [] });
  const rows = await fresh.sql`select id from schema_migrations order by id`;
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

// Response bodies are JSON whose shape the assertions check.
const body = (r: Response) => r.json() as Promise<any>;
const gateReq = (body: unknown) => app.request("/gate", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}, env);
const LINUX_OK = [{ config: "linux-x86_64", r: "4.6.1", check: "OK" }];

test("POST /gate decides against the current publications, with gating_r from bioc_versions", async () => {
  const res = await gateReq({ bioc_version: "release", repo: "bioc", candidates: [
    { package: "IRanges", version: "2.60.0", jobs: LINUX_OK, desc: { Imports: "S4Vectors (>= 0.51.0)" } },
    { package: "S4Vectors", version: "0.50.1", jobs: LINUX_OK },
  ] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const out = await body(res);
  assert.deepEqual(out.config, { gating_r: "4.6", bioccheck: "advisory", replace_seed: true });
  assert.deepEqual(out.approved, []);
  assert.match(out.decisions.IRanges.reasons.at(-1).detail, /S4Vectors \(>= 0.51.0\), published 0.50.1/);
  assert.equal(out.decisions.S4Vectors.reasons.find((r: { rule: string }) => r.rule === "version-gate").ok, false);
});

test("POST /gate: 400 for a malformed body, and for an unknown version without gating_r", async () => {
  assert.equal((await gateReq({ bioc_version: "3.24", repo: "bioc", candidates: [] })).status, 400);
  assert.equal((await gateReq({ bioc_version: "3.24", repo: "cran", candidates: [{ package: "a", version: "1", jobs: [] }] })).status, 400);
  const c = [{ package: "a", version: "1.0", jobs: LINUX_OK }];
  const unknown = await gateReq({ bioc_version: "3.99", repo: "bioc", candidates: c });
  assert.equal(unknown.status, 400);
  assert.match((await body(unknown)).error, /unknown bioc_version 3.99/);
  const given = await gateReq({ bioc_version: "3.99", repo: "bioc", candidates: c, config: { gating_r: "4.6" } });
  assert.equal((await body(given)).decisions.a.propagate, true);
});

test("POST /gate takes null where the current registry does, and refuses a name twice or not a package name", async () => {
  const ok = await gateReq({ bioc_version: "3.24", repo: "bioc", candidates: [{ package: "nulls", version: "1.0",
    jobs: [...LINUX_OK, { config: "bioc-checks", r: null, check: null }], source_git_url: null, stream: null }] });
  assert.equal(ok.status, 200);
  assert.equal((await body(ok)).decisions.nulls.propagate, true);
  const twice = await gateReq({ bioc_version: "3.24", repo: "bioc", candidates: [
    { package: "A", version: "1.0", jobs: LINUX_OK }, { package: "A", version: "0.9", jobs: [] }] });
  assert.equal(twice.status, 400);
  assert.match((await body(twice)).error, /duplicate package in candidates/);
  for (const name of ["__proto__", "1abc", "a_b"]) {
    const bad = await gateReq({ bioc_version: "3.24", repo: "bioc", candidates: [{ package: name, version: "1.0", jobs: [] }] });
    assert.equal(bad.status, 400, name);
  }
});

test("errors are {error} JSON with CORS; a 500 says nothing of its cause", async () => {
  const bad = await app.request("/gate", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }, env);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("access-control-allow-origin"), "*");
  assert.ok((await body(bad)).error);
  // Nothing listens on port 1, so the query fails with a connection error.
  const down = { ...env, HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/x" } };
  const logged = console.error;
  console.error = () => {};
  try {
    const res = await app.request(`/api/v1/cas/${S4}`, {}, down);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await body(res), { error: "internal server error" });
  } finally {
    console.error = logged;
  }
});

test("GET /api/v1/packages resolves release, and 404s what was never published", async () => {
  const res = await app.request("/api/v1/packages/release/bioc/S4Vectors", {}, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const doc = await body(res);
  assert.equal(doc.bioc_version, "3.24");
  assert.equal(doc.current.source.md5, "c".repeat(32));
  assert.equal((await app.request("/api/v1/packages/3.24/data/annotation/S4Vectors", {}, env)).status, 404);
  assert.equal((await app.request("/api/v1/packages/oldrel/bioc/S4Vectors", {}, env)).status, 400);
});

test("GET /api/v1/cas/{sha256}", async () => {
  const doc = await body(await app.request(`/api/v1/cas/${S4}`, {}, env));
  assert.deepEqual(doc.publications.map((p: { package: string; as: string }) => [p.package, p.as]), [["S4Vectors", "source"]]);
  assert.equal((await app.request(`/api/v1/cas/${"0".repeat(64)}`, {}, env)).status, 404);
});

test("GET /openapi.json is generated from the routes", async () => {
  const doc = await body(await app.request("/openapi.json", {}, env));
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    "/api/v1/cas/{sha256}",
    "/api/v1/packages/{bioc_version}/bioc/{package}",
    "/api/v1/packages/{bioc_version}/books/{package}",
    "/api/v1/packages/{bioc_version}/data/annotation/{package}",
    "/api/v1/packages/{bioc_version}/data/experiment/{package}",
    "/api/v1/packages/{bioc_version}/workflows/{package}",
    "/builds/{universe}/{job}",
    "/checks/{universe}/{job}",
    "/gate",
    "/logs/{universe}/{job}",
  ]);
});

test("GET /logs, /checks and /builds serve captures from the bucket only", async () => {
  const { bucket } = testBucket();
  await bucket.put("logs/bioc/123.txt", "a job log");
  await bucket.put("checks/bioc-release/123.json", JSON.stringify({ "00check.log": "Status: OK" }));
  await bucket.put("builds/bioc/123.json", JSON.stringify({ repos: [], deps: { abind: "1.4-8" } }));
  const get = (path: string) => app.request(path, {}, { ...env, BUCKET: bucket });
  const log = await get("/logs/bioc/123");
  assert.equal(log.status, 200);
  assert.equal(log.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(log.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(log.headers.get("access-control-allow-origin"), "*");
  assert.equal(await log.text(), "a job log");
  const check = await get("/checks/bioc-release/123");
  assert.equal(check.headers.get("content-type"), "application/json");
  assert.deepEqual(await check.json(), { "00check.log": "Status: OK" });
  assert.deepEqual(await body(await get("/builds/bioc/123")), { repos: [], deps: { abind: "1.4-8" } });
  for (const path of ["/logs/bioc-release/123", "/checks/bioc/123", "/builds/bioc/124"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  for (const path of ["/logs/cran/123", "/logs/bioc/12a", "/checks/bioc/-1"]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.ok((await body(res)).error, path);
  }
});
