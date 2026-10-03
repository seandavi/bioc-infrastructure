---
name: bioc-health
description: Use when asked how the bioc-* stack is doing — health check, status report, "what's broken/red", or triage of bioc-edge, bioc-traffic, bioc-registry, bioc-website units, Actions, issues, or access logs.
---

# bioc stack health

Read-only triage of the stack Sean runs. Runs on onclappc02 (systemd units, local Parquet, checkouts live there).

## Steps

1. Collect: `~/Documents/git/bioc-infrastructure/health/collect.py` (add `--only <sources>` when the question is narrow). Exit 1 just means fail/error findings exist. The last stdout line is the report path.
2. Read `report.md` in full. Open `bundle.json` (same directory) only for evidence behind fail/warn findings.
3. Group fail and warn findings by root cause: the same error text in several journal tails, a stale rollup next to its failed unit, a failing check shared by PRs. One cause, one entry.
4. Confirm each root cause with one read-only command (`journalctl --user -u <unit> -n 80`, `systemctl --user show <unit> -p …`, `gh run view <id> --log-failed`, a DuckDB aggregate). Mark anything unconfirmed `[unverified]`.
5. Map each cause to its tracking issue (refs in the finding, else `gh issue list -R seandavi/<repo> --search "<keywords>"`) and to a runbook in https://seandavi.github.io/bioc-infrastructure/operations.html (#failed-sync, #purge, #rollback-worker, #rollback-site, #yank) when one applies.
6. Reply in this shape:
   - **Verdict** — overall status and the one-line reason.
   - **Needs action** — per cause: what's wrong · evidence · tracking issue or "untracked" · next command or runbook.
   - **Watch** — warn-level causes, one line each.
   - **Housekeeping** — failure issues to close (`crossref/*/stale-issue`), stale PRs, disk/log growth.
   - **Quiet** — sources with nothing above ok, one line.
   - **Collector gaps** — sources that errored and why.

Done when every fail, error and warn finding in report.md appears in the reply exactly once, on its own or inside a named cause.

## Rules

- Read-only: propose `systemctl --user start`, `gh issue close/comment`, `gh run rerun`, `git pull` as commands for Sean; run none of them.
- Access logs: aggregates and paths only. Never query or quote client IPs, client_id, or user agents.
- bioc-infrastructure is public: never write the report or bundle into any repo.
