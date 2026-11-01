#!/usr/bin/env bash
# Build a BIND zone file for bioconductor.org by querying Route53's own
# authoritative nameserver for every record in route53-index.txt (which was
# read from the Route53 console, since zone transfers aren't available).
#
# Alias records can't be read this way (dig returns the alias target's
# resolved IPs), so they are emitted as flattened CNAMEs to their known
# targets — see ALIASES below. Weighted records are queried repeatedly and
# every distinct answer is kept.
set -euo pipefail
cd "$(dirname "$0")"
NS=${NS:-ns-1784.awsdns-31.co.uk}
ZONE=bioconductor.org

declare -A ALIASES=(
  ["@"]="d3hzwifbu1gvt4.cloudfront.net."
  ["www"]="bioconductor.org."
  ["testweb"]="d3h1507zzd6849.cloudfront.net."
)

fqdn() { [[ $1 == "@" ]] && echo "$ZONE." || echo "$1.$ZONE."; }

echo "\$ORIGIN $ZONE."
echo "; exported $(date -u +%Y-%m-%dT%H:%MZ) from $NS"
while read -r name type ttl flag; do
  [[ $type == NS || $type == SOA ]] && continue   # Cloudflare supplies its own
  owner=$(fqdn "$name"); qname=$owner
  # A literal "@" label (a data-entry mistake, kept for fidelity) must be
  # escaped in zone-file syntax.
  if [[ $name == "@.bioconductor.org" ]]; then qname="@.$ZONE."; owner="\\@.$ZONE."; fi
  if [[ $ttl == ALIAS ]]; then
    echo "$owner 300 IN CNAME ${ALIASES[$name]} ; Route53 Alias (type $type) — flattened"
    continue
  fi
  [[ $ttl == 0 ]] && ttl=60   # Cloudflare's minimum non-auto TTL
  if [[ ${flag:-} == WEIGHTED ]]; then
    answers=$(for i in $(seq 20); do dig +short +norec @"$NS" -q "$qname" -t "$type" </dev/null; done | sort -u)
  else
    answers=$(dig +short +norec @"$NS" -q "$qname" -t "$type" </dev/null)
  fi
  [[ -z $answers ]] && { echo "; MISSING: $owner $type" ; continue; }
  while IFS= read -r rr; do
    echo "$owner $ttl IN $type $rr${flag:+ ; Route53 $flag}"
  done <<<"$answers"
done < route53-index.txt
