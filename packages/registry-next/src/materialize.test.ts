import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { materialize, materializeVersions } from "./materialize.ts";
import { publish, putCasObject, putPackageVersion, setBiocVersions } from "./store.ts";
import { testBucket } from "./testr2.ts";
import { testDb } from "./testdb.ts";

const db = await testDb();
const sql = db.sql;
after(() => db.close());

const hex = (s: string, n = 64) => createHash("sha256").update(s).digest("hex").slice(0, n);
async function source(pkg: string, version: string) {
  const sha = hex(`${pkg}_${version}`);
  await putCasObject(sql, { sha256: sha, md5: hex(sha, 32), size_bytes: 1000 });
  await putPackageVersion(sql, {
    src_sha256: sha, package: pkg, version,
    description: { Package: pkg, Version: version, License: "MIT", NeedsCompilation: "no" },
  });
  return sha;
}
const blob = async (name: string) => {
  const sha = hex(name);
  await putCasObject(sql, { sha256: sha, size_bytes: 10, md5: hex(name, 32) });
  return sha;
};
const pub = (src_sha256: string, binaries: { os: string; r_minor: string; arch?: string; filename: string; sha256: string }[] = []) =>
  publish(sql, { bioc_version: "3.24", repo: "bioc", src_sha256, origin: "r-universe", archs: ["linux"], binaries });
const text = async (b: R2Bucket, key: string) => (await b.get(key))!.text();
const P = "packages/3.24/bioc/";

test("materialize writes every index, only what changed, and empties a binary directory that lost its files", async () => {
  const { bucket } = testBucket();
  const v1 = await source("limma", "3.60.0");
  await pub(v1, [
    { os: "win", r_minor: "4.6", filename: "limma_3.60.0.zip", sha256: await blob("w") },
    { os: "mac", r_minor: "4.6.1", filename: "limma_3.60.0.tgz", sha256: await blob("m") }, // arch-less
  ]);
  await pub(await source("edgeR", "4.0.0"));

  const keys = await materialize(bucket, sql, "3.24", "bioc");
  const dirs = ["src/contrib", "bin/windows/contrib/4.6", "bin/macosx/sonoma-arm64/contrib/4.6", "bin/macosx/big-sur-x86_64/contrib/4.6"];
  assert.deepEqual(keys, [...dirs.flatMap((d) => ["PACKAGES", "PACKAGES.gz", "PACKAGES.rds"].map((f) => `${P}${d}/${f}`)),
    `${P}VIEWS`, `${P}index.json`].sort());

  const src = await text(bucket, `${P}src/contrib/PACKAGES`);
  assert.match(src, new RegExp(`Package: limma\\nVersion: 3.60.0\\n[^]*MD5sum: ${hex(v1, 32)}\\n`));
  assert.match(src, /Package: edgeR/);
  assert.deepEqual(gunzipSync(Buffer.from(await (await bucket.get(`${P}src/contrib/PACKAGES.gz`))!.arrayBuffer())).toString(), src);
  for (const d of dirs.slice(1)) {
    const t = await text(bucket, `${P}${d}/PACKAGES`);
    assert.match(t, /Package: limma/);
    assert.doesNotMatch(t, /edgeR/);
  }
  assert.equal((await bucket.head(`${P}src/contrib/PACKAGES.rds`))!.httpMetadata!.contentType, "application/octet-stream");
  assert.equal((await bucket.head(`${P}VIEWS`))!.httpMetadata!.contentType, "text/plain; charset=utf-8");
  assert.equal(Object.keys(JSON.parse(await text(bucket, `${P}index.json`))).join(), "edgeR,limma");

  assert.deepEqual(await materialize(bucket, sql, "3.24", "bioc"), [], "nothing changed, nothing written");

  // A new limma changes the source index and the binary-less directories' content, nothing for edgeR alone.
  await pub(await source("limma", "3.61.0"));
  const after = await materialize(bucket, sql, "3.24", "bioc");
  assert.ok(after.includes(`${P}src/contrib/PACKAGES`) && after.includes(`${P}index.json`));
  assert.ok(after.includes(`${P}bin/windows/contrib/4.6/PACKAGES`), "the binary is gone, so the directory is emptied");
  assert.equal(await text(bucket, `${P}bin/windows/contrib/4.6/PACKAGES`), "");
  assert.deepEqual(await materialize(bucket, sql, "3.24", "bioc"), []);
});

test("an arm64 binary is only in the arm64 directory", async () => {
  const { bucket } = testBucket();
  const sha = await source("Rsamtools", "2.0.0");
  await pub(sha, [{ os: "mac", r_minor: "4.6", arch: "arm64", filename: "Rsamtools_2.0.0.tgz", sha256: await blob("rs") }]);
  await materialize(bucket, sql, "3.24", "bioc");
  assert.match(await text(bucket, `${P}bin/macosx/sonoma-arm64/contrib/4.6/PACKAGES`), /Package: Rsamtools/);
  assert.equal(await bucket.head(`${P}bin/macosx/big-sur-x86_64/contrib/4.6/PACKAGES`), null);
});

test("materializeVersions writes versions.json once", async () => {
  const { bucket } = testBucket();
  await setBiocVersions(sql, `release_version: "3.24"\ndevel_version: "3.25"\nr_ver_for_bioc_ver:\n  "3.24": "4.6"\n  "3.25": "4.6"\n`);
  assert.deepEqual(await materializeVersions(bucket, sql), ["packages/versions.json"]);
  assert.deepEqual(JSON.parse(await text(bucket, "packages/versions.json")), {
    release: "3.24", devel: "3.25",
    // Without r_universe_* keys in config.yaml, the release and devel versions are the ones built.
    versions: {
      "3.24": { r_minor: "4.6", role: "release", universe: "bioc-release" },
      "3.25": { r_minor: "4.6", role: "devel", universe: "bioc" },
    },
  });
  assert.deepEqual(await materializeVersions(bucket, sql), []);
});

const haveR = spawnSync("Rscript", ["--version"]).error === undefined;
test("available.packages reads the materialized src/contrib", { skip: haveR ? false : "Rscript is not on PATH; R check skipped" }, async () => {
  const { bucket } = testBucket();
  await materialize(bucket, sql, "3.24", "bioc");
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    mkdirSync(join(dir, "contrib"));
    for (const f of ["PACKAGES", "PACKAGES.gz", "PACKAGES.rds"])
      writeFileSync(join(dir, "contrib", f), Buffer.from(await (await bucket.get(`${P}src/contrib/${f}`))!.arrayBuffer()));
    execFileSync("Rscript", ["-e", `ap <- available.packages(contriburl = "file://${dir}/contrib", type = "source", filters = list())
      stopifnot(ap["limma","Version"] == "3.61.0", ap["edgeR","Version"] == "4.0.0", ap["Rsamtools","Version"] == "2.0.0")`],
      { encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
