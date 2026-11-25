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
// The in-memory bucket ignores `range`; this one honors an { offset, length } range as R2 does:
// a whole read reports a range too, and an offset past the end is R2's error 10039.
const ranges: unknown[] = [];
const bucket = {
  head: t.bucket.head.bind(t.bucket),
  put: t.bucket.put.bind(t.bucket),
  list: t.bucket.list.bind(t.bucket),
  async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
    const o = await t.bucket.get(key);
    if (!o) return o;
    const bytes = new Uint8Array(await o.arrayBuffer());
    if (!opts?.range) return { ...o, range: { offset: 0, length: bytes.length } };
    ranges.push(opts.range);
    const { offset, length = bytes.length - offset } = opts.range;
    if (offset >= bytes.length) throw new Error("get: The requested range is not satisfiable (10039)");
    return { ...o, body: new Blob([bytes.slice(offset, offset + length)]).stream(), range: { offset, length } };
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
  assert.equal((await get("/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz", {}, "HEAD")).headers.get("content-length"), "16");
});

test("Range: one well-formed byte range is a 206, an unsatisfiable one a 416, anything else the whole file", async () => {
  const path = "/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz";
  const part = async (range: string) => {
    const r = await get(path, { range });
    return [r.status, r.headers.get("content-range"), await r.text()];
  };
  assert.deepEqual(await part("bytes=10-"), [206, "bytes 10-15/16", "abcdef"]);
  assert.deepEqual(await part("bytes=-3"), [206, "bytes 13-15/16", "def"]);
  assert.deepEqual(await part("bytes=-100"), [206, "bytes 0-15/16", "0123456789abcdef"]);
  assert.deepEqual(await part("bytes=14-99"), [206, "bytes 14-15/16", "ef"]);
  for (const range of ["bytes=16-", "bytes=99-100", "bytes=-0"])
    assert.deepEqual(await part(range), [416, "bytes */16", ""], range);
  ranges.length = 0;
  for (const range of ["bytes=0-1, 4-5", "items=0-1", "bytes=5-2", "bytes=x-", "bytes="])
    assert.deepEqual(await part(range), [200, null, "0123456789abcdef"], range);
  assert.deepEqual(ranges, [], "R2 is given no range it would have to interpret");
});

test("cache headers: immutable only for a numbered version's file that is not a seed", async () => {
  const cc = async (path: string) => (await get(path)).headers.get("cache-control");
  assert.equal(await cc("/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz"), "public, max-age=31536000, immutable");
  assert.equal(await cc("/packages/release/bioc/src/contrib/limma_3.61.0.tar.gz"), "public, max-age=300");
  assert.equal(await cc("/packages/3.24/bioc/src/contrib/Archive/limma/limma_3.60.0.tar.gz"), "public, max-age=31536000, immutable");
  const seed = hex("seeded_1.0");
  await putCasObject(sql, { sha256: seed, md5: seed.slice(0, 32), size_bytes: BYTES.length });
  await putPackageVersion(sql, { src_sha256: seed, package: "seeded", version: "1.0", description: { Package: "seeded", Version: "1.0", License: "MIT" } });
  await t.bucket.put(`cas/${seed}`, BYTES);
  await publish(sql, { bioc_version: "3.24", repo: "bioc", src_sha256: seed, origin: "bioconductor", archs: [] });
  await materialize(bucket, sql, "3.24", "bioc");
  // Not in the index this isolate cached a moment ago: read again rather than 404.
  assert.equal(await cc("/packages/3.24/bioc/src/contrib/seeded_1.0.tar.gz"), "public, max-age=300");
});

test("versions.json: etag, 304 and content-length", async () => {
  const a = await get("/packages/versions.json");
  assert.equal(a.status, 200);
  assert.ok(a.headers.get("etag"));
  assert.equal(a.headers.get("content-length"), String((await a.text()).length));
  assert.equal((await get("/packages/versions.json", { "if-none-match": a.headers.get("etag")! })).status, 304);
  assert.ok((await get("/packages/3.24/bioc/src/contrib/PACKAGES", {}, "HEAD")).headers.get("content-length"));
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
    // Only the directories R asks for: no extra depth, no made-up macOS directory.
    "/packages/3.24/bioc/bin/windows/contrib/4.6/foo/limma_3.61.0.zip",
    "/packages/3.24/bioc/bin/windows/contrib/4.6/foo/PACKAGES",
    "/packages/3.24/bioc/bin/macosx/anything/contrib/4.6/limma_3.61.0.tgz",
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

test("index.json: one load per key at a time", async () => {
  let gets = 0;
  const counted = { ...bucket, head: bucket.head, get: (k: string, o?: unknown) => (k.endsWith("index.json") && gets++, bucket.get(k, o as never)) } as unknown as R2Bucket;
  const env = { BUCKET: counted, HYPERDRIVE: { connectionString: db.url } };
  const rs = await Promise.all([0, 1, 2, 3, 4].map(() =>
    app.request("/packages/3.24/bioc/src/contrib/limma_3.61.0.tar.gz", {}, env)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(gets, 1);
});
