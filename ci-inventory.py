#!/usr/bin/env python3
"""Generate ci-inventory.md: every active GitHub Actions workflow in the public
bioc-related repos, with a live status badge, its triggers, a link to the yml,
and the yml's leading comment block as the description. Run before `quarto
render` (docs.yml does); needs `gh` authenticated (GH_TOKEN in Actions).
Grouping and per-repo roles are the only hand-maintained part: GROUPS below."""
import base64, json, re, subprocess, sys

OWNER = "seandavi"
# ponytail: hand-kept group map; a repo not listed here is not on the page.
GROUPS = {
    "New system pipeline": ["bioc-manifest", "bioc-build", "bioc-registry",
                            "bioc-edge", "bioc-website", "bioc-infrastructure"],
    "Platform services": ["bioc-intelligence"],
}
TRIGGERS = ("schedule", "push", "pull_request", "workflow_dispatch", "workflow_call",
            "workflow_run", "repository_dispatch", "release")

def gh(*args):
    return json.loads(subprocess.check_output(["gh", "api", *args], text=True))

def head_comment(yml):
    lines, started = [], False
    for ln in yml.splitlines():
        s = ln.strip()
        if s.startswith("name:") and not started:
            continue
        if s.startswith("#"):
            started = True
            lines.append(s.lstrip("#").strip())
        elif started or (s and not s.startswith("#")):
            break
    text = " ".join(l for l in lines if l)
    return text

def triggers(yml):
    found = []
    for t in TRIGGERS:
        if re.search(rf"^\s{{0,4}}{t}:", yml, re.M) or re.search(rf"^on:\s*\[.*\b{t}\b", yml, re.M):
            found.append(t)
    crons = re.findall(r'cron:\s*["\']([^"\']+)["\']', yml)
    return ", ".join(found) + (f" (`{'`, `'.join(crons)}`)" if crons else "")

repos = {r["name"]: r for r in gh("users/%s/repos?per_page=200&type=public" % OWNER, "--paginate")}
group_of = {r: g for g, rs in GROUPS.items() for r in rs}
rows = {}
for name, meta in sorted(repos.items(), key=lambda kv: kv[0].lower()):
    if name not in group_of:
        continue
    try:
        wfs = gh(f"repos/{OWNER}/{name}/actions/workflows")["workflows"]
    except subprocess.CalledProcessError:
        continue
    wfs = [w for w in wfs if w["state"] == "active" and w["path"].startswith(".github/")]
    if not wfs:
        continue
    out = []
    for w in sorted(wfs, key=lambda w: w["path"]):
        yml = base64.b64decode(gh(f"repos/{OWNER}/{name}/contents/{w['path']}")["content"]).decode()
        desc = head_comment(yml) or w["name"]
        if len(desc) > 240:
            desc = desc[:237].rsplit(" ", 1)[0] + "..."
        base = f"https://github.com/{OWNER}/{name}"
        fname = w["path"].rsplit("/", 1)[-1]
        out.append(f"| [`{fname}`]({base}/blob/main/{w['path']}) "
                   f"| [![]({base}/actions/workflows/{fname}/badge.svg)]({base}/actions/workflows/{fname}) "
                   f"| {triggers(yml)} | {desc.replace('|', '/')} |")
    rows.setdefault(group_of[name], []).append((name, meta.get("description") or "", out))

with open("ci-inventory.md", "w") as f:
    for group in GROUPS:
        if group not in rows:
            continue
        f.write(f"## {group}\n\n")
        for name, desc, out in rows[group]:
            f.write(f"### [{name}](https://github.com/{OWNER}/{name})\n\n")
            if desc:
                f.write(f"{desc}\n\n")
            f.write("| Workflow | Status | Triggers | What it does |\n|---|---|---|---|\n")
            f.write("\n".join(out) + "\n\n")
print("wrote ci-inventory.md", sum(len(o) for g in rows.values() for _, _, o in g), "workflows", file=sys.stderr)
