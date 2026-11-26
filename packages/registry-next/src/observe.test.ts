import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_SOCKETS, connect } from "./db.ts";
import { COPIES, branchVersion, jobRuns, observe, planWave, refresh, storeBinaries } from "./observe.ts";
import { poll } from "./poll.ts";
import type { ObsRecord } from "./observe.ts";
import { biocVersions, knownExternal, setBiocVersions } from "./store.ts";
import type { BiocVersion, CurrentPub } from "./store.ts";
import { testDb } from "./testdb.ts";
import { testBucket } from "./testr2.ts";

const db = await testDb();
const sql = connect({ HYPERDRIVE: { connectionString: db.url } });
const tmp = mkdtempSync(join(tmpdir(), "observe-test-"));
after(async () => { await sql.end(); await db.close(); rmSync(tmp, { recursive: true, force: true }); });

// Fixtures go in before the first test() so the after() hook cannot run ahead of them.
const CONFIG = `r_universe_release_version: "3.24"
r_universe_devel_version: "3.25"
release_version: "3.23"
devel_version: "3.24"
r_ver_for_bioc_ver:
  "3.23": "4.6"
  "3.24": "4.6"
  "3.25": "4.6"
`;
await setBiocVersions(sql, CONFIG);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------- planWave, pure ----------

const VERSIONS: BiocVersion[] = [
  { bioc_version: "3.23", r_minor: "4.6", role: "release", universe: null },
  { bioc_version: "3.24", r_minor: "4.6", role: "devel", universe: "bioc-release" },
  { bioc_version: "3.25", r_minor: "4.6", role: null, universe: "bioc" },
];
const OK = [{ config: "source", r: "4.6.2", check: "OK" }, { config: "linux-release-x86_64", r: "4.6.2", check: "OK" }];
const bin = (os: string, version: string, fill: string, arch?: string) =>
  ({ os, r: "4.6.2", version, status: "success", fileid: `https://r2.ropensci.org/${fill.repeat(64)}`, arch });
const r = (Package: string, Version: string, o: Partial<ObsRecord> & { imports?: string[]; repository?: string } = {}): ObsRecord => ({
  Package, Version, _sha256: createHash("sha256").update(`${Package}_${Version}`).digest("hex"),
  _status: "success", _jobs: OK, RemoteRef: "RELEASE_3_24", License: "MIT",
  _dependencies: (o.imports ?? []).map((p) => ({ package: p, role: "Imports" })),
  _bioc: o.repository ? [{ repository: o.repository }] : undefined, ...o,
});
const pub = (repo: string, pkg: string, version: string, o: Partial<CurrentPub> = {}): CurrentPub =>
  ({ repo, package: pkg, version, origin: "r-universe", desc: {}, publication_id: 1, archs: ["linux"], slots: [], ...o });

test("branchVersion: RELEASE_x_y, and HEAD or devel as what the bioc universe builds", () => {
  assert.equal(branchVersion("RELEASE_3_24", VERSIONS), "3.24");
  assert.equal(branchVersion("HEAD", VERSIONS), "3.25");
  assert.equal(branchVersion("devel", VERSIONS), "3.25");
  assert.equal(branchVersion(undefined, VERSIONS), undefined);
  assert.equal(branchVersion("main", VERSIONS), undefined);
});

test("planWave: a version per branch, leftovers and unbuildable records ignored", () => {
  const plans = planWave([
    r("a", "1.0", { RemoteRef: "HEAD" }), r("b", "1.0"), r("c", "1.0", { RemoteRef: "RELEASE_3_23" }),
    r("d", "1.0", { RemoteRef: undefined }), r("e", "1.0", { _sha256: undefined }),
  ], VERSIONS, {}, {});
  assert.deepEqual(plans.map((p) => [p.bioc_version, p.approved.map((c) => c.package)]), [["3.25", ["a"]], ["3.24", ["b"]]]);
});

test("planWave: repository from _bioc, and dependencies across a version's repositories", () => {
  const [plan] = planWave([
    r("sw", "1.0", { imports: ["expdata", "Matrix"] }),
    r("expdata", "2.0", { repository: "data/experiment" }),
    r("book", "1.0", { repository: "books" }),
    r("needsAnno", "1.0", { imports: ["org.Hs.eg.db"] }),
    r("needsGhost", "1.0", { imports: ["ghost"] }),
  ], VERSIONS, { "3.24": [pub("data/annotation", "org.Hs.eg.db", "3.22.0", { origin: "bioconductor" })] },
  { "3.24": new Set(["Matrix"]) });
  assert.deepEqual(plan.approved.map((c) => [c.package, c.repo]),
    [["expdata", "data/experiment"], ["book", "books"], ["needsAnno", "bioc"], ["sw", "bioc"]]);
  const ghost = plan.decisions.find((d) => d.package === "needsGhost")!;
  assert.equal(ghost.propagate, false);
  assert.match(ghost.reasons.at(-1)!.detail!, /ghost/);
});

test("planWave: candidate details, recorded decisions, and top-ups", () => {
  const winOk = [...OK, { config: "windows-release-x86_64", r: "4.6.2", check: "OK" }];
  const [plan] = planWave([
    r("new", "2.0", {
      _jobs: [...OK, { config: "bioc-checks", r: "4.6.2", check: "WARNING" }], _filesize: 1234,
      _binaries: [bin("linux", "2.0", "1", "aarch64"), bin("win", "2.0", "2")], RemoteUrl: "https://github.com/bioc/new",
      RemoteSha: "f".repeat(40), _commit: { time: 1795515656 }, _vignettes: [{ filename: "v.html", title: "V" }],
      _devurl: "https://github.com/someone/new", _bioccheck: { error: 0, warning: 1, note: 2 },
    }),
    r("steady", "1.0"),
    r("broken", "1.0", { _jobs: [{ config: "linux-release-x86_64", r: "4.6.2", check: "ERROR" }] }),
    r("failing", "1.1", { _jobs: [{ config: "linux-release-x86_64", r: "4.6.2", check: "ERROR" }] }),
    // Published at this version with linux only; windows passes now and has a binary.
    r("late", "1.0", { _jobs: winOk, _binaries: [bin("linux", "1.0", "3", "x86_64"), bin("linux", "1.0", "9", "x86_64"), bin("win", "1.0", "4")] }),
    r("full", "1.0", { _binaries: [bin("linux", "1.0", "5", "x86_64")] }),
  ], VERSIONS, { "3.24": [
    pub("bioc", "steady", "1.0"), pub("bioc", "broken", "1.0"), pub("bioc", "failing", "1.0"),
    pub("bioc", "late", "1.0", { publication_id: 7, slots: ["linux|4.6|x86_64"] }),
    pub("bioc", "full", "1.0", { slots: ["linux|4.6|x86_64"] }),
  ] }, {});
  const c = plan.approved[0];
  assert.equal(c.package, "new");
  assert.deepEqual({ size: c.size, bioccheck: c.bioccheck, archs: c.archs, git: c.git }, {
    size: 1234, bioccheck: "WARNING", archs: ["linux"],
    git: { git_url: "https://github.com/bioc/new", git_branch: "RELEASE_3_24", git_commit: "f".repeat(40),
      git_commit_at: "2026-11-24T10:20:56.000Z" },
  });
  assert.deepEqual(c.binaries, [{ os: "linux", r_minor: "4.6", arch: "arm64", distro: "", filename: "new_2.0.tar.gz", sha256: "1".repeat(64) }],
    "the win binary's family did not pass");
  assert.deepEqual(c.meta, { vignettes: [{ filename: "v.html", title: "V" }], devurl: "https://github.com/someone/new",
    bioccheck: { error: 0, warning: 1, note: 2 } });
  // Only versions the version rule let in are recorded: steady and broken sit at their published
  // version (broken failing another rule too); failing is a new version that fails.
  assert.deepEqual(plan.decisions.map((d) => [d.package, d.propagate]), [["new", true], ["failing", false]]);
  assert.deepEqual(plan.topups, [{ bioc_version: "3.24", repo: "bioc", package: "late", publication_id: 7, archs: ["linux", "win"], widened: true,
    binaries: [{ os: "win", r_minor: "4.6", arch: "", distro: "", filename: "late_1.0.zip", sha256: "4".repeat(64) }] }]);
});

test("planWave: the version rule compares with the candidate's own repository, deps with all of them", () => {
  const [plan] = planWave([
    r("moved", "1.0", { repository: "books" }),       // was in bioc: a first publication in books
    r("twice", "1.5", { repository: "books" }),       // bioc has 2.0, books 1.0
    r("needs", "1.0", { imports: ["twice"] }),        // twice is published, in some repository
  ], VERSIONS, { "3.24": [
    pub("bioc", "moved", "1.0"), pub("bioc", "twice", "2.0"), pub("books", "twice", "1.0"),
  ] }, {});
  assert.deepEqual(plan.approved.map((c) => [c.repo, c.package]), [["books", "moved"], ["books", "twice"], ["bioc", "needs"]]);
  const [rev] = planWave([r("twice", "1.5", { repository: "books" })], VERSIONS,
    { "3.24": [pub("books", "twice", "2.0"), pub("bioc", "twice", "1.0")] }, {});
  assert.deepEqual(rev.approved, [], "1.5 is not > books' 2.0, whatever bioc holds");
});

test("planWave: a bad commit time is no time, not an error", () => {
  const [plan] = planWave([r("a1", "1.0", { _commit: { time: 1e20 } }), r("b1", "1.0", { _commit: { time: NaN } })], VERSIONS, {}, {});
  assert.deepEqual(plan.approved.map((c) => c.git.git_commit_at), [null, null]);
});

test("planWave: a record named like an Object.prototype member is a package like any other", () => {
  const [plan] = planWave([r("constructor", "1.0")], VERSIONS, { "3.24": [pub("bioc", "other", "1.0")] }, {});
  assert.deepEqual(plan.approved.map((c) => c.package), ["constructor"]);
});

// ---------- observe, against a database, a test bucket and a stand-in for r-universe ----------

const store = testBucket();
const env = { BUCKET: store.bucket };
// r-universe: each universe's /api/packages body, and the artifact store by sha256.
const snapshots: Record<string, string> = {};
const upstream = new Map<string, Uint8Array>();
const fetched: string[] = [];
const ru = (async (u: string) => {
  fetched.push(u);
  const api = /^https:\/\/([^.]+)\.r-universe\.dev\/api\/packages\?/.exec(u);
  if (api && snapshots[api[1]]) return new Response(snapshots[api[1]]);
  const b = upstream.get(u.replace("https://r2.ropensci.org/", ""));
  if (b) return new Response(b, { headers: { "content-length": String(b.length) } });
  return new Response("", { status: 404 });
}) as typeof fetch;
const noNetwork = ru;

let n = 0;
// A real source tarball of `pkg`, in r-universe's store, as a record.
async function source(universe: string, pkg: string, version: string, o: Partial<ObsRecord> & { imports?: string[]; repository?: string; content?: string } = {}) {
  const dir = join(tmp, `s${n++}`);
  const name = o.content ?? pkg;
  mkdirSync(join(dir, name), { recursive: true });
  const imports = o.imports?.length ? `Imports: ${o.imports.join(", ")}\n` : "";
  writeFileSync(join(dir, name, "DESCRIPTION"), `Package: ${name}\nVersion: ${version}\n${imports}License: MIT\n`);
  writeFileSync(join(dir, name, "NEWS"), `${name} ${version}`);
  const gz = execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", dir, name]);
  upstream.set(sha(gz), gz);
  return r(pkg, version, { ...o, _sha256: sha(gz) });
}
async function blob(text: string) {
  const b = new TextEncoder().encode(text);
  upstream.set(sha(b), b);
  return sha(b);
}
// r-universe now reports `records` for the universe, and poll() archives them.
async function observed(universe: string, records: ObsRecord[]) {
  snapshots[universe] = JSON.stringify(records);
  const p = await poll(env, sql, universe, ru);
  assert.equal(p.status, "archived");
  return p.digest;
}
const current = async (version: string) => (await db.sql`select package, version, repo from publications
  where bioc_version = ${version} and superseded_at is null order by package`).map((x) => `${x.repo}/${x.package}@${x.version}`);

test("observe: five candidates in a dependency chain, two per call, published in order", async () => {
  const winSha = await blob("a win zip");
  const chain = [
    await source("bioc-release", "Ax", "1.0", { _binaries: [
      { os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winSha}`, arch: "x86_64" },
    ], _jobs: [...OK, { config: "windows-release-x86_64", r: "4.6.2", check: "OK" }] }),
    await source("bioc-release", "Bx", "1.0", { imports: ["Ax"] }),
    await source("bioc-release", "Cx", "1.0", { imports: ["Bx"] }),
    await source("bioc-release", "Dx", "1.0", { imports: ["Cx", "Ax"] }),
    await source("bioc-release", "Ex", "1.0", { imports: ["Dx"], repository: "workflows" }),
  ];
  const digest = await observed("bioc-release", [...chain].reverse());
  const pubs: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const res = await observe(env, sql, "bioc-release", { limit: 2, fetch: noNetwork });
    assert.equal(res.digest, digest);
    assert.deepEqual(res.failed, []);
    assert.equal(res.remaining, [3, 1, 0][i]);
    assert.equal(res.status, i < 2 ? "partial" : "processed");
    pubs.push(res.published!.map((p) => p.package));
    if (i === 2) assert.deepEqual(res.touched, [["3.24", "workflows"]]);
  }
  assert.deepEqual(pubs, [["Ax", "Bx"], ["Cx", "Dx"], ["Ex"]]);
  assert.deepEqual(await observe(env, sql, "bioc-release", { limit: 2, fetch: noNetwork }), { status: "unchanged", digest });
  assert.deepEqual(await current("3.24"), ["bioc/Ax@1.0", "bioc/Bx@1.0", "bioc/Cx@1.0", "bioc/Dx@1.0", "workflows/Ex@1.0"]);
  const bins = await db.sql`select a.os, a.arch, a.sha256 from published_artifacts a join publications p on p.id = a.publication_id
    where p.package = 'Ax'`;
  assert.deepEqual(bins.map((b) => [b.os, b.arch, b.sha256]), [["win", "x86_64", winSha]]);
  assert.ok(store.objects.has(`cas/${winSha}`));
  const [pv] = await db.sql`select meta, git_branch from package_versions where package = 'Ex'`;
  assert.equal(pv.git_branch, "RELEASE_3_24");
  const decisions = await db.sql`select package from gate_decisions where bioc_version = '3.24' and propagate`;
  assert.equal(decisions.length, 5, "each approval recorded once, however many calls it took");
});

test("observe: a source with no bytes stops what needs it, and the next call retries it", async () => {
  // P's linux binary is not in r-universe's store: it is left out, not fatal.
  const P = await source("bioc", "Px", "1.0", { RemoteRef: "HEAD", _binaries: [
    { os: "linux", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${"e".repeat(64)}`, arch: "x86_64" }] });
  const Q = await source("bioc", "Qx", "1.0", { RemoteRef: "HEAD", imports: ["Px"] });
  const R = await source("bioc", "Rx", "1.0", { RemoteRef: "HEAD", imports: ["Qx"] });
  const S = await source("bioc", "Sx", "1.0", { RemoteRef: "HEAD" });
  const qBytes = upstream.get(Q._sha256!)!;
  upstream.delete(Q._sha256!);
  await observed("bioc", [P, Q, R, S]);
  const first = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(first.published!.map((p) => p.package), ["Px", "Sx"]);
  assert.deepEqual(first.failed, [{ package: "Qx", error: "source bytes are not available" }]);
  assert.equal(first.remaining, 2);
  assert.equal(first.status, "partial");
  upstream.set(Q._sha256!, qBytes);
  const second = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(second.published!.map((p) => p.package), ["Qx", "Rx"]);
  assert.equal(second.status, "processed");
  assert.equal(second.topped_up, 0, "P's missing binary was tried again and is still missing");
  assert.ok(fetched.includes(`https://r2.ropensci.org/${"e".repeat(64)}`), "r-universe was asked for it");
  assert.equal((await db.sql`select 1 from published_artifacts a join publications p on p.id = a.publication_id
    where p.package = 'P'`).length, 0);
  assert.deepEqual(await current("3.25"), ["bioc/Px@1.0", "bioc/Qx@1.0", "bioc/Rx@1.0", "bioc/Sx@1.0"]);
});

test("observe: a tarball holding another package is refused", async () => {
  const T = await source("bioc", "Tx", "1.0", { RemoteRef: "HEAD", content: "Impostor" });
  await observed("bioc", [T]);
  const res = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(res.published, []);
  assert.match(res.failed![0].error, /source tarball is Impostor 1.0, not Tx 1.0/);
  assert.deepEqual(await current("3.25"), ["bioc/Px@1.0", "bioc/Qx@1.0", "bioc/Rx@1.0", "bioc/Sx@1.0"]);
});

test("observe: the files are written before the observation is processed, and all of them when it is", async () => {
  const U = await source("bioc", "Uu", "1.0", { RemoteRef: "HEAD" });
  const V = await source("bioc", "Vv", "1.0", { RemoteRef: "HEAD", repository: "workflows" });
  const digest = await observed("bioc", [U, V]);
  const calls: [string, string][][] = [];
  const fails = async (t: [string, string][]) => { calls.push(t); throw new Error("R2 is down"); };
  // Two publications, one per call; the second call's write fails.
  const one = await observe(env, sql, "bioc", { limit: 1, fetch: noNetwork, write: async (t) => (calls.push(t), ["k"]) });
  assert.deepEqual([one.status, one.written, calls], ["partial", ["k"], [[["3.25", "bioc"]]]]);
  await assert.rejects(observe(env, sql, "bioc", { limit: 1, fetch: noNetwork, write: fails }), /R2 is down/);
  assert.equal((await db.sql`select processed_at from observations where digest = ${digest}`)[0].processed_at, null);
  // Nothing left to publish, but the observation is complete: every repository is rewritten.
  calls.length = 0;
  const done = await observe(env, sql, "bioc", { limit: 1, fetch: noNetwork, write: async (t) => (calls.push(t), []) });
  assert.deepEqual([done.status, done.published], ["processed", []]);
  assert.deepEqual(calls.map((t) => t.map((x) => x.join("/")).sort()), [["3.25/bioc", "3.25/workflows"]]);
});

test("observe: a new observation replaces the universe's jobs and tops up a published version", async () => {
  const jobs = async () => (await db.sql`select package, config, bioc_version, r, "check", time_s, job::text, artifact
    from jobs where universe = 'bioc-release' order by package, config`).map((x) => ({ ...x }));
  assert.deepEqual((await jobs()).map((j) => j.package), ["Ax", "Ax", "Ax", "Bx", "Bx", "Cx", "Cx", "Dx", "Dx", "Ex", "Ex"]);
  const winA = await blob("a newer win build, same version");
  const winB = await blob("B's first win build");
  const pkgs = await db.sql`select package, src_sha256 from publications where bioc_version = '3.24'`;
  const src = Object.fromEntries(pkgs.map((p) => [p.package, p.src_sha256]));
  const winJob = { config: "windows-release-x86_64", r: "4.6.2", check: "OK", job: 138738173549, time: 184.4, artifact: "149" };
  await observed("bioc-release", [
    // A's win slot is filled: the newer build must not replace it.
    { ...r("Ax", "1.0"), _sha256: src.Ax, _jobs: [...OK, winJob],
      _binaries: [{ os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winA}`, arch: "x86_64" }] },
    { ...r("Bx", "1.0", { imports: ["Ax"] }), _sha256: src.Bx, _jobs: [...OK, winJob],
      _binaries: [{ os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winB}`, arch: "amd64" }] },
  ]);
  const res = await observe(env, sql, "bioc-release", { limit: 10, fetch: noNetwork });
  assert.deepEqual({ status: res.status, topped_up: res.topped_up, published: res.published, touched: res.touched },
    { status: "processed", topped_up: 1, published: [], touched: [["3.24", "bioc"]] });
  const after = await jobs();
  assert.deepEqual([...new Set(after.map((j) => j.package))], ["Ax", "Bx"]);
  assert.deepEqual(after.find((j) => j.package === "Bx" && j.config === "windows-release-x86_64"), {
    package: "Bx", config: "windows-release-x86_64", bioc_version: "3.24", r: "4.6.2", check: "OK", time_s: 184,
    job: "138738173549", artifact: "149",
  });
  const bins = await db.sql`select p.package, p.archs::text, a.arch, a.sha256 from published_artifacts a
    join publications p on p.id = a.publication_id where p.package in ('Ax', 'Bx') order by 1`;
  assert.deepEqual(bins.map((b) => [b.package, b.archs, b.arch, b.sha256]),
    [["Ax", "{linux,win}", "x86_64", (await db.sql`select sha256 from published_artifacts where filename = 'Ax_1.0.zip'`)[0].sha256],
     ["Bx", "{linux,win}", "x86_64", winB]]);
  assert.notEqual(bins[0][3], winA);
});

test("database sockets and concurrent copies leave a write its connection", () => {
  // Six open connections per Worker request. Each copy in progress holds a read; if those and
  // the idle database sockets take all six, no write can open and the request never finishes.
  assert.ok(DB_SOCKETS + COPIES < 6, `${DB_SOCKETS} sockets + ${COPIES} reads leave no connection for a write`);
});

test("storeBinaries: three copies at a time, results in input order, a missing one left out", async () => {
  const shas = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => blob(`concurrent ${i}`)));
  upstream.delete(shas[4]); // r-universe 404s it
  // The earlier binaries are the slower ones, so finishing order is not input order.
  let open = 0, most = 0;
  const slow = (async (u: string) => {
    open++; most = Math.max(most, open);
    const i = shas.findIndex((s) => u.endsWith(s));
    await new Promise((res) => setTimeout(res, (7 - i) * 5));
    open--;
    return ru(u);
  }) as typeof fetch;
  const bins = shas.map((s, i) => ({ os: "linux", r_minor: "4.6", arch: `a${i}`, filename: `x${i}.tar.gz`, sha256: s }));
  const kept = await storeBinaries({ BUCKET: store.bucket }, sql, bins, slow);
  assert.deepEqual(kept, bins.filter((_, i) => i !== 4));
  assert.equal(most, 3);
  for (const s of shas) assert.equal(store.objects.has(`cas/${s}`), s !== shas[4]);
});

test("jobRuns: each job once, a newer commit's failed build too, bad dates as none", () => {
  const runs = jobRuns([
    { Package: "a", Version: "1.0", _sha256: "s".repeat(64), RemoteRef: "RELEASE_3_24", RemoteSha: "c".repeat(40),
      _created: "2026-11-20T01:02:03Z", _expires: "2027-02-28T00:00:00.000Z",
      _jobs: [{ config: "source", r: "4.6.2", check: "OK", job: 11, time: 61.6, artifact: "901" },
        { config: "linux-release-x86_64", job: 12, artifact: "" }, { config: "wasm-release" }],
      _failure: { version: "1.1", commit: { id: "d".repeat(40) }, job: { config: "source", check: "FAILURE", job: 13, artifact: "903" } } },
    { Package: "b", Version: "2.0", RemoteRef: "HEAD", _created: "not a date", _jobs: [{ config: "source", job: 11 }] },
    { Package: "never", _failure: { job: null } },
  ], VERSIONS);
  assert.deepEqual(runs, [
    { job: 11, package: "a", version: "1.0", src_sha256: "s".repeat(64), config: "source", r: "4.6.2", check: "OK",
      time_s: 62, artifact: "901", bioc_version: "3.24", commit: "c".repeat(40), failure: false,
      built_at: "2026-11-20T01:02:03.000Z", expires_at: "2027-02-28T00:00:00.000Z" },
    { job: 12, package: "a", version: "1.0", src_sha256: "s".repeat(64), config: "linux-release-x86_64", r: null, check: null,
      time_s: null, artifact: null, bioc_version: "3.24", commit: "c".repeat(40), failure: false,
      built_at: "2026-11-20T01:02:03.000Z", expires_at: "2027-02-28T00:00:00.000Z" },
    { job: 13, package: "a", version: "1.1", src_sha256: null, config: "source", r: null, check: "FAILURE",
      time_s: null, artifact: "903", bioc_version: "3.24", commit: "d".repeat(40), failure: true,
      built_at: null, expires_at: null },
  ]);
});

test("observe: job_runs on first sight, then only last_obs_ts moves; captures queued for new jobs", async () => {
  const runs = async () => (await db.sql`select job::int, package, version, "check", artifact, failure, built_at,
    first_obs_ts, last_obs_ts from job_runs where universe = 'bioc' and job between 500 and 599 order by job`).map((x) => ({ ...x }));
  const queue = async () => (await db.sql`select job::int, kind, artifact, status from capture_queue
    where universe = 'bioc' and job between 500 and 599 order by job, kind`).map((x) => Object.values(x).join(" "));
  // On a branch no version is built from, so nothing is published: only the build record.
  const rec = (Package: string, o: Partial<ObsRecord>): ObsRecord => ({ Package, Version: "1.0", RemoteRef: "main", ...o });
  await observed("bioc", [
    rec("j1", { _jobs: [{ config: "source", check: "OK", job: 501, artifact: "a501" }, { config: "linux-devel-x86_64", job: 502 }],
      _failure: { version: "1.1", job: { config: "source", check: "FAILURE", job: 503, artifact: "a503" } } }),
  ]);
  assert.equal((await observe(env, sql, "bioc", { fetch: noNetwork })).status, "processed");
  const first = await runs();
  assert.deepEqual(first.map((x) => [x.job, x.failure, x.version]), [[501, false, "1.0"], [502, false, "1.0"], [503, true, "1.1"]]);
  assert.ok(first.every((x) => +x.first_obs_ts === +x.last_obs_ts));
  assert.deepEqual(await queue(), ["501 check a501 pending", "501 log  pending", "502 log  pending",
    "503 check a503 pending", "503 log  pending"]);

  // A later observation: 501 again (its verdict reported differently), 502 gone, 504 new.
  await db.sql`update capture_queue set status = 'done' where job = 501 and kind = 'log'`;
  await new Promise((res) => setTimeout(res, 5));
  await observed("bioc", [
    rec("j1", { Version: "1.2", _jobs: [{ config: "source", check: "WARNING", job: 501, artifact: "other" }, { config: "linux-devel-x86_64", job: 504 }] }),
  ]);
  const obs = (await db.sql`select obs_ts from observations where universe = 'bioc' order by obs_ts desc limit 1`)[0].obs_ts;
  assert.equal((await observe(env, sql, "bioc", { fetch: noNetwork })).status, "processed");
  // Observed again before it is processed: re-planned, not recorded again.
  await db.sql`update observations set processed_at = null where universe = 'bioc' and obs_ts = ${obs}`;
  await db.sql`delete from jobs where universe = 'bioc' and job = 504`;
  await observe(env, sql, "bioc", { fetch: noNetwork });
  assert.equal((await db.sql`select 1 from jobs where universe = 'bioc' and job = 504`).length, 0);
  const second = await runs();
  const [r501] = second, was = first[0];
  assert.deepEqual({ ...r501, last_obs_ts: was.last_obs_ts }, was, "nothing but last_obs_ts changes");
  assert.equal(+r501.last_obs_ts, +obs);
  assert.ok(r501.last_obs_ts > was.last_obs_ts);
  assert.deepEqual(+second[1].last_obs_ts, +first[1].last_obs_ts, "502 was not seen again");
  assert.deepEqual(second.map((x) => x.job), [501, 502, 503, 504]);
  assert.equal(+second[3].first_obs_ts, +obs);
  assert.deepEqual(await queue(), ["501 check a501 pending", "501 log  done", "502 log  pending",
    "503 check a503 pending", "503 log  pending", "504 log  pending"]);
  assert.deepEqual((await db.sql`select job::int from jobs where universe = 'bioc' order by config`).map((x) => x.job), [501]);
});

test("observe: a reverted observation is planned and recorded again as the newest", async () => {
  const before = (await db.sql`select last_obs_ts from job_runs where universe = 'bioc' and job = 502`)[0].last_obs_ts;
  await new Promise((res) => setTimeout(res, 5));
  // The first of the two observations above, reported again.
  await observed("bioc", [
    { Package: "j1", Version: "1.0", RemoteRef: "main",
      _jobs: [{ config: "source", check: "OK", job: 501, artifact: "a501" }, { config: "linux-devel-x86_64", job: 502 }],
      _failure: { version: "1.1", job: { config: "source", check: "FAILURE", job: 503, artifact: "a503" } } },
  ]);
  assert.equal((await observe(env, sql, "bioc", { fetch: noNetwork })).status, "processed");
  const [r] = await db.sql`select last_obs_ts from job_runs where universe = 'bioc' and job = 502`;
  assert.ok(r.last_obs_ts > before);
  assert.deepEqual((await db.sql`select job::int from jobs where universe = 'bioc' order by config`).map((x) => x.job), [502, 501]);
});

test("refresh: versions, then known names per version r-universe builds; a 404 version keeps none", async () => {
  const pkgs = (...names: string[]) => names.map((x) => `Package: ${x}\nVersion: 1.0\n`).join("\n");
  const pages: Record<string, string> = {
    "https://bioconductor.org/config.yaml": CONFIG,
    "https://cloud.r-project.org/src/contrib/PACKAGES": pkgs("Matrix", "ggplot2"),
    "https://bioconductor.org/packages/3.24/data/annotation/src/contrib/PACKAGES": pkgs("org.Hs.eg.db"),
    "https://bioconductor.org/packages/3.24/data/experiment/src/contrib/PACKAGES": pkgs("airway"),
    "https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES": pkgs("rnaseqGene"),
    "https://bioconductor.org/packages/3.24/books/src/contrib/PACKAGES": pkgs("OSCA"),
  };
  const f = (async (u: string) => (u in pages ? new Response(pages[u]) : new Response("", { status: 404 }))) as typeof fetch;
  const out = await refresh(sql, { fetch: f });
  assert.deepEqual(out.known, { "3.24": 6, "3.25": "not on bioconductor.org yet" });
  assert.deepEqual([...(await knownExternal(sql, "3.24"))!].sort(), ["Matrix", "OSCA", "airway", "ggplot2", "org.Hs.eg.db", "rnaseqGene"]);
  assert.equal(await knownExternal(sql, "3.25"), undefined);
  // One Bioconductor source missing, or answering with no packages, keeps the previous names.
  const WF = "https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES";
  delete pages[WF];
  const missing = await refresh(sql, { fetch: f });
  assert.match(String(missing.known["3.24"]), /failed, previous names kept: workflows: no packages/);
  assert.equal((await knownExternal(sql, "3.24"))!.size, 6);
  pages[WF] = "";
  assert.match(String((await refresh(sql, { fetch: f })).known["3.24"]), /workflows: no packages/);
  assert.equal((await knownExternal(sql, "3.24"))!.size, 6);
  // So does an empty CRAN.
  pages[WF] = pkgs("rnaseqGene");
  pages["https://cloud.r-project.org/src/contrib/PACKAGES"] = "";
  const again = await refresh(sql, { fetch: f });
  assert.match(String(again.known["3.24"]), /failed/);
  assert.equal((await knownExternal(sql, "3.24"))!.size, 6);
  assert.deepEqual((await biocVersions(sql)).filter((v) => v.universe).map((v) => v.bioc_version), ["3.24", "3.25"]);
});
