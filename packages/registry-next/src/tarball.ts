// One streaming pass over a source tarball: hashes of the received bytes plus every fact the
// registry keeps about the package. Web Streams and node:crypto only, so it runs unchanged in
// Node and in Workers (nodejs_compat). Memory: the current wanted file plus one chunk.
import { createHash } from "node:crypto";
import { R_PKG, R_VER } from "./gate.ts";

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

// A size or offset that can index bytes: anything else would lose the 512-byte alignment.
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : NaN);

// Octal, or base-256 when the high bit of the first byte is set (0xff starts a negative one).
// NaN if malformed, negative or beyond 2^53.
function num(b: Uint8Array, from: number, to: number): number {
  if (b[from] & 0x80) {
    if (b[from] & 0x40) return NaN;
    let n = b[from] & 0x3f;
    for (let i = from + 1; i < to; i++) n = n * 256 + b[i];
    return count(n);
  }
  const t = str(b, from, to).trim();
  return /^[0-7]*$/.test(t) ? count(parseInt(t || "0", 8)) : NaN;
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
    // "<len> <key>=<value>\n", len counting the whole record.
    const sp = b.indexOf(32, p);
    const digits = td.decode(b.subarray(p, Math.max(sp, p)));
    const len = /^\d+$/.test(digits) ? count(Number(digits)) : NaN;
    if (sp < 0 || !(len > sp - p + 1) || p + len > b.length || b[p + len - 1] !== 10)
      throw new Error("bad pax extended header");
    const rec = td.decode(b.subarray(sp + 1, p + len - 1));
    const eq = rec.indexOf("=");
    if (eq <= 0) throw new Error("bad pax extended header");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

// read.dcf for one record: continuation lines join with \n, a lone "." is an empty line, a value
// that starts on the next line has no leading \n, and trailing empty lines are dropped.
function dcf(text: string): Record<string, string> {
  const parts = new Map<string, string[]>(); // a Map, so a field named __proto__ is just a field
  let key = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!key) continue;
      const t = line.trim();
      parts.get(key)!.push(t === "." ? "" : t);
    } else if (!line.trim()) {
      if (key) break; // blank line ends the first record
    } else {
      const m = /^([^:]+):[ \t]*(.*)$/.exec(line);
      if (m) parts.set((key = m[1]), m[2].trim() ? [m[2].trimEnd()] : []);
    }
  }
  return Object.fromEntries([...parts].map(([k, v]) => [k, v.join("\n").trimEnd()]));
}

// The DESCRIPTION, parsed and checked against the directory it sits in and what the caller expects.
function checkedDescription(text: string, top: string | undefined, expect?: { package: string; version: string }) {
  const d = dcf(text);
  if (!d.Package) throw new Error("DESCRIPTION has no Package field");
  if (!d.Version) throw new Error("DESCRIPTION has no Version field");
  if (!R_PKG.test(d.Package)) throw new Error(`Package ${JSON.stringify(d.Package)} is not an R package name`);
  if (!R_VER.test(d.Version)) throw new Error(`Version ${JSON.stringify(d.Version)} is not an R version`);
  if (top !== d.Package) throw new Error(`tarball directory ${top}/ is not Package ${d.Package}`);
  if (expect && (d.Package !== expect.package || d.Version !== expect.version))
    throw new Error(`source tarball is ${d.Package} ${d.Version}, not ${expect.package} ${expect.version}`);
  return d;
}

const isDoc = (rel: string) =>
  rel.includes("/")
    ? rel.startsWith("inst/doc/") || /^inst\/NEWS[^/]*$/.test(rel) || rel === "inst/CITATION" || rel === "build/vignette.rds"
    : /^(NEWS|README|INSTALL|LICENSE|LICENCE)/.test(rel) || rel === "CITATION";

export async function inspectTarball(
  body: ReadableStream<Uint8Array>,
  opts: {
    onDoc?: (path: string, bytes: Uint8Array) => void | Promise<void>; maxDocBytes?: number;
    // The package and version the caller believes this is: checked before any onDoc() call.
    expect?: { package: string; version: string };
  } = {},
): Promise<Inspection> {
  const maxDoc = opts.maxDocBytes ?? 20 * 1024 * 1024;
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let size = 0;
  let notGzip = false;
  const head: number[] = [];
  // Pumped by hand, not pipeThrough(): awaiting each write is what applies backpressure. Node's
  // DecompressionStream does not push back through a pipe, so piping buffered the whole
  // compressed body (measured on a 719 MB tarball: 620 MB held when piped, 12 MB pumped).
  const gunzip = new DecompressionStream("gzip");
  const r = gunzip.readable.getReader();
  const src = body.getReader();
  const pump = (async () => {
    const w = gunzip.writable.getWriter();
    try {
      for (;;) {
        const { done, value } = await src.read();
        if (done) break;
        const had = head.length;
        for (let i = 0; head.length < 2 && i < value.length; i++) head.push(value[i]);
        if (had < 2 && head.length === 2 && (head[0] !== 0x1f || head[1] !== 0x8b)) notGzip = true;
        if (notGzip) throw new Error("not a gzip stream");
        size += value.length;
        sha.update(value);
        md5.update(value);
        await w.write(value);
      }
      if (head.length < 2) {
        notGzip = true;
        throw new Error("not a gzip stream");
      }
      await w.close();
    } catch (e) {
      await w.abort(e).catch(() => {});
      await src.cancel(e).catch(() => {});
      throw e;
    }
  })();
  pump.catch(() => {}); // the same failure reaches the reader below; this only stops an unhandled rejection

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
  let description: Record<string, string> | undefined, top: string | undefined;
  // Documents met before DESCRIPTION when there is an expectation to check first. R CMD build
  // puts DESCRIPTION near the front, so this is usually empty.
  // ponytail: at most maxDoc bytes held; past that a document is skipped, not held.
  let held: [string, Uint8Array][] = [], heldBytes = 0;
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
          if (p.size !== undefined) {
            next.size = /^\d+$/.test(p.size) ? count(Number(p.size)) : NaN;
            if (Number.isNaN(next.size)) throw new Error("tar pax header has an unreadable size");
          }
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
      // Every entry sits under one "<pkg>/", and no segment can climb out of it or be empty:
      // these paths become docs/ keys and the inventory.
      const dir = name.endsWith("/"); // a directory, in old tars as a type-0 entry too
      const segs = name.replace(/^(\.\/)+/, "").replace(/\/$/, "").split("/");
      if (segs.some((s) => !s || s === "." || s === "..")) throw new Error(`tar entry ${JSON.stringify(name)} has an empty, . or .. segment`);
      top ??= segs[0];
      if (segs[0] !== top || (segs.length === 1 && h.type !== "5" && !dir))
        throw new Error(`tar entry ${JSON.stringify(name)} is outside ${top}/`);
      const rel = segs.slice(1).join("/");
      const regular = (h.type === "0" || h.type === "\0") && segs.length > 1 && !dir;
      let doc = false;
      if (regular) {
        // The first DESCRIPTION is the package's; a later one is skipped, never read.
        if (rel === "DESCRIPTION") {
          if (description) {
            await skip(n + pad(n));
            continue;
          }
          if (n > META_MAX) throw new Error("DESCRIPTION is too large");
          description = checkedDescription(td.decode(await take(n)), top, opts.expect);
          await skip(pad(n));
          files.top.push(rel);
          for (const [p, b] of held) await opts.onDoc?.(p, b);
          held = [];
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
      if (doc && opts.expect && !description && heldBytes + n > maxDoc) {
        files.skipped.push(rel);
        doc = false;
      }
      if (doc) {
        const data = await take(n);
        await skip(pad(n));
        if (opts.expect && !description) {
          held.push([rel, data]);
          heldBytes += n;
        } else await opts.onDoc?.(rel, data);
      } else await skip(n + pad(n));
    }
    // Keep reading so the hashes cover every byte, including whatever follows the end blocks.
    while (!(await read()).done);
    await pump;
  } catch (e) {
    // Cancelling the source too ends a pump waiting on it, so nothing is left open or running.
    await Promise.allSettled([r.cancel(e), src.cancel(e)]);
    await pump.catch(() => {});
    throw e;
  }

  if (!description) throw new Error("tarball has no DESCRIPTION");
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
