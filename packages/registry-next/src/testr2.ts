// An in-memory stand-in for the R2 calls this package makes, for tests. Like R2, put() verifies
// a sha256 it is given and every object reports its md5.
import { createHash } from "node:crypto";

type Stored = { bytes: Uint8Array; httpMetadata: Record<string, string>; uploaded: Date; sha256?: boolean };
type Body = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null;

const hash = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest();
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const hex = (v: string | ArrayBuffer) => (typeof v === "string" ? v.toLowerCase() : Buffer.from(v).toString("hex"));

async function bytesOf(v: Body): Promise<Uint8Array> {
  if (v === null) return new Uint8Array(0);
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(await new Response(v).arrayBuffer());
}

export function testBucket() {
  const objects = new Map<string, Stored>();
  const meta = (key: string, o: Stored) => {
    const md5 = hash("md5", o.bytes);
    return {
      key, size: o.bytes.length, etag: md5.toString("hex"), httpEtag: `"${md5.toString("hex")}"`,
      uploaded: o.uploaded, httpMetadata: o.httpMetadata,
      // As R2 does, sha256 only for an object put with one.
      checksums: { md5: ab(md5), ...(o.sha256 ? { sha256: ab(hash("sha256", o.bytes)) } : {}) },
    };
  };
  const bucket = {
    async head(key: string) {
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      const copy = () => o.bytes.slice();
      return {
        ...meta(key, o),
        get body() { return new Blob([copy()]).stream(); },
        arrayBuffer: async () => copy().buffer,
        text: async () => new TextDecoder().decode(o.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      };
    },
    async put(key: string, value: Body, opts: { sha256?: string | ArrayBuffer; httpMetadata?: Record<string, string> } = {}) {
      const bytes = await bytesOf(value);
      if (opts.sha256 !== undefined && hex(opts.sha256) !== hash("sha256", bytes).toString("hex"))
        throw new Error(`put ${key}: sha256 does not match the body`);
      const o = { bytes, httpMetadata: opts.httpMetadata ?? {}, uploaded: new Date(), sha256: opts.sha256 !== undefined };
      objects.set(key, o);
      return meta(key, o);
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) objects.delete(k);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      // Past the cursor, as R2 lists, even if the cursor's own key was deleted since.
      const i = opts.cursor ? keys.findIndex((k) => k > opts.cursor!) : 0;
      const from = i < 0 ? keys.length : i;
      const page = keys.slice(from, from + (opts.limit ?? 1000));
      const truncated = from + page.length < keys.length;
      return { objects: page.map((k) => meta(k, objects.get(k)!)), truncated, cursor: truncated ? page.at(-1) : undefined };
    },
  };
  // Tests read `objects` to assert on what was written.
  return { bucket: bucket as unknown as R2Bucket, objects };
}
