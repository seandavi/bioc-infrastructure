# AGENTS.md

bioc-registry-next: the registry that will replace `packages/registry`. It runs as a shadow.
Read `README.md` and [#213](https://github.com/seandavi/bioc-infrastructure/issues/213) first.

- **Postgres is the only mutable state.** R2 objects under `packages/` are written from the
  database and never read back to make a decision.
- **`LEGACY` (the current registry's bucket) is read by nothing at run time** (#233), and is
  read-only: never widen its type in `Env`.
- **Schema changes are new migrations** appended to `src/migrations.ts`. Never edit one that
  has been applied.
- **Pure logic is unit-tested without a database or the network.** Database tests use
  `testDb()`. No test touches the network.
- **`src/` must run under Node's type stripping**: import with the `.ts` extension, use
  `import type` for types, no enums or parameter properties. `npm run typecheck` enforces it.
- Dependencies are `hono` and `postgres`. Add another only when a few lines cannot cover it.
- `ponytail:` comments mark a deliberate shortcut and name its ceiling.
- Never deploy, and never call `/admin/*` on a deployed Worker, unless the maintainer asked.
- Don't name another package's source path in code (`./check-seams.sh`).
