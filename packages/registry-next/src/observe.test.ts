import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./db.ts";
import { branchVersion, observe, planWave, refresh } from "./observe.ts";
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
    // Published at this version with linux only; windows passes now and has a binary.
    r("late", "1.0", { _jobs: winOk, _binaries: [bin("linux", "1.0", "3", "x86_64"), bin("linux", "1.0", "9", "x86_64"), bin("win", "1.0", "4")] }),
    r("full", "1.0", { _binaries: [bin("linux", "1.0", "5", "x86_64")] }),
  ], VERSIONS, { "3.24": [
    pub("bioc", "steady", "1.0"), pub("bioc", "broken", "1.0"),
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
  // steady sits at its published version: not recorded. broken fails another rule too: recorded.
  assert.deepEqual(plan.decisions.map((d) => [d.package, d.propagate]), [["new", true], ["broken", false]]);
  assert.deepEqual(plan.topups, [{ bioc_version: "3.24", repo: "bioc", package: "late", publication_id: 7, archs: ["linux", "win"], widened: true,
    binaries: [{ os: "win", r_minor: "4.6", arch: "", distro: "", filename: "late_1.0.zip", sha256: "4".repeat(64) }] }]);
});

// ---------- observe, against a database and two test buckets ----------

const legacy = testBucket(), store = testBucket();
const env = { BUCKET: store.bucket, LEGACY: legacy.bucket };
const fetched: string[] = [];
const noNetwork = (async (u: string) => (fetched.push(u), new Response("", { status: 404 }))) as typeof fetch;

let n = 0;
// A real source tarball of `pkg`, mirrored where the current registry keeps it, as a record.
async function source(universe: string, pkg: string, version: string, o: Partial<ObsRecord> & { imports?: string[]; repository?: string; content?: string } = {}) {
  const dir = join(tmp, `s${n++}`);
  const name = o.content ?? pkg;
  mkdirSync(join(dir, name), { recursive: true });
  const imports = o.imports?.length ? `Imports: ${o.imports.join(", ")}\n` : "";
  writeFileSync(join(dir, name, "DESCRIPTION"), `Package: ${name}\nVersion: ${version}\n${imports}License: MIT\n`);
  writeFileSync(join(dir, name, "NEWS"), `${name} ${version}`);
  const gz = execFileSync("tar", ["-czf", "-", "--owner=0", "--group=0", "-C", dir, name]);
  await legacy.bucket.put(`prop/${universe}/cas/${sha(gz)}`, gz);
  return r(pkg, version, { ...o, _sha256: sha(gz) });
}
async function blob(universe: string, text: string) {
  const b = new TextEncoder().encode(text);
  await legacy.bucket.put(`prop/${universe}/cas/${sha(b)}`, b);
  return sha(b);
}
// The current registry's archive of one observation: state/{universe}/latest and the records.
async function observed(universe: string, records: ObsRecord[]) {
  const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  const key = `obs/${universe}/${digest.slice(0, 12)}.json`;
  await legacy.bucket.put(key, JSON.stringify(records));
  await legacy.bucket.put(`state/${universe}/latest`, JSON.stringify({ digest, key, ts: new Date().toISOString() }));
  return digest;
}
const current = async (version: string) => (await db.sql`select package, version, repo from publications
  where bioc_version = ${version} and superseded_at is null order by package`).map((x) => `${x.repo}/${x.package}@${x.version}`);

test("observe: five candidates in a dependency chain, two per call, published in order", async () => {
  const winSha = await blob("bioc-release", "a win zip");
  const chain = [
    await source("bioc-release", "A", "1.0", { _binaries: [
      { os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winSha}`, arch: "x86_64" },
    ], _jobs: [...OK, { config: "windows-release-x86_64", r: "4.6.2", check: "OK" }] }),
    await source("bioc-release", "B", "1.0", { imports: ["A"] }),
    await source("bioc-release", "C", "1.0", { imports: ["B"] }),
    await source("bioc-release", "D", "1.0", { imports: ["C", "A"] }),
    await source("bioc-release", "E", "1.0", { imports: ["D"], repository: "workflows" }),
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
  assert.deepEqual(pubs, [["A", "B"], ["C", "D"], ["E"]]);
  assert.deepEqual(await observe(env, sql, "bioc-release", { limit: 2, fetch: noNetwork }), { status: "unchanged", digest });
  assert.deepEqual(await current("3.24"), ["bioc/A@1.0", "bioc/B@1.0", "bioc/C@1.0", "bioc/D@1.0", "workflows/E@1.0"]);
  const bins = await db.sql`select a.os, a.arch, a.sha256 from published_artifacts a join publications p on p.id = a.publication_id
    where p.package = 'A'`;
  assert.deepEqual(bins.map((b) => [b.os, b.arch, b.sha256]), [["win", "x86_64", winSha]]);
  assert.ok(store.objects.has(`cas/${winSha}`));
  const [pv] = await db.sql`select meta, git_branch from package_versions where package = 'E'`;
  assert.equal(pv.git_branch, "RELEASE_3_24");
  const decisions = await db.sql`select package from gate_decisions where bioc_version = '3.24' and propagate`;
  assert.equal(decisions.length, 5, "each approval recorded once, however many calls it took");
});

test("observe: a source with no bytes stops what needs it, and the next call retries it", async () => {
  // P's linux binary is in neither store: it is left out, not fatal.
  const P = await source("bioc", "P", "1.0", { RemoteRef: "HEAD", _binaries: [
    { os: "linux", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${"e".repeat(64)}`, arch: "x86_64" }] });
  const Q = await source("bioc", "Q", "1.0", { RemoteRef: "HEAD", imports: ["P"] });
  const R = await source("bioc", "R", "1.0", { RemoteRef: "HEAD", imports: ["Q"] });
  const S = await source("bioc", "S", "1.0", { RemoteRef: "HEAD" });
  const qKey = `prop/bioc/cas/${Q._sha256}`, qBytes = legacy.objects.get(qKey)!;
  legacy.objects.delete(qKey);
  await observed("bioc", [P, Q, R, S]);
  const first = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(first.published!.map((p) => p.package), ["P", "S"]);
  assert.deepEqual(first.failed, [{ package: "Q", error: "source bytes are not available" }]);
  assert.equal(first.remaining, 2);
  assert.equal(first.status, "partial");
  legacy.objects.set(qKey, qBytes);
  const second = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(second.published!.map((p) => p.package), ["Q", "R"]);
  assert.equal(second.status, "processed");
  assert.equal(second.topped_up, 0, "P's missing binary was tried again and is still missing");
  assert.ok(fetched.includes(`https://r2.ropensci.org/${"e".repeat(64)}`), "r-universe was asked after the mirror");
  assert.equal((await db.sql`select 1 from published_artifacts a join publications p on p.id = a.publication_id
    where p.package = 'P'`).length, 0);
  assert.deepEqual(await current("3.25"), ["bioc/P@1.0", "bioc/Q@1.0", "bioc/R@1.0", "bioc/S@1.0"]);
});

test("observe: a tarball holding another package is refused", async () => {
  const T = await source("bioc", "T", "1.0", { RemoteRef: "HEAD", content: "Impostor" });
  await observed("bioc", [T]);
  const res = await observe(env, sql, "bioc", { limit: 10, fetch: noNetwork });
  assert.deepEqual(res.published, []);
  assert.match(res.failed![0].error, /source tarball is Impostor 1.0, not T 1.0/);
  assert.deepEqual(await current("3.25"), ["bioc/P@1.0", "bioc/Q@1.0", "bioc/R@1.0", "bioc/S@1.0"]);
});

test("observe: a new observation replaces the universe's jobs and tops up a published version", async () => {
  const jobs = async () => (await db.sql`select package, config, bioc_version, r, "check", time_s, job::text, artifact
    from jobs where universe = 'bioc-release' order by package, config`).map((x) => ({ ...x }));
  assert.deepEqual((await jobs()).map((j) => j.package), ["A", "A", "A", "B", "B", "C", "C", "D", "D", "E", "E"]);
  const winA = await blob("bioc-release", "a newer win build, same version");
  const winB = await blob("bioc-release", "B's first win build");
  const pkgs = await db.sql`select package, src_sha256 from publications where bioc_version = '3.24'`;
  const src = Object.fromEntries(pkgs.map((p) => [p.package, p.src_sha256]));
  const winJob = { config: "windows-release-x86_64", r: "4.6.2", check: "OK", job: 138738173549, time: 184, artifact: "149" };
  await observed("bioc-release", [
    // A's win slot is filled: the newer build must not replace it.
    { ...r("A", "1.0"), _sha256: src.A, _jobs: [...OK, winJob],
      _binaries: [{ os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winA}`, arch: "x86_64" }] },
    { ...r("B", "1.0", { imports: ["A"] }), _sha256: src.B, _jobs: [...OK, winJob],
      _binaries: [{ os: "win", r: "4.6.2", version: "1.0", status: "success", fileid: `x/${winB}`, arch: "amd64" }] },
  ]);
  const res = await observe(env, sql, "bioc-release", { limit: 10, fetch: noNetwork });
  assert.deepEqual({ status: res.status, topped_up: res.topped_up, published: res.published, touched: res.touched },
    { status: "processed", topped_up: 1, published: [], touched: [["3.24", "bioc"]] });
  const after = await jobs();
  assert.deepEqual([...new Set(after.map((j) => j.package))], ["A", "B"]);
  assert.deepEqual(after.find((j) => j.package === "B" && j.config === "windows-release-x86_64"), {
    package: "B", config: "windows-release-x86_64", bioc_version: "3.24", r: "4.6.2", check: "OK", time_s: 184,
    job: "138738173549", artifact: "149",
  });
  const bins = await db.sql`select p.package, p.archs::text, a.arch, a.sha256 from published_artifacts a
    join publications p on p.id = a.publication_id where p.package in ('A', 'B') order by 1`;
  assert.deepEqual(bins.map((b) => [b.package, b.archs, b.arch, b.sha256]),
    [["A", "{linux,win}", "x86_64", (await db.sql`select sha256 from published_artifacts where filename = 'A_1.0.zip'`)[0].sha256],
     ["B", "{linux,win}", "x86_64", winB]]);
  assert.notEqual(bins[0][3], winA);
});

test("refresh: versions, then known names per version r-universe builds; a 404 version keeps none", async () => {
  const pkgs = (...names: string[]) => names.map((x) => `Package: ${x}\nVersion: 1.0\n`).join("\n");
  const pages: Record<string, string> = {
    "https://bioconductor.org/config.yaml": CONFIG,
    "https://cloud.r-project.org/src/contrib/PACKAGES": pkgs("Matrix", "ggplot2"),
    "https://bioconductor.org/packages/3.24/data/annotation/src/contrib/PACKAGES": pkgs("org.Hs.eg.db"),
    "https://bioconductor.org/packages/3.24/data/experiment/src/contrib/PACKAGES": pkgs("airway"),
    "https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES": pkgs("rnaseqGene"),
  };
  const f = (async (u: string) => (u in pages ? new Response(pages[u]) : new Response("", { status: 404 }))) as typeof fetch;
  const out = await refresh(sql, { fetch: f });
  assert.deepEqual(out.known, { "3.24": 5, "3.25": "not on bioconductor.org yet" });
  assert.deepEqual([...(await knownExternal(sql, "3.24"))!].sort(), ["Matrix", "airway", "ggplot2", "org.Hs.eg.db", "rnaseqGene"]);
  assert.equal(await knownExternal(sql, "3.25"), undefined);
  // A failed source keeps the previous names.
  delete pages["https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES"];
  pages["https://cloud.r-project.org/src/contrib/PACKAGES"] = "";
  const again = await refresh(sql, { fetch: f });
  assert.match(String(again.known["3.24"]), /failed/);
  assert.equal((await knownExternal(sql, "3.24"))!.size, 5);
  assert.deepEqual((await biocVersions(sql)).filter((v) => v.universe).map((v) => v.bioc_version), ["3.24", "3.25"]);
});
