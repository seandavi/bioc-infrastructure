// Bytes into the store, and the facts a source tarball holds out of it.
import type { Sql } from "postgres";
import type { Env } from "./db.ts";
import type { Artifact } from "./gate.ts";
import { putCasObject, putPackageVersion } from "./store.ts";
import type { BinaryIn } from "./store.ts";
import { inspectTarball } from "./tarball.ts";

export type Opened = { body: ReadableStream<Uint8Array>; size: number };

const SHA256 = /^[0-9a-f]{64}$/;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// R2 needs a stream of known length. FixedLengthStream is a Workers global; Node has none and
// the test bucket does not care.
function fixedLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === "undefined") return body;
  const { readable, writable } = new FixedLengthStream(size);
  body.pipeTo(writable).catch(() => {}); // a short body fails the put, which reports it
  return readable;
}

// Makes cas/{sha256} exist in BUCKET and in cas_objects, idempotently. R2 verifies the sha256 it
// is given and rejects a mismatch, so nothing is hashed here. false: open() had no bytes.
export async function storeObject(
  bucket: R2Bucket, sql: Sql, sha256: string, open: () => Promise<Opened | null>, source_url: string | null,
): Promise<boolean> {
  if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  if ((await sql`select 1 from cas_objects where sha256 = ${sha256}`).length) return true;
  const key = `cas/${sha256}`;
  // An object without its row is a put whose row insert never ran: record it as it is.
  let obj: R2Object | null = await bucket.head(key);
  if (!obj) {
    const src = await open();
    if (!src) return false;
    obj = await bucket.put(key, fixedLength(src.body, src.size), { sha256 });
    if (!obj) throw new Error(`put ${key} returned nothing`);
  }
  const md5 = obj.checksums.md5;
  await putCasObject(sql, { sha256, md5: md5 ? hex(md5) : null, size_bytes: obj.size, source_url });
  return true;
}

// The bytes of an r-universe artifact: the current registry's mirror first, then r-universe's
// own store. null when neither has them.
export async function openArtifact(
  env: Pick<Env, "LEGACY">, universe: string, sha256: string, f: typeof fetch, size?: number | null,
): Promise<Opened | null> {
  const mirrored = await env.LEGACY.get(`prop/${universe}/cas/${sha256}`);
  if (mirrored) return { body: mirrored.body, size: mirrored.size };
  const res = await f(`https://r2.ropensci.org/${sha256}`);
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new Error(`r2.ropensci.org/${sha256}: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? size);
  if (!(len >= 0)) throw new Error(`r2.ropensci.org/${sha256}: no content-length`);
  return { body: res.body, size: len };
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", pdf: "application/pdf",
  R: "text/plain; charset=utf-8", Rmd: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8",
};
const contentType = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1] ?? ""] ?? "application/octet-stream";

export type SourceExtra = {
  meta?: Record<string, unknown>;
  git_url?: string | null; git_branch?: string | null; git_commit?: string | null; git_commit_at?: string | null;
};

// Reads cas/{sha256} back through the inspector: its documents to docs/{sha256}/, its
// DESCRIPTION and inventory to package_versions. Idempotent: an existing row means done.
export async function ingestSource(
  bucket: R2Bucket, sql: Sql, sha256: string, extra: SourceExtra,
): Promise<{ package: string; version: string }> {
  const [done] = await sql`select package, version from package_versions where src_sha256 = ${sha256}`;
  if (done) return { package: done.package, version: done.version };
  const obj = await bucket.get(`cas/${sha256}`);
  if (!obj) throw new Error(`cas/${sha256} is not in the bucket`);
  const ins = await inspectTarball(obj.body, {
    onDoc: async (path, bytes) => {
      await bucket.put(`docs/${sha256}/${path}`, bytes, { httpMetadata: { contentType: contentType(path) } });
    },
  });
  if (ins.sha256 !== sha256) throw new Error(`cas/${sha256} holds bytes hashing to ${ins.sha256}`);
  await putPackageVersion(sql, {
    src_sha256: sha256, package: ins.package, version: ins.version,
    description: ins.description, files: ins.files, ...extra,
  });
  return { package: ins.package, version: ins.version };
}

// r-universe reports aarch64/amd64, or a platform triple; the store keeps one spelling.
export const normArch = (s: string) => {
  const t = s.split("-").pop() ?? "";
  return t === "aarch64" ? "arm64" : t === "amd64" ? "x86_64" : t;
};

export const binaryIn = (a: Artifact): BinaryIn => ({
  os: a.os, r_minor: a.r.split(".").slice(0, 2).join("."), arch: normArch(a.arch ?? ""),
  distro: a.distro ?? "", filename: a.file!, sha256: a.sha256,
});
