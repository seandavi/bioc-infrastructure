#!/usr/bin/env bash
# Tests mirror-sync.sh against a small fake site served from localhost.
# No network beyond 127.0.0.1. Needs python3 (for the web server), jq, curl.
#   ./test-mirror-sync.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'kill $SERVER 2> /dev/null; rm -rf "$T"' EXIT
SITE=$T/site; export DEST=$T/dest STATE=$T/state REPOS="bioc books" MAX_REMOVE=0.25 JOBS=2
mkdir -p "$SITE" "$DEST"
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { local label=$1; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }

# put <path> <content>: a file on the fake site.
put() { mkdir -p "$(dirname "$SITE/$1")"; printf '%s' "$2" > "$SITE/$1"; }
# publish <release> <devel> [extra jq for index.json]: write the manifests and
# index.json for what's on the site now, the way bioconductor.org publishes them.
publish() {
  local r=$1 d=$2 extra=${3:-.} v repo dir m=$SITE/api/v1/manifest mf="[]"
  mkdir -p "$m"
  for v in $r $d; do for repo in bioc books; do
    dir=$SITE/packages/$v/$repo; mkdir -p "$m/$v"
    (cd "$SITE" && find "packages/$v/$repo" -type f -printf '%p\n' 2> /dev/null | sort |
      while read -r p; do printf '%s\t%s\t%s\n' "$p" "$(stat -c %s "$p")" "$(md5sum < "$p" | cut -d' ' -f1)"; done) > "$m/$v/$repo.tsv"
    gzip -f "$m/$v/$repo.tsv"
    mf=$(jq --arg p "$v/$repo.tsv.gz" --argjson n "$(gunzip -c "$m/$v/$repo.tsv.gz" | wc -l)" '. + [{path: $p, objects: $n}]' <<<"$mf")
  done; done
  jq -n --arg r "$r" --arg d "$d" --argjson mf "$mf" '{versions: {release: $r, devel: $d}, manifests: $mf,
    symlinks: {"packages/release": $r, "packages/devel": $d,
               ("packages/" + $r + "/bioc/bin/windows/contrib/4.7"): "4.6",
               "checkResults/devel": "3.99"}}' | jq "$extra" > "$m/index.json"
}
run() { "$HERE/mirror-sync.sh" > "$T/out" 2>&1; }
listing() { (cd "$DEST" && find . -printf '%p %l\n' | sort | md5sum); }

for v in 9.1 9.2; do
  put packages/$v/bioc/src/contrib/PACKAGES $'Package: foo\nVersion: 1.0\n'
  put packages/$v/bioc/src/contrib/foo_1.0.tar.gz "foo-$v"
  put packages/$v/bioc/bin/windows/contrib/4.6/foo_1.0.zip "win-$v"
  put packages/$v/books/src/contrib/PACKAGES $'Package: book\nVersion: 1.0\n'
  put packages/$v/bioc/src/contrib/extra_$v.tar.gz "x"
done
publish 9.1 9.2
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
python3 -m http.server -b 127.0.0.1 -d "$SITE" "$PORT" > /dev/null 2>&1 & SERVER=$!
export BASE=http://127.0.0.1:$PORT
for _ in $(seq 50); do curl -fs "$BASE/api/v1/manifest/index.json" > /dev/null && break; sleep 0.1; done

# Operator's own files: must never be touched.
mkdir -p "$DEST/packages/3.0/bioc"; echo mine > "$DEST/index.html"; echo old > "$DEST/packages/3.0/bioc/old.tar.gz"

echo "== fresh run"
run; check "exits 0" [ $? = 0 ]
check "files copied" cmp -s "$SITE/packages/9.1/bioc/src/contrib/foo_1.0.tar.gz" "$DEST/packages/9.1/bioc/src/contrib/foo_1.0.tar.gz"
check "release symlink resolves" [ "$(cat "$DEST/packages/release/bioc/src/contrib/foo_1.0.tar.gz")" = foo-9.1 ]
check "R-version alias resolves" [ -f "$DEST/packages/9.1/bioc/bin/windows/contrib/4.7/foo_1.0.zip" ]
check "non-packages links skipped" [ ! -e "$DEST/checkResults" ]
check "no .part files left" [ -z "$(find "$DEST" -name '*.part')" ]
if command -v Rscript > /dev/null; then check "R check ran" grep -q 'available.packages() lists 1 packages' "$T/out"; fi

echo "== rerun"
cp "$STATE/manifest.tsv" "$T/m1"
run; check "exits 0" [ $? = 0 ]
check "downloads nothing" grep -q 'downloading 0 files' "$T/out"
check "state doesn't grow" cmp -s "$STATE/manifest.tsv" "$T/m1"

echo "== same-size content change"
put packages/9.1/bioc/src/contrib/foo_1.0.tar.gz "FOO-9.1"; publish 9.1 9.2
run; check "exits 0" [ $? = 0 ]
check "fetched the changed file only" grep -q 'downloading 1 files' "$T/out"
check "new content in place" [ "$(cat "$DEST/packages/9.1/bioc/src/contrib/foo_1.0.tar.gz")" = FOO-9.1 ]

echo "== small removal"
rm "$SITE/packages/9.2/bioc/src/contrib/extra_9.2.tar.gz"; publish 9.1 9.2
run; check "exits 0" [ $? = 0 ]
check "removed from mirror" [ ! -e "$DEST/packages/9.2/bioc/src/contrib/extra_9.2.tar.gz" ]
check "operator's index.html kept" [ -f "$DEST/index.html" ]
check "operator's old release kept" [ -f "$DEST/packages/3.0/bioc/old.tar.gz" ]

echo "== incomplete manifest"
echo stale > "$DEST/packages/9.1/bioc/src/contrib/stale.tar.gz"
before=$(listing)
publish 9.1 9.2 '.manifests[0].objects += 1'
run; check "exits 1" [ $? = 1 ]
check "says incomplete" grep -q 'incomplete download' "$T/out"
check "mirror untouched" [ "$(listing)" = "$before" ]

echo "== failed download"
publish 9.1 9.2
gunzip "$SITE/api/v1/manifest/9.1/bioc.tsv.gz"
printf 'packages/9.1/bioc/src/contrib/gone_1.0.tar.gz\t4\t\n' >> "$SITE/api/v1/manifest/9.1/bioc.tsv"
gzip "$SITE/api/v1/manifest/9.1/bioc.tsv"
jq '.manifests[0].objects += 1' "$SITE/api/v1/manifest/index.json" > "$T/i" && mv "$T/i" "$SITE/api/v1/manifest/index.json"
run; check "exits 1" [ $? = 1 ]
check "reports the failure" grep -q 'fetch failed: packages/9.1/bioc/src/contrib/gone_1.0.tar.gz' "$T/out"
check "nothing removed" [ -f "$DEST/packages/9.1/bioc/src/contrib/stale.tar.gz" ]

echo "== path outside packages/<version>/"
publish 9.1 9.2
gunzip "$SITE/api/v1/manifest/9.1/books.tsv.gz"
printf 'packages/9.1/books/../../../evil\t1\t\n' >> "$SITE/api/v1/manifest/9.1/books.tsv"
gzip "$SITE/api/v1/manifest/9.1/books.tsv"
jq '.manifests[1].objects += 1' "$SITE/api/v1/manifest/index.json" > "$T/i" && mv "$T/i" "$SITE/api/v1/manifest/index.json"
run; check "exits 1" [ $? = 1 ]
check "refuses the path" grep -q 'outside packages' "$T/out"
check "nothing written outside" [ ! -e "$T/evil" ] && [ ! -e "$DEST/evil" ]

echo "== symlink escaping packages/"
publish 9.1 9.2 '.symlinks["packages/escape"] = "../../etc"'
run; check "exits 1" [ $? = 1 ]
check "refuses the link" grep -q 'points outside packages' "$T/out"

echo "== real directory where a symlink belongs"
publish 9.1 9.2
rm "$DEST/packages/devel"; mkdir "$DEST/packages/devel"
run; check "exits 1" [ $? = 1 ]
check "explains" grep -q 'is a real directory' "$T/out"
rmdir "$DEST/packages/devel"

echo "== overlapping runs"
run; check "clean run first" [ $? = 0 ]
( flock 9; sleep 3 ) 9> "$STATE/lock" & holder=$!; sleep 0.5
run; check "second run refused" grep -q 'another run holds' "$T/out"; wait $holder

echo "== release roll"
for f in PACKAGES foo_1.0.tar.gz; do put packages/9.3/bioc/src/contrib/$f "$(cat "$SITE/packages/9.2/bioc/src/contrib/$f")"; done
put packages/9.3/books/src/contrib/PACKAGES $'Package: book\nVersion: 1.0\n'
publish 9.2 9.3
run; check "held: exits 3" [ $? = 3 ]
check "old release still there" [ -d "$DEST/packages/9.1/bioc" ]
check "list written" [ -s "$STATE/remove.txt" ]
check "release link moved" [ "$(readlink "$DEST/packages/release")" = 9.2 ]
run; check "held again without confirmation" [ $? = 3 ]
CONFIRM_REMOVE=1 run; check "confirmed: exits 0" [ $? = 0 ]
check "old release removed" [ ! -e "$DEST/packages/9.1" ]
check "operator's old release still kept" [ -f "$DEST/packages/3.0/bioc/old.tar.gz" ]
check "hold list cleared" [ ! -e "$STATE/remove.txt" ]
run; check "next run clean" [ $? = 0 ] && grep -q 'removed 0 files' "$T/out"

[ $fail = 0 ] && echo "mirror-sync: all checks pass" || { echo "--- last output:"; cat "$T/out"; }
exit $fail
