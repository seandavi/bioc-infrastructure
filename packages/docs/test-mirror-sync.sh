#!/usr/bin/env bash
# Tests mirror-sync.sh against a small fake site served from localhost.
# No network beyond 127.0.0.1. Needs python3 (for the web server), jq, curl, rclone.
#   ./test-mirror-sync.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'kill $SERVER 2> /dev/null; rm -rf "$T"' EXIT
SITE=$T/site; export DEST=$T/dest REPOS="bioc books"
mkdir -p "$SITE" "$DEST"
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { local label=$1; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }

# put <path> <content>: a file on the fake site.
put() { mkdir -p "$(dirname "$SITE/$1")"; printf '%s' "$2" > "$SITE/$1"; }
# publish [extra jq for index.json]: manifests and index.json for 9.1/9.2, as bioconductor.org publishes them.
publish() {
  local extra=${1:-.} v repo m=$SITE/api/v1/manifest
  for v in 9.1 9.2; do for repo in bioc books; do
    mkdir -p "$m/$v"
    (cd "$SITE" && find "packages/$v/$repo" -type f | sort |
      while read -r p; do printf '%s\t%s\t%s\n' "$p" "$(wc -c < "$p")" x; done) | gzip > "$m/$v/$repo.tsv.gz"
  done; done
  jq -n '{versions: {release: "9.1", devel: "9.2"},
    symlinks: {"packages/release": "9.1", "packages/devel": "9.2",
               "packages/9.1/bioc/bin/windows/contrib/4.7": "4.6",
               "packages/2.0/bioc/old": "../../../etc",
               "checkResults/devel": "3.99"}}' | jq "$extra" > "$m/index.json"
}
run() { "$HERE/mirror-sync.sh" > "$T/out" 2>&1; }

for v in 9.1 9.2; do
  put packages/$v/bioc/src/contrib/PACKAGES $'Package: foo\nVersion: 1.0\n'
  put packages/$v/bioc/src/contrib/foo_1.0.tar.gz "foo-$v"
  put packages/$v/bioc/bin/windows/contrib/4.6/foo_1.0.zip "win-$v"
  put packages/$v/books/src/contrib/PACKAGES $'Package: book\nVersion: 1.0\n'
done
publish
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
python3 -m http.server -b 127.0.0.1 -d "$SITE" "$PORT" > /dev/null 2>&1 & SERVER=$!
export BASE=http://127.0.0.1:$PORT
for _ in $(seq 50); do curl -fs "$BASE/api/v1/manifest/index.json" > /dev/null && break; sleep 0.1; done
echo mine > "$DEST/index.html"

echo "== fresh run"
run; check "exits 0" [ $? = 0 ]
check "files copied" cmp -s "$SITE/packages/9.2/bioc/src/contrib/foo_1.0.tar.gz" "$DEST/packages/9.2/bioc/src/contrib/foo_1.0.tar.gz"
check "release symlink resolves" [ "$(cat "$DEST/packages/release/bioc/src/contrib/foo_1.0.tar.gz")" = foo-9.1 ]
check "R-version alias resolves" [ -f "$DEST/packages/9.1/bioc/bin/windows/contrib/4.7/foo_1.0.zip" ]
check "old-version and non-packages links skipped" [ ! -e "$DEST/packages/2.0" ] && [ ! -e "$DEST/checkResults" ]

echo "== rerun"
run; check "exits 0" [ $? = 0 ]
check "copies nothing" bash -c '! grep -q "Copied" "$1"' _ "$T/out"

echo "== never deletes"
rm "$SITE/packages/9.2/bioc/src/contrib/foo_1.0.tar.gz"; publish
run; check "exits 0" [ $? = 0 ]
check "file kept" [ -f "$DEST/packages/9.2/bioc/src/contrib/foo_1.0.tar.gz" ]
check "operator's index.html kept" [ -f "$DEST/index.html" ]

echo "== INCLUDE / EXCLUDE"
D2=$T/d2; mkdir -p "$D2"
DEST=$D2 INCLUDE='/src/contrib/' EXCLUDE='/books/' run; check "exits 0" [ $? = 0 ]
check "source copied" [ -f "$D2/packages/9.1/bioc/src/contrib/foo_1.0.tar.gz" ]
check "binaries skipped" [ ! -e "$D2/packages/9.1/bioc/bin" ]
check "excluded repo skipped" [ ! -e "$D2/packages/9.1/books" ]
DEST=$D2 INCLUDE='nomatch' run; check "empty selection fails" [ $? != 0 ] && grep -q 'no files to copy' "$T/out"

echo "== failed manifest download"
D3=$T/d3; mkdir -p "$D3"
mv "$SITE/api/v1/manifest/9.2/books.tsv.gz" "$T/held"
DEST=$D3 run; check "fails" [ $? != 0 ]
check "copies nothing" [ -z "$(ls -A "$D3")" ]
mv "$T/held" "$SITE/api/v1/manifest/9.2/books.tsv.gz"

echo "== path outside packages/<version>/"
gunzip "$SITE/api/v1/manifest/9.1/books.tsv.gz"
printf 'packages/9.1/books/../../../evil\t1\tx\n' >> "$SITE/api/v1/manifest/9.1/books.tsv"
gzip "$SITE/api/v1/manifest/9.1/books.tsv"
DEST=$D3 run; check "fails" [ $? != 0 ] && grep -q 'outside packages' "$T/out"
check "copies nothing" [ -z "$(ls -A "$D3")" ]

echo "== unsafe symlink"
publish '.symlinks["packages/9.1/bioc/escape"] = "../../../etc"'
run; check "fails" [ $? != 0 ] && grep -q 'unsafe symlink' "$T/out"
check "link not made" [ ! -L "$DEST/packages/9.1/bioc/escape" ]

echo "== missing tool"
publish
PATH=/nonexistent "$(command -v bash)" "$HERE/mirror-sync.sh" > "$T/out" 2>&1
check "says which" grep -q 'needs curl' "$T/out"

[ $fail = 0 ] && echo "mirror-sync: all checks pass" || { echo "--- last output:"; cat "$T/out"; }
exit $fail
