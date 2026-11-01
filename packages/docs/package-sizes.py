#!/usr/bin/env python3
"""Size audit of the Bioconductor package corpus, per repo.

Backs data-packages-in-r-universe.qmd. Reports source tarball sizes, git mirror
sizes and coverage, and release-to-release churn, for the repos r-universe-org/sync#8
proposes to ingest.

    python3 package-sizes.py            # full report
    python3 package-sizes.py --test     # parser self-check, no network

Needs only the stdlib plus `gh` (authenticated) for the GitHub mirror listing.
Sizes come from a mirror's Apache index rather than HEAD requests against
bioconductor.org, which rate-limits at a few hundred requests.
"""

import gzip
import json
import re
import statistics
import subprocess
import sys
import urllib.request
from collections import defaultdict

BIOC = "https://bioconductor.org/packages/release"
MIRROR = "https://ftp.gwdg.de/pub/misc/bioconductor/packages/release"
REPOS = ["bioc", "data/experiment", "data/annotation", "workflows", "books"]
MB = 1024**2
GB = 1024**3
LIMIT = 100 * MB  # r-universe per-package limit, per r-universe-org/sync#8

# Apache autoindex row: <a href="pkg_1.2.3.tar.gz">...</a>  date  time  bytes
INDEX_ROW = re.compile(r'<a href="([^"/]+?)_([0-9.]+)\.tar\.gz">[^<]*</a>\s+\S+\s+\S+\s+(\d+)')


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def manifest(repo):
    """(package, version) for every package in a release repo, from PACKAGES.gz."""
    txt = gzip.decompress(get(f"{BIOC}/{repo}/src/contrib/PACKAGES.gz")).decode("utf-8", "replace")
    out = []
    for stanza in txt.split("\n\n"):
        d = dict(re.findall(r"^(Package|Version):\s*(.+)$", stanza, re.M))
        if "Package" in d and "Version" in d:
            out.append((d["Package"], d["Version"].strip()))
    return out


def index(repo):
    """{package: {version: bytes}} from the mirror's directory listing."""
    html = get(f"{MIRROR}/{repo}/src/contrib/").decode("utf-8", "replace")
    sizes = defaultdict(dict)
    for pkg, ver, n in INDEX_ROW.findall(html):
        sizes[pkg][ver] = int(n)
    return sizes


def mirror_sizes():
    """{repo_name: bytes} for every repo in github.com/bioc (the r-universe mirror org)."""
    out = subprocess.run(
        ["gh", "api", "--paginate", "-X", "GET", "orgs/bioc/repos",
         "-f", "per_page=100", "--jq", ".[]|[.name,.size]|@tsv"],
        capture_output=True, text=True, check=True).stdout
    return {n: int(kb) * 1024 for n, kb in
            (line.split("\t") for line in out.splitlines() if "\t" in line)}


def fmt(n):
    return f"{n / GB:.2f} GiB" if n >= GB else f"{n / MB:.1f} MiB"


def report():
    git = mirror_sizes()
    print(f"github.com/bioc mirror org: {len(git)} repos\n")

    for repo in REPOS:
        pkgs = manifest(repo)
        idx = index(repo)
        cur = {p: idx[p][v] for p, v in pkgs if v in idx.get(p, {})}
        if len(cur) != len(pkgs):
            print(f"!! {repo}: {len(pkgs) - len(cur)} packages absent from mirror index")
        s = sorted(cur.values())
        over = {p: n for p, n in cur.items() if n > LIMIT}
        missing = [p for p in cur if p not in git]

        print(f"=== {repo}: {len(s)} packages, {fmt(sum(s))} of source")
        print(f"    median {fmt(statistics.median(s))}  mean {fmt(sum(s) / len(s))}  max {fmt(max(s))}")
        print(f"    over {LIMIT // MB} MiB: {len(over)} ({100 * len(over) / len(s):.0f}%), "
              f"holding {100 * sum(over.values()) / sum(s):.0f}% of bytes")
        print(f"    no github.com/bioc mirror: {len(missing)} "
              f"(of which over-limit: {sum(1 for p in missing if p in over)})")

        g = [git[p] for p in cur if p in git]
        if g:
            print(f"    git mirrors: {fmt(sum(g))} total, max {fmt(max(g))}, "
                  f"{sum(1 for x in g if x > LIMIT)} over {LIMIT // MB} MiB")

        # Churn: current tarball vs the previous release version, both in the index.
        stable = comparable = 0
        for p, v in pkgs:
            vs = sorted(idx.get(p, {}), key=lambda x: tuple(int(i) for i in x.split(".")))
            if len(vs) < 2 or v not in idx.get(p, {}):
                continue
            comparable += 1
            prev, now = idx[p][vs[-2]], idx[p][vs[-1]]
            if abs(now - prev) / max(prev, 1) < 0.01:
                stable += 1
        if comparable:
            print(f"    unchanged (<1% size drift) across last release bump: "
                  f"{stable}/{comparable} ({100 * stable / comparable:.0f}%)")

        keep = {p: n for p, n in cur.items() if n <= LIMIT and p in git}
        print(f"    would land in a universe: {len(keep)} packages, {fmt(sum(keep.values()))} "
              f"source, ~{fmt(9 * sum(keep.values()))} with 8 binaries each")
        if missing:
            shown = sorted(missing)[:40]
            tail = f" (+{len(missing) - 40} more)" if len(missing) > 40 else ""
            print(f"    missing mirrors: {', '.join(shown)}{tail}")
        print()


def test():
    rows = INDEX_ROW.findall(
        '<a href="ALLMLL_1.52.0.tar.gz">ALLMLL_1.52.0.tar.gz</a> 04-Nov-2025 20:30  26861598\n'
        '<a href="pd.atdschip.tiling_0.44.0.tar.gz">x</a> 01-Jan-2026 00:00  123\n'
        '<a href="PACKAGES.gz">PACKAGES.gz</a> 01-Jan-2026 00:00  456\n')
    assert rows == [("ALLMLL", "1.52.0", "26861598"),
                    ("pd.atdschip.tiling", "0.44.0", "123")], rows
    assert fmt(3 * GB) == "3.00 GiB" and fmt(10 * MB) == "10.0 MiB"
    print("ok")


if __name__ == "__main__":
    test() if "--test" in sys.argv else report()
