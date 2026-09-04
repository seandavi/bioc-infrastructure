# 0011 — One propagation gate for every producer

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

bioc-registry decides what propagates into the served repositories. Until now it
decided in two places with two vocabularies:

- r-universe builds: `evaluate()` in the Worker — build status, per-family check
  verdicts on the gating R line, strict version bump, then the dependency
  fixpoint (`approveByDeps`, bioc-registry #34). Blocked packages were written to
  `prop/{u}/blocked/` with the unmet requirement.
- bioc-build builds (SPEC-014): `scripts/publish.sh` — sha256, attestation,
  manifest authorization at `manifest_commit`, and its own version gate (strict
  bump, or replacing a `bioconductor` seed at the same version). The dependency
  gate did not apply at all. `POST /publish` trusted the publisher's verdict.

Two gates drift. The seed-replacement rule already differed between them, the
dependency rule was missing from one, and "why did X not propagate" needed the
reader to know which producer built X and then re-derive the answer from shell
or TypeScript.

## Decision

One pure function, `gate(inputs, config, index)` in bioc-registry `src/repo.ts`,
takes build details and configuration and returns, per candidate, a yes/no and
every rule's verdict:

```
{ propagate, archs, reasons: [{rule, ok, detail}] }
rules: build-status, families, bioccheck, version-parse, version-gate,
       manifest-state, manifest-git-url, manifest-stream, manifest-component (bioc-build only),
       deps (a fixpoint over the whole wave, run last)
config: { gating_r, bioccheck: advisory|blocking, replace_seed }
```

Three callers, no other gating anywhere:

- `evaluate()` gates each r-universe wave with `replace_seed: false` and the
  gating R from bioconductor.org `config.yaml`.
- `POST /publish` gates each bioc-build candidate with `replace_seed: true`
  (SPEC-014: a seed is not a verdict; our build of that version is) and the R the
  policy's image ships (bioc-build #32: drift is accepted, not gated on). The
  publisher sends `staged.json` verbatim; the route fetches the manifest facts at
  `manifest_commit`, records `rejected:<rule>` itself, and answers with the
  decision. An `entry` without `staged` is accepted only as a byte-identical
  re-POST of the already-accepted record (the self-heal path).
- `POST /gate` is the same function, read-only, against the live index, for
  anyone asking "would this propagate, and why not".

Integrity stays with the producer's bytes: sha256 and `gh attestation verify`
remain in `publish.sh`. They prove the tarball is bioc-build's; they are not
propagation policy.

`prop/{u}/blocked/` now records every new version that failed, with its full
reasons array, not only dependency blocks.

## Consequences

- One vocabulary for `attempts.json` statuses: `rejected:<rule>` where rule is a
  gate rule name, plus the three integrity checks.
- bioc-build packages are now subject to the dependency gate. Experiment-data
  packages mostly depend on CRAN or on software already in the index, so this is
  expected to bite rarely, and when it does the reason is recorded.
- A rule change is one edit with one test file (`src/repo.test.ts`), and the
  publisher shrinks by the gating it no longer performs.
- SPEC-014's publisher algorithm (bioc-build) and bioc-registry `docs/api.md`
  are updated in the same change.
