"""The merge's follow-up edits to bioc-infrastructure's own files (ADR 0014).
Run from the merged repo root. Each edit asserts it matched, so a drifted
source fails loudly instead of being half-edited."""
import pathlib, re

OPS = "/data/davsean/bioc-ops/bioc-infrastructure"
NEW = "https://github.com/seandavi/bioc-infrastructure"

def edit(path, old, new, count=1):
    p = pathlib.Path(path); t = p.read_text()
    assert t.count(old) >= 1, f"{path}: not found: {old[:60]!r}"
    p.write_text(t.replace(old, new) if count == 0 else t.replace(old, new, count))

# 1. The publish job reads its secrets from the `registry` environment.
edit(".github/workflows/registry-publish.yml",
     "  publish:\n    runs-on: ubuntu-latest\n",
     "  publish:\n    runs-on: ubuntu-latest\n    environment: registry\n")

# 2. Unit files run from the ops clone, not the dev checkouts (#43).
for f in sorted(pathlib.Path("packages").glob("*/systemd/*")):
    t = f.read_text()
    u = re.sub(r"/home/davsean/Documents/git/bioc-(edge|traffic)\b", rf"{OPS}/packages/\1", t)
    if u != t:
        f.write_text(u)

# 3. edge's copy of the Logpush check predates the move to traffic; the
#    installed unit has run traffic's copy since bioc-traffic took it over.
for f in ["packages/edge/check-logpush.sh", "packages/edge/systemd/bioc-logpush-check.service",
          "packages/edge/systemd/bioc-logpush-check.timer"]:
    pathlib.Path(f).unlink()
p = pathlib.Path("packages/edge/systemd/README.md")
p.write_text("".join(l for l in p.read_text().splitlines(True) if not l.startswith("| `bioc-logpush-check`")))

# 4. Health: one tracker, archived repos gone, logs in the ops clone.
edit("health/config.toml",
     'repos = ["bioc-edge", "bioc-traffic", "bioc-infrastructure", "bioc-registry",\n         "bioc-website", "bioc-build", "bioc-manifest", "bioc-intelligence"]',
     'repos = ["bioc-infrastructure", "bioc-website", "bioc-build", "bioc-manifest",\n         "bioc-intelligence"]')
edit("health/config.toml",
     '# Where bioc-notify@ (bioc-edge/notify-failure.sh) files "<unit> is failing" issues.\nfailure_issue_repo = "bioc-edge"',
     '# Where bioc-notify@ (packages/edge/notify-failure.sh) files "<unit> is failing" issues.\nfailure_issue_repo = "bioc-infrastructure"')
edit("health/config.toml", 'log_globs = ["~/Documents/git/bioc-edge/sync-*.log*"]',
     f'log_globs = ["{OPS}/packages/edge/sync-*.log*"]')

# 5. CI inventory: registry and edge workflows are this repo's now.
edit("ci-inventory.py",
     '"New system pipeline": ["bioc-registry", "bioc-edge", "bioc-website", "bioc-infrastructure"],',
     '"New system pipeline": ["bioc-infrastructure", "bioc-website"],')

# 6. Docs: links to workflows and files of the merged repos, and the prose
#    that described dev checkouts and per-repo trackers. ADRs are records; skip.
docs = [p for p in pathlib.Path(".").glob("*.qmd")] + [pathlib.Path("README.md")]
for p in docs:
    t = p.read_text()
    u = re.sub(r"https://github\.com/seandavi/bioc-(registry|edge)/actions/workflows/(\w+)\.yml",
               rf"{NEW}/actions/workflows/\1-\2.yml", t)
    u = re.sub(r"https://github\.com/seandavi/bioc-(registry|edge|traffic)/(blob|tree)/main/",
               rf"{NEW}/\2/main/packages/\1/", u)
    u = re.sub(r"\]\(https://github\.com/seandavi/bioc-(registry|edge|traffic)\)",
               rf"]({NEW}/tree/main/packages/\1)", u)
    if u != t:
        p.write_text(u)

edit("ci.qmd",
     "All of them run on that one host, mostly from development checkouts of their repos (`bioc-site-refresh` uses its own clone of main) (for example\n"
     "`~/Documents/git/bioc-edge`); moving them to separate operations checkouts is planned in\n"
     "[bioc-infrastructure#43](https://github.com/seandavi/bioc-infrastructure/issues/43).",
     f"All of them run on that one host, from operations clones of `main`, not development\n"
     f"checkouts: `{OPS}` for the edge and traffic units, and `bioc-site-refresh`'s own clone of\n"
     f"bioc-website ([#43](https://github.com/seandavi/bioc-infrastructure/issues/43), ADR 0014).")
edit("ci.qmd", f"[`bioc-logpush-check`]({NEW}/blob/main/packages/edge/systemd/bioc-logpush-check.service) | bioc-edge |",
     f"[`bioc-logpush-check`]({NEW}/blob/main/packages/traffic/systemd/bioc-logpush-check.service) | traffic |")
edit("packages/registry/docs/DATAPLANE.md",
     "| bioc-registry | observations, jobs parquet, prop index + CAS, PACKAGES/VIEWS, GHA logs | this repo |",
     "| bioc-registry | observations, jobs parquet, prop index + CAS, PACKAGES/VIEWS, GHA logs | bioc-infrastructure `packages/registry` |")
edit("packages/registry/docs/DATAPLANE.md",
     "| private infra repo (ingestion is bound to private logging config) |",
     "| bioc-infrastructure `packages/traffic` |")
edit("packages/registry/docs/DATAPLANE.md",
     "| published from pipeline runs (bioconductor-website) |",
     "| bioc-website (`ops/refresh-content.sh`, `ops/refresh-packages.sh`) |")
edit("operations.qmd", "running from the dev checkout `~/Documents/git/bioc-edge`",
     f"running from the ops clone `{OPS}/packages/edge`")
edit("operations.qmd", "A GitHub issue in bioc-edge titled", "A GitHub issue in bioc-infrastructure titled")
edit("operations.qmd", "from `~/Documents/git/bioc-traffic`", f"from `{OPS}/packages/traffic`")
edit("operations.qmd", "The same `bioc-notify@` issue in bioc-edge", "The same `bioc-notify@` issue in bioc-infrastructure")

edit("README.md",
     "The rendered site is the point — this repo is its source. It is deliberately\n"
     "separate from the repos it documents, so that no one of them is the privileged\n"
     "place where the estate gets described.",
     "The rendered site is the point. Since [ADR 0014](adr/0014-one-platform-repo-the-website-build-and-manifest-stay-separate.md)\n"
     "this repo also holds the platform's code: `packages/registry`, `packages/edge` and\n"
     "`packages/traffic`, with one issue tracker for all of it. bioc-website, bioc-build and\n"
     "bioc-manifest stay separate repos.")
print("follow-ups applied")
