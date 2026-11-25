#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""How much of the website's packages.json can be derived from the registry's index.json?

Reads index.json for each (version, repo) from the registry, and the packages.json
snapshot the website is built from, derives every packages.json field from the
index.json entry, and counts agreement per field. A Markdown report goes to stdout;
--json writes the same numbers as JSON. See README.md.
"""
import argparse
import collections
import datetime
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY = "https://bioc-registry-next.seandavi.workers.dev"
SNAPSHOT = "https://bioconductor.org/_ci/site-data.tar.zst"
REPOS = ["bioc", "data/experiment", "workflows", "books"]
ALL_REPOS = ["bioc", "data/annotation", "data/experiment", "workflows", "books"]
ROOT_TERM = {"bioc": "Software", "data/annotation": "AnnotationData",
             "data/experiment": "ExperimentData", "workflows": "Workflow"}
LISTS = ["Depends", "Imports", "Suggests", "LinkingTo", "Enhances"]
REV = {"Depends": "dependsOnMe", "Imports": "importsMe", "Suggests": "suggestsMe", "LinkingTo": "linksToMe"}
# Snapshot fields with no source in index.json, and where the collector gets each today.
NO_SOURCE = {
    "DownloadRank": "bio-web-stats scores (/packages/stats/*), ranked within the repository",
    "since": "the manifest's software.txt history, else the first release holding the package on disk",
    "releases": "the packages.json files of earlier releases already on disk",
    "hasArchive": "listing of src/contrib/Archive/ on the legacy server (releases only, software only)",
    "Archs": "the legacy VIEWS file (the Windows binary's architectures)",
    "Date/Publication": "dropped by the collector (unused)",
}
DERIVED = set(LISTS) | {"biocViews", "dependencyCount", "git_branch", "Rfiles", "vignetteTitles"}
MAIN_TEXT = ["Title", "Description", "Author", "Maintainer", "License", "URL", "BugReports",
             "SystemRequirements", "PackageStatus", "Video", "Version"]


# ---------------------------------------------------------------- inputs ---

def get(url):
    try:
        # The registry's edge rejects urllib's default User-Agent.
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bioc-parity/1"}), timeout=300) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def get_json(url):
    body = get(url)
    return json.loads(body) if body else None


def fetch_snapshot(workdir):
    """Download and extract the snapshot; return (data dir, identity)."""
    blob = get(SNAPSHOT)
    (workdir / "site-data.tar.zst").write_bytes(blob)
    out = workdir / "x"
    out.mkdir()
    zstd = subprocess.Popen(["zstd", "-dc", str(workdir / "site-data.tar.zst")], stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(out)], stdin=zstd.stdout, check=True)
    if zstd.wait():
        sys.exit("zstd failed")
    return out / "data", f"{SNAPSHOT} sha256 {hashlib.sha256(blob).hexdigest()}"


def snapshot_repo(root, version, repo):
    f = root / version / repo / "packages.json"
    return json.loads(f.read_text()) if f.exists() else None


# ------------------------------------------------------------ derivations ---

def norm(v):
    if isinstance(v, str):
        return re.sub(r"\s+", " ", v).strip()
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def split_list(v):
    # VIEWS escapes a comma inside an item as ",,"; the collector turns it back.
    return [x.strip().replace(",,", ",") for x in re.split(r"(?<!,),(?!,)\s*", v) if x.strip()] if v else []


def deps(e, role):
    return [norm(x) for x in split_list(e["description"].get(role) or "")]


def dep_name(d):
    return re.split(r"[ (]", d)[0]


def bin_dirs(rver):
    """packages.json field -> (directory, os, arch preferences), as the collector's bin_dirs."""
    arm = "sonoma-arm64" if tuple(map(int, rver.split("."))) >= (4, 6) else "big-sur-arm64"
    return {"win.binary.ver": (f"bin/windows/contrib/{rver}", "win", ["", "x86_64"]),
            f"mac.binary.{arm}.ver": (f"bin/macosx/{arm}/contrib/{rver}", "mac", ["arm64", ""]),
            "mac.binary.big-sur-x86_64.ver": (f"bin/macosx/big-sur-x86_64/contrib/{rver}", "mac", ["x86_64", ""])}


def binary(e, field, rver):
    d, os_, archs = bin_dirs(rver)[field]
    for arch in archs:
        for b in e["binaries"]:
            if b["os"] == os_ and b["r_minor"] == rver and b["arch"] == arch:
                return f"{d}/{b['filename']}"
    return None


def has_rules(name):
    """Candidate rules for hasNEWS & co., each (files) -> bool. The data picks the best."""
    top = re.compile(rf"{name}(\.\w+)?")
    inst = re.compile(rf"inst/{name}(\.\w+)?")
    names = lambda f: f["top"] + f["other"]  # noqa: E731
    return {
        "exact name": lambda f: name in names(f),
        "name + any extension": lambda f: any(top.fullmatch(n) for n in names(f)),
        "name + extension, incl. inst/": lambda f: any(top.fullmatch(n) or inst.fullmatch(n) for n in names(f)),
    }


def vignette_files(docs):
    """Built vignettes in inst/doc: one .html (else .pdf) per stem, ordered by the source file's
    position in the listing, as the vignette index orders them."""
    out = {}
    for i, x in enumerate(docs):
        stem, _, ext = x.rpartition(".")
        if ext in ("html", "pdf"):
            out.setdefault(stem, []).append(x)
    pos = {x.rpartition(".")[0]: i for i, x in reversed(list(enumerate(docs)))
           if x.lower().endswith((".rmd", ".rnw", ".qmd"))}
    files = [(pos.get(st, docs.index(fs[0])), sorted(fs)[0]) for st, fs in out.items()]
    return [f for _, f in sorted(files)]


def derive(e, repo, rver):
    """{field or field/rule: value}. A missing value means the registry cannot say."""
    d, f, out = e["description"], e["files"], {}
    for k, v in d.items():
        out[k] = v
    out["Version"] = e["version"]
    for role in LISTS:
        out[role] = deps(e, role) if d.get(role) else None
    bv = split_list(d.get("biocViews") or "")
    out["biocViews"] = sorted(set(bv) | {ROOT_TERM[repo]}) if repo in ROOT_TERM else None
    out["dependencyCount"] = str(len({dep_name(x) for r in ("Depends", "Imports", "LinkingTo")
                                      for x in deps(e, r)} - {"R"}))
    for name in ("NEWS", "README", "INSTALL", "LICENSE"):
        for rule, fn in has_rules(name).items():
            out[f"has{name}/{rule}"] = fn(f)
    vigs = e["meta"].get("vignettes")
    docs = f["instDoc"]
    out["vignettes/as listed"] = None if vigs is None else [f"vignettes/{e['package']}/inst/doc/{v['filename']}" for v in vigs]
    out["vignetteTitles"] = None if vigs is None else [v["title"] for v in vigs]
    doc = lambda x: f"vignettes/{e['package']}/inst/doc/{x}"  # noqa: E731
    out["vignettes/instDoc"] = [doc(x) for x in vignette_files(docs)]
    out["Rfiles"] = [doc(x) for x in docs if x.endswith((".R", ".r"))] or None
    out["source.ver"] = "src/contrib/" + e["source"]["filename"] if e.get("source") else None
    for field in bin_dirs(rver):
        out[field] = binary(e, field, rver)
    # r-universe's `bioc` universe builds git HEAD; the collector calls that branch "devel".
    out["git_branch"] = {"HEAD": "devel"}.get(e.get("git_branch"), e.get("git_branch"))
    out["Updated/git_commit_at"] = (e.get("git_commit_at") or "")[:10] or None
    out["Updated/Packaged"] = (d.get("Packaged") or "")[:10] or None
    return out


# ------------------------------------------------------------- comparison ---

def compare(stats, examples, key, field, snap, derived, name, extra=None):
    c = stats[key].setdefault(field, collections.Counter())
    if snap is None and derived is None:
        c["both_absent"] += 1
    elif derived is None:
        c["absent_registry"] += 1
    elif snap is None:
        c["absent_snapshot"] += 1
    else:
        c["compared"] += 1
        if snap == derived:
            c["equal"] += 1
        elif norm(snap) == norm(derived):
            c["equal_after_whitespace"] += 1
        elif extra and extra(snap, derived):
            c["snapshot_binary_trails_source"] += 1
        else:
            c["different"] += 1
            ex = examples.setdefault(field, [])
            if len(ex) < 5:
                ex.append((key, name, snap, derived))


def trailing(version):
    """Predicate: the snapshot's binary is an older version than its source, and the registry's is not."""
    def f(snap, derived):
        v = lambda p: re.search(r"_([^_/]+?)\.(zip|tgz|tar\.gz)$", p).group(1)  # noqa: E731
        return v(snap) != version and v(derived) == version
    return f


def compare_repo(stats, examples, key, repo, reg, snap, rver):
    both = reg.keys() & snap.keys()
    same = sorted(n for n in both if reg[n]["version"] == snap[n].get("Version"))
    stats[key] = {}
    cov = {"in_both": len(both), "snapshot_only": len(snap.keys() - reg.keys()),
           "registry_only": len(reg.keys() - snap.keys()), "version_differs": len(both) - len(same),
           "compared": len(same)}
    derive_names = derive(next(iter(reg.values())), repo, rver) if reg else {}
    carried = set().union(*(r.keys() for r in snap.values())) | set(MAIN_TEXT) | {f for f in derive_names if f.endswith(".ver")}
    for n in same:
        s, dv = snap[n], derive(reg[n], repo, rver)
        for field, v in dv.items():
            sk = field.split("/")[0]
            if sk in NO_SOURCE or sk in REV.values() or sk not in carried:
                continue
            trails = trailing(s["Version"]) if field.endswith(".ver") and field != "source.ver" else None
            compare(stats, examples, key, field, s.get(sk), v, n, trails)
    return cov


def revdeps(regs, snaps):
    """Reverse dependencies computed from the registry's indexes, against the snapshot's lists."""
    rev = collections.defaultdict(lambda: collections.defaultdict(set))
    for repo_, reg in regs.items():
        for n, e in reg.items():
            for role, field in REV.items():
                for d in deps(e, role):
                    rev[dep_name(d)][field].add(n)
    in_registry = {n for reg in regs.values() for n in reg}
    in_snapshot = {n for s in snaps.values() for n in s}
    res = {}
    for field in REV.values():
        c = collections.Counter()
        for repo, snap in snaps.items():
            reg = regs.get(repo, {})
            for n, rec in snap.items():
                if n not in reg or reg[n]["version"] != rec.get("Version"):
                    continue
                want, got = set(rec.get(field) or []), rev[n][field]
                c["packages"] += 1
                c["snapshot_items"] += len(want)
                c["recovered"] += len(want & got)
                c["registry_only_items"] += len(got - want)
                for m in want - got:
                    c["missing_in_registry_not_yet" if m in in_snapshot and m not in in_registry
                      else "missing_not_bioconductor" if m not in in_snapshot
                      else "missing_registry_has_it"] += 1
        res[field] = c
    return res


# ----------------------------------------------------------------- report ---

def short(v, n=110):
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else repr(v)
    return s if len(s) <= n else s[:n] + "…"


def table(rows, header):
    return "\n".join(["| " + " | ".join(header) + " |", "|" + "---|" * len(header)] +
                     ["| " + " | ".join(str(x) for x in r) + " |" for r in rows])


def report(meta, cov, stats, examples, rev, unsourced):
    L = [f"# registry-next parity with packages.json", "",
         f"- Date: {meta['date']}", f"- Registry: {meta['registry']}", f"- Snapshot: {meta['snapshot']}", ""]
    L += ["## Coverage", "", table([(k, *[c[x] for x in ("in_both", "snapshot_only", "registry_only", "version_differs", "compared")])
                                    for k, c in sorted(cov.items())],
                                   ["version / repo", "in both", "snapshot only", "registry only", "version differs (left out)", "compared"]), ""]
    cols = ["compared", "equal", "equal_after_whitespace", "different", "snapshot_binary_trails_source", "absent_snapshot", "absent_registry"]
    for key, fields in stats.items():
        if not fields:
            continue
        L += [f"## Fields: {key}", ""]
        main, other = [], collections.Counter()
        for f, c in sorted(fields.items()):
            if f in MAIN_TEXT or "/" in f or f.endswith(".ver") or f in DERIVED:
                main.append((f, *[c[x] for x in cols]))
            else:
                other.update({x: c[x] for x in cols})
                other["keys"] += 1
        if other:
            main.append((f"({other['keys']} other DESCRIPTION keys)", *[other[x] for x in cols]))
        L += [table(main, ["field", "compared", "equal", "equal after whitespace", "different", "binary trails source", "absent in snapshot", "absent in registry"]), ""]
    L += ["## Reverse dependencies (registry indexes only)", ""]
    rows = []
    for key, res in rev.items():
        for field, c in res.items():
            if c["packages"]:
                rows.append((key, field, c["packages"], c["snapshot_items"], c["recovered"], c["registry_only_items"],
                             c["missing_in_registry_not_yet"], c["missing_not_bioconductor"], c["missing_registry_has_it"]))
    L += [table(rows, ["version", "field", "packages", "snapshot items", "recovered", "only in registry",
                       "missing: Bioconductor, not in registry yet", "missing: not Bioconductor (CRAN etc.)", "missing: registry has the name"]), ""]
    L += ["## Snapshot fields with no source in index.json", "",
          table(sorted(unsourced.items()), ["field", "where the collector gets it today"]), ""]
    L += ["## Examples of differences (up to 5 per field)", ""]
    for f, ex in sorted(examples.items()):
        L += [f"### {f}", ""]
        for key, n, s, d in ex:
            L += [f"- {key} `{n}`: snapshot {short(s)} / derived {short(d)}"]
        L += [""]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--versions", nargs="+", default=["3.24", "3.25"])
    ap.add_argument("--snapshot-dir", help="an already extracted snapshot's data/ directory (default: download)")
    ap.add_argument("--registry", default=REGISTRY)
    ap.add_argument("--json", metavar="FILE", help="also write the numbers as JSON")
    a = ap.parse_args()

    tmp = tempfile.TemporaryDirectory()
    if a.snapshot_dir:
        root, ident = Path(a.snapshot_dir), f"extracted copy at {a.snapshot_dir} (no tarball hash)"
    else:
        root, ident = fetch_snapshot(Path(tmp.name))
    versions = get_json(f"{a.registry}/packages/versions.json")["versions"]
    stats, examples, cov, rev, unsourced = {}, {}, {}, {}, {}
    prov = []
    for v in a.versions:
        p = root / v / "provenance.json"
        if p.exists():
            prov.append(f"{v}: {json.loads(p.read_text()).get('branch')}")
        # The snapshot's binary paths use its own R; versions.json may say otherwise (reported).
        rver = (json.loads(p.read_text()).get("r_version") if p.exists() else None) or versions[v]["r_minor"]
        if rver != versions[v]["r_minor"]:
            prov.append(f"{v}: r_version {rver} in the snapshot, r_minor {versions[v]['r_minor']} in versions.json")
        regs = {r: j for r in REPOS if (j := get_json(f"{a.registry}/packages/{v}/{r}/index.json"))}
        snaps = {r: j for r in ALL_REPOS if (j := snapshot_repo(root, v, r))}
        for r in ALL_REPOS:
            if (r in regs) != (r in snaps):
                print(f"note: {v} {r} is only in the {'registry' if r in regs else 'snapshot'}", file=sys.stderr)
        for r in regs.keys() & snaps.keys():
            key = f"{v} {r}"
            cov[key] = compare_repo(stats, examples, key, r, regs[r], snaps[r], rver)
            for s in snaps[r].values():
                unsourced.update({k: NO_SOURCE[k] for k in NO_SOURCE if k in s})
        rev[v] = revdeps(regs, {r: snaps[r] for r in regs.keys() & snaps.keys()})
    meta = {"date": datetime.date.today().isoformat(), "registry": a.registry,
            "snapshot": ident + "; provenance branch " + "; ".join(prov)}
    print(report(meta, cov, stats, examples, rev, unsourced))
    if a.json:
        Path(a.json).write_text(json.dumps({"meta": meta, "coverage": cov, "fields": stats, "reverse_deps": rev,
                                            "no_source": unsourced, "examples": examples}, indent=1, default=dict))


if __name__ == "__main__":
    main()
