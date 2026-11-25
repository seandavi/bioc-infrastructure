import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./db.ts";
import { ingestSource, storeObject } from "./ingest.ts";
import { seed } from "./seed.ts";
import { publish, setBiocVersions } from "./store.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
const sql = connect({ HYPERDRIVE: { connectionString: db.url } });
const tmp = mkdtempSync(join(tmpdir(), "seed-test-"));
after(async () => { await sql.end(); await db.close(); rmSync(tmp, { recursive: true, force: true }); });

await setBiocVersions(sql, `release_version: "3.24"\ndevel_version: "3.25"\nr_ver_for_bioc_ver:\n  "3.24": "4.6"\n  "3.25": "4.6"\n`);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

let n = 0;
function tgz(pkg: string, version: string, extra = ""): Buffer {
  const dir = join(tmp, `t${n++}`);
  mkdirSync(join(dir, pkg), { recursive: true });
  writeFileSync(join(dir, pkg, "DESCRIPTION"), `Package: ${pkg}\nVersion: ${version}\nLicense: MIT\n${extra}`);
  return execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", dir, pkg]);
}

// bioconductor.org, as a map from URL to body. Every fetch is counted.
const B = "https://bioconductor.org/packages/3.24";
const site: Record<string, Uint8Array | string | (() => Response)> = {};
const hits: Record<string, number> = {};
const f = (async (u: string) => {
  hits[u] = (hits[u] ?? 0) + 1;
  const p = site[u];
  return p === undefined ? new Response("", { status: 404 }) : typeof p === "function" ? p() : new Response(p);
}) as typeof fetch;
const stanza = (pkg: string, version: string, gz?: Uint8Array) =>
  `Package: ${pkg}\nVersion: ${version}\n${gz ? `MD5sum: ${md5(gz)}\n` : ""}`;

const { bucket, objects } = testBucket();
const env = { BUCKET: bucket };

test("a repository bioconductor.org does not have is absent", async () => {
  assert.deepEqual(await seed(env, sql, "3.24", "books", { fetch: f }), { status: "absent" });
});

test("a hole is seeded from the tarball, with VIEWS' git fields, once", async () => {
  const gz = tgz("org.Xx.eg.db", "3.22.0", "Depends: R (>= 2.7.0)\n");
  site[`${B}/data/annotation/src/contrib/PACKAGES`] = stanza("org.Xx.eg.db", "3.22.0", gz) + "\n" + stanza("odd", "1.0-a");
  site[`${B}/data/annotation/src/contrib/org.Xx.eg.db_3.22.0.tar.gz`] = gz;
  site[`${B}/data/annotation/VIEWS`] = "Package: org.Xx.eg.db\nVersion: 3.22.0\ngit_url: https://git.bioconductor.org/packages/org.Xx.eg.db\n" +
    "git_branch: RELEASE_3_24\ngit_last_commit: abc1234\ngit_last_commit_date: 2026-10-29\n";
  const r = await seed(env, sql, "3.24", "data/annotation", { fetch: f });
  assert.deepEqual(r, {
    status: "done", seeded: [{ package: "org.Xx.eg.db", version: "3.22.0" }], failed: [], too_large: [],
    remaining: 0, next: "org.Xx.eg.db", touched: [["3.24", "data/annotation"]],
  }, "odd's version is not an R version, so it is not a hole");
  assert.equal(hits[`${B}/data/annotation/src/contrib/org.Xx.eg.db_3.22.0.tar.gz`], 2, "hashed, then stored");
  assert.ok(objects.has(`cas/${sha(gz)}`));
  const [pv] = await db.sql`select package, version, description, git_url, git_branch, git_commit,
    git_commit_at::text as at from package_versions where src_sha256 = ${sha(gz)}`;
  assert.deepEqual([pv.package, pv.version, pv.description.Depends], ["org.Xx.eg.db", "3.22.0", "R (>= 2.7.0)"]);
  assert.deepEqual([pv.git_branch, pv.git_commit], ["RELEASE_3_24", "abc1234"]);
  assert.match(pv.at, /^2026-10-29/);
  const [p] = await db.sql`select origin, bioccheck, to_jsonb(archs) as archs from publications
    where bioc_version = '3.24' and repo = 'data/annotation' and package = 'org.Xx.eg.db' and superseded_at is null`;
  assert.deepEqual({ ...p }, { origin: "bioconductor", bioccheck: null, archs: [] });

  const again = await seed(env, sql, "3.24", "data/annotation", { fetch: f });
  assert.deepEqual([again.status, "remaining" in again && again.remaining, "seeded" in again && again.seeded], ["done", 0, []]);
});

test("a package with a current r-universe publication is never touched, even behind the official version", async () => {
  const gz = tgz("built", "1.0.0");
  await storeObject(bucket, sql, sha(gz), async () => ({ body: new Blob([gz]).stream(), size: gz.length }), null);
  await ingestSource(bucket, sql, sha(gz), {});
  await publish(sql, { bioc_version: "3.24", repo: "workflows", src_sha256: sha(gz), origin: "r-universe", archs: ["linux"] });
  site[`${B}/workflows/src/contrib/PACKAGES`] = stanza("built", "1.2.0") + "\n" + stanza("huge", "1.0");
  // Larger than one R2 put, by content-length: reported, not read.
  site[`${B}/workflows/src/contrib/huge_1.0.tar.gz`] = () => new Response("x", { headers: { "content-length": "6000000000" } });
  const r = await seed(env, sql, "3.24", "workflows", { fetch: f });
  assert.deepEqual(r, { status: "done", seeded: [], failed: [], too_large: [{ package: "huge", version: "1.0" }],
    remaining: 0, next: "huge", touched: [] });
  assert.equal(hits[`${B}/workflows/src/contrib/built_1.2.0.tar.gz`], undefined);
  const [p] = await db.sql`select version, origin from publications where package = 'built' and superseded_at is null`;
  assert.deepEqual({ ...p }, { version: "1.0.0", origin: "r-universe" });
});

test("failures are reported without stopping the rest, and after/next move past them", async () => {
  const good = tgz("dgood", "1.0"), wrong = tgz("other", "1.0"), b = tgz("bmd5", "1.0");
  site[`${B}/data/experiment/src/contrib/PACKAGES`] = [
    stanza("a404", "1.0"), `Package: bmd5\nVersion: 1.0\nMD5sum: ${"0".repeat(32)}\n`,
    stanza("cother", "1.0"), stanza("dgood", "1.0", good),
  ].join("\n");
  site[`${B}/data/experiment/src/contrib/bmd5_1.0.tar.gz`] = b;
  site[`${B}/data/experiment/src/contrib/cother_1.0.tar.gz`] = wrong;
  site[`${B}/data/experiment/src/contrib/dgood_1.0.tar.gz`] = good;

  const one = await seed(env, sql, "3.24", "data/experiment", { fetch: f, limit: 2 });
  assert.ok(one.status === "partial");
  assert.deepEqual(one.failed.map((x) => x.package), ["a404", "bmd5"]);
  assert.match(one.failed[0].error, /HTTP 404/);
  assert.match(one.failed[1].error, /md5/);
  assert.equal(objects.has(`cas/${sha(b)}`), false, "an md5 mismatch stores nothing");
  assert.deepEqual([one.remaining, one.next], [2, "bmd5"]);

  const two = await seed(env, sql, "3.24", "data/experiment", { fetch: f, limit: 2, after: one.next! });
  assert.ok(two.status === "done");
  assert.deepEqual(two.failed.map((x) => x.package), ["cother"]);
  assert.match(two.failed[0].error, /other 1.0, not cother 1.0/);
  assert.deepEqual(two.seeded, [{ package: "dgood", version: "1.0" }]);
  assert.deepEqual([two.remaining, two.next], [0, "dgood"]);

  const three = await seed(env, sql, "3.24", "data/experiment", { fetch: f, limit: 2, after: two.next! });
  assert.deepEqual(three, { status: "done", seeded: [], failed: [], too_large: [], remaining: 0, next: "dgood", touched: [] });
  // Without after, the failures are holes again: the loop that skips them is the caller's.
  const fresh = await seed(env, sql, "3.24", "data/experiment", { fetch: f, limit: 0 });
  assert.ok(fresh.status === "partial" && fresh.remaining === 3);
});

test("binaries: only those listed at the source's version, and a failing one is left out; a build then replaces the seed", async () => {
  const gz = tgz("withbin", "2.0"), zip = new TextEncoder().encode("a windows zip");
  site[`${B}/bioc/src/contrib/PACKAGES`] = stanza("withbin", "2.0", gz);
  site[`${B}/bioc/src/contrib/withbin_2.0.tar.gz`] = gz;
  site[`${B}/bioc/bin/windows/contrib/4.6/PACKAGES`] = stanza("withbin", "2.0", zip);
  site[`${B}/bioc/bin/windows/contrib/4.6/withbin_2.0.zip`] = zip;
  site[`${B}/bioc/bin/macosx/sonoma-arm64/contrib/4.6/PACKAGES`] = stanza("withbin", "1.9");
  site[`${B}/bioc/bin/macosx/sonoma-arm64/contrib/4.6/withbin_2.0.tgz`] = "never fetched";
  site[`${B}/bioc/bin/macosx/big-sur-x86_64/contrib/4.6/PACKAGES`] = stanza("withbin", "2.0"); // the tgz is a 404
  const r = await seed(env, sql, "3.24", "bioc", { fetch: f });
  assert.ok(r.status === "done");
  assert.deepEqual(r.seeded, [{ package: "withbin", version: "2.0" }]);
  assert.equal(hits[`${B}/bioc/bin/macosx/sonoma-arm64/contrib/4.6/withbin_2.0.tgz`], undefined);
  assert.equal(hits[`${B}/bioc/bin/macosx/big-sur-x86_64/contrib/4.6/withbin_2.0.tgz`], 1);
  const arts = await db.sql`select a.os, a.r_minor, a.arch, a.filename, a.sha256 from published_artifacts a
    join publications p on p.id = a.publication_id where p.package = 'withbin' and p.superseded_at is null`;
  assert.deepEqual(arts.map((a) => ({ ...a })),
    [{ os: "win", r_minor: "4.6", arch: "x86_64", filename: "withbin_2.0.zip", sha256: sha(zip) }]);

  // An r-universe build of the same version replaces the seed, and seeding leaves it alone.
  const built = tgz("withbin", "2.0", "Imports: methods\n");
  await storeObject(bucket, sql, sha(built), async () => ({ body: new Blob([built]).stream(), size: built.length }), null);
  await ingestSource(bucket, sql, sha(built), {});
  const pub = await publish(sql, { bioc_version: "3.24", repo: "bioc", src_sha256: sha(built), origin: "r-universe", archs: ["linux"] });
  assert.ok(pub.changed && pub.superseded);
  assert.deepEqual(await seed(env, sql, "3.24", "bioc", { fetch: f }),
    { status: "done", seeded: [], failed: [], too_large: [], remaining: 0, next: null, touched: [] });
});
