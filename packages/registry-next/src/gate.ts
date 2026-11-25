// The propagation gate (ADR 0011), ported from the current registry with its rule names and
// behavior unchanged. Pure: it reads what is published as a Published map, never a database.

// The DCF fields of PACKAGES that come from DESCRIPTION.
export type Desc = Partial<Record<
  "Priority" | "Depends" | "Imports" | "LinkingTo" | "Suggests" | "Enhances" |
  "License" | "OS_type" | "NeedsCompilation", string
>>;

export type Origin = "r-universe" | "bioconductor" | "bioc-build";

// What the gate reads about the current publications of one repository.
export type Published = Record<string, { version: string; origin: Origin; desc: Desc }>;

// arch/distro are carried so a binary can be placed in a CRAN binary path.
export type Artifact = {
  os: string; r: string; sha256: string;
  arch?: string; distro?: string; file?: string;
};

// r-universe binary filenames are not in its API, so we name them ourselves; the name only has
// to agree with the File field the matching PACKAGES emits.
export const PKG_EXT: Record<string, string> = {
  src: "tar.gz", win: "zip", mac: "tgz", linux: "tar.gz", wasm: "tar.gz",
};

// A package propagates when it builds and its checks pass on AT LEAST ONE architecture; only
// the passing architectures' binaries propagate. NOTE/WARNING pass; ERROR/FAIL block, per
// family. bioc-checks (BiocCheck) and wasm stay advisory, mirroring BBS policy.
export type GateJob = { config: string; r?: string; check?: string };
export const GATE_BAD = new Set(["ERROR", "FAIL", "FAILURE"]);
export const GATE_FAMILIES = ["linux", "win", "mac"] as const;
export type Family = (typeof GATE_FAMILIES)[number];

// Which family a check config verdicts, on production-BBS-equivalent platforms only: source +
// linux x86_64 -> linux, windows x86_64 -> win, mac arm64 -> mac. Everything else gates nothing.
// ponytail: family-level verdicts; linux arm64 binaries ride the x86_64 verdict, mac x86_64
// rides arm64. Split per chip if that ever bites.
export function gateFamily(config: string): Family | null {
  if (config === "source") return "linux";
  const arm = config.includes("arm64");
  if (config.startsWith("linux-") && !arm) return "linux";
  if (config.startsWith("windows-") && !arm) return "win";
  if (config.startsWith("macos-") && arm) return "mac";
  return null;
}

// Families with at least one gating job on the gating R line and no ERROR/FAIL among them.
// Empty = the package does not propagate.
export function passingFamilies(jobs: GateJob[], rMinor: string): Family[] {
  const good = new Map<Family, boolean>();
  for (const j of jobs) {
    if (!j.r?.startsWith(rMinor + ".")) continue;
    const f = gateFamily(j.config);
    if (!f) continue;
    good.set(f, (good.get(f) ?? true) && !GATE_BAD.has(j.check ?? ""));
  }
  return GATE_FAMILIES.filter((f) => good.get(f) === true);
}

export type ObsBinary = {
  os: string; r?: string; version?: string; fileid?: string; status?: string;
  arch?: string; distro?: string;
};

// The binaries of one observed build that may ride with `version`: built successfully, of that
// version, and for a family the gate passed. wasm has no gating job, so it rides along.
export function binaryArtifacts(
  pkg: string, version: string, bins: ObsBinary[] | undefined, archs: readonly string[]
): Artifact[] {
  return (bins ?? [])
    .filter((b) => b.status === "success" && b.fileid && b.version === version)
    .filter((b) => b.os === "wasm" || archs.includes(b.os))
    .map((b) => ({
      os: b.os, r: b.r ?? "", sha256: b.fileid!.split("/").pop()!,
      arch: b.arch, distro: b.distro,
      file: `${pkg}_${version}.${PKG_EXT[b.os] ?? "tar.gz"}`,
    }));
}

const DEP_ROLES = ["Depends", "Imports", "LinkingTo", "Suggests", "Enhances"] as const;

// r-universe normalizes the dependency fields into _dependencies [{package, version, role}];
// regroup them back into DCF.
export function describe(p: {
  License?: string; NeedsCompilation?: string; Priority?: string; OS_type?: string;
  _dependencies?: { package: string; version?: string; role: string }[];
}): Desc {
  const d: Desc = {};
  for (const role of DEP_ROLES) {
    const deps = (p._dependencies ?? []).filter((x) => x.role === role);
    if (deps.length)
      d[role] = deps.map((x) => x.package + (x.version ? ` (${x.version})` : "")).join(", ");
  }
  if (p.Priority) d.Priority = p.Priority;
  if (p.License) d.License = p.License;
  if (p.OS_type) d.OS_type = p.OS_type;
  if (p.NeedsCompilation) d.NeedsCompilation = p.NeedsCompilation;
  return d;
}

// Dot- or dash-separated numeric parts, missing parts read as 0.
export function verGt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

// Roles R must resolve to install a package. Suggests/Enhances are not needed to install, and
// BBS's propagation check ignores them too.
const HARD_ROLES = ["Depends", "Imports", "LinkingTo"] as const;

// Base packages ship with R, so depending on one is always satisfiable. Recommended packages
// are deliberately not here: they come from CRAN, the "not ours" branch below.
const BASE_PKGS = new Set([
  "base", "compiler", "datasets", "graphics", "grDevices", "grid", "methods",
  "parallel", "splines", "stats", "stats4", "tcltk", "tools", "utils",
]);

export type DepReq = { pkg: string; op: string; ver: string };

// The hard dependency fields as (package, constraint) triples. Only >= and > are enforced, as
// in BBS; anything unparsable reads as "no constraint" rather than as a blocker.
export function depConstraints(d: Desc): DepReq[] {
  const out: DepReq[] = [];
  for (const role of HARD_ROLES)
    for (const entry of (d[role] ?? "").split(",")) {
      const m = entry.trim().match(
        /^([A-Za-z][A-Za-z0-9._]*)\s*(?:\(\s*(>=?)\s*([0-9][0-9.-]*)\s*\))?/
      );
      if (!m || m[1] === "R" || BASE_PKGS.has(m[1])) continue;
      out.push({ pkg: m[1], op: m[2] ?? "", ver: m[3] ?? "" });
    }
  return out;
}

// The names in a PACKAGES file: what the deps rule needs from CRAN and Bioconductor's data
// repositories, without parsing every stanza.
export function packageNames(dcf: string): string[] {
  return [...dcf.matchAll(/^Package:\s*(\S+)/gm)].map((m) => m[1]);
}

export type Blocked = { package: string; version: string; needs: string };

// A candidate may propagate only if every hard dependency WE publish is present at a version its
// constraint accepts. Dependencies we do not publish are not version-checked; given `known` (the
// names CRAN and Bioconductor's data repositories publish), one in none of those nor here blocks
// (#56). Approval is a fixpoint, as in BBS's makePropagationStatusDb.R, so a coordinated bump
// lands together, and the returned order is topological: a dependency is never published after
// the package that needs it. Blocked candidates carry the unmet requirement.
export function approveByDeps<T extends { package: string; version: string; desc: Desc }>(
  candidates: T[], published: Published, known?: Set<string>
): { approved: T[]; blocked: Blocked[] } {
  const have = new Map<string, string>(
    Object.entries(published).map(([name, e]) => [name, e.version])
  );
  const unmet = (d: Desc): DepReq | null => {
    for (const r of depConstraints(d)) {
      const v = have.get(r.pkg);
      if (v === undefined) {
        if (known && !known.has(r.pkg)) return r;
        continue;
      }
      if (r.op === ">=" && verGt(r.ver, v)) return r;
      if (r.op === ">" && !verGt(v, r.ver)) return r;
    }
    return null;
  };
  const approved: T[] = [];
  let pool = candidates;
  let reasons = new Map<string, DepReq>();
  while (pool.length) {
    const pass: T[] = [], held: T[] = [];
    reasons = new Map();
    for (const c of pool) {
      const r = unmet(c.desc);
      if (r) { reasons.set(c.package, r); held.push(c); } else pass.push(c);
    }
    if (!pass.length) break; // nothing left that this wave can unblock
    for (const c of pass) have.set(c.package, c.version);
    approved.push(...pass);
    pool = held;
  }
  return {
    approved,
    blocked: pool.map((c) => {
      const r = reasons.get(c.package)!;
      const v = have.get(r.pkg);
      return {
        package: c.package, version: c.version,
        needs: v === undefined
          ? `${r.pkg}, which is not in this repository, CRAN or Bioconductor's data repositories`
          : `${r.pkg} (${r.op} ${r.ver}), published ${v}`,
      };
    }),
  };
}

// ---------- the consolidated gate (ADR 0011) ----------
// One decision function for every producer. Every rule reports, pass or fail, so "why did X not
// propagate" is one record. Integrity (sha256, attestation) is not a gate rule: that is checked
// where the bytes are.
export type GateManifest = {
  state?: string; git_url?: string; streams?: string[]; component?: string; profile?: string;
};
export type GateInput = {
  package: string; version: string; origin: Origin;
  build_status: string;   // "success", or whatever the producer says went wrong
  jobs: GateJob[];        // per-config check verdicts; bioc-checks rides along
  desc: Desc;
  // undefined: not subject to manifest rules (r-universe). null: lookup failed.
  manifest?: GateManifest | null;
  source_git_url?: string; stream?: string;
};
export type GateConfig = {
  gating_r: string;                    // R minor the gating jobs must run on
  bioccheck: "advisory" | "blocking";
  // A same-version build may replace a bioconductor-seeded publication, once: a seed is not a
  // verdict, our build of it is.
  replace_seed: boolean;
};

export const waveGateConfig = (gating_r: string): GateConfig =>
  ({ gating_r, bioccheck: "advisory", replace_seed: true });
export type Reason = { rule: string; ok: boolean; detail?: string };
export type Decision = { propagate: boolean; archs: Family[]; reasons: Reason[] };

export const R_VER = /^\d+([.-]\d+)*$/;

// The version-gate rule on its own, because publish() re-checks it under a lock.
export function versionGate(
  version: string, prev: { version: string; origin: Origin } | undefined, replaceSeed: boolean
): { ok: boolean; detail: string } {
  if (!prev) return { ok: true, detail: `${version}, first publication` };
  if (verGt(version, prev.version)) return { ok: true, detail: `${version} > ${prev.version}` };
  if (replaceSeed && version === prev.version && prev.origin === "bioconductor")
    return { ok: true, detail: `${version} replaces the bioconductor seed` };
  return { ok: false, detail: `${version} is not > ${prev.version} (${prev.origin})` };
}

// `known`: package names published outside this repository, for the deps rule.
export function gate(
  inputs: GateInput[], config: GateConfig, published: Published, known?: Set<string>
): { decisions: Record<string, Decision>; approved: string[] } {
  const decisions: Record<string, Decision> = {};
  const clear: { package: string; version: string; desc: Desc }[] = [];
  for (const c of inputs) {
    const reasons: Reason[] = [];
    const rule = (name: string, ok: boolean, detail?: string) =>
      reasons.push(detail === undefined ? { rule: name, ok } : { rule: name, ok, detail });
    rule("build-status", c.build_status === "success", c.build_status);
    const archs = passingFamilies(c.jobs, config.gating_r);
    rule("families", archs.length > 0, archs.length ? archs.join(",") : `no family passed on R ${config.gating_r}`);
    const bc = c.jobs.find((j) => j.config === "bioc-checks")?.check;
    rule("bioccheck", config.bioccheck === "advisory" || !GATE_BAD.has(bc ?? ""), `${bc ?? "not run"} (${config.bioccheck})`);
    rule("version-parse", R_VER.test(c.version), c.version);
    // hasOwn: a package named constructor or toString is not an Object.prototype member.
    const prev = Object.hasOwn(published, c.package) ? published[c.package] : undefined;
    const vg = versionGate(c.version, prev, config.replace_seed);
    rule("version-gate", vg.ok, vg.detail);
    if (c.manifest !== undefined) {
      const m = c.manifest;
      if (!m) rule("manifest", false, "manifest lookup failed");
      else {
        rule("manifest-state", m.state === "active", m.state ?? "not in manifest");
        rule("manifest-git-url", !!m.git_url && m.git_url === c.source_git_url, `${m.git_url ?? "none"} vs built ${c.source_git_url ?? "none"}`);
        rule("manifest-stream", !!c.stream && (m.streams ?? []).includes(c.stream), `${c.stream ?? "none"} in [${(m.streams ?? []).join(", ")}]`);
        rule("manifest-component", !!m.component && m.component === m.profile, `${m.component ?? "none"} / ${m.profile ?? "none"}`);
      }
    }
    const propagate = reasons.every((x) => x.ok);
    decisions[c.package] = { propagate, archs, reasons };
    if (propagate) clear.push({ package: c.package, version: c.version, desc: c.desc });
  }
  // The dependency rule is a fixpoint over the wave, so it runs last and only over candidates
  // every other rule cleared.
  const { approved, blocked } = approveByDeps(clear, published, known);
  for (const p of approved) decisions[p.package].reasons.push({ rule: "deps", ok: true });
  for (const b of blocked) {
    const d = decisions[b.package];
    d.propagate = false;
    d.reasons.push({ rule: "deps", ok: false, detail: `needs ${b.needs}` });
  }
  return { decisions, approved: approved.map((p) => p.package) };
}

// The build details the gate needs, straight out of bioc-build's staged.json (SPEC-014).
export type PublishStaged = {
  status: string; stream: string; manifest_commit: string | null;
  source: { git_url: string | null }; build: { r_version: string | null };
  check: { status: string | null; bioccheck: string | null };
};

// bioc-build's one linux job, in the shape r-universe jobs already have, so the same families
// rule reads both. check.status is ok|warning|error (SPEC-014).
export function gateInputFromStaged(
  pkg: string, entry: { version: string; desc: Desc }, st: PublishStaged, manifest: GateManifest | null
): GateInput {
  const jobs: GateJob[] = [
    { config: "linux-x86_64", r: st.build.r_version ?? "", check: (st.check.status ?? "").toUpperCase() },
  ];
  if (st.check.bioccheck) jobs.push({ config: "bioc-checks", check: st.check.bioccheck.toUpperCase() });
  return {
    package: pkg, version: entry.version, origin: "bioc-build",
    build_status: st.status.startsWith("failed") ? st.status : "success",
    jobs, desc: entry.desc, manifest,
    source_git_url: st.source.git_url ?? undefined, stream: st.stream,
  };
}

// The first failed rule, for the rejected:<rule> vocabulary.
export const rejectedRule = (d: Decision) => d.reasons.find((r) => !r.ok)?.rule ?? "unknown";
