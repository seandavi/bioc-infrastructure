# Security

**In this repository** (the Workers, the sync and log pipelines, the registry and its API):
report vulnerabilities privately to Sean Davis (<seandavi@gmail.com>). You should hear back
within a few days; please allow a fix before public disclosure.

**In upstream bioconductor.org infrastructure**: this project measures the live estate and
occasionally finds issues that belong to the Bioconductor team, not to this repo. Those follow
the same route: email the maintainer privately, who coordinates disclosure with the
Bioconductor core team. Do not open a public issue for them.

No credentials live in this repository or its history. Credentials come from Google Secret
Manager at the point of use (for example `packages/edge/make-env.sh`, which writes a gitignored
`.env`), and the registry publisher's secrets are in a GitHub environment.
