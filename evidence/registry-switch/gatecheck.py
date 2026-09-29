# Ask the registry's read-only POST /gate whether r-universe's current build of
# each package would propagate, and which rule blocks it.
# Usage: python3 gatecheck.py <universe> <pkg>...   (needs obs-<universe>.json; see README)
import json, sys, urllib.request
FIELDS = ["Depends", "Imports", "LinkingTo", "Suggests", "Enhances", "License", "NeedsCompilation"]
u, ps = sys.argv[1], sys.argv[2:]
obs = {p["Package"]: p for p in json.load(open(f"obs-{u}.json"))}
cands = []
for p in ps:
    o = obs.get(p, {})
    if not o.get("Version"):
        print(f"{p}: no successful r-universe build; last failure {(o.get('_failure') or {}).get('version')}"); continue
    cands.append({"package": p, "version": o["Version"], "build_status": o.get("_status", ""),
                  "jobs": [{k: j.get(k) for k in ("config", "r", "check")} for j in o.get("_jobs", [])],
                  "desc": {k: o[k] for k in FIELDS if o.get(k)}})
req = urllib.request.Request("https://bioc-registry.seandavi.workers.dev/gate", method="POST",
    data=json.dumps({"universe": u, "candidates": cands}).encode(),
    headers={"content-type": "application/json", "user-agent": "curl/8"})
for p, d in json.load(urllib.request.urlopen(req))["decisions"].items():
    fails = [f"{r['rule']}: {r.get('detail', '')}" for r in d["reasons"] if not r["ok"]]
    print(f"{p}: {'propagates' if d['propagate'] else 'blocked by ' + '; '.join(fails)}")
