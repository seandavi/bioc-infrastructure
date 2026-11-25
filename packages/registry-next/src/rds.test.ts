import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { packagesRds, serializeCharacterMatrix } from "./rds.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// "X\n", version 3, writer 4.0.0, reader 3.5.0, native encoding "UTF-8"
const HEADER = "580a" + "00000003" + "00040000" + "00030500" + "00000005" + "5554462d38";

test("1x1 matrix, byte for byte", () => {
  const got = hex(serializeCharacterMatrix([["a"]], ["Package"], ["a"]));
  const chr = (s: string) => "00040009" + s.length.toString(16).padStart(8, "0") + Buffer.from(s).toString("hex");
  assert.equal(got, HEADER + "00000210" + "00000001" + chr("a") +
    "00000402" + "00000001" + chr("dim") + "0000000d" + "00000002" + "00000001" + "00000001" +
    "00000402" + "00000001" + chr("dimnames") + "00000013" + "00000002" +
      "00000010" + "00000001" + chr("a") + "00000010" + "00000001" + chr("Package") +
    "000000fe");
});

test("NA is a CHARSXP of length -1; the matrix is column-major", () => {
  const got = hex(serializeCharacterMatrix([["x", null], ["y", "z"]], ["A", "B"]));
  const body = got.slice(HEADER.length);
  assert.ok(body.startsWith("00000210" + "00000004"));
  assert.ok(body.includes("00000009ffffffff")); // NA
  assert.ok(body.indexOf("78") < body.indexOf("79") && body.indexOf("79") < body.indexOf("ffffffff"));
});

test("non-ASCII is UTF-8 flagged, ASCII is ASCII flagged", () => {
  const got = hex(serializeCharacterMatrix([["é"]], ["A"]));
  assert.ok(got.includes("00008009" + "00000002" + "c3a9"));
});

test("zero rows is a 0 x n matrix without row names", () => {
  const got = hex(serializeCharacterMatrix([], ["A", "B"]));
  const chr = (s: string) => "00040009" + s.length.toString(16).padStart(8, "0") + Buffer.from(s).toString("hex");
  assert.equal(got.slice(HEADER.length, HEADER.length + 16), "00000210" + "00000000");
  assert.ok(got.includes("0000000d" + "00000002" + "00000000" + "00000002"));
  assert.ok(got.includes("00000013" + "00000002" + "000000fe" + "00000010" + "00000002" + chr("A") + chr("B")));
});

test("output is deterministic and gzip", async () => {
  const r = [{ Package: "a", Version: "1" }];
  const a = await packagesRds(r, ["Package", "Version"]);
  assert.deepEqual(a, await packagesRds(r, ["Package", "Version"]));
  assert.equal(hex(gunzipSync(a).subarray(0, 2)), "580a");
});

const haveR = spawnSync("Rscript", ["--version"]).error === undefined;
const rtest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: haveR ? false : "Rscript is not on PATH; R round-trip skipped" }, fn);

function withDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "rds-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const R = (code: string) => execFileSync("Rscript", ["-e", code], { encoding: "utf8" });

rtest("readRDS gives the identical matrix, with dimnames, NA and UTF-8", () => withDir(async (dir) => {
  const fields = ["Package", "Version", "Depends", "Author"];
  const recs = [
    { Package: "alpha", Version: "1.0.0", Depends: "R (>= 4.1)" },
    { Package: "beta", Version: "2.1", Author: "Zoë Müller" },
  ];
  writeFileSync(join(dir, "PACKAGES.rds"), await packagesRds(recs, fields));
  const out = R(`f <- file.path("${dir}", "PACKAGES.rds"); x <- readRDS(f)
    e <- matrix(c("alpha","beta","1.0.0","2.1","R (>= 4.1)",NA,NA,"Zo\\u00eb M\\u00fcller"), 2,
      dimnames = list(c("alpha","beta"), c("Package","Version","Depends","Author")))
    stopifnot(identical(x, e)); cat(Encoding(x[2,4]))`);
  assert.equal(out, "UTF-8");
}));

rtest("zero rows reads as a 0 x n character matrix", () => withDir(async (dir) => {
  writeFileSync(join(dir, "PACKAGES.rds"), await packagesRds([], ["Package", "Version"]));
  R(`x <- readRDS("${dir}/PACKAGES.rds"); stopifnot(identical(x, matrix(character(), 0, 2, dimnames = list(NULL, c("Package","Version")))))`);
}));

rtest("available.packages reads only our PACKAGES.rds", () => withDir(async (dir) => {
  const fields = ["Package", "Version", "Depends", "Imports", "License", "NeedsCompilation"];
  const recs = [
    { Package: "alpha", Version: "1.0.0", Depends: "R (>= 4.1)", License: "MIT" },
    { Package: "beta", Version: "2.1", Depends: "alpha" },
  ];
  writeFileSync(join(dir, "PACKAGES.rds"), await packagesRds(recs, fields));
  R(`ap <- available.packages(contriburl = "file://${dir}", type = "source", filters = list())
    stopifnot(identical(sort(rownames(ap)), c("alpha","beta")), ap["alpha","Version"] == "1.0.0",
      ap["alpha","Depends"] == "R (>= 4.1)", ap["beta","Depends"] == "alpha")`);
}));

test("2,500 x 15 is fast", async () => {
  const fields = Array.from({ length: 15 }, (_, i) => (i ? `F${i}` : "Package"));
  const recs = Array.from({ length: 2500 }, (_, k) =>
    Object.fromEntries(fields.map((f, i) => [f, i % 5 === 4 ? undefined : `${f}-${k}-` + "x".repeat(20 + (k % 40))])));
  const t = performance.now();
  const gz = await packagesRds(recs, fields);
  const ms = performance.now() - t;
  console.log(`2500x15: ${ms.toFixed(0)} ms, ${gz.length} bytes gzip`);
  assert.ok(ms < 1000);
});
