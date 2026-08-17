# UmbraDB software supply-chain directory

This directory is UmbraDB's **software supply-chain inventory**: a security-and-updates-focused
record of *every* third-party component the project depends on, plus an assessment of where
UmbraDB stands against the [SLSA](https://slsa.dev) supply-chain integrity framework.

UmbraDB itself is licensed **Apache-2.0** (`LICENSE`, `NOTICE`; Copyright 2026 Charles Hoskinson).

## Why this exists

UmbraDB is the Postgres persistence layer for a Midnight/Cardano dependency chain. Its trust
surface is not just its four direct runtime npm packages — it is the full transitive npm graph used
to build and test it, the pinned Cardano/Midnight release binaries and Docker images the dev
environment runs, and the Lean/mathlib toolchain that checks the formal proofs. This directory
makes that surface explicit so it can be watched, audited, and updated deliberately.

## How the inventory is organized

- **[`inventory.md`](inventory.md)** — the SBOM-style inventory. One table per ecosystem
  (npm-runtime, npm-dev, nix-packages, pinned-binaries, docker-images, lean/mathlib, host-tools),
  with **Component · Version/Pin · Source · Hash/Digest · License · Purpose · Update-watch**.
  Every row records *how* it is pinned — semver range vs exact git rev vs sha256 vs image digest —
  because **pinning quality is the security signal**: an exact rev/sha256/digest is
  tamper-evident, a floating range or ref is not.
- **[`slsa.md`](slsa.md)** — the SLSA examination: the Build-track levels, UmbraDB's current
  posture per track, an estimate of the current SLSA Build level and a realistic target, and the
  concrete gaps mapped to the roadmap items that close them.

Every entry is grounded in a real manifest in this repo. The authoritative sources are:

| Ecosystem | Manifest(s) |
|---|---|
| npm runtime + dev | `package.json`, `package-lock.json` (lockfileVersion 3) |
| Nix dev environment | `nix/midnight-env/flake.nix`, `nix/midnight-env/flake.lock` |
| Lean proofs | `Formal/Lean/lean-toolchain`, `Formal/Lean/lake-manifest.json` |
| CI trust gate | `.github/workflows/conformance.yml` (and the planned `supply-chain.yml`, G18) |

## Update process — how and when to bump each ecosystem

The governing rule differs by ecosystem, because the *security value* of each pin differs.

- **npm runtime deps** — `postgres`, `zod`, `@polkadot/types`, and the local
  `@midnight-ntwrk/ledger-v8` build. Registry dependencies are fixed by the resolved version and
  integrity hash in `package-lock.json`; the vendored ledger is fixed by its source commit,
  committed patches, provenance record and 32-file `SHA256SUMS`. Bump either class deliberately
  and commit its verification metadata.
- **npm dev deps + transitive graph (493 package entries total)** — `npm ci` reinstalls the exact locked
  tree; never `npm install` in CI. Bump dev tooling (vitest, tsx, typedoc, typescript,
  Testcontainers, coverage, mutation tools, `@types/node`, effect, fast-check, tinybench, the stock
  ledger refusal oracle, and the wallet-sdk canary) deliberately, run the
  conformance suite, and commit the new lockfile. A non-blocking full `npm audit` gives dev-graph
  visibility without gating merges on the large dev tree.
- **Nix pins (`flake.lock`)** — updated **deliberately, never via a blind `nix flake update`**.
  This is a stated design rule (`nix/midnight-env/flake.nix` header comment): the Midnight/Cardano
  component commits and the release-binary sha256s are the exact revisions the environment was
  built and verified against, so a re-lock that silently rolls them forward would break
  reproducibility. Bumping a pin means editing the rev/sha256/digest, re-verifying the stack, and
  committing — reviewed as its own change (see the G18 flake-lock change-control gate below).
- **Pinned release binaries (cardano-node, cardano-db-sync, midnight-node)** — bump the version +
  `fetchurl` URL + `sha256` in `flake.nix` together; a mismatched sha256 hard-fails the build.
  Watch upstream releases: IntersectMBO/cardano-node, IntersectMBO/cardano-db-sync,
  midnightntwrk/midnight-node.
- **Docker images** — the two Nix-stack images and all five Compose declarations are pinned by
  `@sha256:` digest. Digest pinning gives immutability, **not** freedom from CVEs: the Nix images
  are watched by scheduled Trivy, and the parity workflow parses resolved Compose image refs so
  quoting, indentation or interpolation cannot evade the pin gate. Bump = replace the digest and
  re-verify the relevant stack.
- **Lean toolchain + mathlib (`lean-toolchain`, `lake-manifest.json`)** — bump the Lean version
  and re-run `lake update` to a mathlib tag matching that toolchain; the transitive Lake deps
  (batteries, aesop, Qq, …) move with mathlib and are recorded as exact git revs in the manifest.
  Driven by proof needs, not a security cadence, but every rev is exact and reviewable.

## Security process — the CI gates

Seven workflows now run on `pull_request`, not one — `conformance.yml` (tests),
`chain-archive-parity.yml` (live node-vs-indexer parity), `vendored-ledger.yml` (vendored-artifact
integrity + export presence), `pack-smoke.yml` (packed-tarball consumability), `supply-chain.yml`
(this gate), `bench-smoke.yml`, and `lean.yml`. Each installs with `npm ci` (enforcing the lockfile
+ integrity hashes) and pins every GitHub Action by commit SHA. Note that several are
path-filtered, so a given PR runs a subset: "runs on `pull_request`" is not the same as "runs on
every PR", and which of these are *required* to merge is branch-protection configuration, not
something this file can assert.

`conformance.yml` remains the broadest tests-only gate. The **G18 supply-chain gate**
(`.github/workflows/supply-chain.yml`, from `openspec/changes/v1.0.0-infosec-signoff/`) —
**landed in this change** — adds six blocking/scheduled sub-gates:

1. **`npm ci` everywhere** (never `npm install`) — a tampered tarball fails the integrity check.
2. **Blocking `npm audit --audit-level=high --omit=dev`** on the tiny runtime scope, plus a
   non-blocking full audit for dev-graph visibility.
3. **Committed `.npmrc` with `ignore-scripts=true`**, asserted by CI — a future malicious
   transitive install script cannot execute. (This also suppresses *this* package's own lifecycle
   hooks, so any needed build/typecheck must be an explicit CI step — it already is.)
4. **`gitleaks`** full git-history secret scan, allowlisting exactly the one valueless Preview
   testnet wallet path + its `.example` template.
5. **`trivy image --severity HIGH,CRITICAL`** on both Nix-stack digest-pinned images, on a schedule, with
   the scan targets asserted equal to the `flake.nix` digests so a bump cannot silently diverge.
6. **`flake.lock` change-control** — fail any PR that changes `flake.lock` unless it carries an
   explicit `flake-lock-update` label, so an unreviewed `nix flake update` cannot land.

> Note: the G18 config files (`.npmrc`, `.gitleaks.toml`, `SECURITY.md`, `supply-chain.yml`) are
> **committed as part of this change** (`v1.0.0-infosec-signoff`) and are **pending merge to `main`**.
> This directory documents the posture and the current state honestly; see `slsa.md` for the gap mapping.

## SLSA posture in one paragraph

SLSA v1.0 defines a **Build track** (levels L1–L3) certifying that an artifact's build is
tamper-evident via signed **provenance**. UmbraDB is not yet published as a build artifact, so its
current Build level is effectively **L0–L1**: builds are scripted (`npm`, Nix) and inputs are
strongly pinned (491/491 registry package entries with integrity hashes plus a checksummed vendored
ledger, exact Nix revs, sha256 binaries,
digest-pinned images), which is excellent *input* hygiene but produces no signed provenance yet.
The realistic **target is SLSA Build L2**, reached the moment a release workflow publishes with
GitHub Actions OIDC + npm `--provenance` (Sigstore-signed, transparency-logged provenance tied to
the build platform), with a credible path toward L3. See **[`slsa.md`](slsa.md)** for the full
per-track assessment, level estimate, and gap-to-roadmap mapping.

## Recommended follow-up

The markdown `inventory.md` is the deliverable here. A machine-readable SBOM is a good next step:
`npm sbom --sbom-format cyclonedx` for the npm graph, and/or [`syft`](https://github.com/anchore/syft)
over the built artifact and the six unique Docker image references, emitted as CycloneDX and
attached to releases.
