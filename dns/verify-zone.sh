#!/usr/bin/env bash
# Compare every record in route53-index.txt between two nameservers.
# Default: Route53 (current authority) vs Cloudflare's assigned nameserver.
# Exit status is the number of differing records (0 = safe to cut over).
#
#   ./verify-zone.sh                          # Route53 vs Cloudflare
#   A=8.8.8.8 ./verify-zone.sh                # public view vs Cloudflare
set -uo pipefail
cd "$(dirname "$0")"
A=${A:-ns-1784.awsdns-31.co.uk}
B=${B:-brynne.ns.cloudflare.com}
ZONE=bioconductor.org
diffs=0

q() { dig +short +norec @"$1" -q "$2" -t "$3" </dev/null | sort; }

while read -r name type ttl flag; do
  [[ $type == NS || $type == SOA ]] && continue
  [[ $name == "@.bioconductor.org" ]] && continue     # literal "@" label: Cloudflare rejects it (known, accepted)
  owner=$([[ $name == "@" ]] && echo "$ZONE." || echo "$name.$ZONE.")
  if [[ $ttl == ALIAS ]]; then
    # Route53 answers an Alias with the target's A records; Cloudflare answers
    # a CNAME chain (flattened to A at the apex). Check that both land on the
    # same CloudFront distribution: B's answers must equal the distribution's
    # current IPs as served to us, and A's likewise. testweb's Alias target no
    # longer exists (Route53 returns NODATA), so it was dropped from the copy.
    [[ $name == testweb ]] && { echo "skip  $owner (dead Alias target, not copied)"; continue; }
    a=$(q "$A" "$owner" A | grep -E '^[0-9.]+$' | head -1)
    b=$(q "$B" "$owner" A | grep -E '^[0-9.]+$' | head -1)
    [[ -z $b ]] && b=$(dig +short "$(q "$B" "$owner" CNAME | tail -1)" A | grep -E '^[0-9.]+$' | head -1)
    # CloudFront's edge IPs differ per resolver, so compare behaviour, not IPs:
    # each side's address must serve this hostname over HTTPS via CloudFront.
    serves() { [[ -n $1 ]] && curl -s -o /dev/null -m 15 -D - --resolve "${owner%.}:443:$1" "https://${owner%.}/" \
                 | grep -qi '^via:.*cloudfront'; }
    if serves "$a" && serves "$b"; then
      echo "ok    $owner $type (Alias: both answers serve it via CloudFront — $a / $b)"
    else
      echo "DIFF  $owner $type  A:$a  B:$b"; ((diffs++))
    fi
    continue
  fi
  a=$(q "$A" "$owner" "$type"); b=$(q "$B" "$owner" "$type")
  # WEIGHTED rows (bbr, *.bbr): Route53 serves the weight-200 answer while its
  # health check passes; only that answer was copied, so an equal diff is expected.
  if [[ $a == "$b" ]]; then echo "ok    $owner $type"; else
    echo "DIFF  $owner $type"; diff <(echo "$a") <(echo "$b") | sed 's/^/        /'; ((diffs++)); fi
done < route53-index.txt
echo "== $diffs differing record(s) between $A and $B"
exit $diffs
