import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { inspectTarball } from "./tarball.ts";

const tmp = mkdtempSync(join(tmpdir(), "tarball-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const DESC = [
  "Package: demo",
  "Version: 1.2.3",
  "Title: A Demo",
  "Description: First line,",
  "    second line.",
  "    .",
  "    After a blank.",
  'Authors@R: c(person("A", "B", role = "aut"),',
  '    person("C", "D", role = "cre"))',
  "License: Artistic-2.0",
  "",
].join("\n");

const longDir = "d".repeat(90);
const longName = "vignette-with-a-long-name.html";

// Writes `files` under pkg/ and returns the uncompressed tar, members in the given order.
let n = 0;
function tar(files: Record<string, string | Buffer>, o: { format?: string; order?: string[] } = {}): Buffer {
  const dir = join(tmp, `fx${n++}`);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "pkg", p)), { recursive: true });
    writeFileSync(join(dir, "pkg", p), c);
  }
  const members = o.order ? o.order.map((m) => `pkg/${m}`) : ["pkg"];
  const fmt = o.format ? [`--format=${o.format}`] : [];
  return execFileSync("tar", ["-cf", "-", "--owner=0", "--group=0", ...fmt, "-C", dir, ...members], { maxBuffer: 1 << 28 });
}

const stream = (b: Uint8Array, chunk = b.length) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += chunk) c.enqueue(b.subarray(i, i + chunk));
      c.close();
    },
  });

const base = {
  DESCRIPTION: DESC,
  "NEWS.md": "# news",
  LICENSE: "MIT",
  "R/f.R": "f <- 1",
  "inst/NEWS": "old news",
  "inst/CITATION": "citation()",
  "inst/doc/x.html": "<html>x</html>",
  "build/vignette.rds": "rds",
  [`inst/doc/${longDir}/${longName}`]: "<html>long</html>",
};

test("ordinary package", async () => {
  const gz = gzipSync(tar(base));
  const file = join(tmp, "demo_1.2.3.tar.gz");
  writeFileSync(file, gz);
  const docs: Record<string, string> = {};
  const got = await inspectTarball(stream(gz), { onDoc: (p, b) => void (docs[p] = new TextDecoder().decode(b)) });
  assert.equal(got.sha256, createHash("sha256").update(gz).digest("hex"));
  assert.equal(got.md5, createHash("md5").update(gz).digest("hex"));
  assert.equal(got.size, gz.length);
  assert.equal(got.package, "demo");
  assert.equal(got.version, "1.2.3");
  assert.equal(got.description.Description, "First line,\nsecond line.\n\nAfter a blank.");
  assert.equal(got.description["Authors@R"], 'c(person("A", "B", role = "aut"),\nperson("C", "D", role = "cre"))');
  assert.equal(got.description.License, "Artistic-2.0");
  assert.deepEqual([...got.files.top].sort(), ["DESCRIPTION", "LICENSE", "NEWS.md"]);
  assert.deepEqual([...got.files.instDoc].sort(), [`${longDir}/${longName}`, "x.html"]);
  assert.deepEqual([...got.files.other].sort(), ["build/vignette.rds", "inst/CITATION", "inst/NEWS"]);
  assert.deepEqual(got.files.skipped, []);
  assert.ok(got.files.entries >= 9);
  assert.equal(docs["inst/doc/x.html"], "<html>x</html>");
  assert.equal(docs["NEWS.md"], "# news");
  assert.equal(docs["DESCRIPTION"], undefined);
  assert.equal(docs["R/f.R"], undefined);
});

test("DESCRIPTION after a large file", async () => {
  const gz = gzipSync(tar({ "data/big.rda": randomBytes(400_000), DESCRIPTION: DESC }, { order: ["data/big.rda", "DESCRIPTION"] }));
  const got = await inspectTarball(stream(gz));
  assert.equal(got.package, "demo");
  assert.equal(got.size, gz.length);
});

test("ustar, gnu and pax give the same file lists", async () => {
  const sorted = (f: Awaited<ReturnType<typeof inspectTarball>>["files"]) => ({
    ...f,
    top: [...f.top].sort(),
    instDoc: [...f.instDoc].sort(),
    other: [...f.other].sort(),
  });
  const [a, b, c] = await Promise.all(
    ["ustar", "gnu", "pax"].map((format) => inspectTarball(stream(gzipSync(tar(base, { format }))))),
  );
  assert.ok(a.files.instDoc.includes(`${longDir}/${longName}`));
  assert.deepEqual(sorted(b.files), sorted(a.files));
  assert.deepEqual(sorted(c.files), sorted(a.files));
});

test("chunk boundaries do not matter", async () => {
  const gz = gzipSync(tar(base, { format: "pax" }));
  const seen = async (chunk: number) => {
    const docs: [string, number][] = [];
    const r = await inspectTarball(stream(gz, chunk), { onDoc: (p, b) => void docs.push([p, b.length]) });
    return { r, docs };
  };
  const whole = await seen(gz.length);
  assert.deepEqual(await seen(1), whole);
  assert.deepEqual(await seen(7), whole);
});

test("base-256 sizes", async () => {
  const h = Buffer.alloc(512);
  h.write("pkg/DESCRIPTION");
  h[124] = 0x80;
  h.writeUInt32BE(DESC.length, 132);
  h[156] = 0x30;
  h.write("        ", 148);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.concat([h, Buffer.from(DESC), Buffer.alloc(512 - (DESC.length % 512)), Buffer.alloc(1024)]);
  assert.equal((await inspectTarball(stream(gzipSync(body)))).version, "1.2.3");
});

test("maxDocBytes moves a document to skipped", async () => {
  const docs: string[] = [];
  const got = await inspectTarball(stream(gzipSync(tar(base))), { maxDocBytes: 8, onDoc: (p) => void docs.push(p) });
  assert.ok(got.files.skipped.includes("inst/doc/x.html"));
  assert.ok(!docs.includes("inst/doc/x.html"));
  assert.ok(docs.includes("LICENSE"));
  assert.ok(got.files.instDoc.includes("x.html"));
});

test("errors", async () => {
  const plain = tar(base);
  await assert.rejects(inspectTarball(stream(Buffer.from("hello, this is not gzip"))), /not a gzip/);
  await assert.rejects(inspectTarball(stream(new Uint8Array(0))), /not a gzip/);

  const bad = Buffer.from(plain);
  bad[3] ^= 1; // a name byte, so the checksum no longer matches
  await assert.rejects(inspectTarball(stream(gzipSync(bad))), /checksum/);

  await assert.rejects(inspectTarball(stream(gzipSync(plain.subarray(0, 1200)))), /truncated tar/);
  const gz = gzipSync(plain);
  await assert.rejects(inspectTarball(stream(gz.subarray(0, gz.length - 20))), /truncated/);

  const { DESCRIPTION: _, ...none } = base;
  await assert.rejects(inspectTarball(stream(gzipSync(tar(none)))), /no DESCRIPTION/);
  await assert.rejects(inspectTarball(stream(gzipSync(tar({ DESCRIPTION: "Version: 1\n" })))), /no Package/);
  await assert.rejects(inspectTarball(stream(gzipSync(tar({ DESCRIPTION: "Package: x\n" })))), /no Version/);
});

test("a blocked consumer stops the inspector from pulling the body (backpressure)", async () => {
  // NEWS first, then 24 MB that does not compress, then DESCRIPTION. While onDoc is pending the
  // inspector must not keep reading: without backpressure it buffers the whole body in memory.
  const dir = join(tmp, "bp");
  const pkg = join(dir, "pkg");
  mkdirSync(join(pkg, "data"), { recursive: true });
  writeFileSync(join(pkg, "NEWS"), "news\n");
  writeFileSync(join(pkg, "data", "blob.bin"), randomBytes(24 * 1024 * 1024));
  writeFileSync(join(pkg, "DESCRIPTION"), "Package: pkg\nVersion: 1.0.0\n");
  const tgz = join(dir, "pkg.tar.gz");
  execFileSync("tar", ["--owner=0", "--group=0", "-czf", tgz, "-C", dir, "pkg/NEWS", "pkg/data/blob.bin", "pkg/DESCRIPTION"]);
  const bytes = readFileSync(tgz);
  const CHUNK = 64 * 1024;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled * CHUNK >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(pulled * CHUNK, ++pulled * CHUNK));
    },
  }, { highWaterMark: 0 });
  let pulledWhileBlocked = -1;
  const r = await inspectTarball(body, {
    async onDoc(path) {
      if (path !== "NEWS") return;
      await new Promise((ok) => setTimeout(ok, 300));
      pulledWhileBlocked = pulled;
    },
  });
  assert.equal(r.size, bytes.length);
  assert.ok(pulledWhileBlocked >= 0 && pulledWhileBlocked * CHUNK < 4 * 1024 * 1024,
    `pulled ${pulledWhileBlocked * CHUNK} of ${bytes.length} bytes while the consumer was blocked`);
});
