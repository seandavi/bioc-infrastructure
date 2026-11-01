#!/bin/bash
u="$1"
out=$(curl -s -o /dev/null -L --max-time 15 --connect-timeout 8 \
  -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36 BioconductorLinkCheck/1.0' \
  -w '%{http_code}\t%{num_redirects}\t%{url_effective}' "$u" 2>/dev/null) || out=$'000\t0\t'
printf '%s\t%s\n' "$u" "$out"
