import { test } from "node:test";
import assert from "node:assert/strict";
import { macArmDir, matchSel, packagesDcf, packagesFields, packagesRecords, parseDcf, parseRepoDir, viewsDcf } from "./dcf.ts";
import type { Binary, RepoRow } from "./store.ts";

const bin = (o: Partial<Binary>): Binary => ({
  os: "win", r_minor: "4.7", arch: "", distro: "", filename: "", sha256: "s", md5: null, size_bytes: 1, ...o,
});
const row = (o: Partial<RepoRow>): RepoRow => ({
  publication_id: 1, package: "X", version: "1.0.0", origin: "r-universe", bioccheck: null, archs: [],
  published_at: "2026-08-09T00:00:00+00:00", description: { License: "MIT" }, files: {}, meta: {},
  git_url: null, git_branch: null, git_commit: null, git_commit_at: null,
  source: { filename: `${o.package ?? "X"}_${o.version ?? "1.0.0"}.tar.gz`, sha256: "src", md5: null, size_bytes: 1 },
  binaries: [], ...o,
});

const S4 = row({
  package: "S4Vectors", version: "0.50.1",
  description: {
    Package: "S4Vectors", Version: "0.50.1", Title: "Foundation of vector-like containers",
    Depends: "R (>= 4.1.0), methods, BiocGenerics (>= 0.53.2)", Imports: "stats",
    License: "Artistic-2.0", NeedsCompilation: "yes",
  },
  source: { filename: "S4Vectors_0.50.1.tar.gz", sha256: "aaa", md5: "0123456789abcdef0123456789abcdef", size_bytes: 9 },
  binaries: [
    bin({ os: "mac", r_minor: "4.7", arch: "aarch64", filename: "S4Vectors_0.50.1.tgz", sha256: "ccc" }),
    bin({ os: "win", r_minor: "4.7", arch: "aarch64", filename: "S4Vectors_0.50.1.zip", sha256: "bb2", md5: "b".repeat(32) }),
    bin({ os: "win", r_minor: "4.7", arch: "x86_64", filename: "S4Vectors_0.50.1.zip", sha256: "bbb", md5: "a".repeat(32) }),
    bin({ os: "linux", r_minor: "4.6", arch: "x86_64", filename: "S4Vectors_0.50.1.tar.gz", sha256: "ddd" }),
  ],
});
// Its DESCRIPTION was never captured: it must not reach PACKAGES, where an absent Depends line
// reads as "no dependencies".
const UNDESCRIBED = row({ package: "legacyPkg", description: {} });

test("PACKAGES is DCF in write_PACKAGES field order, with MD5sum when known", () => {
  assert.equal(packagesDcf([UNDESCRIBED, S4], { os: "src" }), [
    "Package: S4Vectors",
    "Version: 0.50.1",
    "Depends: R (>= 4.1.0), methods, BiocGenerics (>= 0.53.2)",
    "Imports: stats",
    "License: Artistic-2.0",
    "MD5sum: 0123456789abcdef0123456789abcdef",
    "NeedsCompilation: yes",
    "File: S4Vectors_0.50.1.tar.gz",
    "",
  ].join("\n"));
  assert.doesNotMatch(packagesDcf([row({})], { os: "src" }), /MD5sum/, "an unknown md5 is left out");
});

test("packagesDcf renders packagesRecords, whose keys follow packagesFields", () => {
  const recs = packagesRecords([S4, row({ package: "A" })], { os: "src" });
  assert.deepEqual(recs.map((r) => r.Package), ["A", "S4Vectors"]);
  for (const r of recs) {
    const keys = Object.keys(r);
    assert.deepEqual(keys, packagesFields.filter((k) => keys.includes(k)));
  }
  assert.deepEqual(parseDcf(packagesDcf([S4, row({ package: "A" })], { os: "src" })), recs);
});

test("each binary directory picks its own binary, and its md5", () => {
  const pick = (dir: string[]) => packagesRecords([S4], parseRepoDir(dir)!)[0];
  assert.equal(pick(["bin", "windows", "contrib", "4.7"]).MD5sum, "a".repeat(32)); // x86_64, not arm64
  assert.equal(pick(["bin", "macosx", "big-sur-arm64", "contrib", "4.7"]).File, "S4Vectors_0.50.1.tgz");
  assert.equal(packagesDcf([S4], parseRepoDir(["bin", "windows", "contrib", "4.5"])!), "");
});

test("repo paths parse to selectors; linux and wasm get none", () => {
  assert.deepEqual(parseRepoDir(["src", "contrib"]), { os: "src" });
  assert.deepEqual(parseRepoDir(["bin", "windows", "contrib", "4.7"]), { os: "win", r: "4.7", arch: "x86_64" });
  assert.deepEqual(parseRepoDir(["bin", "macosx", "big-sur-arm64", "contrib", "4.7"]),
    { os: "mac", arch: "big-sur-arm64", r: "4.7" });
  assert.equal(parseRepoDir(["src"]), null);
  assert.equal(parseRepoDir(["bin", "linux", "resolute", "4.6"]), null);
  assert.equal(parseRepoDir(["bin", "wasm", "contrib", "4.6"]), null);
});

test("an arch-less binary is valid for every arch; CRAN arch spelling matches uname", () => {
  const noarch = bin({ os: "mac" });
  assert.ok(matchSel(noarch, { os: "mac", arch: "big-sur-arm64", r: "4.7" }));
  assert.ok(matchSel(noarch, { os: "mac", arch: "big-sur-x86_64", r: "4.7" }));
  const arm = bin({ os: "mac", arch: "aarch64" });
  assert.ok(matchSel(arm, { os: "mac", arch: "big-sur-arm64", r: "4.7" }));
  assert.ok(!matchSel(arm, { os: "mac", arch: "big-sur-x86_64", r: "4.7" }));
});

test("VIEWS: metadata, provenance, platform paths, reverse deps", () => {
  const s4 = { ...S4,
    description: { ...S4.description, Description: "S4 classes.\nSecond line.", biocViews: "Infrastructure" },
    meta: { vignettes: [{ filename: "S4Vectors.html", title: "An Overview" }] },
    git_url: "https://github.com/bioc/S4Vectors", git_branch: "devel",
    git_commit: "fe0a5fe", git_commit_at: "2026-08-10T01:21:45+00:00",
  };
  const leaf = row({ package: "leaf", version: "2.0.0",
    description: { Depends: "R (>= 4.4), S4Vectors", Suggests: "legacyPkg", License: "MIT" } });
  const stanzas = viewsDcf([leaf, UNDESCRIBED, s4]).trim().split("\n\n");
  assert.equal(stanzas.length, 2);
  const s = stanzas.find((x) => x.startsWith("Package: S4Vectors"))!;
  assert.match(s, /Title: Foundation of vector-like containers/);
  assert.match(s, /Description: S4 classes\.\n    Second line\./);
  assert.match(s, /^MD5sum: 0123456789abcdef0123456789abcdef$/m);
  assert.match(s, /^git_url: https:\/\/github\.com\/bioc\/S4Vectors$/m);
  assert.match(s, /^git_branch: devel$/m);
  assert.match(s, /git_last_commit: fe0a5fe/);
  assert.match(s, /git_last_commit_date: 2026-08-10/);
  assert.match(s, /source\.ver: src\/contrib\/S4Vectors_0\.50\.1\.tar\.gz/);
  assert.match(s, /win\.binary\.ver: bin\/windows\/contrib\/4\.7\/S4Vectors_0\.50\.1\.zip/);
  // R 4.7 is past CRAN's rename, so arm64 lives in sonoma-arm64.
  assert.match(s, /mac\.binary\.ver: bin\/macosx\/sonoma-arm64\/contrib\/4\.7\/S4Vectors_0\.50\.1\.tgz/);
  assert.match(s, /vignettes: S4Vectors\.html/);
  assert.match(s, /vignetteTitles: An Overview/);
  assert.match(s, /dependsOnMe: leaf/);
  const l = stanzas.find((x) => x.startsWith("Package: leaf"))!;
  assert.doesNotMatch(l, /Title:|vignettes:/);
  assert.match(l, /Depends: R \(>= 4\.4\), S4Vectors/);
});

test("VIEWS mac paths: arm64 tracks the R version, Intel gets its own field", () => {
  const arm = bin({ os: "mac", r_minor: "4.6", arch: "arm64", filename: "X_1.0.0.tgz" });
  const x86 = bin({ os: "mac", r_minor: "4.6", arch: "x86_64", filename: "X_1.0.0.tgz" });
  const both = viewsDcf([row({ binaries: [arm, x86] })]);
  assert.match(both, /^mac\.binary\.ver: bin\/macosx\/sonoma-arm64\/contrib\/4\.6\/X_1\.0\.0\.tgz$/m);
  assert.match(both, /^mac\.binary\.big-sur-x86_64\.ver: bin\/macosx\/big-sur-x86_64\/contrib\/4\.6\/X_1\.0\.0\.tgz$/m);
  const intelOnly = viewsDcf([row({ binaries: [x86] })]);
  assert.doesNotMatch(intelOnly, /^mac\.binary\.ver:/m);
  const old = viewsDcf([row({ binaries: [{ ...arm, r_minor: "4.5" }] })]);
  assert.match(old, /^mac\.binary\.ver: bin\/macosx\/big-sur-arm64\/contrib\/4\.5\/X_1\.0\.0\.tgz$/m);
});

test("macArmDir tracks CRAN's rename at R 4.6", () => {
  assert.equal(macArmDir("4.5"), "big-sur-arm64");
  assert.equal(macArmDir("4.6"), "sonoma-arm64");
  assert.equal(macArmDir("4.10"), "sonoma-arm64");
});

test("parseDcf: stanzas, continuation lines, trailing record, colons in values", () => {
  const recs = parseDcf("Package: alpha\nVersion: 1.0.0\nDescription: one\n    two\n\nPackage: beta\nURL: https://example.org/x");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].Description, "one two");
  assert.equal(recs[1].URL, "https://example.org/x");
});
