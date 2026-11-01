# bioconductor.org zone copy

Tooling and data for moving the `bioconductor.org` zone from Route53 to Cloudflare.
The runbook is [`dns-cutover.qmd`](../dns-cutover.qmd#migration-plan).

| File | What |
|---|---|
| `route53-index.txt` | Every record's name, type and TTL, as read from the Route53 console on 2026-09-28 (152 records; weighted pairs collapsed). `ALIAS` marks Route53 Alias records |
| `export-zone.sh` | Queries Route53's authoritative nameserver for every indexed record and prints a BIND zone |
| `bioconductor.org.zone` | Its output: the full copy |
| `bioconductor.org.cloudflare-import.zone` | The same without the apex CNAME and the literal-`@` TXT, which were handled by hand. This is what was uploaded |
| `verify-zone.sh` | Diffs every indexed record between two nameservers (default Route53 vs `brynne.ns.cloudflare.com`). Exit status = number of differences |

```sh
./dns/export-zone.sh > dns/bioconductor.org.zone    # re-export from Route53
./dns/verify-zone.sh                                # Route53 vs Cloudflare; expect 0
A=1.1.1.1 ./dns/verify-zone.sh                      # public view vs Cloudflare
```

Records are public DNS data; nothing here is secret.
