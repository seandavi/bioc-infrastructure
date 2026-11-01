import re, sys, collections
def dcf(path):
    out, cur, key = {}, {}, None
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        if not line.strip():
            if cur.get("Package"): out[cur["Package"]] = cur
            cur, key = {}, None; continue
        if line[0] in " \t" and key: cur[key] += " " + line.strip(); continue
        k, _, v = line.partition(":"); key = k.strip(); cur[key] = v.strip()
    if cur.get("Package"): out[cur["Package"]] = cur
    return out
def vkey(v): return [int(x) for x in re.split(r"[.-]", v) if x.isdigit()]
DEP = ["Depends", "Imports", "LinkingTo", "Suggests"]
norm = lambda s: re.sub(r"\s+", " ", s or "").replace(" ,", ",").strip()
for v in ["3.23", "3.24"]:
    for f in ["src_contrib", "bin_windows_contrib_4.6", "bin_macosx_sonoma-arm64_contrib_4.6", "bin_macosx_big-sur-x86_64_contrib_4.6"]:
        b, r = dcf(f"bioc-{v}-{f}.PACKAGES"), dcf(f"reg-{v}-{f}.PACKAGES")
        only_b, only_r = sorted(set(b) - set(r)), sorted(set(r) - set(b))
        both = set(b) & set(r)
        newer_b = [p for p in both if vkey(b[p]["Version"]) > vkey(r[p]["Version"])]
        newer_r = [p for p in both if vkey(r[p]["Version"]) > vkey(b[p]["Version"])]
        same = [p for p in both if b[p]["Version"] == r[p]["Version"]]
        depdiff = collections.Counter(k for p in same for k in DEP if norm(b[p].get(k)) != norm(r[p].get(k)))
        print(f"{v} {f}: bioc {len(b)} reg {len(r)} | only-bioc {len(only_b)} only-reg {len(only_r)} | same-ver {len(same)} bioc-newer {len(newer_b)} reg-newer {len(newer_r)} | dep-field diffs at same ver {dict(depdiff)}")
        if f == "src_contrib":
            print("   only-bioc e.g.", only_b[:12]); print("   only-reg e.g.", only_r[:8]); print("   bioc-newer e.g.", [(p, b[p]['Version'], r[p]['Version']) for p in sorted(newer_b)[:6]])
            print("   fields bioc-only:", sorted(set().union(*[set(x) for x in b.values()]) - set().union(*[set(x) for x in r.values()])))
    vb, vr = dcf(f"bioc-{v}-VIEWS"), dcf(f"reg-{v}-VIEWS")
    print(f"{v} VIEWS: bioc {len(vb)} reg {len(vr)}; fields missing in reg:", sorted(set().union(*[set(x) for x in vb.values()]) - set().union(*[set(x) for x in vr.values()])))
