# AGENTS.md: edge

Serves bioconductor.org from Cloudflare R2 behind a Worker (`bioc-site`, in `worker/`), and
keeps R2 in step with master's docroot (`sync.sh`, run hourly by the units in `systemd/`). Read
`README.md` for how it works and `CONTRIBUTING.md` for the tests. The repository-wide rules are
in the root `AGENTS.md`.

- **The units run in production from the operations clone**
  (`/data/davsean/bioc-ops/bioc-infrastructure/packages/edge`), not from your checkout. A change
  reaches them only after merge and a `git pull` there.
- **`rsync-filter` is the scope decision** for what the mirror holds. Changing it changes what
  R2 serves.
- **Never move `/data/davsean/bioc-cloudflare/mirror`.** Despite the name it is the live mirror
  (`DEST` in `.env`).
- **Credentials:** `./make-env.sh` pulls them from Secret Manager into a gitignored `.env`.
  Never commit one, and never write a secret's value into a file or an issue.
- **Worker deploys are manual** (`npx wrangler deploy` in `worker/`), by the maintainer.
- **Access-log analytics moved to `packages/traffic`.** `ANALYTICS.local.md`, if present, is a
  local, untracked note.
- Findings about upstream bioconductor.org infrastructure go to the Bioconductor team privately
  first (`../../SECURITY.md`); track them with the `upstream` label.
