#!/usr/bin/env python3
"""Polite BFS spider of the hand-authored (non-/packages/) bioconductor.org page space.
Records every edge (referrer -> target) and the status of every fetched page."""
import re, csv, sys, time, gzip, io, queue, threading
import urllib.request, urllib.error, urllib.parse
from urllib.parse import urljoin, urldefrag, urlsplit

UA = "BioconductorLinkCheck/1.0 (site link-health audit; contact seandavi@gmail.com)"
START = "https://bioconductor.org/"
MAXPAGES = int(sys.argv[1]) if len(sys.argv) > 1 else 700
OUT = "/home/davsean/Documents/git/bioconductor-site/review/data"
WORKERS, DELAY = 4, 0.2

SKIP_PREFIX = ("/packages/", "/checkResults/", "/shields/", "/books/", "/help/bioc-views/")
BIN_EXT = re.compile(r"\.(pdf|zip|tar\.gz|tgz|gz|png|jpe?g|gif|svg|css|js|R|Rmd|Rnw|rda|RData|xlsx?|pptx?|docx?|mp4|ico|txt|sh|py|bib|csv|tsv)$", re.I)
ATTR = re.compile(rb'<a\b[^>]*?href\s*=\s*["\']([^"\'>]+)["\']', re.I)
IMG = re.compile(rb'<(?:img|script)\b[^>]*?src\s*=\s*["\']([^"\'>]+)["\']', re.I)
LINKREL = re.compile(rb'<link\b[^>]*?href\s*=\s*["\']([^"\'>]+)["\']', re.I)

opener = urllib.request.build_opener()

def fetch(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA, "Accept": "text/html,*/*", "Accept-Encoding": "gzip"})
    try:
        r = opener.open(req, timeout=25)
        body = b""
        ct = r.headers.get("Content-Type", "")
        if method == "GET" and "html" in ct:
            body = r.read(600000)
            if r.headers.get("Content-Encoding") == "gzip":
                try: body = gzip.GzipFile(fileobj=io.BytesIO(body)).read()
                except Exception: pass
        return r.status, r.geturl(), ct, body
    except urllib.error.HTTPError as e:
        return e.code, url, e.headers.get("Content-Type", ""), b""
    except Exception as e:
        return f"ERR:{type(e).__name__}", url, "", b""

q = queue.Queue()
q.put((START, "SEED"))
seen = {START}
pages, edges = [], []
lock = threading.Lock()
stop = threading.Event()

def canon(u):
    s = urlsplit(u)
    if s.netloc.lower() == "www.bioconductor.org":
        u = u.replace("://www.bioconductor.org", "://bioconductor.org", 1)
    return u

def crawlable(u):
    s = urlsplit(u)
    if s.netloc.lower() not in ("bioconductor.org", "www.bioconductor.org"): return False
    if s.path.startswith(SKIP_PREFIX): return False
    if BIN_EXT.search(s.path): return False
    return True

def worker():
    while not stop.is_set():
        try: url, ref = q.get(timeout=3)
        except queue.Empty: return
        time.sleep(DELAY)
        st, final, ct, body = fetch(url)
        with lock:
            pages.append((url, str(st), final if final != url else "", ct, ref))
            if len(pages) >= MAXPAGES: stop.set()
        if body:
            links = set()
            for rx in (ATTR, IMG, LINKREL):
                for m in rx.findall(body):
                    try: t = m.decode("utf-8", "replace")
                    except Exception: continue
                    links.add(t)
            for t in links:
                t = t.strip()
                if not t or t.startswith(("#", "mailto:", "javascript:", "data:", "tel:")): continue
                full = canon(urldefrag(urljoin(final or url, t))[0])
                if not full.startswith(("http://", "https://")): continue
                with lock:
                    edges.append((url, t, full))
                    if crawlable(full) and full not in seen and not stop.is_set():
                        seen.add(full); q.put((full, url))
        q.task_done()

ts = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
[t.start() for t in ts]
[t.join() for t in ts]

with open(f"{OUT}/spider2-pages.tsv", "w", newline="") as f:
    w = csv.writer(f, delimiter="\t"); w.writerow(["url","status","final_url","content_type","referrer"])
    w.writerows(pages)
with open(f"{OUT}/spider2-edges.tsv", "w", newline="") as f:
    w = csv.writer(f, delimiter="\t"); w.writerow(["page","raw_link","resolved"])
    w.writerows(sorted(set(edges)))
print(f"pages={len(pages)} edges={len(set(edges))} queued_unique={len(seen)}", file=sys.stderr)
