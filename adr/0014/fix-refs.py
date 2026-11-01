"""Rewrite bare #N references in transferred issues so they keep pointing at
what they meant in the source repo: #N -> #<new> if that issue moved too,
else seandavi/<source-repo>#N. Code spans and fenced blocks are left alone.
Only bodies/comments by OWNER are edited. Usage: fix-refs.py MAP [--apply]"""
import csv, json, re, subprocess, sys

OWNER, DEST = "seandavi", "seandavi/bioc-infrastructure"
rows = list(csv.reader(open(sys.argv[1]), delimiter="\t"))
apply = "--apply" in sys.argv
moved = {(r, int(o)): int(n) for r, o, n in rows}
REF = re.compile(r"(?<![\w/#&\]])#(\d+)\b")
CODE = re.compile(r"(```.*?```|`[^`\n]*`)", re.S)

_exists = {}
def exists(repo, n):
    # Issue or PR N in the source repo. A bare ref to a number the source never
    # had was written meaning this repo's numbering; leave it bare.
    if (repo, n) not in _exists:
        r = subprocess.run(["gh", "api", f"repos/{OWNER}/{repo}/issues/{n}", "--jq", ".number"],
                           capture_output=True, text=True)
        _exists[(repo, n)] = r.returncode == 0
    return _exists[(repo, n)]

def fix(text, repo):
    def sub(m):
        n = int(m.group(1))
        if (repo, n) in moved: return f"#{moved[(repo, n)]}"
        return f"{OWNER}/{repo}#{n}" if exists(repo, n) else m.group(0)
    parts = CODE.split(text)
    return "".join(p if i % 2 else REF.sub(sub, p) for i, p in enumerate(parts))

def gh(*a, inp=None):
    return subprocess.run(["gh", "api", *a], input=inp, capture_output=True, text=True, check=True).stdout

total = 0
for repo, old, new in rows:
    iss = json.loads(gh(f"repos/{DEST}/issues/{new}"))
    targets = [("issue", f"repos/{DEST}/issues/{new}", iss["user"]["login"], iss["body"] or "")]
    for c in json.loads(gh(f"repos/{DEST}/issues/{new}/comments", "--paginate")):
        targets.append(("comment", f"repos/{DEST}/issues/comments/{c['id']}", c["user"]["login"], c["body"] or ""))
    for kind, path, who, body in targets:
        out = fix(body, repo)
        if out == body:
            continue
        refs = sorted(set(REF.findall(CODE.sub("", body))), key=int)
        if who != OWNER:
            print(f"SKIP #{new} {kind} by {who}: refs {refs}")
            continue
        total += 1
        print(f"#{new} ({repo}#{old}) {kind}: {', '.join('#'+r for r in refs)}")
        if apply:
            gh("-X", "PATCH", path, "--input", "-", inp=json.dumps({"body": out}))
print(("applied" if apply else "would edit"), total)
