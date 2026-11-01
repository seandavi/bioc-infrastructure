exec(open("diff.py").read().split("for v in")[0])
import json
BAD = {"ERROR", "FAIL", "FAILURE"}
PLAT = {"bin_windows_contrib_4.6": ("win", "windows-release-x86_64", "x86_64"),
        "bin_macosx_sonoma-arm64_contrib_4.6": ("mac", "macos-release-arm64", "arm64"),
        "bin_macosx_big-sur-x86_64_contrib_4.6": ("mac", "macos-release-arm64", "x86_64")}
tot = collections.Counter()
for v, u in [("3.23", "bioc-release"), ("3.24", "bioc")]:
    idx = json.load(open(f"idx-{u}.json")); obs = {p["Package"]: p for p in json.load(open(f"obs-{u}.json"))}
    bs = dcf(f"bioc-{v}-src_contrib.PACKAGES")
    for f, (fam, gcfg, arch) in PLAT.items():
        b, r = dcf(f"bioc-{v}-{f}.PACKAGES"), dcf(f"reg-{v}-{f}.PACKAGES")
        why = collections.defaultdict(list)
        for p in sorted(set(b) - set(r)):
            e, o = idx.get(p), obs.get(p, {})
            stale = p in bs and b[p]["Version"] != bs[p]["Version"]
            tag = " [bioc.org binary older than its source]" if stale else ""
            if not e: k = "A. not in registry (not on bioc.org src either)" if p not in bs else "A. not in registry"
            elif e.get("origin") == "bioconductor": k = "B. seed: bioc.org binary didn't match source version at seed time"
            elif e.get("origin") == "bioc-build": k = "bioc-build"
            else:
                same = o.get("Version") == e["version"]
                chk = next((j.get("check") for j in o.get("_jobs", []) if j["config"] == gcfg and str(j.get("r","")).startswith("4.6")), None)
                if fam not in (e.get("archs") or []):
                    if not same: k = "C?. withheld at publication; r-universe has since moved to a newer version"
                    elif chk in BAD or chk is None: k = f"C. gate withheld: {fam} check {chk} (by design)"
                    else: k = f"D. gate withheld at publication, same version now passes ({chk}); never re-evaluated"
                else: k = "E. family passed but binary absent at publication time; never re-added"
            why[k + tag].append(p)
        for k, ps in why.items(): tot[(v, k)] += len(ps)
        print(f"== {v} {f}: {len(set(b)-set(r))} missing")
        for k, ps in sorted(why.items()): print(f"   {len(ps):3d} {k}: {ps[:4]}")
