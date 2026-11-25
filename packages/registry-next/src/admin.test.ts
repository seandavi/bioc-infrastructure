import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "./index.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
const tmp = mkdtempSync(join(tmpdir(), "admin-test-"));
// The routes call the global fetch; no test reaches the network.
const realFetch = globalThis.fetch;
const pages: Record<string, string | Uint8Array> = {
  "https://bioconductor.org/config.yaml":
    `r_universe_release_version: "3.24"\nr_universe_devel_version: "3.25"\nrelease_version: "3.23"\n` +
    `devel_version: "3.24"\nr_ver_for_bioc_ver:\n  "3.23": "4.6"\n  "3.24": "4.6"\n`,
  "https://cloud.r-project.org/src/contrib/PACKAGES": "Package: Matrix\nVersion: 1.7\n",
  "https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES": "Package: rnaseqGene\nVersion: 1.0\n",
};
globalThis.fetch = (async (u: string) =>
  u in pages ? new Response(pages[u]) : new Response("", { status: 404 })) as typeof fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const legacy = testBucket(), store = testBucket();
const env = { HYPERDRIVE: { connectionString: db.url }, MAINT_KEY: "k", BUCKET: store.bucket, LEGACY: legacy.bucket };
const call = (path: string, method = "POST", key = "k") =>
  app.request(path, { method, headers: { "x-maint-key": key } }, env);
const body = (r: Response) => r.json() as Promise<any>;

// One workflow r-universe never built, on bioconductor.org.
mkdirSync(join(tmp, "rnaseqGene"));
writeFileSync(join(tmp, "rnaseqGene", "DESCRIPTION"), "Package: rnaseqGene\nVersion: 1.0\nLicense: Artistic-2.0\n");
pages["https://bioconductor.org/packages/3.24/workflows/src/contrib/rnaseqGene_1.0.tar.gz"] =
  execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", tmp, "rnaseqGene"]);

// One source tarball, as the current registry archives it, observed in bioc-release.
mkdirSync(join(tmp, "demo"));
writeFileSync(join(tmp, "demo", "DESCRIPTION"), "Package: demo\nVersion: 1.0.0\nImports: Matrix\nLicense: MIT\n");
const gz = execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", tmp, "demo"]);
const sha = createHash("sha256").update(gz).digest("hex");
await legacy.bucket.put(`prop/bioc-release/cas/${sha}`, gz);
await legacy.bucket.put("obs/bioc-release/1.json", JSON.stringify([{
  Package: "demo", Version: "1.0.0", _sha256: sha, _status: "success", RemoteRef: "RELEASE_3_24",
  _dependencies: [{ package: "Matrix", role: "Imports" }], _bioc: [{ repository: "bioc" }],
  _jobs: [{ config: "linux-release-x86_64", r: "4.6.2", check: "OK" }],
}]));
await legacy.bucket.put("state/bioc-release/latest",
  JSON.stringify({ digest: "d1", key: "obs/bioc-release/1.json", ts: "2026-11-25T15:16:05.699Z" }));

test("the admin routes need the maintenance key", async () => {
  for (const [path, method] of [["/admin/status", "GET"], ["/admin/refresh", "POST"], ["/admin/observe?universe=bioc", "POST"]])
    assert.equal((await call(path, method, "wrong")).status, 403, path);
});

test("POST /admin/refresh, POST /admin/observe and GET /admin/status drive a backfill", async () => {
  const refreshed = await body(await call("/admin/refresh"));
  assert.deepEqual(refreshed.known, { "3.24": 2, "3.25": "not on bioconductor.org yet" });

  assert.equal((await call("/admin/observe?universe=cran")).status, 400);
  assert.equal((await call("/admin/observe?universe=bioc&limit=x")).status, 400);
  const res = await call("/admin/observe?universe=bioc-release&limit=5");
  assert.equal(res.status, 200);
  const { written, ...observed } = await body(res);
  assert.deepEqual(observed, {
    status: "processed", digest: "d1", topped_up: 0, failed: [], remaining: 0, touched: [["3.24", "bioc"]],
    published: [{ bioc_version: "3.24", repo: "bioc", package: "demo", version: "1.0.0" }],
  });
  // The repository's files are rewritten by the call that changed it, and by nothing else.
  assert.ok(written.includes("packages/3.24/bioc/src/contrib/PACKAGES"));
  assert.ok(written.includes("packages/3.24/bioc/index.json"));
  assert.deepEqual(await body(await call("/admin/observe?universe=bioc-release")),
    { status: "unchanged", digest: "d1", written: [] });
  assert.equal((await call("/admin/materialize?bioc_version=3.24&repo=nope")).status, 400);
  assert.deepEqual(await body(await call("/admin/materialize?bioc_version=3.24&repo=bioc")), { written: [] });

  const st = await body(await call("/admin/status", "GET"));
  assert.deepEqual(st.publications, [{ bioc_version: "3.24", repo: "bioc", origin: "r-universe", current: 1 }]);
  assert.deepEqual(st.cas, { objects: 1, bytes: gz.length });
  assert.equal(st.observations.length, 1);
  assert.equal(st.observations[0].digest, "d1");
  assert.ok(st.observations[0].processed_at);
});

test("POST /admin/seed fills a repository's holes from bioconductor.org and rewrites its files", async () => {
  assert.equal((await call("/admin/seed?bioc_version=3.24&repo=workflows", "POST", "wrong")).status, 403);
  assert.equal((await call("/admin/seed?bioc_version=9.9&repo=workflows")).status, 400);
  assert.equal((await call("/admin/seed?bioc_version=3.24&repo=workflows&limit=51")).status, 400);
  const { written, ...r } = await body(await call("/admin/seed?bioc_version=3.24&repo=workflows&after="));
  assert.deepEqual(r, { status: "done", seeded: [{ package: "rnaseqGene", version: "1.0" }], failed: [], too_large: [],
    remaining: 0, next: "rnaseqGene", touched: [["3.24", "workflows"]] });
  assert.ok(written.includes("packages/3.24/workflows/src/contrib/PACKAGES"));
  assert.deepEqual(await body(await call("/admin/seed?bioc_version=3.24&repo=books")), { status: "absent", written: [] });
});
