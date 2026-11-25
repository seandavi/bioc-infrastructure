import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approveByDeps, binaryArtifacts, depConstraints, describe, gate, gateFamily, gateInputFromStaged,
  packageNames, passingFamilies, rejectedRule, verGt, waveGateConfig,
} from "./gate.ts";
import type { Origin, Published } from "./gate.ts";

const pub = (version: string, origin: Origin = "r-universe") => ({ version, origin, desc: {} });

test("describe regroups _dependencies back into DCF fields", () => {
  const d = describe({
    License: "GPL (>= 2)",
    NeedsCompilation: "yes",
    _dependencies: [
      { package: "R", version: ">= 4.1.0", role: "Depends" },
      { package: "methods", role: "Depends" },
      { package: "stats", role: "Imports" },
      { package: "knitr", role: "Suggests" },
    ],
  });
  assert.equal(d.Depends, "R (>= 4.1.0), methods");
  assert.equal(d.Imports, "stats");
  assert.equal(d.Suggests, "knitr");
  assert.equal(d.LinkingTo, undefined); // absent roles emit no field at all
  assert.equal(d.License, "GPL (>= 2)");
});

test("gateFamily maps BBS-equivalent configs and nothing else", () => {
  assert.equal(gateFamily("source"), "linux");
  assert.equal(gateFamily("linux-release-x86_64"), "linux");
  assert.equal(gateFamily("windows-release-x86_64"), "win");
  assert.equal(gateFamily("macos-release-arm64"), "mac");
  assert.equal(gateFamily("bioc-checks"), null);
  assert.equal(gateFamily("wasm-release"), null);
  assert.equal(gateFamily("linux-release-arm64"), null);
  assert.equal(gateFamily("windows-release-arm64"), null);
  assert.equal(gateFamily("macos-release-x86_64"), null);
});

test("one passing architecture is enough, and only it passes", () => {
  const jobs = [
    { config: "source", r: "4.6.1", check: "OK" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "ERROR" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "NOTE" },
    { config: "macos-release-arm64", r: "4.6.1", check: "WARNING" },
    { config: "bioc-checks", r: "4.6.1", check: "ERROR" }, // advisory, ignored
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["win", "mac"]);
});

test("every architecture failing means no propagation", () => {
  const jobs = [
    { config: "linux-release-x86_64", r: "4.6.1", check: "ERROR" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "FAIL" },
    { config: "macos-release-arm64", r: "4.6.1", check: "FAILURE" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), []);
});

test("a family only passes on the gating R line, with at least one job", () => {
  const jobs = [
    { config: "linux-devel-x86_64", r: "4.7.0", check: "OK" },   // wrong R line
    { config: "macos-release-arm64", r: "4.6.1", check: "OK" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["mac"]);
  assert.deepEqual(passingFamilies([], "4.6"), []);
});

test("all gating jobs of a family must be clean, source counts against linux", () => {
  const jobs = [
    { config: "source", r: "4.6.1", check: "ERROR" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "OK" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["win"]);
});

test("verGt compares numerically, part by part", () => {
  assert.ok(verGt("1.10.0", "1.9.9"));
  assert.ok(!verGt("1.2.0", "1.2.0"));
  assert.ok(!verGt("1.2.0", "1.2"));
  assert.ok(verGt("1.2.1", "1.2"));
  assert.ok(verGt("1.2-1", "1.2-0"));
});

test("depConstraints: hard roles only, R and base packages dropped", () => {
  assert.deepEqual(
    depConstraints({
      Depends: "R (>= 4.0.0), methods, BiocGenerics (>= 0.59.5), S4Vectors (>= 0.51.8)",
      Imports: "stats, utils, Rcpp",
      LinkingTo: "Rcpp (>= 1.0.0)",
      Suggests: "testthat (>= 3.0.0)",
    }),
    [
      { pkg: "BiocGenerics", op: ">=", ver: "0.59.5" },
      { pkg: "S4Vectors", op: ">=", ver: "0.51.8" },
      { pkg: "Rcpp", op: "", ver: "" },
      { pkg: "Rcpp", op: ">=", ver: "1.0.0" },
    ]
  );
  assert.deepEqual(depConstraints({ Imports: "IRanges(>2.47.2)" }),
    [{ pkg: "IRanges", op: ">", ver: "2.47.2" }]);
  assert.deepEqual(depConstraints({}), []);
});

// IRanges 2.47.3 requires S4Vectors >= 0.51.8, which failed its own checks, while 0.51.7 is
// published: propagating IRanges would serve a pair that cannot install.
test("approveByDeps: blocks a candidate whose published dependency is too old", () => {
  const { approved, blocked } = approveByDeps(
    [{ package: "IRanges", version: "2.47.3", desc: { Depends: "S4Vectors (>= 0.51.8)" } }],
    { S4Vectors: pub("0.51.7") });
  assert.deepEqual(approved, []);
  assert.deepEqual(blocked, [{
    package: "IRanges", version: "2.47.3",
    needs: "S4Vectors (>= 0.51.8), published 0.51.7",
  }]);
});

test("approveByDeps: coordinated bump lands, dependency ordered first", () => {
  const { approved } = approveByDeps([
    { package: "IRanges", version: "2.47.3", desc: { Depends: "S4Vectors (>= 0.51.8)" } },
    { package: "S4Vectors", version: "0.51.8", desc: { Imports: "stats" } },
  ], { S4Vectors: pub("0.51.7"), IRanges: pub("2.47.2") });
  assert.deepEqual(approved.map((c) => c.package), ["S4Vectors", "IRanges"]);
});

test("approveByDeps: dependencies we do not publish are not our business", () => {
  const { approved } = approveByDeps([{
    package: "edgeR", version: "4.10.1",
    desc: { Depends: "S4Vectors (>= 0.51.8)", Imports: "Rcpp (>= 99.0.0), crisprScoreData" },
  }], { S4Vectors: pub("0.51.9") });
  assert.deepEqual(approved.map((c) => c.package), ["edgeR"]);
});

test("approveByDeps: a hard dependency nobody publishes blocks, once names are known", () => {
  const published = { S4Vectors: pub("0.51.9") };
  const known = new Set(["Rcpp", "crisprScoreData"]);
  const melissa = { package: "Melissa", version: "1.26.0", desc: { Imports: "BPRMeth, Rcpp, S4Vectors" } };
  const edger = {
    package: "edgeR", version: "4.10.1",
    desc: { Depends: "S4Vectors (>= 0.51.8)", Imports: "Rcpp (>= 99.0.0), crisprScoreData", Suggests: "Gone" },
  };
  const { approved, blocked } = approveByDeps([melissa, edger], published, known);
  assert.deepEqual(approved.map((c) => c.package), ["edgeR"], "Suggests never blocks");
  assert.deepEqual(blocked, [{
    package: "Melissa", version: "1.26.0",
    needs: "BPRMeth, which is not in this repository, CRAN or Bioconductor's data repositories",
  }]);
  assert.deepEqual(approveByDeps([melissa], published).approved.map((c) => c.package), ["Melissa"]);
});

test("approveByDeps: a dependency approved in the same wave counts as published", () => {
  const { approved } = approveByDeps([
    { package: "Ularcirc", version: "1.0.0", desc: { Imports: "Organism.dplyr" } },
    { package: "Organism.dplyr", version: "1.40.0", desc: { Imports: "stats" } },
  ], {}, new Set());
  assert.deepEqual(approved.map((c) => c.package), ["Organism.dplyr", "Ularcirc"]);
});

test("approveByDeps: a mutual dependency cycle cannot deadlock the whole wave", () => {
  const { approved, blocked } = approveByDeps([
    { package: "A", version: "2.0.0", desc: { Imports: "B (>= 2.0.0)" } },
    { package: "B", version: "2.0.0", desc: { Imports: "A (>= 2.0.0)" } },
    { package: "C", version: "2.0.0", desc: { Imports: "stats" } },
  ], { A: pub("1.0.0"), B: pub("1.0.0"), C: pub("1.0.0") });
  assert.deepEqual(approved.map((c) => c.package), ["C"]);
  assert.deepEqual(blocked.map((b) => b.package), ["A", "B"]);
});

test("packageNames: every Package: field of a PACKAGES file", () => {
  const dcf = "Package: A3\nVersion: 1.0.0\nDepends: R (>= 2.15.0)\n\nPackage: abc.data\nVersion: 1.1\n";
  assert.deepEqual(packageNames(dcf), ["A3", "abc.data"]);
});

const GATE_CFG = { gating_r: "4.6", bioccheck: "advisory" as const, replace_seed: false };
const LINUX_OK = [{ config: "linux-x86_64", r: "4.6.1", check: "OK" }];
const cand = (o: Partial<Parameters<typeof gate>[0][number]> = {}) => ({
  package: "msdata", version: "0.52.0", origin: "bioc-build" as const,
  build_status: "success", jobs: LINUX_OK, desc: { Depends: "R (>= 4.1.0)" }, ...o,
});
const rules = (d: { reasons: { rule: string; ok: boolean }[] }) =>
  Object.fromEntries(d.reasons.map((r) => [r.rule, r.ok]));

test("gate: a clean first publication propagates and every rule reports", () => {
  const { decisions, approved } = gate([cand()], GATE_CFG, {});
  const d = decisions.msdata;
  assert.equal(d.propagate, true);
  assert.deepEqual(d.archs, ["linux"]);
  assert.deepEqual(rules(d), {
    "build-status": true, families: true, bioccheck: true, "version-parse": true,
    "version-gate": true, deps: true,
  });
  assert.deepEqual(approved, ["msdata"]);
});

test("gate: a package named like an Object.prototype member is a first publication", () => {
  const { decisions, approved } = gate([cand({ package: "constructor" }), cand({ package: "toString" })], GATE_CFG, {});
  assert.deepEqual(Object.entries(decisions).map(([k, d]) => [k, d.propagate]), [["constructor", true], ["toString", true]]);
  assert.deepEqual(approved, ["constructor", "toString"]);
});

test("gate: version-gate is strict; replace_seed lets bioc-build replace a bioconductor seed once", () => {
  const seeded: Published = { msdata: pub("0.52.0", "bioconductor") };
  const ours: Published = { msdata: pub("0.52.0", "bioc-build") };
  assert.equal(gate([cand()], GATE_CFG, seeded).decisions.msdata.propagate, false);
  assert.equal(gate([cand()], { ...GATE_CFG, replace_seed: true }, seeded).decisions.msdata.propagate, true);
  const d = gate([cand()], { ...GATE_CFG, replace_seed: true }, ours).decisions.msdata;
  assert.equal(d.propagate, false);
  assert.equal(rejectedRule(d), "version-gate");
  assert.match(d.reasons.find((r) => r.rule === "version-gate")!.detail!, /not > 0.52.0 \(bioc-build\)/);
});

test("gate: the r-universe wave config lets a passing same-version build replace a seed, once", () => {
  const jobs = [
    { config: "source", r: "4.6.1", check: "OK" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "macos-release-arm64", r: "4.6.1", check: "OK" },
  ];
  const c = cand({ package: "BiocFileCache", version: "3.2.0", origin: "r-universe", jobs });
  const d = gate([c], waveGateConfig("4.6"), { BiocFileCache: pub("3.2.0", "bioconductor") }).decisions.BiocFileCache;
  assert.equal(d.propagate, true);
  assert.deepEqual(d.archs, ["linux", "win", "mac"]);
  const again = gate([c], waveGateConfig("4.6"), { BiocFileCache: pub("3.2.0", "r-universe") }).decisions.BiocFileCache;
  assert.equal(again.propagate, false);
  assert.equal(rejectedRule(again), "version-gate");
});

test("gate: families need a passing job on the gating R line; bioccheck is advisory unless configured", () => {
  const wrongR = cand({ jobs: [{ config: "linux-x86_64", r: "4.7.0", check: "OK" }] });
  assert.equal(rejectedRule(gate([wrongR], GATE_CFG, {}).decisions.msdata), "families");
  const bcErr = cand({ jobs: [...LINUX_OK, { config: "bioc-checks", check: "ERROR" }] });
  assert.equal(gate([bcErr], GATE_CFG, {}).decisions.msdata.propagate, true);
  assert.equal(rejectedRule(gate([bcErr], { ...GATE_CFG, bioccheck: "blocking" }, {}).decisions.msdata), "bioccheck");
  assert.equal(rejectedRule(gate([cand({ build_status: "failed:build" })], GATE_CFG, {}).decisions.msdata), "build-status");
  assert.equal(rejectedRule(gate([cand({ version: "abc" })], GATE_CFG, {}).decisions.msdata), "version-parse");
});

test("gate: manifest rules apply only when a manifest block is present", () => {
  const m = { state: "active", git_url: "https://git.bioconductor.org/packages/msdata",
              streams: ["release", "devel"], component: "data-experiment", profile: "data-experiment" };
  const ok = cand({ manifest: m, source_git_url: m.git_url, stream: "release" });
  assert.equal(gate([ok], GATE_CFG, {}).decisions.msdata.propagate, true);
  assert.equal(rejectedRule(gate([cand({ ...ok, manifest: null })], GATE_CFG, {}).decisions.msdata), "manifest");
  assert.equal(rejectedRule(gate([cand({ ...ok, manifest: {} })], GATE_CFG, {}).decisions.msdata), "manifest-state");
  assert.equal(rejectedRule(gate([cand({ ...ok, stream: "oldrel" })], GATE_CFG, {}).decisions.msdata), "manifest-stream");
  assert.equal(rejectedRule(gate([cand({ ...ok, manifest: { ...m, git_url: "https://github.com/x/msdata" } })], GATE_CFG, {}).decisions.msdata), "manifest-git-url");
  assert.equal(rejectedRule(gate([cand({ ...ok, manifest: { ...m, profile: "workflows" } })], GATE_CFG, {}).decisions.msdata), "manifest-component");
  assert.ok(!("manifest-state" in rules(gate([cand()], GATE_CFG, {}).decisions.msdata)));
});

test("gate: deps rule is the wave fixpoint, ordered dependency-first, and blocks with the unmet requirement", () => {
  const published = { S4Vectors: pub("0.50.1") };
  const iranges = cand({ package: "IRanges", version: "2.60.0", desc: { Imports: "S4Vectors (>= 0.51.0)" } });
  const s4 = cand({ package: "S4Vectors", version: "0.51.0", desc: {} });
  const alone = gate([iranges], GATE_CFG, published).decisions.IRanges;
  assert.equal(alone.propagate, false);
  assert.equal(rejectedRule(alone), "deps");
  assert.match(alone.reasons.at(-1)!.detail!, /S4Vectors \(>= 0.51.0\), published 0.50.1/);
  const both = gate([iranges, s4], GATE_CFG, published);
  assert.deepEqual(both.approved, ["S4Vectors", "IRanges"]);
  assert.equal(both.decisions.IRanges.propagate, true);
});

test("binaryArtifacts keeps only successful builds of the version, for passing families or wasm", () => {
  const a = binaryArtifacts("P", "1.0", [
    { os: "win", r: "4.6.1", version: "1.0", status: "success", fileid: "x/a" },
    { os: "mac", r: "4.6.1", version: "1.0", status: "success", fileid: "x/b" },
    { os: "wasm", r: "4.6.0", version: "1.0", status: "success", fileid: "x/c" },
    { os: "win", r: "4.6.1", version: "0.9", status: "success", fileid: "x/d" },
    { os: "win", r: "4.6.1", version: "1.0", status: "success" },
  ], ["win"]);
  assert.deepEqual(a.map((x) => [x.sha256, x.file]), [["a", "P_1.0.zip"], ["c", "P_1.0.tar.gz"]]);
});

test("gateInputFromStaged: bioc-build's linux job and BiocCheck in the r-universe job shape", () => {
  const st = {
    status: "ok", stream: "release", manifest_commit: null,
    source: { git_url: "https://git.bioconductor.org/packages/msdata" },
    build: { r_version: "4.6.1" }, check: { status: "warning", bioccheck: "error" },
  };
  const c = gateInputFromStaged("msdata", { version: "0.52.0", desc: { License: "GPL" } }, st, null);
  assert.deepEqual(c.jobs, [
    { config: "linux-x86_64", r: "4.6.1", check: "WARNING" },
    { config: "bioc-checks", check: "ERROR" },
  ]);
  assert.equal(c.build_status, "success");
  assert.equal(gateInputFromStaged("msdata", c, { ...st, status: "failed:check" }, null).build_status, "failed:check");
});
