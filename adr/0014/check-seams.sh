#!/usr/bin/env bash
# ADR 0014: packages meet only through documented R2 keys and HTTP artifacts,
# never through each other's source. Fail if a file under packages/<a>/ names a
# path inside packages/<b>/ (relative "../<b>/" or "packages/<b>/").
# ponytail: a grep, not a dependency graph; catches the import, not a copy-paste.
set -euo pipefail
cd "$(dirname "$0")"
pkgs=$(ls packages)
bad=0
for a in $pkgs; do
  for b in $pkgs; do
    [ "$a" = "$b" ] && continue
    if hits=$(git grep -n -E "(\.\./)+$b/|packages/$b/" -- "packages/$a" ':!*.md' ':!**/package-lock.json'); then
      echo "packages/$a reaches into packages/$b:"; echo "$hits"; bad=1
    fi
  done
done
exit $bad
