#!/usr/bin/env python3
"""Extract every href/src from the hand-authored content/ tree."""
import os, re, csv, sys
from urllib.parse import urljoin, urldefrag

ROOT = "/data/davsean/tmp/claude-1727698091/-home-davsean-Documents-git-bioconductor-site/8d4d4ef5-3e99-45d1-98c8-ac3e6574a4a9/scratchpad/bioc-site-src"
CONTENT = os.path.join(ROOT, "content")
OUT = "/home/davsean/Documents/git/bioconductor-site/review/data"

ATTR = re.compile(r'(?:href|src)\s*=\s*["\']([^"\'>]+)["\']', re.I)
MD = re.compile(r'\]\(\s*(<?[^)\s]+)>?\s*(?:"[^"]*")?\)')
MDREF = re.compile(r'^\s*\[[^\]]+\]:\s*(\S+)', re.M)
BARE = re.compile(r'(?<![\w"\'=(<])(https?://[^\s<>"\'`\])}]+)')

rows = []
for dirpath, _, files in os.walk(CONTENT):
    for fn in files:
        if not fn.endswith((".html", ".md", ".markdown", ".yaml", ".xml")):
            continue
        p = os.path.join(dirpath, fn)
        rel = os.path.relpath(p, ROOT)
        try:
            txt = open(p, encoding="utf-8", errors="replace").read()
        except Exception as e:
            print("ERR", p, e, file=sys.stderr); continue
        found = set()
        if fn.endswith((".html", ".xml")):
            found |= set(ATTR.findall(txt))
        if fn.endswith((".md", ".markdown")):
            found |= set(m.strip("<>") for m in MD.findall(txt))
            found |= set(MDREF.findall(txt))
            found |= set(ATTR.findall(txt))
        found |= set(BARE.findall(txt))
        for u in found:
            u = u.strip().rstrip('.,;')
            if not u or u.startswith(("#", "mailto:", "javascript:", "data:", "<%")):
                continue
            if "<%" in u or "<#" in u:   # erb templating, unresolvable statically
                continue
            rows.append((rel, u))

# derive the live URL each content file maps to
def site_url(rel):
    p = rel[len("content/"):]
    p = re.sub(r"\.(html|md|markdown)$", "", p)
    if p.endswith("index"):
        p = p[:-5]
    return "https://bioconductor.org/" + p + ("/" if p and not p.endswith("/") else "")

resolved = []
for rel, u in rows:
    base = site_url(rel)
    if u.startswith("//"):
        full = "https:" + u
    elif re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", u):
        full = u
    else:
        full = urljoin(base, u)
    full = urldefrag(full)[0]
    if not full.startswith(("http://", "https://")):
        continue
    resolved.append((rel, base, u, full))

with open(os.path.join(OUT, "content-links-all.tsv"), "w", newline="") as f:
    w = csv.writer(f, delimiter="\t")
    w.writerow(["source_file", "source_page_url", "raw_link", "resolved_url"])
    w.writerows(sorted(set(resolved)))

BIOC = re.compile(r"(^|\.)(bioconductor\.org|bioconductor\.riken\.jp)$", re.I)
def host(u):
    m = re.match(r"https?://([^/:]+)", u)
    return m.group(1).lower() if m else ""

ext = sorted({r[3] for r in resolved if not BIOC.search(host(r[3]))})
intl = sorted({r[3] for r in resolved if BIOC.search(host(r[3]))})
open(os.path.join(OUT, "external-urls.txt"), "w").write("\n".join(ext) + "\n")
open(os.path.join(OUT, "internal-urls-from-content.txt"), "w").write("\n".join(intl) + "\n")

from collections import Counter
hosts = Counter(host(u) for u in ext)
with open(os.path.join(OUT, "external-hosts.tsv"), "w", newline="") as f:
    w = csv.writer(f, delimiter="\t"); w.writerow(["host", "n_urls"])
    w.writerows(hosts.most_common())

print(f"files scanned, links: {len(resolved)}  unique external: {len(ext)}  unique internal: {len(intl)}  hosts: {len(hosts)}")
