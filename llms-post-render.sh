#!/usr/bin/env bash
# Quarto post-render: install the hand-written llms.txt over the one Quarto
# generates (llms-txt: true still produces the per-page .llms.md files), and
# build llms-full.txt from those pages in llms.txt's order.
#
# Fails if llms.txt links a page that wasn't rendered; warns about rendered
# pages llms.txt doesn't list. Either means llms.txt needs an edit.
set -euo pipefail

out=${QUARTO_PROJECT_OUTPUT_DIR:-_site}
base=https://seandavi.github.io/bioc-infrastructure/

# Quarto only rebuilds these on a full render; skip incremental ones (preview).
[[ -n ${QUARTO_PROJECT_RENDER_ALL:-} ]] || exit 0

cp llms.txt "$out/llms.txt"

mapfile -t pages < <(grep -o "(${base}[^)]*\.llms\.md)" llms.txt | tr -d '()' | sed "s|^$base||" | awk '!seen[$0]++')
for p in "${pages[@]}"; do
  [[ -f $out/$p ]] || { echo "llms.txt links $p, which was not rendered" >&2; exit 1; }
done
(cd "$out" && find . -name '*.llms.md' | sed 's|^\./||') | sort | while read -r p; do
  printf '%s\n' "${pages[@]}" | grep -qx "$p" || echo "WARNING: $p is not listed in llms.txt" >&2
done

{
  echo "# Bioconductor Infrastructure: full text"
  echo
  echo "> Every page of ${base}, in the order of ${base}llms.txt. Each page starts with its source URL."
  for p in "${pages[@]}"; do
    printf '\n\n---\n\nSource: %s%s\n\n' "$base" "${p%.llms.md}.html"
    cat "$out/$p"
  done
} > "$out/llms-full.txt"
echo "llms.txt installed; llms-full.txt: ${#pages[@]} pages, $(wc -c < "$out/llms-full.txt") bytes"
