import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, captureLog, drain, fetchCheckLogs, isLogEntry, metered, parseZipCentral } from "./capture.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
after(() => db.close());

// A real zip built by `zip -X`: a deflated log, a deflated "tarball" standing in
// for the built package, and a stored entry. 412 bytes, so it doubles as the
// short-file case where the whole archive is smaller than the tail slab.
const FIXTURE_ZIP =
  "UEsDBBQAAAAIAKN8D12BzVauMgAAAEQBAAAWAAAAUGtnLlJjaGVjay8wMGNoZWNrLmxvZ9NSSM5ITc7OzEtXSK1I" +
  "zC3ISS1W0NPTU3ANCvIP4goqzctDkUpLzMxJTeHSGtWFpAsAUEsDBBQAAAAIAKN8D10TLUMbBwAAACwBAAAQAAAA" +
  "UGtnXzEuMC4wLnRhci5nequoGAXEAgBQSwMECgAAAAAAo3wPXeKcU6UHAAAABwAAAAsAAABwa2dkYXRhLnR4dHN0" +
  "b3JlZApQSwECHgMUAAAACACjfA9dgc1WrjIAAABEAQAAFgAAAAAAAAABAAAAoIEAAAAAUGtnLlJjaGVjay8wMGNo" +
  "ZWNrLmxvZ1BLAQIeAxQAAAAIAKN8D10TLUMbBwAAACwBAAAQAAAAAAAAAAEAAACggWYAAABQa2dfMS4wLjAudGFy" +
  "Lmd6UEsBAh4DCgAAAAAAo3wPXeKcU6UHAAAABwAAAAsAAAAAAAAAAAAAAKCBmwAAAHBrZ2RhdGEudHh0UEsFBgAA" +
  "AAADAAMAuwAAAMsAAAAAAA==";
const zip = Uint8Array.from(atob(FIXTURE_ZIP), (c) => c.charCodeAt(0));

test("parseZipCentral reads the directory without the rest of the archive", () => {
  const entries = parseZipCentral(zip, 0)!;
  assert.deepEqual(entries.map((e) => e.name),
    ["Pkg.Rcheck/00check.log", "Pkg_1.0.0.tar.gz", "pkgdata.txt"]);
  assert.deepEqual(entries.map((e) => [e.method, e.compressed, e.size, e.offset]),
    [[8, 50, 324, 0], [8, 7, 300, 102], [0, 7, 7, 155]], "deflated and stored both read");

  // The built package is ~99% of a real artifact and must not be fetched.
  assert.deepEqual(entries.filter((e) => isLogEntry(e.name)).map((e) => e.name),
    ["Pkg.Rcheck/00check.log", "pkgdata.txt"]);

  // The point of the whole thing: given only the tail, the offsets still resolve,
  // so the caller can range-fetch the entries it wants out of a 7.6MB archive.
  const from = 150; // directory starts at 203, so this slab holds it and nothing else
  const fromTail = parseZipCentral(zip.subarray(from), from)!;
  assert.deepEqual(fromTail.map((e) => e.offset), [0, 102, 155]);

  // A slab that misses part of the directory must say so rather than return half
  // of it — the caller re-fetches a larger one.
  assert.equal(parseZipCentral(zip.subarray(340), 340), null, "directory truncated");
  assert.equal(parseZipCentral(zip.subarray(0, 100), 0), null, "no end-of-directory record");
});

// Shaped like the real thing: GHA prefixes every line with a timestamp, the image
// digest is printed away from the image name, and dependencies appear only as
// tarball URLs. Verified against two real job logs (11 and 126 deps).
const JOB_LOG = [
  "2026-07-31T12:43:40.1Z ##[group]Run docker pull ghcr.io/r-universe-org/build-source:latest",
  "2026-07-31T12:43:41.2Z latest: Pulling from r-universe-org/build-source",
  "2026-07-31T12:43:47.3Z Digest: sha256:" + "b9".repeat(32),
  "2026-07-31T12:43:50.1Z trying URL 'https://p3m.dev/all/__linux__/resolute/latest/src/contrib/abind_1.4-8.tar.gz'",
  "2026-07-31T12:43:51.2Z trying URL 'https://p3m.dev/all/__linux__/resolute/latest/src/contrib/bit64_4.8.2.tar.gz'",
  "2026-07-31T12:43:52.3Z trying URL 'https://bioc.r-universe.dev/bin/linux/resolute-x86_64/4.6/src/contrib/msa_1.45.1.tar.gz'",
  // Only Linux installs from source. Windows and macOS pull binaries, and missing
  // these left 52% of jobs with no dependency versions at all.
  "2026-07-31T12:43:53.4Z trying URL 'https://cloud.r-project.org/bin/windows/contrib/4.7/utf8_1.2.6.zip'",
  "2026-07-31T12:43:54.5Z trying URL 'https://cloud.r-project.org/bin/macosx/big-sur-arm64/contrib/4.6/pillar_1.11.1.tgz'",
  "2026-07-31T12:44:01.9Z * DONE (abind)",
].join("\n");

test("buildManifest recovers the image and resolved dependency versions", () => {
  const m = buildManifest(JOB_LOG);
  assert.equal(m.image, `ghcr.io/r-universe-org/build-source@sha256:${"b9".repeat(32)}`,
    "pinned by digest, not by the :latest tag it was pulled with");
  assert.deepEqual(m.deps,
    { abind: "1.4-8", bit64: "4.8.2", msa: "1.45.1", utf8: "1.2.6", pillar: "1.11.1" },
    "source .tar.gz, Windows .zip and macOS .tgz all parse");
  assert.deepEqual(m.repos, [
    "https://bioc.r-universe.dev",
    "https://cloud.r-project.org",
    "https://p3m.dev/all/__linux__/resolute/latest",
  ]);

  // A log with no install section must not claim the build had no dependencies —
  // captureLog uses this emptiness to decide not to write a manifest at all.
  const none = buildManifest("2026-07-31T12:43:40.1Z nothing to see");
  assert.equal(none.image, undefined);
  assert.deepEqual(none.deps, {});
  assert.deepEqual(none.repos, []);

  // An image with no digest line is not a pin, so it is not recorded as one.
  assert.equal(buildManifest("pulled ghcr.io/r-universe-org/build-source:latest").image, undefined);

  // Windows and macOS run on GitHub-hosted runners, not in a container, so there
  // is no digest. The runner image is the only environment they can be pinned to,
  // and without this fallback half the jobs would record none at all.
  const hosted = [
    "2026-07-31T12:43:40.1Z ##[group]Runner Image",
    "2026-07-31T12:43:40.2Z Image: windows-2025-vs2026",
    "2026-07-31T12:43:40.3Z Version: 20260628.158.1",
    "2026-07-31T12:43:41.1Z trying URL 'https://cloud.r-project.org/bin/windows/contrib/4.7/utf8_1.2.6.zip'",
  ].join("\n");
  const h = buildManifest(hosted);
  assert.equal(h.image, "windows-2025-vs2026@20260628.158.1");
  assert.deepEqual(h.deps, { utf8: "1.2.6" });
});

// ---------- a stand-in for GitHub ----------

const API = "https://api.github.com/repos/r-universe";
const BLOB = "https://blob.example/artifact.zip";
// Per URL: a status, a log body (with its length, as GitHub sends it), or the fixture zip behind a
// redirect. `blobFails` gives the blob host a status for a request, by "HEAD" or by range start.
// Every call is recorded.
const gh: Record<string, number | string> = {};
const blobFails: Record<string, number> = {};
const calls: string[] = [];
const github = (async (u: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const range = new Headers(init.headers).get("range");
  calls.push(`${method} ${u}${range ? ` ${range}` : ""}`);
  if (u === BLOB) {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "") ?? [];
    const fail = blobFails[method === "HEAD" ? "HEAD" : a];
    if (fail) return new Response("", { status: fail });
    if (method === "HEAD") return new Response(null, { headers: { "content-length": String(zip.length) } });
    return new Response(zip.slice(Number(a), Number(b) + 1), { status: 206 });
  }
  const g = gh[u];
  if (g === "zip") return new Response(null, { status: 302, headers: { location: BLOB } });
  if (typeof g === "string") return new Response(g, { headers: { "content-length": String(Buffer.byteLength(g)) } });
  return new Response("", { status: g ?? 404 });
}) as typeof fetch;

test("fetchCheckLogs: the text entries out of the artifact by range, never the built package", async () => {
  gh[`${API}/bioc/actions/artifacts/77/zip`] = "zip";
  calls.length = 0;
  const logs = (await fetchCheckLogs("bioc", "77", "t", github))!;
  assert.deepEqual(Object.keys(logs), ["00check.log", "pkgdata.txt"]);
  assert.match(logs["00check.log"], /^\* checking examples \.\.\. ERROR\n/);
  assert.equal(logs["00check.log"].length, 324);
  assert.equal(logs["pkgdata.txt"], "stored\n");
  assert.ok(!calls.some((c) => c.includes("bytes=102-")), "the tarball entry is not fetched");
  assert.equal(await fetchCheckLogs("bioc", "78", "t", github), null, "404: expired");
  gh[`${API}/bioc/actions/artifacts/79/zip`] = 500;
  await assert.rejects(fetchCheckLogs("bioc", "79", "t", github), /no redirect \(HTTP 500\)/);
});

test("fetchCheckLogs: a failure at the blob host throws, never null (gone) or an entry short (partial)", async () => {
  gh[`${API}/bioc/actions/artifacts/77/zip`] = "zip";
  // The directory's slab starts at 0 (the fixture is smaller than it), and 00check.log is entry 0
  // too, so the stored entry at 155 stands for "an entry".
  for (const [at, status, what] of [["HEAD", 503, /HEAD HTTP 503/], ["0", 500, /directory HTTP 500/],
    ["155", 429, /pkgdata\.txt HTTP 429/]] as const) {
    blobFails[at] = status;
    try { await assert.rejects(fetchCheckLogs("bioc", "77", "t", github), what, at); } finally { delete blobFails[at]; }
  }
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(fetchCheckLogs("bioc", "77", "t", down), /fetch failed/, "network");
  // Terminal: an artifact the blob host reports no length for.
  const lengthless = (async (u: string, init: RequestInit = {}) =>
    init.method === "HEAD" ? new Response(null) : github(u, init)) as typeof fetch;
  assert.equal(await fetchCheckLogs("bioc", "77", "t", lengthless), null);
});

test("captureLog: a log without a length is retried, not read as text", async () => {
  const { bucket, objects } = testBucket();
  const lengthless = (async () => new Response(JOB_LOG)) as unknown as typeof fetch;
  await assert.rejects(captureLog(bucket, "bioc", "6", "t", lengthless), /no content-length/);
  const bad = (async () => new Response(JOB_LOG, { headers: { "content-length": "12x" } })) as unknown as typeof fetch;
  await assert.rejects(captureLog(bucket, "bioc", "6", "t", bad), /no content-length/);
  assert.equal(objects.size, 0);
});

test("metered: every fetch, redirect hop and R2 call is counted, and the cap is never passed", async () => {
  const { bucket } = testBucket();
  const m = metered(bucket, github, 4);
  await m.bucket.put("k", "v");
  await m.fetch(`${API}/bioc/actions/artifacts/77/zip`, { redirect: "manual" });
  assert.equal(m.used(), 2);
  await m.fetch(`${API}/bioc/actions/jobs/1/logs`); // followed: the API and its redirect
  assert.equal(m.left(), 0);
  calls.length = 0;
  await assert.rejects(m.bucket.head("k"), /budget of 4 spent/);
  await assert.rejects(m.fetch(BLOB, { method: "HEAD" }), /budget of 4 spent/);
  assert.deepEqual(calls, [], "not made");
});

test("captureLog: a log over the text ceiling is streamed to R2, and its manifest read from the head", async () => {
  const { bucket, objects } = testBucket();
  const big = (async () => new Response(JOB_LOG, { headers: { "content-length": "17000000" } })) as unknown as typeof fetch;
  assert.equal(await captureLog(bucket, "bioc", "5", "t", big), true);
  assert.equal(new TextDecoder().decode(objects.get("logs/bioc/5.txt")!.bytes), JOB_LOG);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(objects.get("builds/bioc/5.json")!.bytes)), buildManifest(JOB_LOG));
});

// ---------- drain, against the database ----------

const queue = async () => (await db.sql`select job::int, kind, status, attempts, last_error,
  round(extract(epoch from next_attempt_at - now()) / 60)::int as wait_min, done_at is not null as done
  from capture_queue order by job, kind`).map((r) => ({ ...r }));
const enqueue = (job: number, kind: string, o: { artifact?: string; expires?: string; universe?: string } = {}) =>
  db.sql`insert into capture_queue (universe, job, kind, artifact, expires_at)
    values (${o.universe ?? "bioc"}, ${job}, ${kind}, ${o.artifact ?? null}, ${o.expires ?? null})`;

test("drain: without a token it does nothing and says so", async () => {
  await enqueue(1, "log");
  const { bucket } = testBucket();
  assert.deepEqual(await drain({ BUCKET: bucket }, db.sql, { fetch: github }), { status: "skipped", reason: "no GITHUB_TOKEN" });
  assert.deepEqual(await drain({ BUCKET: bucket, GITHUB_TOKEN: " \n" }, db.sql, { fetch: github }),
    { status: "skipped", reason: "no GITHUB_TOKEN" });
  await db.sql`delete from capture_queue`;
});

test("drain: saved is done, gone upstream is gone, already in the bucket is done without asking", async () => {
  const { bucket, objects } = testBucket();
  await enqueue(10, "log");
  await enqueue(11, "log");
  await enqueue(12, "log", { universe: "bioc-release" });
  await enqueue(10, "check", { artifact: "77" });
  await enqueue(11, "check", { artifact: "78" });
  gh[`${API}/bioc/actions/jobs/10/logs`] = JOB_LOG;
  await bucket.put("logs/bioc-release/12.txt", "copied from the current registry");
  calls.length = 0;
  const r = await drain({ BUCKET: bucket, GITHUB_TOKEN: "t\n" }, db.sql, { fetch: github });
  assert.deepEqual(r, { status: "drained", done: 2, gone: 2, present: 1 });
  assert.ok(!calls.some((c) => c.includes("/12/")), "job 12 was not asked for");
  assert.deepEqual((await queue()).map((q) => [q.job, q.kind, q.status, q.done]), [
    [10, "check", "done", true], [10, "log", "done", true], [11, "check", "gone", true], [11, "log", "gone", true],
    [12, "log", "done", true],
  ]);
  assert.equal(new TextDecoder().decode(objects.get("logs/bioc/10.txt")!.bytes), JOB_LOG);
  assert.ok(objects.has("builds/bioc/10.json"));
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(objects.get("checks/bioc/10.json")!.bytes))),
    ["00check.log", "pkgdata.txt"]);
  assert.deepEqual(await drain({ BUCKET: bucket, GITHUB_TOKEN: "t" }, db.sql, { fetch: github }),
    { status: "drained", done: 0, gone: 0, present: 0 }, "nothing pending");
  await db.sql`delete from capture_queue`;
});

test("drain: soonest expiry first; a failure stops it, backs that row off and releases the rest", async () => {
  const { bucket } = testBucket();
  await enqueue(20, "log", { expires: "2027-01-03T00:00:00Z" });
  await enqueue(21, "log", { expires: "2027-01-01T00:00:00Z" });
  await enqueue(22, "log");
  await enqueue(23, "log", { expires: "2027-01-02T00:00:00Z" });
  for (const j of [20, 21, 22, 23]) gh[`${API}/bioc/actions/jobs/${j}/logs`] = `log ${j}`;
  gh[`${API}/bioc/actions/jobs/23/logs`] = 403; // rate limited
  calls.length = 0;
  const env = { BUCKET: bucket, GITHUB_TOKEN: "t" };
  const r = await drain(env, db.sql, { fetch: github });
  assert.deepEqual(r, { status: "stopped", done: 1, gone: 0, present: 0,
    stopped: { universe: "bioc", job: "23", kind: "log", error: "HTTP 403" } });
  assert.deepEqual(calls, [`GET ${API}/bioc/actions/jobs/21/logs`, `GET ${API}/bioc/actions/jobs/23/logs`]);
  // Minutes until due, for what is still pending.
  assert.deepEqual((await queue()).map((q) => [q.job, q.status, q.attempts, q.last_error, q.status === "pending" ? q.wait_min : null]), [
    [20, "pending", 0, null, 0], [21, "done", 0, null, null], [22, "pending", 0, null, 0], [23, "pending", 1, "HTTP 403", 15],
  ]);
  // The next drain goes on with the rest; 23 is not due yet.
  calls.length = 0;
  assert.deepEqual(await drain(env, db.sql, { fetch: github, logs: 1 }), { status: "drained", done: 1, gone: 0, present: 0 });
  assert.deepEqual(calls, [`GET ${API}/bioc/actions/jobs/20/logs`], "a limit of one log, the soonest to expire");
  // Each further failure doubles the wait, up to a day.
  await db.sql`update capture_queue set next_attempt_at = now() where job = 23`;
  await drain(env, db.sql, { fetch: github, logs: 1 });
  assert.deepEqual((await queue()).filter((q) => q.job === 23).map((q) => [q.attempts, q.wait_min]), [[2, 30]]);
  await db.sql`update capture_queue set next_attempt_at = now(), attempts = 9 where job = 23`;
  await drain(env, db.sql, { fetch: github, logs: 1 });
  const [q23] = (await queue()).filter((q) => q.job === 23);
  assert.deepEqual([q23.attempts, q23.wait_min], [10, 24 * 60]);
  assert.deepEqual((await queue()).map((q) => q.status), ["done", "done", "pending", "pending"]);
  await db.sql`delete from capture_queue`;
});

test("drain: claimed rows are skipped by a concurrent drain", async () => {
  const { bucket } = testBucket();
  await enqueue(30, "log");
  gh[`${API}/bioc/actions/jobs/30/logs`] = "log 30";
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  const slow = (async (u: string, init?: RequestInit) => { await held; return github(u, init); }) as typeof fetch;
  const env = { BUCKET: bucket, GITHUB_TOKEN: "t" };
  const first = drain(env, db.sql, { fetch: slow });
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(await drain(env, db.sql, { fetch: github }), { status: "drained", done: 0, gone: 0, present: 0 });
  release();
  assert.deepEqual(await first, { status: "drained", done: 1, gone: 0, present: 0 });
  await db.sql`delete from capture_queue`;
});

test("drain: a drain whose lease ran out changes nothing once another drain or an import settled the row", async () => {
  const { bucket } = testBucket();
  await enqueue(40, "log");
  await enqueue(41, "log");
  gh[`${API}/bioc/actions/jobs/40/logs`] = "log 40";
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  // Drain A is held at GitHub, which then fails it.
  const slow = (async () => { await held; return new Response("", { status: 502 }); }) as unknown as typeof fetch;
  const env = { BUCKET: bucket, GITHUB_TOKEN: "t" };
  const first = drain(env, db.sql, { fetch: slow, logs: 1 });
  await new Promise((res) => setTimeout(res, 50));
  // Its lease on 40 runs out; drain B takes 40 and saves it, and an import marks 41 done.
  await db.sql`update capture_queue set next_attempt_at = now() - interval '1 hour' where job = 40`;
  assert.deepEqual(await drain(env, db.sql, { fetch: github, logs: 1 }), { status: "drained", done: 1, gone: 0, present: 0 });
  await db.sql`update capture_queue set status = 'done', done_at = now(), lease = null where job = 41`;
  release();
  assert.equal((await first).status, "stopped");
  assert.deepEqual((await queue()).map((q) => [q.job, q.status, q.attempts, q.last_error]),
    [[40, "done", 0, null], [41, "done", 0, null]], "A's failure is not recorded against either");
  // And a late success is not recorded over a row that is no longer pending or no longer A's.
  await enqueue(42, "log");
  gh[`${API}/bioc/actions/jobs/42/logs`] = "log 42";
  const held2 = new Promise<void>((res) => { release = res; });
  const slow2 = (async (u: string, init?: RequestInit) => { await held2; return github(u, init); }) as typeof fetch;
  const second = drain(env, db.sql, { fetch: slow2, logs: 1 });
  await new Promise((res) => setTimeout(res, 50));
  await db.sql`update capture_queue set status = 'gone', done_at = now(), lease = null where job = 42`;
  release();
  assert.deepEqual(await second, { status: "drained", done: 1, gone: 0, present: 0 });
  assert.deepEqual((await queue()).filter((q) => q.job === 42).map((q) => q.status), ["gone"]);
  assert.equal((await db.sql`select count(*)::int as n from capture_queue where lease is not null`)[0].n, 0);
  await db.sql`delete from capture_queue`;
});

test("drain: the subrequest budget running out releases what is left, without an attempt", async () => {
  const { bucket, objects } = testBucket();
  for (const j of [50, 51, 52]) {
    await enqueue(j, "log");
    gh[`${API}/bioc/actions/jobs/${j}/logs`] = `log ${j}`;
  }
  await enqueue(50, "check", { artifact: "77" });
  gh[`${API}/bioc/actions/artifacts/77/zip`] = "zip";
  const env = { BUCKET: bucket, GITHUB_TOKEN: "t" };
  // A log with no manifest spends 4 (R2 head, the API and its redirect, the put) but needs 6
  // left to start, so 10 is two logs and not a third.
  calls.length = 0;
  assert.deepEqual(await drain(env, db.sql, { fetch: github, budget: 10 }),
    { status: "out_of_subrequests", done: 2, gone: 0, present: 0, released: 2 });
  assert.equal(calls.length, 2, "two logs fetched");
  assert.ok(!objects.has("logs/bioc/52.txt"));
  assert.deepEqual((await queue()).map((q) => [q.job, q.kind, q.status, q.attempts, q.status === "pending" ? q.wait_min : null]), [
    [50, "check", "pending", 0, 0], [50, "log", "done", 0, null], [51, "log", "done", 0, null], [52, "log", "pending", 0, 0],
  ]);
  // A check stopped part way writes nothing and is released the same way: R2 head and the API
  // (1 each), HEAD (2, as a fetch that may follow a redirect), and the directory's range is past 5.
  calls.length = 0;
  assert.deepEqual(await drain(env, db.sql, { fetch: github, logs: 0, budget: 5 }),
    { status: "out_of_subrequests", done: 0, gone: 0, present: 0, released: 1 });
  assert.deepEqual(calls, [`GET ${API}/bioc/actions/artifacts/77/zip`, `HEAD ${BLOB}`]);
  assert.ok(!objects.has("checks/bioc/50.json"));
  assert.deepEqual((await queue()).filter((q) => q.kind === "check").map((q) => [q.status, q.attempts, q.wait_min]),
    [["pending", 0, 0]]);
  assert.equal((await db.sql`select count(*)::int as n from capture_queue where lease is not null`)[0].n, 0);
  await db.sql`delete from capture_queue`;
});
