import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "./db.ts";
import { testDb } from "./testdb.ts";
import {
  addBinaries, biocVersion, biocVersions, casDoc, knownExternal, packageDoc, parseBiocConfig, publish,
  published, PublishRefused, putCasObject, putPackageVersion, recordDecisions, repoRows, setBiocVersions,
  setKnownExternal,
} from "./store.ts";
import type { DecisionRow } from "./store.ts";

const db = await testDb();
// The Worker's own client settings (fetch_types off), so these tests cover what production runs.
const open = () => connect({ HYPERDRIVE: { connectionString: db.url } });
const sql = open();
after(async () => { await sql.end(); await db.close(); });

const hex = (s: string, n = 64) => createHash("sha256").update(s).digest("hex").slice(0, n);

// A source tarball in the store: its CAS object and package_versions row.
async function source(pkg: string, version: string, salt = "") {
  const sha = hex(`${pkg}_${version}${salt}`);
  await putCasObject(sql, { sha256: sha, md5: hex(sha, 32), size_bytes: 1000 });
  await putPackageVersion(sql, {
    src_sha256: sha, package: pkg, version,
    description: { Package: pkg, Version: version, Imports: "stats", License: "MIT", Title: "T" },
  });
  return sha;
}
const blob = async (name: string) => {
  const sha = hex(name);
  await putCasObject(sql, { sha256: sha, size_bytes: 10 });
  return sha;
};
const pub = (src_sha256: string, origin: "r-universe" | "bioc-build" | "bioconductor" = "r-universe") =>
  ({ bioc_version: "3.24", repo: "bioc", src_sha256, origin, archs: ["linux"] });
const current = async (pkg: string) =>
  db.sql`select version, origin from publications where package = ${pkg} and superseded_at is null`;

const CONFIG = `
release_version: "3.24"
devel_version: "3.25"
r_ver_for_bioc_ver:
  "3.22": "4.5"
  "3.23": "4.5"
  "3.24": "4.6"
  "3.25": "4.6"
bioc_version_for_r_ver:
  "4.6": "3.24"
`;

test("parseBiocConfig reads the roles and the R line of each version", () => {
  const c = parseBiocConfig(CONFIG);
  assert.equal(c.release, "3.24");
  assert.equal(c.devel, "3.25");
  assert.deepEqual(c.r, { "3.22": "4.5", "3.23": "4.5", "3.24": "4.6", "3.25": "4.6" });
  assert.equal(c.ruRelease, "3.24", "without r_universe_* keys, the roles");
  assert.equal(c.ruDevel, "3.25");
});

// As config.yaml read on 2026-11-25: r-universe has rolled ahead of the roles, and the version it
// builds as devel has no R line yet.
const ROLL = `r_universe_release_version: "3.24"
r_universe_devel_version: "3.25"
release_version: "3.23"
devel_version: "3.24"
r_ver_for_bioc_ver:
  "3.9": "3.6"
  "3.10": "3.6"
  "3.23": "4.6"
  "3.24": "4.6"
release_dates:
  "1.0": "1/5/2001"
`;

test("parseBiocConfig: an unmapped version r-universe builds takes the newest mapped R line", () => {
  const c = parseBiocConfig(ROLL);
  assert.deepEqual([c.release, c.devel, c.ruRelease, c.ruDevel], ["3.23", "3.24", "3.24", "3.25"]);
  assert.deepEqual(c.r, { "3.9": "3.6", "3.10": "3.6", "3.23": "4.6", "3.24": "4.6", "3.25": "4.6" });
  assert.throws(() => parseBiocConfig("release_version: 3.1\ndevel_version: 3.2\n"), /no r_ver_for_bioc_ver/);
});

test("setBiocVersions moves the roles so exactly release and devel hold them", async () => {
  await setBiocVersions(sql, CONFIG);
  const roles = async () => Object.fromEntries((await biocVersions(sql)).map((v) => [v.bioc_version, v.role]));
  assert.deepEqual(await roles(), { "3.22": null, "3.23": null, "3.24": "release", "3.25": "devel" });
  // The roll: devel becomes release and a new devel appears, in one update.
  await setBiocVersions(sql, CONFIG.replace('"3.24"\ndevel_version: "3.25"', '"3.25"\ndevel_version: "3.26"')
    .replace('  "3.25": "4.6"', '  "3.25": "4.6"\n  "3.26": "4.7"'));
  assert.deepEqual(await roles(), { "3.22": null, "3.23": null, "3.24": null, "3.25": "release", "3.26": "devel" });
  assert.equal((await biocVersion(sql, "devel"))?.r_minor, "4.7");
  assert.equal((await biocVersion(sql, "3.24"))?.r_minor, "4.6");
  assert.equal(await biocVersion(sql, "9.9"), undefined);
  // A release roll as config.yaml has it: universes move ahead of the roles.
  const rolled = await setBiocVersions(sql, ROLL);
  assert.deepEqual(rolled.filter((v) => v.role || v.universe).map((v) => [v.bioc_version, v.r_minor, v.role, v.universe]), [
    ["3.23", "4.6", "release", null], ["3.24", "4.6", "devel", "bioc-release"], ["3.25", "4.6", null, "bioc"],
  ]);
  await setBiocVersions(sql, CONFIG); // back to the fixture for the route tests below
  assert.deepEqual((await biocVersions(sql)).filter((v) => v.universe).map((v) => [v.bioc_version, v.universe]),
    [["3.24", "bioc-release"], ["3.25", "bioc"]]);
});

test("knownExternal is undefined until a version has names, then exactly the last set", async () => {
  assert.equal(await knownExternal(sql, "3.24"), undefined);
  await setKnownExternal(sql, "3.24", ["Matrix", "org.Hs.eg.db", "Matrix"]);
  await setKnownExternal(sql, "3.24", ["Matrix", "GO.db"]);
  assert.deepEqual([...(await knownExternal(sql, "3.24"))!].sort(), ["GO.db", "Matrix"]);
  await setKnownExternal(sql, "3.24", []);
});

test("putCasObject is idempotent and fills a missing md5, never replaces one", async () => {
  const sha = hex("cas-1");
  await putCasObject(sql, { sha256: sha, size_bytes: 5 });
  await putCasObject(sql, { sha256: sha, size_bytes: 5, md5: "a".repeat(32) });
  await putCasObject(sql, { sha256: sha, size_bytes: 5, md5: "b".repeat(32) });
  const [row] = await db.sql`select md5 from cas_objects where sha256 = ${sha}`;
  assert.equal(row.md5, "a".repeat(32));
});

test("publish: first, no-op, upgrade, and every refusal of the version rule", async () => {
  const v1 = await source("limma", "3.60.0"), v2 = await source("limma", "3.61.0");
  const first = await publish(sql, { ...pub(v1), binaries: [{ os: "win", r_minor: "4.6", arch: "x86_64", filename: "limma_3.60.0.zip", sha256: await blob("w") }] });
  assert.equal(first.changed, true);
  assert.equal(first.superseded, undefined);
  assert.deepEqual(await publish(sql, pub(v1)), { changed: false, publication_id: first.publication_id });
  const up = await publish(sql, pub(v2));
  assert.equal(up.superseded, first.publication_id);
  // Downgrade, same version from another producer, and same version with other bytes: refused.
  await assert.rejects(publish(sql, pub(v1)), PublishRefused);
  await assert.rejects(publish(sql, pub(v2, "bioc-build")), /version-gate: 3.61.0 is not > 3.61.0 \(r-universe\)/);
  await assert.rejects(publish(sql, pub(await source("limma", "3.61.0", "rebuilt"))), PublishRefused);
  await assert.rejects(publish(sql, pub(hex("nothing"))), /not in the store/);
  assert.deepEqual([...await current("limma")], [{ version: "3.61.0", origin: "r-universe" }]);
});

test("publish: a same-version build replaces a bioconductor seed, once", async () => {
  const seed = await source("BiocFileCache", "3.2.0", "seed"), ours = await source("BiocFileCache", "3.2.0");
  await publish(sql, pub(seed, "bioconductor"));
  assert.equal((await publish(sql, pub(ours, "bioc-build"))).changed, true);
  await assert.rejects(publish(sql, pub(seed, "bioconductor")), PublishRefused);
  assert.deepEqual([...await current("BiocFileCache")], [{ version: "3.2.0", origin: "bioc-build" }]);
});

// The point of the transaction: two producers publishing one package at once, on separate
// connections, end with one current row at the higher version, whichever reaches the lock first,
// and whether or not a row existed before.
test("publish: concurrent publishes of one package never downgrade and leave one current row", async () => {
  const a = open(), b = open();
  try {
    for (let i = 0; i < 10; i++) {
      for (const order of ["low-first", "high-first"]) {
        const pkg = `race${i}${order === "low-first" ? "L" : "H"}`;
        if (i % 2) await publish(sql, pub(await source(pkg, "0.9.0"))); // half start from a row
        const lo = pub(await source(pkg, "1.0.0")), hi = pub(await source(pkg, "2.0.0"));
        const [x, y] = order === "low-first" ? [lo, hi] : [hi, lo];
        const res = await Promise.allSettled([publish(a, x), publish(b, y)]);
        for (const r of res)
          if (r.status === "rejected") assert.ok(r.reason instanceof PublishRefused, String(r.reason));
        assert.deepEqual([...await current(pkg)], [{ version: "2.0.0", origin: "r-universe" }], pkg);
      }
    }
    // Two producers racing the identical first publication: one writes, the other is a no-op.
    const same = pub(await source("twin", "1.0.0"));
    const res = await Promise.all([publish(a, same), publish(b, same)]);
    assert.deepEqual(res.map((r) => r.changed).sort(), [false, true]);
    assert.equal(res[0].publication_id, res[1].publication_id);
  } finally {
    await a.end(); await b.end();
  }
});

test("addBinaries fills empty slots only, widens archs, and ignores a superseded publication", async () => {
  const v1 = await source("SparseArray", "1.13.3");
  const w1 = await blob("sa-w1"), w2 = await blob("sa-w2"), m1 = await blob("sa-m1");
  const { publication_id } = await publish(sql, { ...pub(v1), archs: ["win"],
    binaries: [{ os: "win", r_minor: "4.6", arch: "x86_64", filename: "SparseArray_1.13.3.zip", sha256: w1 }] });
  const t = await addBinaries(sql, publication_id, [
    { os: "win", r_minor: "4.6", arch: "x86_64", filename: "SparseArray_1.13.3.zip", sha256: w2 },
    { os: "mac", r_minor: "4.6", arch: "arm64", filename: "SparseArray_1.13.3.tgz", sha256: m1 },
  ], ["mac", "linux"]);
  assert.deepEqual(t, { added: 1, archs: ["linux", "win", "mac"] });
  const [row] = await repoRows(sql, "3.24", "bioc").then((rs) => rs.filter((r) => r.package === "SparseArray"));
  assert.deepEqual(row.binaries.map((b) => [b.os, b.sha256]), [["mac", m1], ["win", w1]]);
  await publish(sql, pub(await source("SparseArray", "1.13.4")));
  assert.equal(await addBinaries(sql, publication_id, [], ["linux"]), null);
});

test("recordDecisions stores a decision only when it changed", async () => {
  const d = (o: Partial<DecisionRow> = {}): DecisionRow => ({
    bioc_version: "3.24", repo: "bioc", package: "edgeR", version: "4.10.1", origin: "r-universe",
    propagate: false, archs: [], reasons: [{ rule: "deps", ok: false, detail: "needs X" }], ...o,
  });
  const wave = Array.from({ length: 2500 }, (_, i) => d({ package: `p${i}` }));
  assert.equal(await recordDecisions(sql, wave), 2500);
  assert.equal(await recordDecisions(sql, wave), 0);
  assert.equal(await recordDecisions(sql, [d(), d({ package: "p1", propagate: true, archs: ["linux"], reasons: [] })]), 2);
  assert.equal(await recordDecisions(sql, [d({ package: "p1", propagate: true, archs: ["linux"], reasons: [] })]), 0);
  assert.equal(await recordDecisions(sql, [d({ package: "p1" })]), 1, "flipping back is a change too");
});

test("published, repoRows, packageDoc and casDoc read the current state", async () => {
  const sha = await source("S4Vectors", "0.50.1"), w = await blob("s4-win");
  await putCasObject(sql, { sha256: w, size_bytes: 10, md5: "c".repeat(32) });
  await publish(sql, { ...pub(sha), bioccheck: "OK",
    binaries: [{ os: "win", r_minor: "4.6", arch: "x86_64", filename: "S4Vectors_0.50.1.zip", sha256: w }] });
  const p = await published(sql, "3.24", "bioc");
  assert.deepEqual(p.S4Vectors, { version: "0.50.1", origin: "r-universe", desc: { Imports: "stats", License: "MIT" } });

  const row = (await repoRows(sql, "3.24", "bioc")).find((r) => r.package === "S4Vectors")!;
  assert.deepEqual(row.source, { filename: "S4Vectors_0.50.1.tar.gz", sha256: sha, md5: hex(sha, 32), size_bytes: 1000 });
  assert.deepEqual(row.binaries, [{ os: "win", r_minor: "4.6", arch: "x86_64", distro: "", filename: "S4Vectors_0.50.1.zip", sha256: w, md5: "c".repeat(32), size_bytes: 10 }]);
  assert.deepEqual(row.archs, ["linux"]);
  assert.equal(typeof row.publication_id, "number");
  assert.equal(await packageDoc(sql, "3.24", "bioc", "nope"), null);

  await recordDecisions(sql, [{ bioc_version: "3.24", repo: "bioc", package: "limma", version: "3.62.0",
    origin: "r-universe", propagate: false, archs: [], reasons: [{ rule: "families", ok: false }] }]);
  const doc = (await packageDoc(sql, "3.24", "bioc", "limma"))!;
  assert.equal(doc.current?.version, "3.61.0");
  assert.deepEqual(doc.history.map((h: { version: string }) => h.version), ["3.61.0", "3.60.0"]);
  assert.ok(doc.history[1].superseded_at);
  assert.equal(doc.decisions[0].version, "3.62.0");

  const cas = (await casDoc(sql, w))!;
  assert.equal(cas.md5, "c".repeat(32));
  assert.deepEqual(cas.publications.map((x: { package: string; as: string }) => [x.package, x.as]), [["S4Vectors", "win"]]);
  assert.equal((await casDoc(sql, sha))!.publications[0].as, "source");
  assert.equal(await casDoc(sql, hex("unknown")), null);
});

test("binary slots have one spelling: an R patch version or a uname arch fills the same slot", async () => {
  const { publication_id } = await publish(sql, { ...pub(await source("Rhtslib", "3.6.0")), archs: ["mac", "win"],
    binaries: [{ os: "mac", r_minor: "4.6.1", arch: "aarch64", filename: "Rhtslib_3.6.0.tgz", sha256: await blob("rh-m1") },
      { os: "win", r_minor: "4.6", arch: "amd64", filename: "Rhtslib_3.6.0.zip", sha256: await blob("rh-w1") }] });
  const [{ archs }] = await db.sql`select archs::text from publications where id = ${publication_id}`;
  assert.equal(archs, "{win,mac}", "archs in gate-family order, as addBinaries() keeps them");
  const t = await addBinaries(sql, publication_id, [
    { os: "mac", r_minor: "4.6", arch: "big-sur-arm64", filename: "Rhtslib_3.6.0.tgz", sha256: await blob("rh-m2") },
    { os: "win", r_minor: "4.6.2", arch: "x86_64", filename: "Rhtslib_3.6.0.zip", sha256: await blob("rh-w2") },
  ], []);
  assert.equal(t!.added, 0, "both slots were filled");
  const [row] = (await repoRows(sql, "3.24", "bioc")).filter((r) => r.package === "Rhtslib");
  assert.deepEqual(row.binaries.map((b) => [b.os, b.r_minor, b.arch, b.sha256]),
    [["mac", "4.6", "arm64", hex("rh-m1")], ["win", "4.6", "x86_64", hex("rh-w1")]]);
});

test("publish refuses a version verGt() cannot order, and a seed never replaces a seed", async () => {
  await assert.rejects(publish(sql, pub(await source("oddver", "1.0a"))), /version-parse: 1.0a/);
  assert.equal((await current("oddver")).length, 0);
  await publish(sql, pub(await source("seeded", "1.0.0", "s1"), "bioconductor"));
  await assert.rejects(publish(sql, pub(await source("seeded", "1.0.0", "s2"), "bioconductor")),
    /version-gate: 1.0.0 is not > 1.0.0 \(bioconductor\)/);
  assert.equal((await publish(sql, pub(await source("seeded", "1.0.0"), "bioc-build"))).changed, true);
});

test("recordDecisions: a package version given twice keeps its last, and concurrent calls store once", async () => {
  const d = (o: Partial<DecisionRow> = {}): DecisionRow => ({
    bioc_version: "3.24", repo: "bioc", package: "dup", version: "1.0", origin: "r-universe",
    propagate: false, archs: [], reasons: [{ rule: "families", ok: false }], ...o,
  });
  assert.equal(await recordDecisions(sql, [d(), d({ propagate: true, archs: ["linux"], reasons: [] })]), 1);
  const rows = await db.sql`select propagate from gate_decisions where package = 'dup'`;
  assert.deepEqual(rows.map((r) => r.propagate), [true]);
  const a = open(), b = open();
  try {
    const wave = Array.from({ length: 500 }, (_, i) => d({ package: `race${i}` }));
    const n = await Promise.all([recordDecisions(a, wave), recordDecisions(b, wave)]);
    assert.equal(n[0] + n[1], 500);
  } finally {
    await a.end(); await b.end();
  }
});

test("the latest decision of a package version is one index probe", async () => {
  const [ix] = await db.sql`select indexdef from pg_indexes where indexname = 'gate_decisions_version'`;
  assert.match(ix?.indexdef ?? "", /\(bioc_version, repo, package, version, decided_at DESC, id DESC\)/);
});
