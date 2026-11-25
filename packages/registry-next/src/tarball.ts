// One streaming pass over a source tarball: hashes of the received bytes plus every fact the
// registry keeps about the package. Web Streams and node:crypto only, so it runs unchanged in
// Node and in Workers (nodejs_compat). Memory: the current wanted file plus one chunk.
import { createHash } from "node:crypto";

export type Inspection = {
  sha256: string;
  md5: string;
  size: number;
  package: string;
  version: string;
  description: Record<string, string>;
  files: {
    top: string[];
    instDoc: string[];
    other: string[];
    skipped: string[];
    entries: number;
  };
};

const BLOCK = 512;
// DESCRIPTION and tar extension headers are small; a larger claim is a corrupt or hostile header.
const META_MAX = 1 << 20;
const OTHER = new Set(["inst/NEWS", "inst/NEWS.md", "inst/NEWS.Rd", "inst/CITATION", "build/vignette.rds"]);
const td = new TextDecoder();

// NUL-terminated string field.
function str(b: Uint8Array, from: number, to: number): string {
  let e = from;
  while (e < to && b[e]) e++;
  return td.decode(b.subarray(from, e));
}

// Octal, or base-256 when the high bit of the first byte is set. NaN if malformed.
function num(b: Uint8Array, from: number, to: number): number {
  if (b[from] & 0x80) {
    let n = b[from] & 0x7f;
    for (let i = from + 1; i < to; i++) n = n * 256 + b[i];
    return n;
  }
  return parseInt(str(b, from, to).trim() || "0", 8);
}

function header(b: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  if (sum !== num(b, 148, 156)) throw new Error("tar header checksum mismatch");
  // The prefix field exists only in POSIX ustar ("ustar\0"); GNU ("ustar  ") reuses those bytes.
  const prefix = str(b, 257, 263) === "ustar" ? str(b, 345, 500) : "";
  const name = str(b, 0, 100);
  const size = num(b, 124, 136);
  if (Number.isNaN(size)) throw new Error("tar header has an unreadable size");
  return { name: prefix ? `${prefix}/${name}` : name, size, type: String.fromCharCode(b[156]) };
}

function pax(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (let p = 0; p < b.length; ) {
    const sp = b.indexOf(32, p);
    const len = parseInt(td.decode(b.subarray(p, Math.max(sp, p))), 10);
    if (sp < 0 || !(len > sp - p + 1) || p + len > b.length) throw new Error("bad pax extended header");
    const rec = td.decode(b.subarray(sp + 1, p + len - 1)); // the record ends in \n
    const eq = rec.indexOf("=");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

// read.dcf for one record: continuation lines join with \n, a lone "." is an empty line.
function dcf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!key) continue;
      const t = line.trim();
      out[key] += "\n" + (t === "." ? "" : t);
    } else if (!line.trim()) {
      if (key) break; // blank line ends the first record
    } else {
      const m = /^([^:]+):[ \t]*(.*)$/.exec(line);
      if (m) out[(key = m[1])] = m[2].trimEnd();
    }
  }
  return out;
}

const isDoc = (rel: string) =>
  rel.includes("/")
    ? rel.startsWith("inst/doc/") || /^inst\/NEWS[^/]*$/.test(rel) || rel === "inst/CITATION" || rel === "build/vignette.rds"
    : /^(NEWS|README|INSTALL|LICENSE|LICENCE)/.test(rel) || rel === "CITATION";

export async function inspectTarball(
  body: ReadableStream<Uint8Array>,
  opts: { onDoc?: (path: string, bytes: Uint8Array) => void | Promise<void>; maxDocBytes?: number } = {},
): Promise<Inspection> {
  const maxDoc = opts.maxDocBytes ?? 20 * 1024 * 1024;
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let size = 0;
  let notGzip = false;
  const head: number[] = [];
  const checkMagic = () => {
    if (head[0] === 0x1f && head[1] === 0x8b) return;
    notGzip = true;
    throw new Error("not a gzip stream");
  };
  const hashed = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      const before = head.length;
      for (let i = 0; head.length < 2 && i < chunk.length; i++) head.push(chunk[i]);
      if (before < 2 && head.length === 2) checkMagic();
      size += chunk.length;
      sha.update(chunk);
      md5.update(chunk);
      c.enqueue(chunk);
    },
    flush() {
      if (head.length < 2) checkMagic();
    },
  });
  const r = body.pipeThrough(hashed).pipeThrough(new DecompressionStream("gzip")).getReader();

  let chunk: Uint8Array = new Uint8Array(0);
  let pos = 0;
  const read = async () => {
    try {
      return await r.read();
    } catch (e) {
      throw new Error(notGzip ? "not a gzip stream" : `truncated or corrupt gzip stream: ${(e as Error).message}`);
    }
  };
  const fill = async () => {
    const res = await read();
    if (res.done) throw new Error("truncated tar archive");
    chunk = res.value;
    pos = 0;
  };
  const take = async (n: number) => {
    const out = new Uint8Array(n);
    for (let o = 0; o < n; ) {
      if (pos >= chunk.length) await fill();
      const k = Math.min(n - o, chunk.length - pos);
      out.set(chunk.subarray(pos, pos + k), o);
      o += k;
      pos += k;
    }
    return out;
  };
  const skip = async (n: number) => {
    while (n > 0) {
      if (pos >= chunk.length) await fill();
      const k = Math.min(n, chunk.length - pos);
      pos += k;
      n -= k;
    }
  };

  const files = { top: [] as string[], instDoc: [] as string[], other: [] as string[], skipped: [] as string[], entries: 0 };
  let descText: string | undefined;
  try {
    let next: { path?: string; size?: number } = {};
    for (;;) {
      const raw = await take(BLOCK);
      if (raw.every((x) => x === 0)) break;
      const h = header(raw);
      const pad = (n: number) => Math.ceil(n / BLOCK) * BLOCK - n;
      if (h.type === "L" || h.type === "x") {
        if (h.size > META_MAX) throw new Error("tar extension header is too large");
        const data = await take(h.size);
        await skip(pad(h.size));
        if (h.type === "L") next.path = str(data, 0, data.length);
        else {
          const p = pax(data);
          if (p.path) next.path = p.path;
          if (p.size) next.size = Number(p.size);
        }
        continue;
      }
      if (h.type === "g") {
        await skip(h.size + pad(h.size));
        continue;
      }
      files.entries++;
      const n = next.size ?? h.size;
      const name = next.path ?? h.name;
      next = {};
      // Strip the leading "<pkg>/"; a regular file outside any directory is not in the package.
      const clean = name.replace(/^(\.\/)+/, "");
      const rel = clean.slice(clean.indexOf("/") + 1);
      const regular = (h.type === "0" || h.type === "\0") && clean.includes("/") && rel !== "" && !rel.endsWith("/");
      let doc = false;
      if (regular) {
        if (rel === "DESCRIPTION") {
          if (n > META_MAX) throw new Error("DESCRIPTION is too large");
          descText = td.decode(await take(n));
          await skip(pad(n));
          files.top.push(rel);
          continue;
        }
        if (!rel.includes("/")) files.top.push(rel);
        else if (rel.startsWith("inst/doc/")) files.instDoc.push(rel.slice(9));
        if (OTHER.has(rel)) files.other.push(rel);
        doc = isDoc(rel);
      }
      if (doc && n > maxDoc) {
        files.skipped.push(rel);
        doc = false;
      }
      if (doc) {
        const data = await take(n);
        await skip(pad(n));
        await opts.onDoc?.(rel, data);
      } else await skip(n + pad(n));
    }
    // Keep reading so the hashes cover every byte, including whatever follows the end blocks.
    while (!(await read()).done);
  } catch (e) {
    await r.cancel().catch(() => {});
    throw e;
  }

  if (descText === undefined) throw new Error("tarball has no DESCRIPTION");
  const description = dcf(descText);
  if (!description.Package) throw new Error("DESCRIPTION has no Package field");
  if (!description.Version) throw new Error("DESCRIPTION has no Version field");
  return {
    sha256: sha.digest("hex"),
    md5: md5.digest("hex"),
    size,
    package: description.Package,
    version: description.Version,
    description,
    files,
  };
}
