// What r-universe does not build, seeded from bioconductor.org's own repositories so a version's
// repositories match what Bioconductor publishes: software that fails in r-universe's
// environment, all of data/annotation, and some data/experiment, workflows and books packages.
// A seed only fills a hole and is not a verdict (origin "bioconductor", no archs, no bioccheck):
// publish() lets an r-universe build of that version or a newer one replace it.
import type { Sql } from "postgres";
import type { Env } from "./db.ts";
import { MAC_X86_DIR, macArmDir, parseDcf } from "./dcf.ts";
import { R_VER } from "./gate.ts";
import { ingestSource, storeUrl } from "./ingest.ts";
import { biocVersion, currentNames, publish } from "./store.ts";
import type { BinaryIn } from "./store.ts";

// R2's limit for one put, in decimal bytes so it holds under either reading of "5 GB".
// ponytail: the four annotation packages above it are reported, not stored; they need a
// multipart upload.
export const MAX_SEED_BYTES = 5_000_000_000;

export type SeedResult = { status: "absent" } | {
  status: "partial" | "done";
  seeded: { package: string; version: string }[];
  failed: { package: string; error: string }[];
  too_large: { package: string; version: string }[];
  remaining: number;          // holes after `next` not attempted because the limit ran out
  next: string | null;        // the last package attempted: pass it as `after` to move on
  touched: [string, string][];
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The official index of one directory, by package. A directory that is not there has nothing.
async function index(f: typeof fetch, url: string): Promise<Map<string, Record<string, string>>> {
  const res = await f(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return new Map();
  }
  return new Map(parseDcf(await res.text()).map((r) => [r.Package, r]));
}

// A hole is an official package with no current publication in (bioc_version, repo). At most
// `limit` of them, in name order after `after`, are copied in and published; one failing is
// reported and skipped. Holes are recomputed from the database on every call, so calling again
// with after = next continues, and a hole that fails every time is passed, not retried forever.
export async function seed(
  env: Pick<Env, "BUCKET">, sql: Sql, bioc_version: string, repo: string,
  opts: { limit?: number; after?: string; fetch?: typeof fetch } = {},
): Promise<SeedResult> {
  const f = opts.fetch ?? fetch, limit = opts.limit ?? 5, after = opts.after ?? "";
  const v = await biocVersion(sql, bioc_version);
  if (!v) throw new Error(`unknown Bioconductor version ${bioc_version}`);
  const base = `https://bioconductor.org/packages/${bioc_version}/${repo}`;
  const res = await f(`${base}/src/contrib/PACKAGES`);
  if (res.status === 404) return { status: "absent" };
  if (!res.ok) throw new Error(`${base}/src/contrib/PACKAGES: HTTP ${res.status}`);
  const have = await currentNames(sql, bioc_version, repo);
  // Code-unit order, as Postgres "C" and R's C locale sort these ASCII names.
  const holes = parseDcf(await res.text())
    .filter((p) => p.Package && R_VER.test(p.Version ?? "") && !have.has(p.Package) && p.Package > after)
    .sort((a, b) => (a.Package < b.Package ? -1 : 1));
  const batch = holes.slice(0, limit);

  const r = v.r_minor;
  const dirs = repo === "bioc" ? [
    { os: "win", arch: "x86_64", dir: `bin/windows/contrib/${r}`, ext: "zip" },
    { os: "mac", arch: "arm64", dir: `bin/macosx/${macArmDir(r)}/contrib/${r}`, ext: "tgz" },
    { os: "mac", arch: "x86_64", dir: `bin/macosx/${MAC_X86_DIR}/contrib/${r}`, ext: "tgz" },
  ] : [];
  // Each fetched once per call, and only when there is something to seed.
  const [views, ...bins] = batch.length
    ? await Promise.all([index(f, `${base}/VIEWS`), ...dirs.map((d) => index(f, `${base}/${d.dir}/PACKAGES`))])
    : [new Map()];

  const seeded: { package: string; version: string }[] = [];
  const failed: { package: string; error: string }[] = [];
  const too_large: { package: string; version: string }[] = [];
  for (const p of batch) {
    const stem = `${p.Package}_${p.Version}`;
    try {
      const src = await storeUrl(env.BUCKET, sql, `${base}/src/contrib/${stem}.tar.gz`, f,
        { md5: p.MD5sum, max: MAX_SEED_BYTES });
      if ("too_large" in src) {
        too_large.push({ package: p.Package, version: p.Version });
        continue;
      }
      const g = views.get(p.Package) ?? {};
      const day = /^\d{4}-\d{2}-\d{2}$/.test(g.git_last_commit_date ?? "") ? `${g.git_last_commit_date}T00:00:00Z` : null;
      const got = await ingestSource(env.BUCKET, sql, src.sha256, {
        git_url: g.git_url ?? null, git_branch: g.git_branch ?? null,
        git_commit: g.git_last_commit ?? null, git_commit_at: day,
      });
      if (got.package !== p.Package || got.version !== p.Version)
        throw new Error(`source tarball is ${got.package} ${got.version}, not ${p.Package} ${p.Version}`);
      // Binaries often lag the source: only one the directory lists at this version.
      const binaries: BinaryIn[] = [];
      for (const [i, d] of dirs.entries()) {
        const listed = bins[i].get(p.Package);
        if (listed?.Version !== p.Version) continue;
        const filename = `${stem}.${d.ext}`;
        const b = await storeUrl(env.BUCKET, sql, `${base}/${d.dir}/${filename}`, f,
          { md5: listed.MD5sum, max: MAX_SEED_BYTES }).catch(() => null);
        if (b && "sha256" in b) binaries.push({ os: d.os, r_minor: r, arch: d.arch, filename, sha256: b.sha256 });
      }
      await publish(sql, {
        bioc_version, repo, src_sha256: src.sha256, origin: "bioconductor", bioccheck: null, archs: [], binaries,
      });
      seeded.push({ package: p.Package, version: p.Version });
    } catch (e) {
      failed.push({ package: p.Package, error: message(e) });
    }
  }
  const remaining = holes.length - batch.length;
  return {
    status: remaining ? "partial" : "done", seeded, failed, too_large, remaining,
    next: batch.at(-1)?.Package ?? (opts.after || null),
    touched: seeded.length ? [[bioc_version, repo]] : [],
  };
}
