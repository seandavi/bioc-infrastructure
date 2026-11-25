// Writes a repository's files to R2 from the database. The files are the only thing readers
// touch, and nothing ever reads them back to make a decision.
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { MAC_X86_DIR, macArmDir, packagesDcf, packagesFields, packagesRecords, parseRepoDir, rMinor, viewsDcf } from "./dcf.ts";
import { packagesRds } from "./rds.ts";
import { biocVersions, repoRows } from "./store.ts";
import type { RepoRow } from "./store.ts";

const TEXT = "text/plain; charset=utf-8";
const enc = new TextEncoder();

const gzip = async (b: Uint8Array) =>
  new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// Writes only when the md5 differs from the stored etag (R2's etag of a plain put is the md5),
// so an unchanged file keeps its etag and downstream caches stay valid.
async function put(bucket: R2Bucket, key: string, body: string | Uint8Array, contentType: string, written: string[]) {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  const have = await bucket.head(key);
  if (have?.etag === createHash("md5").update(bytes).digest("hex")) return;
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  written.push(key);
}

// The binary directories a row's binaries land in. An arch-less mac binary serves both.
function binaryDirs(r: RepoRow): string[] {
  return r.binaries.flatMap((b) => {
    const v = rMinor(b.r_minor);
    if (b.os === "win") return [`bin/windows/contrib/${v}`];
    if (b.os !== "mac") return [];
    const arm = `bin/macosx/${macArmDir(v)}/contrib/${v}`, x86 = `bin/macosx/${MAC_X86_DIR}/contrib/${v}`;
    return !b.arch ? [arm, x86] : /arm64|aarch64/.test(b.arch) ? [arm] : [x86];
  });
}

// Returns the keys it wrote.
export async function materialize(bucket: R2Bucket, sql: Sql, bioc_version: string, repo: string): Promise<string[]> {
  const rows = await repoRows(sql, bioc_version, repo);
  const base = `packages/${bioc_version}/${repo}/`;
  const written: string[] = [];

  // A directory that had files and no longer has a binary gets empty indexes, not stale ones.
  const dirs = new Set(["src/contrib", ...rows.flatMap(binaryDirs)]);
  for (const o of (await bucket.list({ prefix: `${base}bin/` })).objects)
    if (o.key.endsWith("/PACKAGES")) dirs.add(o.key.slice(base.length, -"/PACKAGES".length));
  // ponytail: one list() page (1000 keys) is plenty for the three index files of a few dozen directories.

  await Promise.all([...dirs].map(async (dir) => {
    const sel = parseRepoDir(dir.split("/"))!;
    const text = packagesDcf(rows, sel);
    await Promise.all([
      put(bucket, `${base}${dir}/PACKAGES`, text, TEXT, written),
      put(bucket, `${base}${dir}/PACKAGES.gz`, await gzip(enc.encode(text)), "application/gzip", written),
      put(bucket, `${base}${dir}/PACKAGES.rds`, await packagesRds(packagesRecords(rows, sel), packagesFields),
        "application/octet-stream", written),
    ]);
  }));
  await put(bucket, `${base}VIEWS`, viewsDcf(rows), TEXT, written);
  await put(bucket, `${base}index.json`, JSON.stringify(Object.fromEntries(rows.map((r) => [r.package, r]))),
    "application/json", written);
  return written.sort();
}

export async function materializeVersions(bucket: R2Bucket, sql: Sql): Promise<string[]> {
  const vs = await biocVersions(sql);
  const doc = {
    release: vs.find((v) => v.role === "release")?.bioc_version ?? null,
    devel: vs.find((v) => v.role === "devel")?.bioc_version ?? null,
    versions: Object.fromEntries(vs.map((v) => [v.bioc_version, { r_minor: v.r_minor, role: v.role }])),
  };
  const written: string[] = [];
  await put(bucket, "packages/versions.json", JSON.stringify(doc), "application/json", written);
  return written;
}
