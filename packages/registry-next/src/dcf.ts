// Repository indexes (PACKAGES, VIEWS) rendered from the current publications. Pure: rows come
// from repoRows().
import { verGt } from "./gate.ts";
import type { Binary, RepoRow } from "./store.ts";

export type Sel = { os: string; r?: string; arch?: string; distro?: string };

// DCF: stanzas separated by blank lines, "Field: value", continuation lines indented. Only what
// the official VIEWS and PACKAGES use: no comments, no folded quoting.
export function parseDcf(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let rec: Record<string, string> = {};
  let field = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (Object.keys(rec).length) out.push(rec);
      rec = {}; field = "";
      continue;
    }
    if (/^\s/.test(line) && field) {
      rec[field] += " " + line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    field = line.slice(0, i);
    rec[field] = line.slice(i + 1).trim();
  }
  if (Object.keys(rec).length) out.push(rec);
  return out;
}

// contrib.url() paths. Only Windows and macOS binaries are served: contrib.url() on Linux returns
// the source path, so there is no Linux binary layout to target.
// ponytail: the Windows path is pinned to x86_64 because contrib.url() on Windows-on-ARM asks
// for this same directory, and mixing arm64 zips in would hand an ARM build to an x86 R.
export function parseRepoDir(p: string[]): Sel | null {
  if (p[0] === "src" && p[1] === "contrib" && p.length === 2) return { os: "src" };
  if (p[0] !== "bin") return null;
  if (p[1] === "windows" && p[2] === "contrib" && p[3])
    return { os: "win", r: p[3], arch: "x86_64" };
  if (p[1] === "macosx" && p[3] === "contrib" && p[4])
    return { os: "mac", arch: p[2], r: p[4] };
  return null;
}

export const rMinor = (r: string) => r.split(".").slice(0, 2).join(".");

const normArch = (s: string) => {
  const t = s.split("-").pop() ?? "";
  return t === "aarch64" ? "arm64" : t === "amd64" ? "x86_64" : t;
};

export function matchSel(b: Binary, s: Sel): boolean {
  if (b.os !== s.os) return false;
  if (s.r && rMinor(b.r_minor) !== s.r) return false;
  // A package with no compiled code builds one arch-independent binary and r-universe omits
  // the arch for it, so an arch-less binary is valid for every arch, not for none.
  if (s.arch && b.arch && normArch(s.arch) !== normArch(b.arch)) return false;
  if (s.distro && s.distro !== b.distro) return false;
  return true;
}

// CRAN renamed the macOS arm64 directory at R 4.6 (big-sur-arm64 -> sonoma-arm64) and
// Bioconductor followed. Intel stayed put.
export const macArmDir = (r: string) => (verGt(r, "4.5") ? "sonoma-arm64" : "big-sur-arm64");
export const MAC_X86_DIR = "big-sur-x86_64";

// The fields tools::write_PACKAGES() writes, in its order, then File. Archs (mac fat binaries)
// is left out, as the current registry does.
export const packagesFields = [
  "Package", "Version", "Priority", "Depends", "Imports", "LinkingTo", "Suggests", "Enhances",
  "License", "License_is_FOSS", "License_restricts_use", "OS_type", "MD5sum",
  "NeedsCompilation", "File",
] as const;

// A row whose DESCRIPTION was never captured is skipped: a stanza with no Depends line would
// claim the package has no dependencies.
const described = (r: RepoRow) => Object.keys(r.description).length > 0;

// DCF forbids bare newlines in a value.
const dcfValue = (s: string) => s.replace(/\s+/g, " ").trim();

// One record per package that has a file in the selected directory, with only the fields it has.
export function packagesRecords(rows: RepoRow[], sel: Sel): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of [...rows].sort((a, b) => cmp(a.package, b.package))) {
    if (!described(r)) continue;
    const f = sel.os === "src" ? r.source : r.binaries.find((b) => matchSel(b, sel));
    if (!f) continue;
    const all: Record<string, string | null | undefined> = {
      ...r.description, Package: r.package, Version: r.version, MD5sum: f.md5, File: f.filename,
    };
    const rec: Record<string, string> = {};
    for (const k of packagesFields) if (all[k]) rec[k] = dcfValue(all[k]!);
    out.push(rec);
  }
  return out;
}

export function packagesDcf(rows: RepoRow[], sel: Sel): string {
  const stanzas = packagesRecords(rows, sel).map((rec) =>
    Object.entries(rec).map(([k, v]) => `${k}: ${v}`).join("\n"));
  return stanzas.length ? stanzas.join("\n\n") + "\n" : "";
}

// Code-point order, as R's sort in the C locale; localeCompare would vary by runtime.
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- VIEWS ----------
// The DCF file at each repository root that BiocPkgTools and biocViews parse: PACKAGES fields
// plus descriptive metadata, vignettes, git provenance, per-platform paths and first-order
// reverse dependencies within these rows. Not emitted yet: Rank, dependencyCount,
// hasREADME/hasNEWS/hasINSTALL/hasLICENSE, Rfiles, htmlDocs, htmlTitles.

// Multi-line values are legal DCF as continuation lines.
const viewsValue = (s: string) => s.replace(/\r?\n\s*/g, "\n    ").trim();

// "R (>= 4.0)" is a constraint on R itself, not a dependency edge.
function depNames(v?: string): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().split(/[\s(]/, 1)[0])
    .filter((s) => s && s !== "R");
}

const VIEWS_DESC = [
  "Depends", "Suggests", "Imports", "LinkingTo", "Enhances", "License", "OS_type", "Priority",
] as const;
const VIEWS_META = [
  "NeedsCompilation", "Title", "Description", "biocViews", "Author", "Maintainer", "URL",
  "BugReports", "SystemRequirements", "VignetteBuilder", "Date",
] as const;

export function viewsDcf(rows: RepoRow[]): string {
  const sorted = rows.filter(described).sort((a, b) => cmp(a.package, b.package));
  const rev: Record<string, { dependsOnMe: string[]; importsMe: string[]; suggestsMe: string[] }> =
    Object.fromEntries(sorted.map((r) => [r.package, { dependsOnMe: [], importsMe: [], suggestsMe: [] }]));
  for (const r of sorted) {
    const d = r.description;
    for (const p of depNames(d.Depends)) rev[p]?.dependsOnMe.push(r.package);
    for (const p of depNames(d.Imports)) rev[p]?.importsMe.push(r.package);
    for (const p of depNames(d.Suggests)) rev[p]?.suggestsMe.push(r.package);
  }

  const stanzas: string[] = [];
  for (const r of sorted) {
    const d = r.description;
    const win = r.binaries.find((b) => b.os === "win");
    // Two mac builds share a filename and differ only by arch. An arch-less binary is
    // arch-independent, so it stands in for arm64.
    const macs = r.binaries.filter((b) => b.os === "mac");
    const macArm = macs.find((b) => !b.arch || normArch(b.arch) === "arm64");
    const macX86 = macs.find((b) => b.arch && normArch(b.arch) === "x86_64");
    const vigs = Array.isArray(r.meta.vignettes)
      ? (r.meta.vignettes as { filename?: string; title?: string }[]) : [];
    const vigFiles = vigs.map((v) => v.filename).filter(Boolean);
    const vigTitles = vigs.map((v) => v.title).filter(Boolean);
    const rec: Record<string, string | null | undefined> = {
      Package: r.package,
      Version: r.version,
      ...Object.fromEntries(VIEWS_DESC.map((k) => [k, d[k]])),
      MD5sum: r.source.md5,
      ...Object.fromEntries(VIEWS_META.map((k) => [k, d[k]])),
      git_url: r.git_url,
      git_branch: r.git_branch,
      git_last_commit: r.git_commit,
      git_last_commit_date: r.git_commit_at?.slice(0, 10),
      "source.ver": `src/contrib/${r.source.filename}`,
      "win.binary.ver": win ? `bin/windows/contrib/${rMinor(win.r_minor)}/${win.filename}` : undefined,
      "mac.binary.ver": macArm
        ? `bin/macosx/${macArmDir(rMinor(macArm.r_minor))}/contrib/${rMinor(macArm.r_minor)}/${macArm.filename}`
        : undefined,
      [`mac.binary.${MAC_X86_DIR}.ver`]: macX86
        ? `bin/macosx/${MAC_X86_DIR}/contrib/${rMinor(macX86.r_minor)}/${macX86.filename}` : undefined,
      vignettes: vigFiles.length ? vigFiles.join(", ") : undefined,
      vignetteTitles: vigTitles.length ? vigTitles.join(", ") : undefined,
      dependsOnMe: rev[r.package].dependsOnMe.join(", ") || undefined,
      importsMe: rev[r.package].importsMe.join(", ") || undefined,
      suggestsMe: rev[r.package].suggestsMe.join(", ") || undefined,
    };
    stanzas.push(
      Object.entries(rec)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${viewsValue(v!)}`)
        .join("\n")
    );
  }
  return stanzas.length ? stanzas.join("\n\n") + "\n" : "";
}
