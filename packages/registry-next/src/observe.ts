// An r-universe observation, turned into publications. The current registry polls r-universe and
// archives what it saw; this reads those archives through LEGACY. planWave() is the pure part;
// observe() runs it against the database a bounded batch at a time, and every step is safe to
// repeat, so calling it until `remaining` is 0 is the whole backfill.
import type { Sql } from "postgres";
import type { Env } from "./db.ts";
import {
  GATE_FAMILIES, binaryArtifacts, depConstraints, describe, gate, packageNames, passingFamilies,
  waveGateConfig,
} from "./gate.ts";
import type { Desc, Family, GateInput, GateJob, ObsBinary, Published } from "./gate.ts";
import { binaryIn, ingestSource, openArtifact, storeObject } from "./ingest.ts";
import type { SourceExtra } from "./ingest.ts";
import {
  REPOS,
  addBinaries, biocVersions, currentPublications, knownExternal, markProcessed, observation, publish,
  recordDecisions, recordObservation, setBiocVersions, setKnownExternal,
} from "./store.ts";
import type { BinaryIn, BiocVersion, CurrentPub, DecisionRow, JobRow } from "./store.ts";

// The fields of an r-universe /api/packages record this reads.
export type ObsRecord = {
  Package?: string; Version?: string; _sha256?: string; _status?: string; _filesize?: number;
  License?: string; NeedsCompilation?: string; Priority?: string; OS_type?: string;
  _dependencies?: { package: string; version?: string; role: string }[];
  _jobs?: (GateJob & { job?: number; time?: number; artifact?: string })[];
  _binaries?: ObsBinary[];
  _bioc?: { repository?: string }[];
  RemoteUrl?: string; RemoteRef?: string; RemoteSha?: string;
  _commit?: { time?: number };
  _vignettes?: { filename?: string; title?: string }[];
  _devurl?: string; _upstream?: string; _sysdeps?: unknown; _bioccheck?: unknown;
  _buildurl?: string; _created?: string; _distro?: string;
};

export type Candidate = {
  bioc_version: string; repo: string; package: string; version: string; desc: Desc;
  src_sha256: string; size: number | null; bioccheck: string | null; archs: Family[];
  binaries: BinaryIn[]; git: SourceExtra; meta: Record<string, unknown>;
};
export type TopUp = {
  bioc_version: string; repo: string; package: string; publication_id: number;
  binaries: BinaryIn[]; archs: string[]; widened: boolean;
};
export type Plan = { bioc_version: string; decisions: DecisionRow[]; approved: Candidate[]; topups: TopUp[] };

const repoOf = (r: ObsRecord) => {
  const repo = r._bioc?.[0]?.repository;
  return (REPOS as readonly string[]).includes(repo ?? "") ? repo! : "bioc";
};

// RELEASE_x_y is x.y; HEAD and devel are whatever the bioc universe builds.
export function branchVersion(ref: string | undefined, versions: BiocVersion[]): string | undefined {
  const m = /^RELEASE_(\d+)_(\d+)$/.exec(ref ?? "");
  if (m) return `${m[1]}.${m[2]}`;
  if (ref === "HEAD" || ref === "devel") return versions.find((v) => v.universe === "bioc")?.bioc_version;
  return undefined;
}

// One binary per (os, R minor, arch), as published_artifacts keys it.
const slot = (b: BinaryIn) => `${b.os}|${b.r_minor}|${b.arch}`;

// What the tarball cannot say about itself.
function metaOf(r: ObsRecord): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (r._vignettes?.length) m.vignettes = r._vignettes.map((v) => ({ filename: v.filename, title: v.title }));
  const more = {
    devurl: r._devurl, upstream: r._upstream, sysdeps: r._sysdeps, bioccheck: r._bioccheck,
    buildurl: r._buildurl, created: r._created, distro: r._distro,
  };
  for (const [k, v] of Object.entries(more)) if (v !== undefined && v !== null) m[k] = v;
  return m;
}

// gate() orders approvals by dependency only for names it checks; with no known names for a
// version, a fellow candidate's dependency goes unchecked and can come out after the package
// that needs it. Order them here; a cycle comes out as it stands.
function depOrder(cands: Candidate[]): Candidate[] {
  const left = new Map(cands.map((c) => [c.package, c]));
  const out: Candidate[] = [];
  while (left.size) {
    const ready = [...left.values()].filter((c) =>
      !depConstraints(c.desc).some((d) => d.pkg !== c.package && left.has(d.pkg)));
    for (const c of ready.length ? ready : [...left.values()]) {
      out.push(c);
      left.delete(c.package);
    }
  }
  return out;
}

export function planWave(
  records: ObsRecord[], versions: BiocVersion[],
  publishedByVersion: Record<string, CurrentPub[]>, knownByVersion: Record<string, Set<string> | undefined>,
): Plan[] {
  const built = new Map(versions.filter((v) => v.universe).map((v) => [v.bioc_version, v]));
  const byVersion = new Map<string, Map<string, ObsRecord>>();
  for (const r of records) {
    if (!r.Package || !r.Version || !r._sha256) continue;
    // A version r-universe is not building is a leftover of a release roll.
    const v = branchVersion(r.RemoteRef, versions);
    if (!v || !built.has(v)) continue;
    if (!byVersion.has(v)) byVersion.set(v, new Map());
    byVersion.get(v)!.set(r.Package, r);
  }
  const plans: Plan[] = [];
  for (const [bioc_version, recs] of byVersion) {
    const r_minor = built.get(bioc_version)!.r_minor;
    const pubs = publishedByVersion[bioc_version] ?? [];
    // Every repository of the version at once: a software package may depend on a data package.
    const merged: Published = {};
    for (const p of pubs) merged[p.package] = { version: p.version, origin: p.origin, desc: p.desc };
    const inputs: GateInput[] = [...recs.values()].map((r) => ({
      package: r.Package!, version: r.Version!, origin: "r-universe",
      build_status: r._status ?? "", jobs: r._jobs ?? [], desc: describe(r),
    }));
    const { decisions, approved } = gate(inputs, waveGateConfig(r_minor), merged, knownByVersion[bioc_version]);
    // As the current registry records them: not the steady state of a package sitting at its
    // published version, which only fails the version rule.
    const recorded: DecisionRow[] = Object.entries(decisions)
      .filter(([, d]) => d.propagate || d.reasons.some((x) => !x.ok && x.rule !== "version-gate"))
      .map(([name, d]) => ({
        bioc_version, repo: repoOf(recs.get(name)!), package: name, version: recs.get(name)!.Version!,
        origin: "r-universe", propagate: d.propagate, archs: d.archs, reasons: d.reasons,
      }));
    const candidates = approved.map((name): Candidate => {
      const r = recs.get(name)!;
      const archs = decisions[name].archs;
      return {
        bioc_version, repo: repoOf(r), package: name, version: r.Version!, desc: describe(r),
        src_sha256: r._sha256!, size: r._filesize ?? null,
        bioccheck: r._jobs?.find((j) => j.config === "bioc-checks")?.check ?? null,
        archs, binaries: binaryArtifacts(name, r.Version!, r._binaries, archs).map(binaryIn),
        git: {
          git_url: r.RemoteUrl ?? null, git_branch: r.RemoteRef ?? null, git_commit: r.RemoteSha ?? null,
          git_commit_at: r._commit?.time ? new Date(r._commit.time * 1000).toISOString() : null,
        },
        meta: metaOf(r),
      };
    });
    // Binaries a published version gained since (the current registry's topUpBinaries):
    // additive only, so a filled slot is never replaced and a passed family never withdrawn.
    const current = new Map(pubs.map((p) => [`${p.repo}\0${p.package}`, p]));
    const topups: TopUp[] = [];
    for (const r of recs.values()) {
      const repo = repoOf(r);
      const cur = current.get(`${repo}\0${r.Package}`);
      if (!cur || cur.origin !== "r-universe" || cur.version !== r.Version) continue;
      const passing = passingFamilies(r._jobs ?? [], r_minor);
      const archs = GATE_FAMILIES.filter((f) => cur.archs.includes(f) || passing.includes(f));
      const have = new Set(cur.slots);
      const add: BinaryIn[] = [];
      for (const b of binaryArtifacts(r.Package!, cur.version, r._binaries, archs).map(binaryIn)) {
        if (have.has(slot(b))) continue;
        have.add(slot(b));
        add.push(b);
      }
      const widened = archs.length !== cur.archs.length;
      if (add.length || widened)
        topups.push({ bioc_version, repo, package: r.Package!, publication_id: cur.publication_id, binaries: add, archs, widened });
    }
    plans.push({ bioc_version, decisions: recorded, approved: depOrder(candidates), topups });
  }
  return plans;
}

export const UNIVERSES = ["bioc", "bioc-release"] as const;

export type ObserveResult = {
  status: "unchanged" | "partial" | "processed"; digest: string;
  published?: { bioc_version: string; repo: string; package: string; version: string }[];
  topped_up?: number; failed?: { package: string; error: string }[]; remaining?: number;
  touched?: [string, string][];
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function observe(
  env: Pick<Env, "BUCKET" | "LEGACY">, sql: Sql, universe: string,
  opts: { limit?: number; fetch?: typeof fetch } = {},
): Promise<ObserveResult> {
  const limit = opts.limit ?? 10, f = opts.fetch ?? fetch;
  const latest = await env.LEGACY.get(`state/${universe}/latest`);
  if (!latest) throw new Error(`no observation of ${universe}`);
  const { digest, key, ts } = await latest.json<{ digest: string; key: string; ts: string }>();
  const seen = await observation(sql, universe, digest);
  if (seen?.processed_at) return { status: "unchanged", digest };
  const versions = await biocVersions(sql);
  if (!versions.some((v) => v.universe)) throw new Error("no Bioconductor versions yet: run refresh first");
  const obj = await env.LEGACY.get(key);
  if (!obj) throw new Error(`missing observation ${key}`);
  const records = await obj.json<ObsRecord[]>();

  if (!seen) {
    const jobs = new Map<string, JobRow>();
    for (const r of records)
      for (const j of r.Package ? r._jobs ?? [] : [])
        jobs.set(`${r.Package}\0${j.config}`, {
          package: r.Package!, config: j.config, bioc_version: branchVersion(r.RemoteRef, versions) ?? null,
          version: r.Version ?? null, r: j.r ?? null, check: j.check ?? null, time_s: j.time ?? null,
          job: j.job ?? null, artifact: j.artifact || null,
        });
    await recordObservation(sql, { universe, digest, obs_ts: ts, r2_key: key }, [...jobs.values()]);
  }

  // Planned from the database as it is now, so an interrupted call loses nothing.
  const built = versions.filter((v) => v.universe).map((v) => v.bioc_version);
  const pubs: Record<string, CurrentPub[]> = {}, known: Record<string, Set<string> | undefined> = {};
  for (const v of built) [pubs[v], known[v]] = await Promise.all([currentPublications(sql, v), knownExternal(sql, v)]);
  const plans = planWave(records, versions, pubs, known);
  await recordDecisions(sql, plans.flatMap((p) => p.decisions));

  const open = (sha256: string, size?: number | null) => () => openArtifact(env, universe, sha256, f, size);
  const store = async (bins: BinaryIn[]) => {
    const kept: BinaryIn[] = [];
    // A binary whose bytes are gone is left out; a later top-up fills its slot if they return.
    for (const b of bins)
      if (await storeObject(env.BUCKET, sql, b.sha256, open(b.sha256), `https://r2.ropensci.org/${b.sha256}`)) kept.push(b);
    return kept;
  };

  let budget = limit, remaining = 0, topped_up = 0;
  const published: NonNullable<ObserveResult["published"]> = [];
  const failed: NonNullable<ObserveResult["failed"]> = [];
  const touched = new Map<string, [string, string]>();
  for (const plan of plans) {
    // A dependency is never published after a package that needs it: what needs a candidate that
    // failed waits for the next call, and so does what needs that.
    const held = new Set<string>();
    for (const c of plan.approved) {
      if (budget <= 0 || depConstraints(c.desc).some((d) => held.has(d.pkg))) {
        held.add(c.package);
        remaining++;
        continue;
      }
      budget--;
      try {
        const src = `https://r2.ropensci.org/${c.src_sha256}`;
        if (!(await storeObject(env.BUCKET, sql, c.src_sha256, open(c.src_sha256, c.size), src)))
          throw new Error("source bytes are not available");
        const got = await ingestSource(env.BUCKET, sql, c.src_sha256, { ...c.git, meta: c.meta });
        if (got.package !== c.package || got.version !== c.version)
          throw new Error(`source tarball is ${got.package} ${got.version}, not ${c.package} ${c.version}`);
        await publish(sql, {
          bioc_version: c.bioc_version, repo: c.repo, src_sha256: c.src_sha256, origin: "r-universe",
          bioccheck: c.bioccheck, archs: c.archs, binaries: await store(c.binaries),
        });
        published.push({ bioc_version: c.bioc_version, repo: c.repo, package: c.package, version: c.version });
        touched.set(`${c.bioc_version}\0${c.repo}`, [c.bioc_version, c.repo]);
      } catch (e) {
        failed.push({ package: c.package, error: message(e) });
        held.add(c.package);
        remaining++;
      }
    }
  }
  for (const t of plans.flatMap((p) => p.topups)) {
    if (budget <= 0) { remaining++; continue; }
    budget--;
    try {
      const kept = await store(t.binaries);
      if (!kept.length && !t.widened) continue;
      if (await addBinaries(sql, t.publication_id, kept, t.archs)) {
        topped_up++;
        touched.set(`${t.bioc_version}\0${t.repo}`, [t.bioc_version, t.repo]);
      }
    } catch (e) {
      failed.push({ package: t.package, error: message(e) });
      remaining++;
    }
  }
  // ponytail: a candidate whose bytes are gone for good keeps its observation unprocessed, so each
  // call re-reads it until a newer observation replaces it (a few hours at most).
  if (!remaining) await markProcessed(sql, universe, digest);
  return {
    status: remaining ? "partial" : "processed", digest, published, topped_up, failed, remaining,
    touched: [...touched.values()],
  };
}

const CONFIG_URL = "https://bioconductor.org/config.yaml";
const CRAN = "https://cloud.r-project.org/src/contrib/PACKAGES";
const KNOWN_REPOS = ["data/annotation", "data/experiment", "workflows", "books"];

// config.yaml into bioc_versions, then for each version r-universe builds the package names
// CRAN and Bioconductor's other repositories publish. All-or-nothing per version: a partial set
// would block whatever the missing source holds, so a failure keeps the previous names.
export async function refresh(sql: Sql, opts: { fetch?: typeof fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const text = async (url: string, missingOk = false) => {
    const res = await f(url);
    if (missingOk && res.status === 404) return null;
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  };
  const versions = await setBiocVersions(sql, (await text(CONFIG_URL))!);
  const known: Record<string, number | string> = {};
  let cran: string[] | undefined;
  for (const { bioc_version: v } of versions.filter((x) => x.universe)) {
    try {
      cran ??= packageNames((await text(CRAN))!);
      if (!cran.length) throw new Error(`${CRAN}: no packages`);
      const bioc = await Promise.all(KNOWN_REPOS.map((r) =>
        text(`https://bioconductor.org/packages/${v}/${r}/src/contrib/PACKAGES`, true)));
      // A version bioconductor.org does not have yet (devel, during a roll) has none of these.
      // CRAN alone would then block every package needing an annotation package, so the version
      // gets no names and, until it has some, the deps rule does not block on unknown ones.
      if (bioc.every((t) => t === null)) {
        known[v] = "not on bioconductor.org yet";
        continue;
      }
      const names = new Set([...cran, ...bioc.flatMap((t) => (t ? packageNames(t) : []))]);
      await setKnownExternal(sql, v, [...names]);
      known[v] = names.size;
    } catch (e) {
      known[v] = `failed, previous names kept: ${message(e)}`;
    }
  }
  return { versions, known };
}
