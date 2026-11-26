import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cron } from "./admin.ts";
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
  "https://bioconductor.org/packages/3.24/data/annotation/src/contrib/PACKAGES": "Package: org.Hs.eg.db\nVersion: 1.0\n",
  "https://bioconductor.org/packages/3.24/data/experiment/src/contrib/PACKAGES": "Package: airway\nVersion: 1.0\n",
  "https://bioconductor.org/packages/3.24/books/src/contrib/PACKAGES": "Package: OSCA\nVersion: 1.0\n",
};
// Pages by URL without its query; bytes with their length, as r-universe's store sends them.
globalThis.fetch = (async (u: string) => {
  const p = pages[u.split("?")[0]];
  if (p === undefined) return new Response("", { status: 404 });
  return new Response(p, typeof p === "string" ? {} : { headers: { "content-length": String(p.length) } });
}) as typeof fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const store = testBucket();
const env = { HYPERDRIVE: { connectionString: db.url }, MAINT_KEY: "k", BUCKET: store.bucket };
const call = (path: string, method = "POST", key = "k") =>
  app.request(path, { method, headers: { "x-maint-key": key } }, env);
const body = (r: Response) => r.json() as Promise<any>;

// One source tarball in r-universe's store, and bioc-release reporting it.
mkdirSync(join(tmp, "demo"));
writeFileSync(join(tmp, "demo", "DESCRIPTION"), "Package: demo\nVersion: 1.0.0\nImports: Matrix\nLicense: MIT\n");
const gz = execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", tmp, "demo"]);
const sha = createHash("sha256").update(gz).digest("hex");
pages[`https://r2.ropensci.org/${sha}`] = gz;
const RU = "https://bioc-release.r-universe.dev/api/packages";
pages[RU] = JSON.stringify([{
  Package: "demo", Version: "1.0.0", _sha256: sha, _status: "success", RemoteRef: "RELEASE_3_24",
  _dependencies: [{ package: "Matrix", role: "Imports" }], _bioc: [{ repository: "bioc" }],
  _jobs: [{ config: "linux-release-x86_64", r: "4.6.2", check: "OK" }],
}]);
const d1 = createHash("sha256").update(pages[RU]).digest("hex");

test("the admin routes need the maintenance key", async () => {
  for (const [path, method] of [["/admin/status", "GET"], ["/admin/refresh", "POST"], ["/admin/poll?universe=bioc", "POST"],
    ["/admin/capture", "POST"], ["/admin/import-jobs", "POST"],
    ["/admin/observe?universe=bioc", "POST"]])
    assert.equal((await call(path, method, "wrong")).status, 403, path);
});

test("POST /admin/refresh, /admin/poll, /admin/observe and GET /admin/status drive a backfill", async () => {
  const refreshed = await body(await call("/admin/refresh"));
  assert.deepEqual(refreshed.known, { "3.24": 5, "3.25": "not on bioconductor.org yet" });

  assert.equal((await call("/admin/poll?universe=cran")).status, 400);
  const polled = await body(await call("/admin/poll?universe=bioc-release"));
  assert.equal(polled.status, "archived");
  assert.equal(polled.digest, d1);
  assert.deepEqual(await body(await call("/admin/poll?universe=bioc-release")), { status: "unchanged", digest: d1 });

  assert.equal((await call("/admin/observe?universe=cran")).status, 400);
  for (const limit of ["x", "", " ", "-1", "1.5", "501"])
    assert.equal((await call(`/admin/observe?universe=bioc&limit=${limit}`)).status, 400, `limit=${limit}`);
  const res = await call("/admin/observe?universe=bioc-release&limit=5");
  assert.equal(res.status, 200);
  const { written, ...observed } = await body(res);
  assert.deepEqual(observed, {
    status: "processed", digest: d1, topped_up: 0, failed: [], remaining: 0, touched: [["3.24", "bioc"]],
    published: [{ bioc_version: "3.24", repo: "bioc", package: "demo", version: "1.0.0" }],
  });
  // The repository's files are rewritten by the call that changed it, and by nothing else.
  assert.ok(written.includes("packages/3.24/bioc/src/contrib/PACKAGES"));
  assert.ok(written.includes("packages/3.24/bioc/index.json"));
  assert.deepEqual(await body(await call("/admin/observe?universe=bioc-release")),
    { status: "unchanged", digest: d1, written: [] });
  assert.equal((await call("/admin/materialize?bioc_version=3.24&repo=nope")).status, 400);
  assert.deepEqual(await body(await call("/admin/materialize?bioc_version=3.24&repo=bioc")), { written: [] });

  const st = await body(await call("/admin/status", "GET"));
  assert.deepEqual(st.publications, [{ bioc_version: "3.24", repo: "bioc", origin: "r-universe", current: 1 }]);
  assert.deepEqual(st.cas, { objects: 1, bytes: gz.length });
  assert.equal(st.observations.length, 1);
  assert.equal(st.observations[0].digest, d1);
  assert.ok(st.observations[0].processed_at);
});

test("POST /admin/capture drains the queue by hand, within limits", async () => {
  for (const q of ["logs=201", "checks=101", "logs=x", "checks="])
    assert.equal((await call(`/admin/capture?${q}`)).status, 400, q);
  assert.deepEqual(await body(await call("/admin/capture")), { status: "skipped", reason: "no GITHUB_TOKEN" });
  // A queued log, and GitHub serving it.
  await db.sql`insert into capture_queue (universe, job, kind) values ('bioc', 42, 'log')`;
  pages["https://api.github.com/repos/r-universe/bioc/actions/jobs/42/logs"] = "the log";
  const res = await app.request("/admin/capture?logs=5&checks=0", { method: "POST", headers: { "x-maint-key": "k" } },
    { ...env, GITHUB_TOKEN: "t" });
  assert.deepEqual(await body(res), { status: "drained", done: 1, gone: 0, present: 0 });
  assert.ok(store.objects.has("logs/bioc/42.txt"));
});

test("POST /admin/import-jobs: job_runs widened, captures queued by what was copied, done never downgraded", async () => {
  const post = (b: unknown) => app.request("/admin/import-jobs",
    { method: "POST", headers: { "x-maint-key": "k", "content-type": "application/json" }, body: JSON.stringify(b) }, env);
  const row = (job: number, o: Record<string, unknown> = {}) => ({ universe: "bioc", job, package: "p", version: "1.0",
    config: "source", first_obs_ts: "2026-09-01T00:00:00Z", last_obs_ts: "2026-09-02T00:00:00Z", ...o });
  const FUTURE = new Date(Date.now() + 864e5).toISOString(), PAST = "2026-01-01T00:00:00Z";
  for (const bad of [null, {}, { rows: [row(1), row(1)] }, { rows: [row(1, { universe: "cran" })] },
    { rows: [row(1, { first_obs_ts: "yesterday" })] }, { rows: [row(-1)] }, { rows: Array.from({ length: 5001 }, (_, i) => row(i)) }])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  const queue = async () => (await db.sql`select job::int, kind, status, attempts from capture_queue
    where job between 900 and 999 order by job, kind`).map((q) => Object.values(q).join(" "));

  assert.deepEqual(await body(await post({ rows: [
    row(900, { artifact: "a900", expires_at: FUTURE, log_captured: true }),
    row(901, { artifact: "a901", expires_at: PAST, failure: true }),
    row(902),
  ] })), { rows: 3, inserted: 3, updated: 0, capture: { pending: 2, done: 1, gone: 2 } });
  assert.deepEqual(await queue(), ["900 check pending 0", "900 log done 0", "901 check gone 0", "901 log gone 0", "902 log pending 0"]);
  const [r901] = await db.sql`select failure, expires_at from job_runs where job = 901`;
  assert.deepEqual([r901.failure, r901.expires_at.toISOString()], [true, "2026-01-01T00:00:00.000Z"]);

  // Seen again, wider and with other values: only the bounds move. 900's log stays done, its
  // check is now copied; 901's are now copied; 902's pending row keeps its attempts.
  await db.sql`update capture_queue set attempts = 3 where job = 902`;
  assert.deepEqual(await body(await post({ rows: [
    row(900, { version: "9.9", artifact: "a900", expires_at: FUTURE, first_obs_ts: "2026-08-01T00:00:00Z", check_captured: true }),
    row(901, { artifact: "a901", expires_at: PAST, log_captured: true, check_captured: true, last_obs_ts: "2026-08-15T00:00:00Z" }),
    row(902),
  ] })), { rows: 3, inserted: 0, updated: 3, capture: { pending: 0, done: 3, gone: 0 } });
  assert.deepEqual(await queue(), ["900 check done 0", "900 log done 0", "901 check done 0", "901 log done 0", "902 log pending 3"]);
  const runs = await db.sql`select job::int, version, first_obs_ts, last_obs_ts from job_runs where job in (900, 901) order by job`;
  assert.deepEqual(runs.map((r) => [r.job, r.version, r.first_obs_ts.toISOString().slice(0, 10), r.last_obs_ts.toISOString().slice(0, 10)]),
    [[900, "1.0", "2026-08-01", "2026-09-02"], [901, "1.0", "2026-09-01", "2026-09-02"]]);
});

test("cron: a failed refresh stops neither versions.json nor observation", async () => {
  await db.sql`update bioc_versions set updated_at = now() - interval '2 days'`;
  const config = pages["https://bioconductor.org/config.yaml"];
  delete pages["https://bioconductor.org/config.yaml"]; // bioconductor.org is down
  store.objects.delete("packages/versions.json");      // and the last write of it was lost
  pages[RU] = JSON.stringify([...JSON.parse(pages[RU] as string), { Package: "nobuild", _type: "failure" }]);
  const d2 = createHash("sha256").update(pages[RU]).digest("hex");
  const log = console.log;
  console.log = () => {};
  try { await cron(env); } finally { console.log = log; pages["https://bioconductor.org/config.yaml"] = config; }
  assert.ok(store.objects.has("packages/versions.json"));
  const [o] = await db.sql`select processed_at from observations where digest = ${d2}`;
  assert.ok(o?.processed_at, "polled and observed despite the failed refresh");
});
