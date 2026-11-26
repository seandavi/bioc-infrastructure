// An r-universe observation, turned into publications. poll() archives what r-universe reports;
// this reads the newest archive back from BUCKET. planWave() is the pure part;
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
  addBinaries, biocVersions, currentPublications, knownExternal, latestObservation, markProcessed, publish,
  recordDecisions, recordObservation, setBiocVersions, setKnownExternal,
} from "./store.ts";
import type { BinaryIn, BiocVersion, CurrentPub, DecisionRow, JobRow, JobRun } from "./store.ts";

// The fields of an r-universe /api/packages record this reads.
export type ObsRecord = {
  Package?: string; Version?: string; _sha256?: string; _status?: string; _filesize?: number;
  License?: string; NeedsCompilation?: string; Priority?: string; OS_type?: string;
  _dependencies?: { package: string; version?: string; role: string }[];
  _jobs?: ObsJob[];
  _failure?: { version?: string; commit?: { id?: string }; job?: ObsJob | null };
  _binaries?: ObsBinary[];
  _bioc?: { repository?: string }[];
  RemoteUrl?: string; RemoteRef?: string; RemoteSha?: string;
  _commit?: { time?: number };
  _vignettes?: { filename?: string; title?: string }[];
  _devurl?: string; _upstream?: string; _sysdeps?: unknown; _bioccheck?: unknown;
  _buildurl?: string; _created?: string; _expires?: string; _distro?: string;
};
export type ObsJob = GateJob & { job?: number; time?: number; artifact?: string };

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
// that needs it. Order them here.
function depOrder(cands: Candidate[]): Candidate[] {
  const left = new Map(cands.map((c) => [c.package, c]));
  const out: Candidate[] = [];
  while (left.size) {
    const ready = [...left.values()].filter((c) =>
      !depConstraints(c.desc).some((d) => d.pkg !== c.package && left.has(d.pkg)));
    // Only a cycle leaves nothing ready, and R refuses circular hard dependencies.
    for (const c of ready.length ? ready : [...left.values()]) {
      out.push(c);
      left.delete(c.package);
    }
  }
  return out;
}

// One record's bad number must not abort the whole observation.
function commitAt(time: number | undefined): string | null {
  const d = new Date(Number.isFinite(time) && time ? time * 1000 : NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
    // Dependencies against every repository of the version at once (a software package may
    // depend on a data package); the version rule against the row the candidate would replace.
    const current = new Map(pubs.map((p) => [`${p.repo}\0${p.package}`, p]));
    const merged: Published = {}, own: Published = {};
    for (const p of pubs) merged[p.package] = { version: p.version, origin: p.origin, desc: p.desc };
    for (const r of recs.values()) {
      const p = current.get(`${repoOf(r)}\0${r.Package}`);
      if (p) own[r.Package!] = { version: p.version, origin: p.origin, desc: p.desc };
    }
    const inputs: GateInput[] = [...recs.values()].map((r) => ({
      package: r.Package!, version: r.Version!, origin: "r-universe",
      build_status: r._status ?? "", jobs: r._jobs ?? [], desc: describe(r),
    }));
    const { decisions, approved } = gate(inputs, waveGateConfig(r_minor), merged, knownByVersion[bioc_version], own);
    // As the current registry records them: only versions the version rule let in, so not the
    // steady state of a package sitting at its published version.
    const recorded: DecisionRow[] = Object.entries(decisions)
      .filter(([, d]) => d.reasons.some((x) => x.rule === "version-gate" && x.ok))
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
          git_commit_at: commitAt(r._commit?.time),
        },
        meta: metaOf(r),
      };
    });
    // Binaries a published version gained since (the current registry's topUpBinaries):
    // additive only, so a filled slot is never replaced and a passed family never withdrawn.
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
  touched?: [string, string][]; written?: string[];
};

// Writes the repository files of (bioc_version, repo) pairs and returns the keys it wrote.
export type WriteRepos = (repos: [string, string][]) => Promise<string[]>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Copies binaries into the store COPIES at a time. The number is bounded by the Worker's six
// open connections, shared with the database sockets (see DB_SOCKETS in db.ts). Returns those
// whose bytes were found, in their order; a binary whose bytes are gone is left out, and a later
// top-up fills its slot if they return.
// ponytail: batches, not a pool; a pool only helps when one copy is much slower.
export const COPIES = 3;
export async function storeBinaries(
  env: Pick<Env, "BUCKET">, sql: Sql, bins: BinaryIn[], f: typeof fetch,
): Promise<BinaryIn[]> {
  const found: boolean[] = [];
  for (let i = 0; i < bins.length; i += COPIES) {
    // allSettled, so no copy is still running after this returns or throws.
    const batch = await Promise.allSettled(bins.slice(i, i + COPIES).map((b) => storeObject(env.BUCKET, sql, b.sha256,
      () => openArtifact(b.sha256, f), `https://r2.ropensci.org/${b.sha256}`)));
    for (const r of batch) {
      if (r.status === "rejected") throw r.reason;
      found.push(r.value);
    }
  }
  return bins.filter((_, i) => found[i]);
}

// One record's bad date must not abort the whole observation either.
const isoOrNull = (s: string | undefined) => {
  const d = new Date(s ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Every job an observation shows, once each: the last build's jobs of each record, and a newer
// commit's failed build, which r-universe reports only in _failure (its tarball, build time and
// expiry are not the record's).
export function jobRuns(records: ObsRecord[], versions: BiocVersion[]): JobRun[] {
  const runs = new Map<number, JobRun>();
  const add = (r: ObsRecord, j: ObsJob, failure: boolean) => {
    if (!Number.isSafeInteger(j.job) || runs.has(j.job!)) return;
    runs.set(j.job!, {
      job: j.job!, package: r.Package ?? null,
      version: (failure ? r._failure?.version : r.Version) ?? null,
      src_sha256: failure ? null : r._sha256 ?? null,
      config: j.config ?? null, r: j.r ?? null, check: j.check ?? null,
      time_s: Number.isFinite(j.time) ? Math.round(j.time!) : null, artifact: j.artifact || null,
      bioc_version: branchVersion(r.RemoteRef, versions) ?? null,
      commit: (failure ? r._failure?.commit?.id : r.RemoteSha) ?? null, failure,
      built_at: failure ? null : isoOrNull(r._created), expires_at: failure ? null : isoOrNull(r._expires),
    });
  };
  for (const r of records) {
    for (const j of r._jobs ?? []) add(r, j, false);
    if (r._failure?.job) add(r, r._failure.job, true);
  }
  return [...runs.values()];
}

export async function observe(
  env: Pick<Env, "BUCKET">, sql: Sql, universe: string,
  opts: { limit?: number; fetch?: typeof fetch; write?: WriteRepos } = {},
): Promise<ObserveResult> {
  const limit = opts.limit ?? 10, f = opts.fetch ?? fetch, write = opts.write ?? (async () => []);
  const obs = await latestObservation(sql, universe);
  if (!obs) throw new Error(`no observation of ${universe}: poll it first`);
  const { digest } = obs;
  if (obs.processed_at) return { status: "unchanged", digest };
  const versions = await biocVersions(sql);
  if (!versions.some((v) => v.universe)) throw new Error("no Bioconductor versions yet: run refresh first");
  const obj = await env.BUCKET.get(obs.r2_key);
  if (!obj) throw new Error(`missing observation ${obs.r2_key}`);
  const records = await obj.json<ObsRecord[]>();

  if (!obs.recorded_at) {
    const jobs = new Map<string, JobRow>();
    for (const r of records)
      for (const j of r.Package ? r._jobs ?? [] : [])
        jobs.set(`${r.Package}\0${j.config}`, {
          package: r.Package!, config: j.config, bioc_version: branchVersion(r.RemoteRef, versions) ?? null,
          version: r.Version ?? null, r: j.r ?? null, check: j.check ?? null,
          time_s: Number.isFinite(j.time) ? Math.round(j.time!) : null,
          job: j.job ?? null, artifact: j.artifact || null,
        });
    await recordObservation(sql, { universe, digest, obs_ts: obs.obs_ts }, [...jobs.values()], jobRuns(records, versions));
  }

  // Planned from the database as it is now, so an interrupted call loses nothing.
  const built = versions.filter((v) => v.universe).map((v) => v.bioc_version);
  const pubs: Record<string, CurrentPub[]> = {}, known: Record<string, Set<string> | undefined> = {};
  for (const v of built) [pubs[v], known[v]] = await Promise.all([currentPublications(sql, v), knownExternal(sql, v)]);
  const plans = planWave(records, versions, pubs, known);
  await recordDecisions(sql, plans.flatMap((p) => p.decisions));

  const open = (sha256: string, size?: number | null) => () => openArtifact(sha256, f, size);
  const store = (bins: BinaryIn[]) => storeBinaries(env, sql, bins, f);

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
        await ingestSource(env.BUCKET, sql, c.src_sha256, { ...c.git, meta: c.meta }, c);
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
  // The files are written before the observation is marked processed, so a failed write is
  // retried. A call's own changes are written by it; the call that completes the observation
  // rewrites every repository of its versions, which covers a write an earlier call lost.
  // Unchanged files are not written again.
  const repos = new Map(touched);
  if (!remaining)
    for (const p of plans)
      for (const x of pubs[p.bioc_version] ?? []) repos.set(`${p.bioc_version}\0${x.repo}`, [p.bioc_version, x.repo]);
  const written = await write([...repos.values()]);
  // ponytail: a candidate whose bytes are gone for good keeps its observation unprocessed, so each
  // call re-reads it until a newer observation replaces it (a few hours at most).
  if (!remaining) await markProcessed(sql, universe, digest);
  return {
    status: remaining ? "partial" : "processed", digest, published, topped_up, failed, remaining,
    touched: [...touched.values()], written,
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
      const sets = bioc.map((t) => (t ? packageNames(t) : []));
      const empty = KNOWN_REPOS.filter((_, i) => !sets[i].length);
      if (empty.length) throw new Error(`${empty.join(", ")}: no packages`);
      const names = new Set([...cran, ...sets.flat()]);
      await setKnownExternal(sql, v, [...names]);
      known[v] = names.size;
    } catch (e) {
      known[v] = `failed, previous names kept: ${message(e)}`;
    }
  }
  return { versions, known };
}
