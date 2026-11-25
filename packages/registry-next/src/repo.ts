// The repository files at Bioconductor's own paths, served from R2. Nothing here touches the
// database except Archive/, so installs keep working when it is down.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { described, matchSel, parseRepoDir } from "./dcf.ts";
import { archivedSource } from "./store.ts";
import type { Binary, RepoRow } from "./store.ts";

const INDEXES = new Set(["PACKAGES", "PACKAGES.gz", "PACKAGES.rds"]);
const notFound = () => new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

// What serving a package's files needs from its index.json row; the rest stays in R2.
type Served = {
  ok: boolean; origin: string;
  source: { filename: string; sha256: string };
  binaries: Pick<Binary, "os" | "r_minor" | "arch" | "distro" | "filename" | "sha256">[];
};
const served = (idx: Record<string, RepoRow>) => new Map(Object.entries(idx).map(([k, r]): [string, Served] => [k, {
  ok: described(r), origin: r.origin,
  source: { filename: r.source.filename, sha256: r.source.sha256 },
  binaries: r.binaries.map(({ os, r_minor, arch, distro, filename, sha256 }) => ({ os, r_minor, arch, distro, filename, sha256 })),
}]));

// Parsed index.json and versions.json, per isolate and bucket, for at most a minute; after that
// one head() decides whether the etag moved. One load per key at a time, and a key whose object
// is gone is dropped. `fresh` skips the minute.
const TTL = 60_000;
type Cached = { etag: string; at: number; value: unknown };
const cache = new WeakMap<object, { done: Map<string, Cached>; loading: Map<string, Promise<unknown>> }>();
async function readJson<T>(
  bucket: R2Bucket, key: string, project: (v: any) => T, fresh = false,
): Promise<{ value: T; cached: boolean } | null> {
  const mine = cache.get(bucket) ?? cache.set(bucket, { done: new Map(), loading: new Map() }).get(bucket)!;
  const hit = mine.done.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return { value: hit.value as T, cached: true };
  let p = mine.loading.get(key) as Promise<T | null> | undefined;
  if (!p) {
    p = (async () => {
      const head = await bucket.head(key);
      const prev = mine.done.get(key);
      if (head && prev?.etag === head.etag) { prev.at = Date.now(); return prev.value as T; }
      const obj = head && await bucket.get(key);
      if (!obj) { mine.done.delete(key); return null; }
      const value = project(await obj.json());
      mine.done.set(key, { etag: obj.etag, at: Date.now(), value });
      return value;
    })().finally(() => mine.loading.delete(key));
    mine.loading.set(key, p);
  }
  const value = await p;
  return value === null ? null : { value, cached: false };
}

const notModified = (inm: string | undefined, etag: string) =>
  !!inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "").replace(/"/g, "") === etag);

// An index file as stored: conditional, five minutes of cache, and its length for HEAD too.
function indexFile(obj: R2ObjectBody, inm: string | undefined, contentType: string): Response {
  const headers = { "content-type": contentType, etag: obj.httpEtag, "cache-control": "public, max-age=300" };
  if (notModified(inm, obj.etag)) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

const app = new Hono<{ Bindings: Env }>().basePath("/packages");
app.use("*", cors());

// Which version is release and which is devel, and what each gates on.
app.get("/versions.json", async (c) => {
  const obj = await c.env.BUCKET.get("packages/versions.json");
  if (!obj) return notFound();
  return indexFile(obj, c.req.header("if-none-match"), "application/json");
});

app.get("/*", async (c) => {
  const m = c.req.path.match(/^\/packages\/([^/]+)\/(bioc|data\/annotation|data\/experiment|workflows|books)\/(.+)$/);
  if (!m) return notFound();
  let rest: string;
  try { rest = decodeURIComponent(m[3]); } catch { return notFound(); }
  const segs = rest.split("/");
  if (segs.some((s) => !s || s === "." || s === "..")) return notFound();
  const bucket = c.env.BUCKET, repo = m[2];

  let version = m[1];
  const alias = version === "release" || version === "devel";
  if (alias) {
    const vs = await readJson(bucket, "packages/versions.json", (v) => v as { release: string | null; devel: string | null });
    version = vs?.value[version as "release" | "devel"] ?? "";
  }
  if (!/^\d+\.\d+$/.test(version)) return notFound();
  const base = `packages/${version}/${repo}/`;
  const name = segs[segs.length - 1];

  if (rest === "VIEWS" || rest === "index.json" || (INDEXES.has(name) && parseRepoDir(segs.slice(0, -1)))) {
    const obj = await bucket.get(base + rest);
    if (!obj) return notFound();
    return indexFile(obj, c.req.header("if-none-match"), obj.httpMetadata?.contentType ?? "application/octet-stream");
  }

  // Archive/{package}/{package}_{version}.tar.gz: the one route that reads the database.
  let file: { sha256: string; origin: string } | null = null;
  if (segs.length === 5 && segs[0] === "src" && segs[1] === "contrib" && segs[2] === "Archive") {
    const v = name.startsWith(segs[3] + "_") && name.endsWith(".tar.gz") ? name.slice(segs[3].length + 1, -7) : "";
    if (!v) return notFound();
    const sql = connect(c.env);
    try { file = await archivedSource(sql, version, repo, segs[3], v); } finally { await sql.end({ timeout: 5 }); }
  } else {
    // Resolve the file name the way that directory's PACKAGES was built.
    const sel = parseRepoDir(segs.slice(0, -1));
    if (!sel) return notFound();
    const find = (index: Map<string, Served> | undefined) => {
      const row = index?.get(name.split("_", 1)[0]);
      // PACKAGES skips a row whose DESCRIPTION was never captured, so the file is not served either.
      const f = row?.ok && (sel.os === "src" ? row.source : row.binaries.find((b) => matchSel(b as Binary, sel)));
      return f && f.filename === name ? { sha256: f.sha256, origin: row.origin } : null;
    };
    const index = await readJson(bucket, base + "index.json", served);
    file = find(index?.value);
    // PACKAGES is read from R2 on every request, index.json from a cache: a file PACKAGES has
    // just started naming may be newer than the cached index, so look again before a 404.
    if (!file && index?.cached) file = find((await readJson(bucket, base + "index.json", served, true))?.value);
  }
  if (!file) return notFound();

  // A file at a numbered version's path keeps its bytes, unless it is a seed, which a build of
  // the same version replaces under the same name. A release/devel path moves on a roll.
  const immutable = !alias && file.origin !== "bioconductor";
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream", "accept-ranges": "bytes",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
  };
  // Only one well-formed byte range goes to R2; anything else is served whole, as RFC 9110 has
  // a server ignore a Range it does not support.
  const key = `cas/${file.sha256}`;
  const rm = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(c.req.header("range")?.trim() ?? "");
  let range: { offset: number; length: number } | undefined;
  if (rm && !(rm[2] && Number(rm[2]) < Number(rm[1]))) {
    const head = await bucket.head(key);
    if (!head) return notFound();
    const size = head.size, suffix = rm[3] === undefined ? undefined : Number(rm[3]);
    const first = suffix === undefined ? Number(rm[1]) : size - Math.min(suffix, size);
    const last = suffix === undefined && rm[2] ? Math.min(Number(rm[2]), size - 1) : size - 1;
    // Starting at or past the end, or a suffix of nothing (bytes=-0): unsatisfiable.
    if (first >= size)
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    range = { offset: first, length: last - first + 1 };
  }
  const obj = await bucket.get(key, range ? { range } : undefined);
  if (!obj) return notFound();
  headers.etag = obj.httpEtag;
  if (!range) return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...headers, "content-length": String(range.length),
      "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`,
    },
  });
});

export default app;
