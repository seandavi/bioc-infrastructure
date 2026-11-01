"""Point the packages' own docs at their new home (ADR 0014): clone/cd
instructions, issue links, CI badges, CITATION. User-Agent strings are left
alone on purpose: log analysis may key on them. Links to old issue numbers in
specs stay too; closed issues remain in the archived repos.
Usage: python3 relink.py <repo-root> <pkg>..."""
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
NEW = "https://github.com/seandavi/bioc-infrastructure"
for pkg in sys.argv[2:]:
    old = f"https://github.com/seandavi/bioc-{pkg}"
    for f in sorted((root / "packages" / pkg).rglob("*")):
        if f.suffix not in (".md", ".cff") or "node_modules" in f.parts:
            continue
        t = f.read_text()
        u = t.replace(f"git clone {old}\ncd bioc-{pkg}\n", f"git clone {NEW}\ncd bioc-infrastructure/packages/{pkg}\n")
        u = re.sub(re.escape(old) + r"/actions/workflows/(\w+)\.yml", rf"{NEW}/actions/workflows/{pkg}-\1.yml", u)
        u = u.replace(f"({old}/issues)", f"({NEW}/issues)")
        u = re.sub(r"^repository-code: " + re.escape(old) + "$", f"repository-code: {NEW}/tree/main/packages/{pkg}", u, flags=re.M)
        for other in ("registry", "edge", "traffic"):
            u = u.replace(f"](https://github.com/seandavi/bioc-{other})", f"](../{other}/)")
        if u != t:
            f.write_text(u)
            print("relinked", f.relative_to(root))
