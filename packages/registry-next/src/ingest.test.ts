import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "./db.ts";
import { binaryIn, contentType, ingestSource, openArtifact, storeObject } from "./ingest.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
const sql = connect({ HYPERDRIVE: { connectionString: db.url } });
const tmp = mkdtempSync(join(tmpdir(), "ingest-test-"));
after(async () => { await sql.end(); await db.close(); rmSync(tmp, { recursive: true, force: true }); });

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const opened = (b: Uint8Array) => async () => ({ body: new Blob([b]).stream(), size: b.length });

let n = 0;
function tgz(files: Record<string, string>): Buffer {
  const dir = join(tmp, `t${n++}`);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "demo", p)), { recursive: true });
    writeFileSync(join(dir, "demo", p), c);
  }
  return execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", dir, "demo"]);
}

test("storeObject: writes once, records size and md5, and is idempotent", async () => {
  const { bucket, objects } = testBucket();
  const bytes = new TextEncoder().encode("some artifact");
  let opens = 0;
  const open = async () => (opens++, opened(bytes)());
  assert.equal(await storeObject(bucket, sql, sha(bytes), open, "https://example.org/a"), true);
  assert.equal(await storeObject(bucket, sql, sha(bytes), open, "https://example.org/a"), true);
  assert.equal(opens, 1);
  assert.ok(objects.has(`cas/${sha(bytes)}`));
  const [row] = await db.sql`select md5, size_bytes::int as size, source_url from cas_objects where sha256 = ${sha(bytes)}`;
  assert.deepEqual({ ...row }, { md5: md5(bytes), size: bytes.length, source_url: "https://example.org/a" });
});

test("storeObject: an object without its row is recorded from head(), not fetched again", async () => {
  const { bucket } = testBucket();
  const bytes = new TextEncoder().encode("put, then the Worker died");
  await bucket.put(`cas/${sha(bytes)}`, bytes, { sha256: sha(bytes) });
  const never = async () => { throw new Error("must not open"); };
  assert.equal(await storeObject(bucket, sql, sha(bytes), never, null), true);
  const [row] = await db.sql`select md5 from cas_objects where sha256 = ${sha(bytes)}`;
  assert.equal(row.md5, md5(bytes));
});

test("storeObject: an object R2 never verified against its key is written again, verified", async () => {
  const { bucket, objects } = testBucket();
  const bytes = new TextEncoder().encode("the real bytes");
  await bucket.put(`cas/${sha(bytes)}`, "something else, put without a sha256");
  let opens = 0;
  assert.equal(await storeObject(bucket, sql, sha(bytes), async () => (opens++, opened(bytes)()), null), true);
  assert.equal(opens, 1);
  assert.equal(new TextDecoder().decode(objects.get(`cas/${sha(bytes)}`)!.bytes), "the real bytes");
  const [row] = await db.sql`select md5, size_bytes::int as size from cas_objects where sha256 = ${sha(bytes)}`;
  assert.deepEqual({ ...row }, { md5: md5(bytes), size: bytes.length });
});

test("storeObject: bytes that do not hash to the key are rejected and nothing is recorded", async () => {
  const { bucket, objects } = testBucket();
  const want = sha(new TextEncoder().encode("expected"));
  await assert.rejects(storeObject(bucket, sql, want, opened(new TextEncoder().encode("other")), null), /sha256/);
  assert.equal(objects.size, 0);
  assert.equal((await db.sql`select 1 from cas_objects where sha256 = ${want}`).length, 0);
  assert.equal(await storeObject(bucket, sql, "f".repeat(64), async () => null, null), false, "no bytes anywhere");
  await assert.rejects(storeObject(bucket, sql, "../x", async () => null, null), /not a sha256/);
});

test("storeObject: a copy that stalls fails by name instead of hanging, and records nothing", async () => {
  const { bucket } = testBucket();
  const bytes = new TextEncoder().encode("never arrives");
  const never = new Promise<never>(() => {});
  const stuckPut = { ...bucket, head: bucket.head, put: () => never } as unknown as R2Bucket;
  await assert.rejects(storeObject(stuckPut, sql, sha(bytes), opened(bytes), null, () => 30),
    new RegExp(`put cas/${sha(bytes)}: nothing after`));
  await assert.rejects(storeObject(bucket, sql, sha(bytes), () => never, null, () => 30), /open cas\/.*: nothing after/);
  assert.equal((await sql`select 1 from cas_objects where sha256 = ${sha(bytes)}`).length, 0);
});

test("openArtifact: r-universe's store, null on 404", async () => {
  const urls: string[] = [];
  const f = (async (u: string) => {
    urls.push(u);
    return u.endsWith("a".repeat(64)) ? new Response("remote", { headers: { "content-length": "6" } }) : new Response("", { status: 404 });
  }) as typeof fetch;
  const a = (await openArtifact("a".repeat(64), f))!;
  assert.equal(a.size, 6);
  assert.equal(await new Response(a.body).text(), "remote");
  assert.equal(await openArtifact("b".repeat(64), f), null);
  assert.deepEqual(urls, [`https://r2.ropensci.org/${"a".repeat(64)}`, `https://r2.ropensci.org/${"b".repeat(64)}`]);
  // No content-length and no size from the record: an error, not an empty object.
  const bare = (async () => new Response(new Blob(["remote"]).stream())) as unknown as typeof fetch;
  await assert.rejects(openArtifact("c".repeat(64), bare), /no content-length/);
  await assert.rejects(openArtifact("c".repeat(64), bare, null), /no content-length/);
  assert.equal((await openArtifact("c".repeat(64), bare, 6))!.size, 6);
});

test("ingestSource: the package_versions row and the documents, once", async () => {
  const { bucket, objects } = testBucket();
  const gz = tgz({
    DESCRIPTION: "Package: demo\nVersion: 1.2.3\nImports: S4Vectors\nLicense: MIT\n",
    "NEWS.md": "# demo 1.2.3", "inst/doc/intro.html": "<html></html>", "inst/doc/intro.R": "x <- 1",
    "R/f.R": "f <- 1",
  });
  const s = sha(gz);
  await storeObject(bucket, sql, s, opened(gz), null);
  const extra = { meta: { vignettes: [{ filename: "intro.html", title: "Intro" }] }, git_url: "https://github.com/bioc/demo",
    git_branch: "RELEASE_3_24", git_commit: "c".repeat(40), git_commit_at: "2026-11-01T00:00:00.000Z" };
  const want = { package: "demo", version: "1.2.3" };
  // Not the package the caller expected: no documents and no row.
  await assert.rejects(ingestSource(bucket, sql, s, extra, { package: "other", version: "1.2.3" }),
    /source tarball is demo 1.2.3, not other 1.2.3/);
  await assert.rejects(ingestSource(bucket, sql, s, extra, { package: "demo", version: "9" }), /not demo 9/);
  assert.equal([...objects.keys()].filter((k) => k.startsWith("docs/")).length, 0);
  assert.equal((await db.sql`select 1 from package_versions where src_sha256 = ${s}`).length, 0);
  assert.deepEqual(await ingestSource(bucket, sql, s, extra, want), want);
  const [row] = await db.sql`select package, version, description, files, meta, git_branch from package_versions where src_sha256 = ${s}`;
  assert.equal(row.description.Imports, "S4Vectors");
  assert.deepEqual(row.files.instDoc.sort(), ["intro.R", "intro.html"]);
  assert.deepEqual(row.meta, extra.meta);
  assert.equal(row.git_branch, "RELEASE_3_24");
  const docs = [...objects.keys()].filter((k) => k.startsWith("docs/")).sort();
  assert.deepEqual(docs, [`docs/${s}/NEWS.md`, `docs/${s}/inst/doc/intro.R`, `docs/${s}/inst/doc/intro.html`]);
  assert.equal(objects.get(`docs/${s}/inst/doc/intro.html`)!.httpMetadata.contentType, "text/html; charset=utf-8");
  assert.equal(objects.get(`docs/${s}/NEWS.md`)!.httpMetadata.contentType, "text/plain; charset=utf-8");
  objects.delete(`cas/${s}`); // done means the row: no second read
  assert.deepEqual(await ingestSource(bucket, sql, s, {}, want), want);
  await assert.rejects(ingestSource(bucket, sql, s, {}, { package: "other", version: "1.2.3" }), /not other 1.2.3/,
    "an existing row is checked too");
});

test("binaryIn normalizes r-universe's architectures and R versions", () => {
  const b = (arch?: string) => binaryIn({ os: "linux", r: "4.6.2", sha256: "a", arch, file: "x.tar.gz" });
  assert.deepEqual([b("aarch64").arch, b("amd64").arch, b("x86_64").arch, b("linux-aarch64").arch, b().arch],
    ["arm64", "x86_64", "x86_64", "arm64", ""]);
  assert.equal(b().r_minor, "4.6");
});

test("contentType: extensionless documents and R's own text formats are text", () => {
  for (const p of ["NEWS", "README", "LICENCE", "inst/CITATION", "inst/NEWS", "inst/doc/a.Rnw", "inst/doc/a.qmd", "inst/NEWS.Rd", "NEWS.md"])
    assert.equal(contentType(p), "text/plain; charset=utf-8", p);
  assert.equal(contentType("inst/doc/a.html"), "text/html; charset=utf-8");
  assert.equal(contentType("build/vignette.rds"), "application/octet-stream");
});
