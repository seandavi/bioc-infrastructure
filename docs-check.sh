#!/usr/bin/env bash
# docs-check.sh: find content that has gone stale since the 2026-09-28 cutover.
#   ./docs-check.sh           report; exit 1 if anything is found
#   LINKS=0 ./docs-check.sh   skip the external link check (offline)
# Lines ending in <!-- docs-check: ok --> are skipped: the phrase is intended there.
# Checks: phrases that only made sense before the cutover, names of retired
# repos, and external links that no longer resolve. Migration-record
# pages (banner "migration record") are exempt from the phrase checks: they're
# dated snapshots by design (CONTRIBUTING.md).
set -uo pipefail
cd "$(dirname "$0")"
report=""
# The banner sits in the first 20 lines; a later mention isn't a banner.
record() { head -20 "$1" | grep -qi 'migration record'; }

# phrase|why: extended regexes, case-insensitive.
PHRASES='until (the )?cut-?over|the cutover happened on 2026-09-28
(before|after) (the )?cut-?over|check the tense: the cutover happened on 2026-09-28
bioc-cloudflare|bioc-origin|archived 2026-09-29; bioc-edge is the serving repo
DNS only|grey-clouded|apex and www are proxied since 2026-09-28
not yet (live|in production|serving)|check whether it is live now'
while IFS= read -r line; do
  re=${line%|*}; why=${line##*|}
  for f in $(ls *.qmd); do
    record "$f" && continue
    report+=$(grep -n -i -E "$re" "$f" | grep -v -i archived | grep -v "docs-check: ok" | sed "s#^\([0-9]*\):#PHRASE  $f:\1  ($why)  #" | cut -c1-220)
    report+=$'\n'
  done
done <<< "$PHRASES"

if [[ ${LINKS:-1} == 1 ]]; then
  # Unique external links; HEAD, falling back to GET for servers that refuse HEAD.
  while read -r u; do
    c=$(curl -s -o /dev/null -I -L --max-time 20 -w '%{http_code}' "$u")
    [[ $c == 405 || $c == 403 || $c == 000 ]] && c=$(curl -s -o /dev/null -L --max-time 20 -w '%{http_code}' "$u")
    [[ $c =~ ^(2|3) || $c == 405 ]] || report+="LINK    $c  $u  (in: $(grep -l -F "$u" *.qmd adr/*.md | tr '\n' ' '))"$'\n'
  done < <(grep -h -v 'docs-check: ok' *.qmd adr/*.md | grep -o -E 'https?://[^ )>"`]+' | sed -E 's/[.,;:]+$//' | sort -u |
           grep -v -E '(localhost|127[.]0[.]0[.]1|example[.](org|com))' |
           # Placeholders in examples (<path>, %s, $1, {a,b}) aren't links.
           grep -v -E '[<{$%]' |
           # Private repos 404 for anonymous readers by design; ADRs that cite them stay as written.
           grep -v -E 'github[.]com/seandavi/(bioc-cloudflare|bioc-origin|bioc-traffic|infra-costs|monode)([/]|$)')
fi
report=$(grep . <<< "$report")
[[ -z $report ]] && { echo "docs-check: clean"; exit 0; }
echo "$report"
exit 1
