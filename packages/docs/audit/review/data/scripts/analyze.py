#!/usr/bin/env python3
"""Classify link-check results and join them back to referring source files."""
import csv, sys, re, collections

D = "/home/davsean/Documents/git/bioconductor-site/review/data/"
res_file = sys.argv[1]

ref = collections.defaultdict(set)
for r in csv.reader(open(D + "content-links-all.tsv"), delimiter="\t"):
    if len(r) < 4 or r[0] == "source_file":
        continue
    ref[r[3]].add(r[0])
for r in csv.reader(open(D + "config-layout-links.tsv"), delimiter="\t"):
    if len(r) < 2 or r[0] == "source_file":
        continue
    ref[r[1]].add(r[0])
for r in csv.reader(open(D + "spider2-edges.tsv"), delimiter="\t"):
    if len(r) < 3 or r[0] == "page":
        continue
    ref[r[2]].add("LIVE:" + r[0])

ARCHIVE = re.compile(r"content/(help/course-materials/|news/|help/newsletters/)")
SOFT404 = re.compile(r"(404|not found|page (?:not|no longer) (?:found|exists)|"
                     r"domain (?:is )?for sale|this domain|parked|buy this domain|"
                     r"account suspended|site not found|coming soon|under construction)", re.I)

rows = [r for r in csv.reader(open(res_file), delimiter="\t")][1:]
out = []
for r in rows:
    if len(r) < 8:
        continue
    url, status, nred, chain, final, ctype, title, note = r[:8]
    srcs = sorted(ref.get(url, set()))
    live = [s for s in srcs if s.startswith("LIVE:")]
    files = [s for s in srcs if not s.startswith("LIVE:")]
    archival = bool(files) and all(ARCHIVE.search(f) for f in files) and not live
    if status in ("404", "410"):
        cls = "hard_404"
    elif status.startswith("5"):
        cls = "server_5xx"
    elif status == "DNS_FAIL":
        cls = "dead_host_dns"
    elif status == "TLS_ERROR":
        cls = "tls_error"
    elif status in ("TIMEOUT", "CONN_ERROR", "ERROR", "TOO_MANY_REDIRECTS"):
        cls = "unreachable"
    elif status in ("403", "401", "429"):
        cls = "blocked_" + status
    elif status == "200" and title and SOFT404.search(title):
        cls = "soft_404_suspect"
    elif status == "200" and url.startswith("http://"):
        cls = "ok_http_only" if not chain else "ok_http_to_https"
    elif status == "200" and int(nred or 0) > 2:
        cls = "ok_long_redirect"
    elif status == "200" and url.startswith("http://"):
        cls = "ok_http"
    else:
        cls = "ok"
    out.append([cls, url, status, nred, chain, final, title, note,
                "archival" if archival else ("live" if live else "content"),
                "; ".join(files[:4]), "; ".join(s[5:] for s in live[:3])])

out.sort(key=lambda x: (x[0], x[1]))
with open(D + "external-classified.tsv", "w", newline="") as f:
    w = csv.writer(f, delimiter="\t")
    w.writerow(["class", "url", "status", "n_redirects", "redirect_chain", "final_url",
                "title", "note", "context", "source_files", "live_referrers"])
    w.writerows(out)

c = collections.Counter(x[0] for x in out)
print("total checked:", len(out))
for k, v in c.most_common():
    print(f"{v:6d}  {k}")
print("\n--- non-archival breakage (the actionable set) ---")
c2 = collections.Counter(x[0] for x in out if x[8] != "archival"
                         and x[0] in ("hard_404", "dead_host_dns", "tls_error", "unreachable", "server_5xx", "soft_404_suspect"))
for k, v in c2.most_common():
    print(f"{v:6d}  {k}")
