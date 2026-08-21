#!/usr/bin/env python3
"""Polite link checker. HEAD first, GET fallback. Records redirect chain + title."""
import os, sys, csv, ssl, socket, time, re, threading, gzip, io
import urllib.request, urllib.error
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor

UA = "BioconductorLinkCheck/1.0 (site link-health audit; contact seandavi@gmail.com)"
TIMEOUT = 12
MAXHOPS = 8

infile, outfile = sys.argv[1], sys.argv[2]
CONCURRENCY = int(sys.argv[3]) if len(sys.argv) > 3 else 4
DELAY = float(sys.argv[4]) if len(sys.argv) > 4 else 0.15
WANT_BODY = "--body" in sys.argv

ctx = ssl.create_default_context()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

opener = urllib.request.build_opener(NoRedirect)

# per-host semaphore: cap concurrent requests to any single host
PER_HOST = int(sys.argv[5]) if len(sys.argv) > 5 else 2
host_locks = {}
hl_lock = threading.Lock()
def lock_for(h):
    with hl_lock:
        return host_locks.setdefault(h, threading.Semaphore(PER_HOST))

def one(url, method):
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip"})
    try:
        r = opener.open(req, timeout=TIMEOUT)
        return r.status, dict(r.headers), r
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e
    except urllib.error.URLError as e:
        r = e.reason
        if isinstance(r, ssl.SSLError) or isinstance(r, ssl.SSLCertVerificationError):
            return "TLS_ERROR", {"err": str(r)}, None
        if isinstance(r, socket.gaierror):
            return "DNS_FAIL", {"err": str(r)}, None
        if isinstance(r, socket.timeout):
            return "TIMEOUT", {"err": str(r)}, None
        return "CONN_ERROR", {"err": str(r)}, None
    except socket.timeout:
        return "TIMEOUT", {"err": "timeout"}, None
    except Exception as e:
        return "ERROR", {"err": f"{type(e).__name__}: {e}"}, None

TITLE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)

def check(url):
    chain, cur, title, note = [], url, "", ""
    method = "HEAD"
    final_status = None
    for hop in range(MAXHOPS):
        h = urlsplit(cur).netloc.lower()
        with lock_for(h):
            time.sleep(DELAY)
            status, hdrs, resp = one(cur, method)
        if status == 405 or status == 501 or (isinstance(status, int) and status in (403, 400) and method == "HEAD"):
            method = "GET"
            with lock_for(h):
                time.sleep(DELAY)
                status, hdrs, resp = one(cur, "GET")
        if isinstance(status, int) and 300 <= status < 400 and hdrs.get("Location"):
            chain.append(f"{status}->{hdrs['Location']}")
            nxt = urllib.parse.urljoin(cur, hdrs["Location"])
            if resp is not None:
                try: resp.close()
                except Exception: pass
            if nxt == cur:
                final_status, note = status, "redirect loop"; break
            cur = nxt
            continue
        final_status = status
        if WANT_BODY and isinstance(status, int) and resp is not None:
            try:
                if method == "HEAD":
                    with lock_for(urlsplit(cur).netloc.lower()):
                        time.sleep(DELAY)
                        s2, h2, r2 = one(cur, "GET")
                    if r2 is not None: resp, hdrs = r2, h2
                raw = resp.read(20000)
                if hdrs.get("Content-Encoding") == "gzip":
                    try: raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                    except Exception: pass
                m = TITLE.search(raw)
                if m:
                    title = re.sub(r"\s+", " ", m.group(1).decode("utf-8", "replace")).strip()[:160]
            except Exception as e:
                note = f"body:{type(e).__name__}"
        if resp is not None:
            try: resp.close()
            except Exception: pass
        break
    else:
        final_status, note = "TOO_MANY_REDIRECTS", ""
    return (url, str(final_status), str(len(chain)), " | ".join(chain)[:600],
            cur if cur != url else "", hdrs.get("Content-Type", "") if isinstance(hdrs, dict) else "",
            title, note)

urls = [l.strip() for l in open(infile) if l.strip()]
lock = threading.Lock()
done = [0]
f = open(outfile + ".part", "w", newline="")
w = csv.writer(f, delimiter="\t")
w.writerow(["url", "status", "n_redirects", "redirect_chain", "final_url", "content_type", "title", "note"])
def run(u):
    try:
        row = check(u)
    except Exception as e:
        row = (u, "CHECKER_ERROR", "0", "", "", "", "", f"{type(e).__name__}: {e}")
    with lock:
        w.writerow(row); done[0] += 1
        if done[0] % 100 == 0:
            f.flush(); print(f"  {done[0]}/{len(urls)}", file=sys.stderr, flush=True)
with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
    list(ex.map(run, urls))
f.close()
os.replace(outfile + ".part", outfile)
print(f"done {done[0]} -> {outfile}", file=sys.stderr)
