exec(open("diff.py").read().split("for v in")[0])
b, r = dcf("bioc-3.23-src_contrib.PACKAGES"), dcf("reg-3.23-src_contrib.PACKAGES")
def parse(s):  # {pkg: constraint}
    out = {}
    for t in [x.strip() for x in (s or "").split(",") if x.strip()]:
        m = re.match(r"([A-Za-z0-9.]+)\s*(\((.*)\))?", t); out[m.group(1)] = re.sub(r"\s+", "", m.group(3) or "")
    return out
kinds = collections.Counter(); ex = {}
for p in set(b) & set(r):
    if b[p]["Version"] != r[p]["Version"]: continue
    for k in DEP:
        pb, pr = parse(b[p].get(k)), parse(r[p].get(k))
        if norm(b[p].get(k)) == norm(r[p].get(k)): continue
        if pb == pr: kind = "formatting only"
        elif set(pb) == set(pr): kind = "same packages, different version constraint"
        else: kind = "different package list"
        kinds[(k, kind)] += 1; ex.setdefault((k, kind), (p, b[p].get(k), r[p].get(k)))
for k, n in sorted(kinds.items()): print(n, k)
for k, e in ex.items():
    if k[1] != "formatting only": print("\n", k, "\n  pkg:", e[0], "\n  bioc:", e[1], "\n  reg: ", e[2])
