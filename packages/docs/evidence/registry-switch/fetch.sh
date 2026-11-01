#!/usr/bin/env bash
# Fetch every repository index from both sides. usage: fetch.sh
B=https://bioconductor.org/packages; R=https://bioc-registry.seandavi.workers.dev/repo
for pair in "3.23:bioc-release" "3.24:bioc"; do v=${pair%%:*}; u=${pair#*:}
  for p in src/contrib bin/windows/contrib/4.6 bin/macosx/sonoma-arm64/contrib/4.6 bin/macosx/big-sur-x86_64/contrib/4.6; do
    f=$(echo "$p" | tr / _)
    curl -sL -m 120 -o "bioc-$v-$f.PACKAGES" "$B/$v/bioc/$p/PACKAGES"
    curl -sL -m 120 -o "reg-$v-$f.PACKAGES" "$R/$u/$p/PACKAGES"
    for x in PACKAGES.gz PACKAGES.rds; do
      printf '%s %s %s: bioc %s reg %s\n' "$v" "$p" "$x" \
        "$(curl -s -o /dev/null -w '%{http_code}' $B/$v/bioc/$p/$x)" "$(curl -s -o /dev/null -w '%{http_code}' $R/$u/$p/$x)"
    done
  done
  curl -sL -m 120 -o "bioc-$v-VIEWS" "$B/$v/bioc/VIEWS"; curl -sL -m 120 -o "reg-$v-VIEWS" "$R/$u/VIEWS"
  printf '%s Archive/: bioc %s reg %s\n' $v "$(curl -s -o /dev/null -w '%{http_code}' $B/$v/bioc/src/contrib/Archive/)" "$(curl -s -o /dev/null -w '%{http_code}' $R/$u/src/contrib/Archive/)"
done
