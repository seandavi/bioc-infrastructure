import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { materialize, materializeVersions } from "./materialize.ts";
import app from "./repo.ts";
import { publish, putCasObject, putPackageVersion, setBiocVersions } from "./store.ts";
import { testBucket } from "./testr2.ts";
import { testDb } from "./testdb.ts";

const db = await testDb();
const sql = db.sql;
after(() => db.close());

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const BYTES = new TextEncoder().encode("0123456789abcdef");
const t = testBucket();
// The in-memory bucket ignores `range`; this one honors it the way R2 does for a Range header.
const bucket = {
  head: t.bucket.head.bind(t.bucket),
  put: t.bucket.put.bind(t.bucket),
  list: t.bucket.list.bind(t.bucket),
  async get(key: string, opts?: { range?: Headers }) {
    const o = await t.bucket.get(key);
    const m = opts?.range?.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!o || !m) return o;
    const offset = Number(m[1]), length = Number(m[2]) - offset + 1;
    return { ...o, body: new Blob([BYTES.slice(offset, offset + length)]).stream(), range: { offset, length } };
  },
} as unknown as R2Bucket;
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  app.request(path, { method, headers }, { BUCKET: bucket, HYPERDRIVE: { connectionString: db.url } });

const tgz = hex("limma-tgz"), zip = hex("limma-zip"), old = hex("limma_3.60.0");

test("setup", async () => {
  await setBiocVersions(sql, `release_version: "3.24"\ndevel_version: "3.25"\nr_ver_for_bioc_ver:\n  "3.24": "4.6"\n  "3.25": "4.6"\n`);
  for (const [v, sha] of [["3.60.0", old], ["3.61.0", tgz]]) {
    await putCasObject(sql, { sha256: sha, md5: sha.slice(0, 32), size_bytes: BYTES.length });
    await putPackageVersion(sql, { src_sha256: sha, package: "limma", version: v, description: { Package: "limma", Version: v, License: "GPL (>= 2)" } });
    await t.bucket.put(`cas/${sha}`, BYTES);
  }
  await putCasObject(sql, { sha256: zip, md5: zip.slice(0, 32), size_bytes: BYTES.length });
  await t.bucket.put(`cas/${zip}`, BYTES);
  const base = { bioc_version: "3.24", repo: "bioc", origin: "r-universe" as const, archs: ["linux"] };
  await publish(sql, { ...base, src_sha256: old });
  await publish(sql, { ...base, src_sha256: tgz,
    binaries: [{ os: "win", r_minor: "4.6", arch: "x86_64", filename: "limma_3.61.0.zip", sha256: zip }] });
  await materialize(bucket, sql, "3.24", "bioc");
  await materializeVersions(bucket, sql);
});

test("PACKAGES by version and by alias, with caching headers and CORS", async () => {
  const a = await get("/packages/3.24/bioc/src/contrib/PACKAGES");
  assert.equal(a.status, 200);
  assert.match(await a.text(), /Package: limma\nVersion: 3.61.0/);
  assert.equal(a.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(a.headers.get("cache-control"), "public, max-age=300");
  assert.equal(a.headers.get("access-control-allow-origin"), "*");
  assert.equal(a.headers.get("content-encoding"), null);
  const b = await get("/packages/release/bioc/src/contrib/PACKAGES");
  assert.equal(b.headers.get("etag"), a.headers.get("etag"));
  assert.equal((await get("/packages/devel/bioc/src/contrib/PACKAGES")).status, 404, "devel has no files here");
  assert.equal((await get("/packages/3.24/bioc/src/contrib/PACKAGES.gz")).headers.get("content-type"), "application/gzip");
  assert.equal((await get("/packages/3.24/bioc/VIEWS")).status, 200);
  assert.equal((await get("/packages/3.24/bioc/index.json")).headers.get("content-type"), "application/json");
});

test("if-none-match answers 304", async () => {
  const etag = (await get("/packages/3.24/bioc/src/contrib/PACKAGES")).headers.get("etag")!;
  const r = await get("/packages/3.24/bioc/src/contrib/PACKAGES", { "if-none-match": etag });
  assert.equal(r.status, 304);
  assert.equal(await r.text(), "");
  assert.equal((await get("/packages/3.24/bioc/src/contrib/PACKAGES", { "if-none-match": '"other"' })).status, 200);
});

test("artifacts: source, binary, HEAD and Range", async () => {
  const r = await get("/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz");
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), BYTES);
  assert.equal(r.headers.get("content-length"), "16");
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(r.headers.get("accept-ranges"), "bytes");

  const w = await get("/packages/release/bioc/bin/windows/contrib/4.6/limma_3.61.0.zip");
  assert.equal(w.status, 200);
  assert.equal((await get("/packages/3.24/bioc/bin/windows/contrib/4.6/limma_3.61.0.zip", {}, "HEAD")).status, 200);

  const p = await get("/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz", { range: "bytes=2-5" });
  assert.equal(p.status, 206);
  assert.equal(await p.text(), "2345");
  assert.equal(p.headers.get("content-range"), "bytes 2-5/16");
  assert.equal(p.headers.get("content-length"), "4");
});

test("Archive serves a superseded source, from the database", async () => {
  const r = await get("/packages/3.24/bioc/src/contrib/Archive/limma/limma_3.60.0.tar.gz");
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), BYTES);
  assert.equal((await get("/packages/3.24/bioc/src/contrib/Archive/limma/limma_3.61.0.tar.gz")).status, 404, "current is not archived");
  assert.equal((await get("/packages/3.24/bioc/src/contrib/Archive/limma/limma_9.tar.gz")).status, 404);
});

test("404s: unknown repo, file not in the index, wrong directory, traversal", async () => {
  for (const path of [
    "/packages/3.24/nope/src/contrib/PACKAGES",
    "/packages/3.24/bioc/src/contrib/limma_3.60.0.tar.gz", // superseded, only in Archive/
    "/packages/3.24/bioc/src/contrib/nothere_1.0.tar.gz",
    "/packages/3.24/bioc/bin/windows/contrib/4.5/limma_3.61.0.zip",
    "/packages/3.24/bioc/src/contrib/",
    "/packages/3.24/bioc/src/contrib/..%2f..%2findex.json",
    "/packages/3.24/bioc/src/contrib/../../../../cas/" + tgz,
    "/packages/3.24/bioc/cas/" + tgz,
    // Object.prototype members are not packages.
    "/packages/3.24/bioc/src/contrib/constructor_1.0.tar.gz",
    "/packages/3.24/bioc/src/contrib/toString_1.0.tar.gz",
  ]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  }
});
