#!/usr/bin/env bash
# Transfer every open issue from the platform repos into bioc-infrastructure,
# label it area:<pkg>, and record old -> new numbers in $MAP (TSV: repo old new).
set -euo pipefail
MAP=${MAP:-$(dirname "$0")/issue-map.tsv}
DEST=seandavi/bioc-infrastructure
touch "$MAP"
for pkg in "$@"; do
  for n in $(gh issue list -R "seandavi/bioc-$pkg" --state open --limit 500 --json number -q '.[].number' | sort -n); do
    url=$(gh issue transfer "$n" "$DEST" -R "seandavi/bioc-$pkg" | tail -1)
    new=${url##*/}
    gh issue edit "$new" -R "$DEST" --add-label "area:$pkg" >/dev/null
    printf '%s\t%s\t%s\n' "bioc-$pkg" "$n" "$new" | tee -a "$MAP"
  done
done
