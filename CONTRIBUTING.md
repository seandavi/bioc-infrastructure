# Contributing

This repository is a documentation site — prose, diagrams, and decision
records, no code. Corrections and clarifications are the most valuable
contribution: if a page says something the estate no longer does, that is a
bug.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Content is licensed [CC BY 4.0](LICENSE).

## Getting set up

```bash
git clone https://github.com/seandavi/bioc-infrastructure
cd bioc-infrastructure
quarto render     # output in _site/; quarto preview for live reload
```

## The two kinds of pages, and how to edit each

- **Reference pages** (Install, Edge Cache, Astro Site Build, Propagation
  Gate) describe the replacement system and should track reality — update them
  freely when the system changes, refreshing the measurement dates.
- **Migration record pages** carry a banner saying so: they are dated
  snapshots kept as history. Correct them if they were *wrong at the time*;
  do not update them to describe the current system.
- **ADRs are immutable.** To change a decision, write a new ADR that
  supersedes the old one, and link both ways. Amendments (clearly dated) are
  fine; silent edits are not.

## Pull requests

Small and single-topic. If a change alters a number, say where the new number
was measured. New pages need a sidebar entry in `_quarto.yml` and a home in
either Reference or Migration record.

For the wider project's roadmap and where to file issues about the *system*
(rather than these docs), see the
[roadmap](https://seandavi.github.io/bioc-infrastructure/roadmap.html) and the
[front page](https://seandavi.github.io/bioc-infrastructure/).
