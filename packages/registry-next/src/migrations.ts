// Schema migrations, as SQL in TypeScript so the same list runs under node --test and in the
// Worker (POST /admin/migrate) without a bundler rule for .sql files. Append only: never edit
// a migration that has been applied anywhere.
import type { Sql } from "postgres";

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
-- Bytes we hold. A row exists only for an object that is in R2 at cas/{sha256}.
create table cas_objects (
  sha256      text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  md5         text check (md5 ~ '^[0-9a-f]{32}$'),   -- null until a full read computed it
  size_bytes  bigint not null,
  source_url  text,                                  -- where the bytes were copied from
  created_at  timestamptz not null default now()
);

-- One row per source tarball. Everything here is a fact about those bytes, so it never
-- changes and never depends on what a builder reports later.
create table package_versions (
  src_sha256    text primary key references cas_objects,
  package       text not null,
  version       text not null,
  description   jsonb not null,                -- every DESCRIPTION field, as read.dcf returns it
  files         jsonb not null default '{}',   -- inventory read from the tarball (hasNEWS, vignettes, ...)
  meta          jsonb not null default '{}',   -- reported by the builder, not readable from the tarball
  git_url       text,
  git_branch    text,
  git_commit    text,
  git_commit_at timestamptz,
  created_at    timestamptz not null default now()
);
create index package_versions_name on package_versions (package, version);

-- What is, or was, served where. The current version of a package in a repository is the row
-- with superseded_at null; older rows are what src/contrib/Archive/ serves.
create table publications (
  id            bigint generated always as identity primary key,
  bioc_version  text not null,                 -- '3.24', never 'release' or a universe name
  repo          text not null check (repo in ('bioc', 'data/annotation', 'data/experiment', 'workflows')),
  package       text not null,
  version       text not null,
  src_sha256    text not null references package_versions,
  origin        text not null check (origin in ('r-universe', 'bioc-build', 'bioconductor')),
  bioccheck     text,
  archs         text[] not null default '{}',  -- gate families that passed; empty for a seed
  published_at  timestamptz not null default now(),
  superseded_at timestamptz
);
create unique index publications_current on publications (bioc_version, repo, package)
  where superseded_at is null;
create index publications_history on publications (bioc_version, repo, package, published_at desc);

-- Binaries of a publication. The source tarball is publications.src_sha256.
create table published_artifacts (
  publication_id bigint not null references publications on delete cascade,
  os        text not null check (os in ('win', 'mac', 'linux', 'wasm')),
  r_minor   text not null default '',
  arch      text not null default '',
  distro    text not null default '',
  filename  text not null,
  sha256    text not null references cas_objects,
  added_at  timestamptz not null default now(),
  primary key (publication_id, os, r_minor, arch)
);

-- Every gate verdict that changed, with each rule's result (ADR 0011), so "why is X not
-- available" is a query.
create table gate_decisions (
  id            bigint generated always as identity primary key,
  bioc_version  text not null,
  repo          text not null,
  package       text not null,
  version       text not null,
  origin        text not null,
  propagate     boolean not null,
  archs         text[] not null default '{}',
  reasons       jsonb not null,
  decided_at    timestamptz not null default now()
);
create index gate_decisions_latest on gate_decisions (bioc_version, repo, package, decided_at desc);
`,
  },
  {
    id: "0002_bioc_versions",
    sql: `
-- Bioconductor versions and the R line each gates on, from bioconductor.org's config.yaml.
-- role resolves the symbolic release/devel paths; at most one row holds each.
create table bioc_versions (
  bioc_version text primary key,            -- '3.24'
  r_minor      text not null,               -- the R line that version gates on, '4.6'
  role         text check (role in ('release', 'devel')),
  updated_at   timestamptz not null default now()
);
create unique index bioc_versions_role on bioc_versions (role) where role is not null;
`,
  },
  {
    id: "0003_observations",
    sql: `
-- The r-universe universe that builds a version, from config.yaml's r_universe_* keys. It can
-- run ahead of role during a release roll.
alter table bioc_versions add column universe text check (universe in ('bioc', 'bioc-release'));
create unique index bioc_versions_universe on bioc_versions (universe) where universe is not null;

create table observations (
  universe text not null, digest text not null, obs_ts timestamptz not null, r2_key text not null,
  seen_at timestamptz not null default now(), processed_at timestamptz,
  primary key (universe, digest)
);
-- The newest observation's job verdicts: one row per (universe, package, config).
create table jobs (
  universe text not null, package text not null, config text not null,
  bioc_version text, version text, r text, "check" text, time_s integer, job bigint, artifact text,
  obs_ts timestamptz not null,
  primary key (universe, package, config)
);
-- Package names published outside this registry (CRAN, Bioconductor repositories this registry
-- does not hold yet), for the gate's deps rule.
create table known_external_deps (
  bioc_version text not null, name text not null, primary key (bioc_version, name)
);
create index publications_src on publications (src_sha256);
create index published_artifacts_sha on published_artifacts (sha256);
`,
  },
  {
    id: "0004_books",
    sql: `
-- Books are a fifth repository on bioconductor.org, and r-universe builds them in the same
-- universes as software.
alter table publications drop constraint publications_repo_check;
alter table publications add constraint publications_repo_check
  check (repo in ('bioc', 'data/annotation', 'data/experiment', 'workflows', 'books'));
`,
  },
  {
    id: "0005_gate_decisions_version",
    sql: `
-- recordDecisions() reads the latest decision of one package version. Without version and id in
-- the key, that probe sorts every older version's decisions of the package to find it.
create index gate_decisions_version on gate_decisions (bioc_version, repo, package, version, decided_at desc, id desc);
`,
  },
  {
    id: "0006_job_runs",
    sql: `
-- poll() inserts an observation unparsed; observe() parses it and records its jobs once, setting
-- this. Every observation before this migration had its jobs recorded on insert.
alter table observations add column recorded_at timestamptz;
update observations set recorded_at = seen_at;

-- Every build job ever seen, append only: a row is inserted on first sight and afterwards only
-- last_obs_ts moves. jobs stays the newest observation's verdicts.
create table job_runs (
  builder      text not null default 'r-universe',
  universe     text not null,
  job          bigint not null,             -- the GitHub Actions job id
  package      text,
  version      text,
  src_sha256   text,
  config       text,
  r            text,
  "check"      text,
  time_s       integer,
  artifact     text,                        -- the GitHub Actions artifact id
  bioc_version text,
  commit       text,                        -- RemoteSha, or the failed commit
  failure      boolean not null default false,  -- from _failure: a newer commit's failed build
  built_at     timestamptz,                 -- _created
  expires_at   timestamptz,                 -- _expires: when the artifact goes upstream
  first_obs_ts timestamptz not null,
  last_obs_ts  timestamptz not null,
  primary key (builder, universe, job)
);
create index job_runs_package on job_runs (universe, package, first_obs_ts);

-- What is still to be copied from GitHub before it expires there: a job's log (and the build
-- environment read from it) and its check artifact's text.
create table capture_queue (
  builder         text not null default 'r-universe',
  universe        text not null,
  job             bigint not null,
  kind            text not null check (kind in ('log', 'check')),
  artifact        text,
  status          text not null default 'pending' check (status in ('pending', 'done', 'gone')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  expires_at      timestamptz,
  last_error      text,
  done_at         timestamptz,
  primary key (builder, universe, job, kind)
);
create index capture_queue_due on capture_queue (next_attempt_at, expires_at) where status = 'pending';
`,
  },
];

// Applies pending migrations in one transaction, under an advisory lock so two callers
// cannot interleave. Returns the ids it applied.
export async function migrate(sql: Sql): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7203113)`;
    await tx`create table if not exists schema_migrations (
      id text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select id from schema_migrations`).map((r) => r.id as string));
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (id) values (${m.id})`;
      applied.push(m.id);
    }
    return applied;
  }) as Promise<string[]>;
}
