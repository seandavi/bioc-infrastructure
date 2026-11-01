#!/usr/bin/env bash
#
# mirror-sync.sh: copy Bioconductor's current release and devel package
# repositories from bioconductor.org with rclone. Documentation:
# https://seandavi.github.io/bioc-infrastructure/mirror-how-to.html
#
#   DEST=/srv/bioc ./mirror-sync.sh
#
# Needs: bash, curl, gunzip, jq, rclone. Works on Linux and macOS
# (macOS: `brew install jq rclone`).
#
# Settings (environment variables):
#   DEST     directory you serve as the site root (required)
#   REPOS    repositories to carry
#            (default: bioc data-annotation data-experiment workflows books)
#   INCLUDE  extended regex; copy only paths that match (default: everything)
#   EXCLUDE  extended regex; skip paths that match (default: nothing)
#            e.g. INCLUDE='/src/contrib/' for source packages only
#   BASE     site to mirror (default https://bioconductor.org)
#   Any RCLONE_* variable is passed through, e.g. RCLONE_TRANSFERS=16.
#
# What it does: reads the current versions from the manifest index, lists every
# file in those versions' manifests, filters the list, `rclone copy`s it
# (new and changed files only, judged by size and modification time), then
# recreates the release/devel symlinks.
#
# It never deletes. At a release roll, remove the old version yourself:
#   rm -rf "$DEST/packages/<old version>"
#
# Exit status: 0 done; anything else failed, with a message on stderr.
set -euo pipefail

BASE=${BASE:-https://bioconductor.org}
DEST=${DEST:?set DEST to the directory you serve as the site root}
REPOS=${REPOS:-bioc data-annotation data-experiment workflows books}
INCLUDE=${INCLUDE:-}
EXCLUDE=${EXCLUDE:-}

die() { echo "mirror-sync: $*" >&2; exit 1; }

for tool in curl gunzip jq rclone; do
  command -v "$tool" > /dev/null || die "needs $tool on PATH"
done
[[ -d $DEST ]] || die "DEST=$DEST is not a directory"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# 1. The index names the current versions; read it fresh every run.
curl -fsS --retry 3 "$BASE/api/v1/manifest/index.json" -o "$work/index.json" || die "could not fetch index.json"
release=$(jq -r '.versions.release // empty' "$work/index.json")
devel=$(jq -r '.versions.devel // empty' "$work/index.json")
[[ $release =~ ^[0-9]+\.[0-9]+$ && $devel =~ ^[0-9]+\.[0-9]+$ ]] || die "index.json has no usable versions"
echo "release $release, devel $devel"

# 2. Every file in the carried manifests, filtered. pipefail makes a failed
#    manifest download stop the run instead of shortening the list.
for v in $release $devel; do
  for repo in $REPOS; do
    curl -fsS --retry 3 "$BASE/api/v1/manifest/$v/$repo.tsv.gz" | gunzip | cut -f1 ||
      die "could not fetch manifest $v/$repo"
  done
done > "$work/all.txt"
# The manifest decides which paths get written, so refuse anything outside packages/<version>/.
if grep -Eqv '^packages/[0-9]+\.[0-9]+/[A-Za-z0-9._+/-]+$' "$work/all.txt" || grep -q '/\.\./' "$work/all.txt"; then
  die "manifest has a path outside packages/<version>/"
fi
grep -E "${INCLUDE:-.}" "$work/all.txt" | { if [[ -n $EXCLUDE ]]; then grep -Ev "$EXCLUDE"; else cat; fi; } > "$work/files.txt" || true
[[ -s $work/files.txt ]] || die "no files to copy (check INCLUDE/EXCLUDE)"
echo "$(wc -l < "$work/files.txt" | tr -d ' ') files in scope"

# 3. Copy. rclone copy never deletes, so a short list can't empty the mirror.
rclone copy --http-url "$BASE" :http: "$DEST" --files-from "$work/files.txt" --no-traverse --stats-one-line -v

# 4. Symlinks: release/devel, and R-version aliases inside the current versions
#    (e.g. bin/windows/contrib/4.7 -> 4.6). rclone can't make them, and without
#    them URLs that go through them return 404 on your mirror.
jq -r --arg r "$release" --arg d "$devel" '.symlinks | to_entries[]
    | select(.key == "packages/release" or .key == "packages/devel"
             or (.key | startswith("packages/\($r)/") or startswith("packages/\($d)/")))
    | "\(.key)\t\(.value)"' "$work/index.json" |
  while IFS=$'\t' read -r link target; do
    [[ $target =~ ^[A-Za-z0-9._-]+$ && $target != .* && $link != */../* ]] || die "unsafe symlink in index.json: $link -> $target"
    [[ -d $DEST/$(dirname "$link") ]] || continue   # a repo you don't carry
    ln -sfn "$target" "$DEST/$link"
  done
echo "done"
