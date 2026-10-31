"""Move packages/<pkg>/.github/workflows/*.yml to the root .github/workflows/
as <pkg>-<name>.yml, so GitHub runs them from the merged repo:
  - workflow name gets the package prefix ("registry / test")
  - run steps default to packages/<pkg>; step-level working-directory is
    re-rooted there too (it is relative to the workspace, not to defaults)
  - push / pull_request triggers only fire for that package's paths
  - setup-node's npm cache finds the package's lockfile
Text edits, not a YAML round-trip, so comments and layout survive.
Usage: python3 hoist.py <repo-root> <pkg>..."""
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
for pkg in sys.argv[2:]:
    src = root / "packages" / pkg / ".github" / "workflows"
    for f in sorted(src.glob("*.yml")):
        t = f.read_text()
        t = re.sub(r"^name: (.+)$", rf"name: {pkg} / \1", t, count=1, flags=re.M)
        paths = f"    paths: ['packages/{pkg}/**', '.github/workflows/{pkg}-*.yml']\n"
        # "  pull_request:" / "  push:" at trigger level, with or without nested keys
        t = re.sub(r"^(  (?:push|pull_request):[ \t]*\n)", lambda m: m.group(1) + paths, t, flags=re.M)
        t = re.sub(r"^(\s+)working-directory: (?!packages/)(\S+)", rf"\1working-directory: packages/{pkg}/\2", t, flags=re.M)
        t = re.sub(r"^(\s+)cache: npm\s*$", rf"\1cache: npm\n\1cache-dependency-path: packages/{pkg}/package-lock.json", t, flags=re.M)
        assert "\ndefaults:" not in t, f"{f}: already has defaults"
        t = re.sub(r"^jobs:", f"defaults:\n  run:\n    working-directory: packages/{pkg}\n\njobs:", t, count=1, flags=re.M)
        dest = root / ".github" / "workflows" / f"{pkg}-{f.name}"
        assert not dest.exists(), dest
        dest.write_text(t)
        f.unlink()
    for d in (src, src.parent):
        if d.exists() and not any(d.iterdir()):
            d.rmdir()
    print(pkg, "hoisted")
