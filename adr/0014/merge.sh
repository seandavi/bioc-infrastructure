#!/usr/bin/env bash
# ADR 0014's merge, run in a scratch directory: fresh clones from GitHub,
# each code repo rewritten into packages/<name>/ with history, merged into
# bioc-infrastructure. Touches nothing outside $WORK and pushes nothing, so it
# is both the rehearsal and the real thing: review $WORK/infra, then push it.
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/data/davsean/tmp/merge-rehearsal}
FILTER=(uvx --from git-filter-repo git-filter-repo)
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"

git clone -q https://github.com/seandavi/bioc-infrastructure infra
for name in registry edge traffic; do
  git clone -q --single-branch --branch main "https://github.com/seandavi/bioc-$name" "$name"
  ( cd "$name"
    "${FILTER[@]}" --quiet --force --to-subdirectory-filter "packages/$name" --tag-rename ":$name-" )
  ( cd infra
    git remote add "$name" "../$name" && git fetch -q "$name" --tags
    git merge -q --allow-unrelated-histories --no-edit -m "Merge bioc-$name into packages/$name (ADR 0014)" "$name/main" )
done
cd infra && git log --oneline -1 && git rev-list --count HEAD

# Workflows: hoist package workflows to the root; keep the docs site and
# infra's own tests from running on package-only changes.
python3 -I "$HERE/hoist.py" . registry edge
python3 -I - <<'PY'
import pathlib, re
for f in [".github/workflows/docs.yml", ".github/workflows/test.yml"]:
    p = pathlib.Path(f); t = p.read_text()
    t = re.sub(r"^(  (?:push|pull_request):[ \t]*\n)", r"\1    paths-ignore: ['packages/**']\n", t, flags=re.M)
    p.write_text(t)
PY
git add -A && git commit -q -m "Hoist package workflows to the root, filtered by path (ADR 0014)"

# New checks from ADR 0014: CI for traffic, and the seam rule.
cp "$HERE/traffic-test.yml" .github/workflows/traffic-test.yml
cp "$HERE/check-seams.sh" check-seams.sh
cp "$HERE/seams.yml" .github/workflows/seams.yml
git add -A && git commit -q -m "traffic CI and the seam check (ADR 0014)"
./check-seams.sh && echo "seams: clean"

# Point docs at the new home, and the follow-up edits ADR 0014 lists.
python3 -I "$HERE/relink.py" . registry edge traffic
python3 -I "$HERE/followups.py"

git add -A && git commit -q -m "Follow-ups to the merge (ADR 0014)

Docs, CI inventory and health config point at the merged packages; unit
files run from the ops clone (/data/davsean/bioc-ops/bioc-infrastructure); the registry publish job reads its
secrets from the registry environment; edge's stale copy of the Logpush
check is removed (traffic owns it). adr/0014/issue-map.tsv records the
issue transfer (source repo, old number, new number)."
