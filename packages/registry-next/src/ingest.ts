// Bytes into the store, and the facts a source tarball holds out of it.
import type { Sql } from "postgres";
import type { Env } from "./db.ts";
import { normArch, rMinor } from "./dcf.ts";
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

// A copy that stalls would otherwise hold the request open until the caller gives up, with
// nothing to say which object it was (seen 2026-11-25: twenty minutes, no response). Past the
// deadline it is that object's failure, by name.
async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing after ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
// ponytail: two minutes, or the time the object takes at 2 MB/s if that is longer. The stalled
// streams are not torn down; the request ends soon after, since the caller stops on a failure.
const copyDeadline = (size: number) => Math.max(120_000, size / 2000);

// Makes cas/{sha256} exist in BUCKET and in cas_objects, idempotently. R2 verifies the sha256 it
// is given and rejects a mismatch, so nothing is hashed here. false: open() had no bytes.
export async function storeObject(
  bucket: R2Bucket, sql: Sql, sha256: string, open: () => Promise<Opened | null>, source_url: string | null,
  deadline: (size: number) => number = copyDeadline,
): Promise<boolean> {
  if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  if ((await sql`select 1 from cas_objects where sha256 = ${sha256}`).length) return true;
  const key = `cas/${sha256}`;
  // An object without its row is a put whose row insert never ran: record it as it is, but only
  // when R2 verified it against this key. Anything else is written again, verified this time.
  let obj = await bucket.head(key);
  const verified = obj?.checksums.sha256;
  if (!obj || !verified || hex(verified) !== sha256) {
    const src = await within(deadline(0), `open ${key}`, open());
    if (!src) return false;
    obj = await within(deadline(src.size), `put ${key}`, bucket.put(key, fixedLength(src.body, src.size), { sha256 }));
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
  // A missing length is an error, not 0: FixedLengthStream(0) would fail the put opaquely.
  const raw = res.headers.get("content-length") ?? (size == null ? null : String(size));
  const len = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(len)) {
    await res.body.cancel().catch(() => {});
    throw new Error(`r2.ropensci.org/${sha256}: no content-length`);
  }
  return { body: res.body, size: len };
}

const TEXT = "text/plain; charset=utf-8";
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", pdf: "application/pdf",
  R: TEXT, Rmd: TEXT, Rnw: TEXT, Rd: TEXT, qmd: TEXT, md: TEXT, txt: TEXT,
};
// An extensionless document is NEWS, README, LICENSE, CITATION and the like: text.
export const contentType = (path: string) => {
  const ext = /\.([^./]+)$/.exec(path)?.[1];
  return ext === undefined ? TEXT : TYPES[ext] ?? "application/octet-stream";
};

export type SourceExtra = {
  meta?: Record<string, unknown>;
  git_url?: string | null; git_branch?: string | null; git_commit?: string | null; git_commit_at?: string | null;
};

// Reads cas/{sha256} back through the inspector: its documents to docs/{sha256}/, its
// DESCRIPTION and inventory to package_versions. Idempotent: an existing row means done. Bytes
// that are not the expected package and version write nothing: the row's git fields and meta
// are the caller's, and would otherwise stick to another package's version for good.
export async function ingestSource(
  bucket: R2Bucket, sql: Sql, sha256: string, extra: SourceExtra, expect: { package: string; version: string },
): Promise<{ package: string; version: string }> {
  const [done] = await sql`select package, version from package_versions where src_sha256 = ${sha256}`;
  if (done && (done.package !== expect.package || done.version !== expect.version))
    throw new Error(`source tarball is ${done.package} ${done.version}, not ${expect.package} ${expect.version}`);
  if (done) return { package: done.package, version: done.version };
  const obj = await bucket.get(`cas/${sha256}`);
  if (!obj) throw new Error(`cas/${sha256} is not in the bucket`);
  const ins = await inspectTarball(obj.body, {
    expect,
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

// Spelled as the store keeps it, so planWave() can compare it with a publication's slots.
export const binaryIn = (a: Artifact): BinaryIn => ({
  os: a.os, r_minor: rMinor(a.r), arch: normArch(a.arch ?? ""),
  distro: a.distro ?? "", filename: a.file!, sha256: a.sha256,
});
