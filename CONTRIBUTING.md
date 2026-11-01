# Contributing

This repository holds the bioc-infrastructure platform: its code under `packages/` and its
documentation site in `packages/docs`. Corrections are valuable in both: if a page says
something the system no longer does, that is a bug.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
git clone https://github.com/seandavi/bioc-infrastructure
cd bioc-infrastructure
```

Then work in the package you are changing. Each has its own README, and the code packages
have their own CONTRIBUTING with setup and tests:
[registry](packages/registry/CONTRIBUTING.md), [edge](packages/edge/CONTRIBUTING.md).
No credentials are needed to contribute; deploys are manual and maintainer-only.

## Rules that span packages

- **Packages don't reach into each other.** They meet only through documented R2 keys and HTTP
  artifacts. `./check-seams.sh` must pass; CI runs it on every pull request.
- **A change to a contract updates both sides in the same pull request**: the producer, the
  consumer, and the documentation of the contract (for the registry, `docs/api.md` and
  `src/openapi.ts`).
- **Issues go in this repository's tracker**, labelled `area:<package>`.

## Documentation pages

- **Reference pages** (Install, Edge Cache, Astro Site Build, Propagation Gate) describe the
  current system and should track it. Update them when the system changes, and refresh the
  measurement dates.
- **Migration record pages** carry a banner saying so. They are dated snapshots kept as
  history: correct them if they were *wrong at the time*, but don't update them to describe the
  current system.
- **ADRs are immutable.** To change a decision, write a new ADR that supersedes the old one, and
  link both ways. Clearly dated amendments are fine; silent edits are not.
- New pages need a sidebar entry in `packages/docs/_quarto.yml`.

## Pull requests

Small and single-topic. If a change alters a number, say where the new number was measured.

Documentation is licensed [CC BY 4.0](packages/docs/LICENSE); code is Apache 2.0 (each code
package's `LICENSE`).
