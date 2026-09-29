#!/usr/bin/env bash
#
# mirror-sync.sh: keep a Bioconductor mirror in step with bioconductor.org.
# Safe to run from cron. Documentation:
# https://seandavi.github.io/bioc-infrastructure/mirror-how-to.html
#
#   DEST=/srv/bioc ./mirror-sync.sh
#
# Settings (environment variables):
#   DEST            directory you serve as the site root (required)
#   REPOS           repositories to carry
#                   (default: bioc data-annotation data-experiment workflows books)
#   MAX_REMOVE      remove files automatically only while they are at most this
#                   fraction of the mirror (default 0.10); a release roll exceeds it
#   CONFIRM_REMOVE  set to 1 to carry out a removal that exceeded MAX_REMOVE
#   JOBS            parallel downloads (default 8)
#   STATE           where the script keeps its state
#                   (default ~/.local/state/bioc-mirror-sync; one per DEST)
#   BASE            site to mirror (default https://bioconductor.org)
#
# Exit status: 0 done; 1 error, nothing removed; 3 removal held for confirmation
# (the list is in $STATE/remove.txt; rerun with CONFIRM_REMOVE=1 to go ahead).
#
# Needs: bash, curl, jq, gzip, md5sum, flock. Rscript is optional (final check).
set -euo pipefail

BASE=${BASE:-https://bioconductor.org}
DEST=${DEST:?set DEST to the directory you serve as the site root}
REPOS=${REPOS:-bioc data-annotation data-experiment workflows books}
MAX_REMOVE=${MAX_REMOVE:-0.10}
CONFIRM_REMOVE=${CONFIRM_REMOVE:-0}
JOBS=${JOBS:-8}
STATE=${STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/bioc-mirror-sync}

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Manifest repo names to their directory under packages/<version>/.
repo_dir() {
  case $1 in
    bioc | workflows | books) echo "$1" ;;
    data-annotation) echo data/annotation ;;
    data-experiment) echo data/experiment ;;
    *) die "unknown repo '$1' in REPOS" ;;
  esac
}

# The manifest decides which paths get written, so it's checked as untrusted
# input: every file path must sit under packages/<version>/, with no '..'.
PATH_RE='^packages/[0-9]+\.[0-9]+/[A-Za-z0-9._+/-]+$'
LINK_RE='^packages/[A-Za-z0-9._+/-]+$'
has_dotdot() { [[ /$1/ == */../* ]]; }

# fetch_one <path> <size> <md5>: download to a .part file, check it, then move
# it into place, so a web server never serves a half-written file.
fetch_one() {
  local path=$1 size=$2 md5=$3 f="$DEST/$1"
  mkdir -p "$(dirname "$f")"
  curl -fsS --retry 3 -o "$f.part" "$BASE/$path" || { rm -f "$f.part"; echo "fetch failed: $path" >&2; return 1; }
  if [[ -n $md5 ]]; then
    [[ $(md5sum < "$f.part" | cut -d' ' -f1) == "$md5" ]] || { rm -f "$f.part"; echo "md5 mismatch: $path" >&2; return 1; }
  else
    [[ $(stat -c %s "$f.part") == "$size" ]] || { rm -f "$f.part"; echo "size mismatch: $path" >&2; return 1; }
  fi
  mv -f "$f.part" "$f"
}
export -f fetch_one
export BASE DEST

# find, limited to the directories this run owns ($scope, set in main). With no
# directories yet (a first run), list nothing: plain find would search all of DEST.
scoped_find() { (( ${#scope[@]} )) || return 0; (cd "$DEST" && find "${scope[@]}" "$@" 2> /dev/null) || true; }

main() {
  [[ -d $DEST ]] || die "DEST=$DEST is not a directory"
  DEST=$(cd "$DEST" && pwd)
  mkdir -p "$STATE"
  exec 9> "$STATE/lock"
  flock -n 9 || die "another run holds $STATE/lock"
  local new=$STATE/new
  rm -rf "$new" && mkdir -p "$new"

  # 1. The index names the current versions; read it fresh every run.
  curl -fsS --retry 3 "$BASE/api/v1/manifest/index.json" -o "$new/index.json" || die "could not fetch index.json"
  local release devel
  release=$(jq -r '.versions.release // empty' "$new/index.json")
  devel=$(jq -r '.versions.devel // empty' "$new/index.json")
  [[ $release =~ ^[0-9]+\.[0-9]+$ && $devel =~ ^[0-9]+\.[0-9]+$ ]] || die "index.json has no usable versions"
  log "release $release, devel $devel"

  # 2. Fetch the manifests, and check each is complete: its line count must match
  #    the object count the index publishes for it.
  local v repo n want
  : > "$new/manifest.tsv"
  for v in $release $devel; do
    for repo in $REPOS; do
      repo_dir "$repo" > /dev/null
      want=$(jq -r --arg p "$v/$repo.tsv.gz" '.manifests[] | select(.path == $p) | .objects' "$new/index.json")
      [[ -n $want ]] || die "index.json lists no manifest $v/$repo"
      curl -fsS --retry 3 "$BASE/api/v1/manifest/$v/$repo.tsv.gz" | gunzip > "$new/$v-$repo.tsv" || die "could not fetch manifest $v/$repo"
      n=$(wc -l < "$new/$v-$repo.tsv")
      [[ $n == "$want" ]] || die "manifest $v/$repo has $n objects, index.json says $want: incomplete download?"
      cat "$new/$v-$repo.tsv" >> "$new/manifest.tsv"
    done
  done
  local bad
  bad=$(cut -f1 "$new/manifest.tsv" | awk -v re="$PATH_RE" '$0 !~ re || ("/" $0 "/") ~ /\/\.\.\//' | head -3)
  [[ -z $bad ]] || die "manifest has paths outside packages/<version>/: $bad"
  log "manifests complete: $(wc -l < "$new/manifest.tsv") objects"

  # The directories this script owns: the carried repos, in the current versions
  # and in any version a previous run carried but hasn't finished removing.
  local versions scope=() d
  versions=$( { echo "$release"; echo "$devel"; cat "$STATE/versions" 2> /dev/null || true; } | sort -u)
  for v in $versions; do for repo in $REPOS; do
    d=packages/$v/$(repo_dir "$repo"); [[ -d $DEST/$d ]] && scope+=("$d")
  done; done

  # 3. Download what's new or changed: not on disk, a different size, or a
  #    different md5 from the last run's manifest.
  scoped_find -type f -printf '%p\t%s\n' > "$new/have.tsv"
  touch "$STATE/manifest.tsv"
  awk -F'\t' 'FILENAME == ARGV[1] { old[$1] = $3; next }
              FILENAME == ARGV[2] { have[$1] = $2; next }
              !($1 in have) || have[$1] != $2 || ($1 in old && old[$1] != $3)' \
    "$STATE/manifest.tsv" "$new/have.tsv" "$new/manifest.tsv" > "$new/fetch.tsv"
  log "downloading $(wc -l < "$new/fetch.tsv") files"
  if [[ -s $new/fetch.tsv ]]; then
    tr '\t' '\n' < "$new/fetch.tsv" | xargs -d '\n' -n 3 -P "$JOBS" bash -c 'fetch_one "$@"' _ ||
      die "some downloads failed (above); nothing removed. Rerun to retry."
  fi
  cp "$new/manifest.tsv" "$STATE/manifest.tsv"

  # 4. Recreate the symlinks (release, devel, and R-version aliases in contrib/).
  #    Skipping this fails silently: pages work, install.packages() gets 404s.
  local link target resolved
  jq -r '.symlinks | to_entries[] | select(.key | startswith("packages/")) | "\(.key)\t\(.value)"' "$new/index.json" > "$new/links.tsv"
  while IFS=$'\t' read -r link target; do
    [[ $link =~ $LINK_RE ]] && ! has_dotdot "$link" || die "bad symlink path in index.json: $link"
    resolved=$(realpath -m "$DEST/$(dirname "$link")/$target")
    [[ $resolved == "$DEST/packages/"* && $target != /* ]] || die "symlink $link -> $target points outside packages/"
    if [[ -d $DEST/$link && ! -L $DEST/$link ]]; then
      die "$DEST/$link is a real directory where the site has a symlink (to $target). Move it aside, then rerun."
    fi
    mkdir -p "$DEST/$(dirname "$link")"
    ln -sfn "$target" "$DEST/$link"
  done < "$new/links.tsv"
  log "symlinks: $(wc -l < "$new/links.tsv")"

  # 5. Remove files that left the manifest, only inside the owned directories.
  #    Anything else under DEST (your own pages, older releases) is never touched.
  cut -f1 "$new/have.tsv" | sort > "$new/have.txt"
  cut -f1 "$new/manifest.tsv" | sort > "$new/want.txt"
  comm -23 "$new/have.txt" "$new/want.txt" > "$new/remove.txt"
  local nrm nwant limit
  nrm=$(wc -l < "$new/remove.txt"); nwant=$(wc -l < "$new/want.txt")
  limit=$(awk -v f="$MAX_REMOVE" -v n="$nwant" 'BEGIN { printf "%d", f * n }')
  if (( nrm > limit )) && [[ $CONFIRM_REMOVE != 1 ]]; then
    cp "$new/remove.txt" "$STATE/remove.txt"
    { echo "$release"; echo "$devel"; echo "$versions"; } | sort -u > "$STATE/versions"
    log "HELD: $nrm files to remove, over the limit of $limit (MAX_REMOVE=$MAX_REMOVE of $nwant)."
    log "This is expected after a release roll. Review $STATE/remove.txt, then rerun with CONFIRM_REMOVE=1."
    exit 3
  fi
  (cd "$DEST" && xargs -d '\n' -r rm -f -- < "$new/remove.txt")
  # Symlinks the index no longer lists, then directories left empty.
  scoped_find -type l -printf '%p\n' | sort | comm -23 - <(cut -f1 "$new/links.tsv" | sort) |
    (cd "$DEST" && xargs -d '\n' -r rm -f --)
  scoped_find -depth -type d -empty -delete
  for v in $versions; do rmdir "$DEST/packages/$v/data" "$DEST/packages/$v" 2> /dev/null || true; done
  rm -f "$STATE/remove.txt"
  { echo "$release"; echo "$devel"; } > "$STATE/versions"
  log "removed $nrm files"

  # 6. The check that matters: R can read the repository through the release link.
  local first; first=$(repo_dir "${REPOS%% *}")
  if [[ -f $DEST/packages/release/$first/src/contrib/PACKAGES ]] && command -v Rscript > /dev/null; then
    n=$(Rscript -e "cat(nrow(available.packages(repos='file://$DEST/packages/release/$first')))" 2> /dev/null) || n=0
    (( n > 0 )) || die "available.packages() found nothing in packages/release/$first"
    log "check: available.packages() lists $n packages in release/$first"
  fi
  log "done"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
