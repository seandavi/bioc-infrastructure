// Every query, as plain functions over a postgres client or transaction.
//
// Values that are arrays, bigints or timestamps cross the wire as JSON: the Worker's client runs
// with fetch_types off (src/db.ts), which leaves text[] parameters unserializable and text[]
// results unparsed, and bigints arrive as strings. JSON is typed the same either way.
import type { Sql, TransactionSql } from "postgres";
import { normArch, rMinor } from "./dcf.ts";
import { R_VER, verGt, versionGate } from "./gate.ts";
import type { Desc, Origin, Published } from "./gate.ts";

type Db = Sql | TransactionSql;

// Bioconductor's repositories within a version. The publications table checks the same list.
export const REPOS = ["bioc", "data/annotation", "data/experiment", "workflows", "books"] as const;

export type Binary = {
  os: string; r_minor: string; arch: string; distro: string;
  filename: string; sha256: string; md5: string | null; size_bytes: number;
};
export type BinaryIn = Pick<Binary, "os" | "filename" | "sha256"> &
  Partial<Pick<Binary, "r_minor" | "arch" | "distro">>;

// One current publication, with everything the repository indexes and a package page read.
export type RepoRow = {
  publication_id: number;
  package: string; version: string; origin: Origin; bioccheck: string | null; archs: string[];
  published_at: string;
  description: Record<string, string>;     // every DESCRIPTION field, as read.dcf returns it
  files: Record<string, unknown>;
  meta: Record<string, unknown>;
  git_url: string | null; git_branch: string | null; git_commit: string | null;
  git_commit_at: string | null;
  source: { filename: string; sha256: string; md5: string | null; size_bytes: number };
  binaries: Binary[];
};

export async function putCasObject(sql: Db, o: {
  sha256: string; md5?: string | null; size_bytes: number; source_url?: string | null;
}): Promise<void> {
  // An object's bytes never change, so a second put only fills in an md5 learned later.
  await sql`insert into cas_objects (sha256, md5, size_bytes, source_url)
    values (${o.sha256}, ${o.md5 ?? null}, ${o.size_bytes}, ${o.source_url ?? null})
    on conflict (sha256) do update set md5 = excluded.md5
    where cas_objects.md5 is null and excluded.md5 is not null`;
}

export async function putPackageVersion(sql: Db, v: {
  src_sha256: string; package: string; version: string; description: Record<string, string>;
  files?: Record<string, unknown>; meta?: Record<string, unknown>;
  git_url?: string | null; git_branch?: string | null; git_commit?: string | null;
  git_commit_at?: string | null;
}): Promise<void> {
  await sql`insert into package_versions
    (src_sha256, package, version, description, files, meta, git_url, git_branch, git_commit, git_commit_at)
    values (${v.src_sha256}, ${v.package}, ${v.version}, ${sql.json(v.description)},
      ${sql.json((v.files ?? {}) as never)}, ${sql.json((v.meta ?? {}) as never)},
      ${v.git_url ?? null}, ${v.git_branch ?? null}, ${v.git_commit ?? null}, ${v.git_commit_at ?? null})
    on conflict (src_sha256) do nothing`;
}

// ---------- Bioconductor versions ----------

// What this registry reads from bioconductor.org's config.yaml: the release and devel roles, the
// versions r-universe builds, and each version's R line. Line-oriented, not a YAML parser: the
// file's shape for these keys has been stable for a decade.
export function parseBiocConfig(yaml: string): {
  release: string; devel: string; ruRelease: string; ruDevel: string; r: Record<string, string>;
} {
  const top = (k: string) => yaml.match(new RegExp(`^${k}:\\s*"?([\\d.]+)"?`, "m"))?.[1];
  const r: Record<string, string> = {};
  const block = yaml.split(/^r_ver_for_bioc_ver:.*$/m)[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s+"?([\d.]+)"?\s*:\s*"?([\d.]+)"?/);
    if (!m) break; // the next top-level key ends the block
    r[m[1]] = m[2];
  }
  const release = top("release_version"), devel = top("devel_version");
  if (!release || !devel) throw new Error("config.yaml: release_version or devel_version missing");
  // During a release roll r-universe builds a version ahead of bioconductor.org's roles.
  const ruRelease = top("r_universe_release_version") ?? release;
  const ruDevel = top("r_universe_devel_version") ?? devel;
  const known = Object.keys(r).sort((a, b) => (verGt(a, b) ? 1 : -1));
  if (!known.length) throw new Error("config.yaml: no r_ver_for_bioc_ver entries");
  // A version config.yaml has not mapped yet (r-universe builds the next devel before the file
  // says so): R advances every second Bioconductor version, so a version that follows two on the
  // same R takes the next R minor, and one that follows the first of a pair shares its R. That
  // holds for 25 of the 27 versions since 2.11 (2012); the two misses are R's major version
  // changes. ponytail: wrong at the next R major version, until config.yaml lists the version.
  const nextMinor = (v: string) => v.replace(/\d+$/, (m) => String(Number(m) + 1));
  for (const v of [release, devel, ruRelease, ruDevel].sort((a, b) => (verGt(a, b) ? 1 : -1))) {
    if (r[v]) continue;
    const last = known.at(-1)!, before = known.at(-2);
    r[v] = before !== undefined && r[before] === r[last] ? nextMinor(r[last]) : r[last];
    known.push(v);
  }
  return { release, devel, ruRelease, ruDevel, r };
}

export type BiocVersion = {
  bioc_version: string; r_minor: string; role: "release" | "devel" | null;
  universe: "bioc" | "bioc-release" | null;   // the r-universe universe that builds it
};

// Upserts every mapped version and moves the roles and universes, so exactly one version holds
// each. updated_at is touched on every call: it is when config.yaml was last read.
export async function setBiocVersions(sql: Sql, configYaml: string): Promise<BiocVersion[]> {
  const c = parseBiocConfig(configYaml);
  const rows = Object.entries(c.r).map(([bioc_version, r_minor]) => ({
    bioc_version, r_minor,
    role: bioc_version === c.release ? "release" : bioc_version === c.devel ? "devel" : null,
    universe: bioc_version === c.ruRelease ? "bioc-release" : bioc_version === c.ruDevel ? "bioc" : null,
  }));
  await sql.begin(async (tx) => {
    // Roles and universes move first: their unique indexes are checked row by row, so a version
    // taking one in the upsert must not collide with the one giving it up.
    await tx`update bioc_versions b set role = null, universe = null
      where (b.role is not null or b.universe is not null) and not exists (
        select 1 from jsonb_to_recordset(${tx.json(rows)}) as x(bioc_version text, role text, universe text)
        where x.bioc_version = b.bioc_version
          and x.role is not distinct from b.role and x.universe is not distinct from b.universe)`;
    await tx`insert into bioc_versions (bioc_version, r_minor, role, universe)
      select x.bioc_version, x.r_minor, x.role, x.universe
      from jsonb_to_recordset(${tx.json(rows)}) as x(bioc_version text, r_minor text, role text, universe text)
      on conflict (bioc_version) do update set r_minor = excluded.r_minor, role = excluded.role,
        universe = excluded.universe, updated_at = now()`;
  });
  return biocVersions(sql);
}

export async function biocVersions(sql: Db): Promise<BiocVersion[]> {
  return (await sql`select bioc_version, r_minor, role, universe from bioc_versions
    order by string_to_array(bioc_version, '.')::int[]`) as unknown as BiocVersion[];
}

// A numbered version, or the version currently holding the role 'release' or 'devel'.
export async function biocVersion(sql: Db, versionOrRole: string): Promise<BiocVersion | undefined> {
  const [row] = await sql`select bioc_version, r_minor, role, universe from bioc_versions
    where bioc_version = ${versionOrRole} or role = ${versionOrRole}`;
  return row as BiocVersion | undefined;
}

// ---------- the read model ----------

const DESC_FIELDS = [
  "Priority", "Depends", "Imports", "LinkingTo", "Suggests", "Enhances",
  "License", "OS_type", "NeedsCompilation",
] as const;

export async function published(sql: Db, bioc_version: string, repo: string): Promise<Published> {
  const rows = await sql`select p.package, p.version, p.origin, v.description
    from publications p join package_versions v on v.src_sha256 = p.src_sha256
    where p.bioc_version = ${bioc_version} and p.repo = ${repo} and p.superseded_at is null`;
  const out: Published = {};
  for (const r of rows) {
    const desc: Desc = {};
    for (const k of DESC_FIELDS) if (r.description[k]) desc[k] = r.description[k];
    out[r.package] = { version: r.version, origin: r.origin, desc };
  }
  return out;
}

// Every current publication of a version, across its repositories, with what the observer
// needs beyond published(): the row to top up, its families and the binary slots it fills.
export type CurrentPub = {
  repo: string; package: string; version: string; origin: Origin; desc: Desc;
  publication_id: number; archs: string[]; slots: string[];
};

export async function currentPublications(sql: Db, bioc_version: string): Promise<CurrentPub[]> {
  const rows = await sql`select p.repo, p.package, p.version, p.origin, v.description,
      p.id::float8 as publication_id, to_jsonb(p.archs) as archs,
      coalesce((select jsonb_agg(a.os || '|' || a.r_minor || '|' || a.arch)
        from published_artifacts a where a.publication_id = p.id), '[]') as slots
    from publications p join package_versions v on v.src_sha256 = p.src_sha256
    where p.bioc_version = ${bioc_version} and p.superseded_at is null`;
  return rows.map((r) => {
    const desc: Desc = {};
    for (const k of DESC_FIELDS) if (r.description[k]) desc[k] = r.description[k];
    return { repo: r.repo, package: r.package, version: r.version, origin: r.origin, desc,
      publication_id: r.publication_id, archs: r.archs, slots: r.slots };
  });
}

// undefined when the version has no names yet, which the gate reads as "do not block on
// unknown names".
export async function knownExternal(sql: Db, bioc_version: string): Promise<Set<string> | undefined> {
  const rows = await sql`select name from known_external_deps where bioc_version = ${bioc_version}`;
  return rows.length ? new Set(rows.map((r) => r.name as string)) : undefined;
}

export async function setKnownExternal(sql: Sql, bioc_version: string, names: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from known_external_deps where bioc_version = ${bioc_version}`;
    await tx`insert into known_external_deps (bioc_version, name)
      select ${bioc_version}, n from jsonb_array_elements_text(${tx.json(names)}) as n
      on conflict do nothing`;
  });
}

// One query for a whole repository: the binaries are a correlated aggregate over their primary
// key, not a query per package.
async function rowsWhere(sql: Db, where: ReturnType<Db>): Promise<RepoRow[]> {
  const rows = await sql`select jsonb_build_object(
      'publication_id', p.id, 'package', p.package, 'version', p.version, 'origin', p.origin,
      'bioccheck', p.bioccheck, 'archs', to_jsonb(p.archs), 'published_at', p.published_at,
      'description', v.description, 'files', v.files, 'meta', v.meta,
      'git_url', v.git_url, 'git_branch', v.git_branch, 'git_commit', v.git_commit,
      'git_commit_at', v.git_commit_at,
      'source', jsonb_build_object('filename', p.package || '_' || p.version || '.tar.gz',
        'sha256', c.sha256, 'md5', c.md5, 'size_bytes', c.size_bytes),
      'binaries', coalesce((select jsonb_agg(jsonb_build_object(
          'os', a.os, 'r_minor', a.r_minor, 'arch', a.arch, 'distro', a.distro,
          'filename', a.filename, 'sha256', a.sha256, 'md5', b.md5, 'size_bytes', b.size_bytes)
          order by a.os, a.r_minor, a.arch)
        from published_artifacts a join cas_objects b on b.sha256 = a.sha256
        where a.publication_id = p.id), '[]')) as r
    from publications p
    join package_versions v on v.src_sha256 = p.src_sha256
    join cas_objects c on c.sha256 = p.src_sha256
    where p.superseded_at is null and ${where}
    order by p.package`;
  return rows.map((x) => x.r as RepoRow);
}

export const repoRows = (sql: Db, bioc_version: string, repo: string) =>
  rowsWhere(sql, sql`p.bioc_version = ${bioc_version} and p.repo = ${repo}`);

// The source tarball of a superseded publication, for src/contrib/Archive/. Null when that
// version was never published here, or is still current (it is then in src/contrib itself).
export async function archivedSource(sql: Db, bioc_version: string, repo: string, pkg: string, version: string) {
  const [row] = await sql`select src_sha256 from publications
    where bioc_version = ${bioc_version} and repo = ${repo} and package = ${pkg} and version = ${version}
      and superseded_at is not null order by id desc limit 1`;
  return (row?.src_sha256 as string | undefined) ?? null;
}

// ---------- the write path ----------

// A publication publish() would not write: the version rule failed against the locked row, or
// the source is not in the store.
export class PublishRefused extends Error {}

export type PublishInput = {
  bioc_version: string; repo: string; src_sha256: string; origin: Origin;
  bioccheck?: string | null; archs: string[]; binaries?: BinaryIn[];
};

// Every binary is stored here, so this is where its slot gets its one spelling: a caller's
// "4.6.1"/"aarch64" and another's "4.6"/"arm64" must collide on the primary key, or the second
// would be served in place of the first.
async function insertBinaries(sql: Db, publication_id: number, binaries: BinaryIn[]): Promise<number> {
  if (!binaries.length) return 0;
  binaries = binaries.map((b) => ({ ...b, r_minor: rMinor(b.r_minor ?? ""), arch: normArch(b.arch ?? "") }));
  const added = await sql`insert into published_artifacts (publication_id, os, r_minor, arch, distro, filename, sha256)
    select ${publication_id}, x.os, coalesce(x.r_minor, ''), coalesce(x.arch, ''), coalesce(x.distro, ''),
      x.filename, x.sha256
    from jsonb_to_recordset(${sql.json(binaries)})
      as x(os text, r_minor text, arch text, distro text, filename text, sha256 text)
    on conflict do nothing returning 1`;
  return added.length;
}

// THE write path. Package and version are those of the source tarball, so a publication can
// never name bytes of another package. In one transaction, serialized per (bioc_version, repo,
// package) by an advisory lock so that a first publication is serialized too: re-check the
// version rule against the current row, supersede it, insert the new row and its binaries.
export async function publish(sql: Sql, p: PublishInput): Promise<{
  changed: boolean; publication_id: number; superseded?: number;
}> {
  return sql.begin(async (tx) => {
    const [pv] = await tx`select package, version from package_versions where src_sha256 = ${p.src_sha256}`;
    if (!pv) throw new PublishRefused(`source ${p.src_sha256} is not in the store`);
    // gate()'s version-parse rule: a version verGt() cannot order would block every later one.
    if (!R_VER.test(pv.version)) throw new PublishRefused(`version-parse: ${pv.version}`);
    await tx`select pg_advisory_xact_lock(hashtextextended(
      ${p.bioc_version} || '/' || ${p.repo} || '/' || ${pv.package}, 7203114))`;
    const [cur] = await tx`select id::float8 as id, version, src_sha256, origin from publications
      where bioc_version = ${p.bioc_version} and repo = ${p.repo} and package = ${pv.package}
        and superseded_at is null`;
    if (cur && cur.version === pv.version && cur.src_sha256 === p.src_sha256 && cur.origin === p.origin)
      return { changed: false, publication_id: cur.id };
    // The same rule gate() applied, with replace_seed as every producer runs it. A seed replaces
    // nothing at its own version: only a build of it replaces a seed.
    const vg = versionGate(pv.version, cur as { version: string; origin: Origin } | undefined,
      p.origin !== "bioconductor");
    if (!vg.ok) throw new PublishRefused(`version-gate: ${vg.detail}`);
    if (cur) await tx`update publications set superseded_at = now() where id = ${cur.id}`;
    const [row] = await tx`insert into publications
      (bioc_version, repo, package, version, src_sha256, origin, bioccheck, archs)
      values (${p.bioc_version}, ${p.repo}, ${pv.package}, ${pv.version}, ${p.src_sha256}, ${p.origin},
        ${p.bioccheck ?? null}, array(select f from unnest(array['linux', 'win', 'mac']) with ordinality as g(f, i)
          where ${tx.json(p.archs)}::jsonb ? f order by i))
      returning id::float8 as id`;
    await insertBinaries(tx, row.id, p.binaries ?? []);
    return cur ? { changed: true, publication_id: row.id, superseded: cur.id }
      : { changed: true, publication_id: row.id };
  }) as never;
}

// Additive top-up of a current publication: binaries only for slots it lacks (a filled slot is
// never replaced) and archs widened, in gate-family order. null when the publication is not
// current: the row lock taken by the update waits out a concurrent publish(), and then sees it
// superseded.
export async function addBinaries(
  sql: Sql, publication_id: number, binaries: BinaryIn[], archs: string[]
): Promise<{ added: number; archs: string[] } | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx`update publications set archs = array(
        select f from unnest(array['linux', 'win', 'mac']) with ordinality as g(f, i)
        where f = any(archs) or ${tx.json(archs)}::jsonb ? f order by i)
      where id = ${publication_id} and superseded_at is null
      returning to_jsonb(archs) as archs`;
    if (!row) return null;
    return { added: await insertBinaries(tx, publication_id, binaries), archs: row.archs };
  }) as never;
}

export type DecisionRow = {
  bioc_version: string; repo: string; package: string; version: string; origin: Origin;
  propagate: boolean; archs: string[]; reasons: { rule: string; ok: boolean; detail?: string }[];
};

// A decision is stored only when it differs from the latest one for the same package version,
// so the table is a history of changes. One statement for a whole wave. Returns how many it
// stored. A package version given twice keeps its last decision, and the lock makes concurrent
// calls take turns: each would otherwise miss the other's uncommitted rows and store its own.
export async function recordDecisions(sql: Sql, rows: DecisionRow[]): Promise<number> {
  rows = [...new Map(rows.map((r) => [`${r.bioc_version}\0${r.repo}\0${r.package}\0${r.version}`, r])).values()];
  if (!rows.length) return 0;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7203115)`;
    return (await tx`insert into gate_decisions
      (bioc_version, repo, package, version, origin, propagate, archs, reasons)
    select x.bioc_version, x.repo, x.package, x.version, x.origin, x.propagate,
      array(select jsonb_array_elements_text(x.archs)), x.reasons
    from jsonb_to_recordset(${tx.json(rows as never)}) as x(bioc_version text, repo text, package text,
      version text, origin text, propagate boolean, archs jsonb, reasons jsonb)
    where not exists (
      select 1 from (
        select d.propagate, d.archs, d.reasons from gate_decisions d
        where d.bioc_version = x.bioc_version and d.repo = x.repo and d.package = x.package
          and d.version = x.version
        order by d.decided_at desc, d.id desc limit 1) l
      where l.propagate = x.propagate and to_jsonb(l.archs) = x.archs and l.reasons = x.reasons)
    returning 1`).length;
  }) as never;
}

// ---------- documents ----------

export async function packageDoc(sql: Db, bioc_version: string, repo: string, pkg: string) {
  const key = sql`bioc_version = ${bioc_version} and repo = ${repo} and package = ${pkg}`;
  const [current] = await rowsWhere(sql,
    sql`p.bioc_version = ${bioc_version} and p.repo = ${repo} and p.package = ${pkg}`);
  const [{ history }] = await sql`select coalesce(jsonb_agg(jsonb_build_object(
      'version', version, 'origin', origin, 'src_sha256', src_sha256,
      'published_at', published_at, 'superseded_at', superseded_at)
      order by published_at desc, id desc), '[]') as history
    from publications where ${key}`;
  if (!current && !history.length) return null;
  // ponytail: the latest 20 decisions across versions; page it if a package page needs more.
  const [{ decisions }] = await sql`select coalesce(jsonb_agg(jsonb_build_object(
      'version', version, 'origin', origin, 'propagate', propagate, 'archs', to_jsonb(archs),
      'reasons', reasons, 'decided_at', decided_at) order by decided_at desc, id desc), '[]') as decisions
    from (select * from gate_decisions where ${key} order by decided_at desc, id desc limit 20) d`;
  return { bioc_version, repo, package: pkg, current: current ?? null, history, decisions };
}

export async function casDoc(sql: Db, sha256: string) {
  const [object] = await sql`select jsonb_build_object('sha256', sha256, 'md5', md5,
      'size_bytes', size_bytes, 'source_url', source_url, 'created_at', created_at) as o
    from cas_objects where sha256 = ${sha256}`;
  if (!object) return null;
  const [{ publications }] = await sql`select coalesce(jsonb_agg(jsonb_build_object(
      'bioc_version', p.bioc_version, 'repo', p.repo, 'package', p.package, 'version', p.version,
      'origin', p.origin, 'as', x.as_, 'filename', x.filename,
      'published_at', p.published_at, 'superseded_at', p.superseded_at)
      order by p.published_at desc, p.id), '[]') as publications
    from (select id, 'source' as as_, package || '_' || version || '.tar.gz' as filename
            from publications where src_sha256 = ${sha256}
          union all
          select publication_id, os, filename from published_artifacts where sha256 = ${sha256}) x
    join publications p on p.id = x.id`;
  return { ...object.o, publications };
}

// ---------- observations ----------

export type JobRow = {
  package: string; config: string; bioc_version: string | null; version: string | null;
  r: string | null; check: string | null; time_s: number | null; job: number | null; artifact: string | null;
};

export async function observation(sql: Db, universe: string, digest: string) {
  const [row] = await sql`select processed_at from observations
    where universe = ${universe} and digest = ${digest}`;
  return row as { processed_at: string | null } | undefined;
}

// First sight of an observation: its row, and that universe's jobs replaced by its verdicts, in
// one transaction. Rows of packages the observation no longer holds are deleted.
export async function recordObservation(sql: Sql, o: {
  universe: string; digest: string; obs_ts: string; r2_key: string;
}, jobs: JobRow[]): Promise<void> {
  await sql.begin(async (tx) => {
    const [added] = await tx`insert into observations (universe, digest, obs_ts, r2_key)
      values (${o.universe}, ${o.digest}, ${o.obs_ts}, ${o.r2_key}) on conflict do nothing returning 1`;
    if (!added) return;
    await tx`with x as (
        select * from jsonb_to_recordset(${tx.json(jobs as never)}) as x(package text, config text,
          bioc_version text, version text, r text, "check" text, time_s integer, job bigint, artifact text)),
      gone as (delete from jobs j where j.universe = ${o.universe}
        and not exists (select 1 from x where x.package = j.package and x.config = j.config))
      insert into jobs (universe, package, config, bioc_version, version, r, "check", time_s, job, artifact, obs_ts)
      select ${o.universe}, package, config, bioc_version, version, r, "check", time_s, job, artifact, ${o.obs_ts}
      from x
      on conflict (universe, package, config) do update set bioc_version = excluded.bioc_version,
        version = excluded.version, r = excluded.r, "check" = excluded."check", time_s = excluded.time_s,
        job = excluded.job, artifact = excluded.artifact, obs_ts = excluded.obs_ts`;
  });
}

export async function markProcessed(sql: Db, universe: string, digest: string): Promise<void> {
  await sql`update observations set processed_at = now()
    where universe = ${universe} and digest = ${digest} and processed_at is null`;
}

// Counts for a human driving a backfill.
export async function status(sql: Db) {
  const publications = await sql`select bioc_version, repo, origin, count(*)::int as current
    from publications where superseded_at is null group by 1, 2, 3 order by 1, 2, 3`;
  const [cas] = await sql`select count(*)::int as objects, coalesce(sum(size_bytes), 0)::float8 as bytes
    from cas_objects`;
  const observations = await sql`select distinct on (universe) universe, digest, obs_ts, seen_at, processed_at
    from observations order by universe, obs_ts desc, seen_at desc`;
  return { publications: [...publications], cas, observations: [...observations] };
}
