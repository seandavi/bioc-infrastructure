// The repository files at Bioconductor's own paths, served from R2. Nothing here touches the
// database except Archive/, so installs keep working when it is down.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { matchSel, parseRepoDir } from "./dcf.ts";
import { archivedSource } from "./store.ts";
import type { RepoRow } from "./store.ts";

const INDEXES = new Set(["PACKAGES", "PACKAGES.gz", "PACKAGES.rds"]);
const notFound = () => new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

// Parsed index.json and versions.json, per isolate and bucket, for at most a minute; after that
// one head() decides whether the etag moved.
const TTL = 60_000;
type Cached = { etag: string; at: number; value: unknown };
const cache = new WeakMap<object, Map<string, Cached>>();
async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const mine = cache.get(bucket) ?? cache.set(bucket, new Map()).get(bucket)!;
  const hit = mine.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const head = await bucket.head(key);
  if (!head) return null;
  if (hit?.etag === head.etag) { hit.at = Date.now(); return hit.value as T; }
  const obj = await bucket.get(key);
  if (!obj) return null;
  const value = await obj.json();
  mine.set(key, { etag: obj.etag, at: Date.now(), value });
  return value as T;
}

const notModified = (inm: string | undefined, etag: string) =>
  !!inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "").replace(/"/g, "") === etag);

const app = new Hono<{ Bindings: Env }>().basePath("/packages");
app.use("*", cors());

// Which version is release and which is devel, and what each gates on.
app.get("/versions.json", async (c) => {
  const obj = await c.env.BUCKET.get("packages/versions.json");
  if (!obj) return notFound();
  return new Response(obj.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
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
  if (version === "release" || version === "devel") {
    const vs = await readJson<{ release: string | null; devel: string | null }>(bucket, "packages/versions.json");
    version = vs?.[version] ?? "";
  }
  if (!/^\d+\.\d+$/.test(version)) return notFound();
  const base = `packages/${version}/${repo}/`;
  const name = segs[segs.length - 1];

  if (rest === "VIEWS" || rest === "index.json" || (INDEXES.has(name) && parseRepoDir(segs.slice(0, -1)))) {
    const obj = await bucket.get(base + rest);
    if (!obj) return notFound();
    const headers = {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag, "cache-control": "public, max-age=300",
    };
    if (notModified(c.req.header("if-none-match"), obj.etag)) return new Response(null, { status: 304, headers });
    return new Response(obj.body, { headers });
  }

  // Archive/{package}/{package}_{version}.tar.gz: the one route that reads the database.
  let sha: string | null | undefined;
  if (segs.length === 5 && segs[0] === "src" && segs[1] === "contrib" && segs[2] === "Archive") {
    const v = name.startsWith(segs[3] + "_") && name.endsWith(".tar.gz") ? name.slice(segs[3].length + 1, -7) : "";
    if (!v) return notFound();
    const sql = connect(c.env);
    try { sha = await archivedSource(sql, version, repo, segs[3], v); } finally { await sql.end({ timeout: 5 }); }
  } else {
    // Resolve the file name the way that directory's PACKAGES was built.
    const sel = parseRepoDir(segs.slice(0, -1));
    const index = sel ? await readJson<Record<string, RepoRow>>(bucket, base + "index.json") : null;
    const row = index?.[name.split("_", 1)[0]];
    // PACKAGES skips a row whose DESCRIPTION was never captured, so the file is not served either.
    const f = sel && row && Object.keys(row.description).length > 0 && (sel.os === "src" ? row.source : row.binaries.find((b) => matchSel(b, sel)));
    sha = f && f.filename === name ? f.sha256 : null;
  }
  if (!sha) return notFound();

  const obj = await bucket.get(`cas/${sha}`, { range: c.req.raw.headers });
  if (!obj) return notFound();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream", "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag,
  };
  // R2 reports a range for a whole-object read too, so the request decides whether this is a 206.
  const r = c.req.header("range") ? (obj.range as { offset?: number; length?: number; suffix?: number } | undefined) : undefined;
  if (!r) return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
  const offset = r.offset ?? Math.max(0, obj.size - (r.suffix ?? obj.size));
  const length = r.length ?? obj.size - offset;
  return new Response(obj.body, {
    status: 206,
    headers: { ...headers, "content-length": String(length), "content-range": `bytes ${offset}-${offset + length - 1}/${obj.size}` },
  });
});

export default app;
