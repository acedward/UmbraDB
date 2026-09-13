# Proposal — 00009-09: the merged monitor-node, with viewing keys only in RAM

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer design and change list:
> `plans/00009-09-merged-monitor-node.md`.
> Owner decision that drives this shape: organizer question **Q28** (2026-09-12).
> This change stacks on `00009-08-b-as-a-service` (PR #16).

## Why this change exists

00009-08 got project B off the database: it reads and writes through one HTTP channel and holds no
credential. What it did NOT get rid of is the **viewing key at rest**. `monitors.key_serialized`
held the plaintext serialized encryption secret key, the scanner fetched it once per batch, and a
`monitor_leases` row decided which scanner was allowed to. So a backup, a replica or a dump of the
`shielded_monitor` schema was key material, and the TEE step would have inherited that.

The owner's Q28 decision removes it: **a received viewing key is never persisted; the database
keeps only its hash as identity.** That single requirement forces the rest of this change, because
a key that exists in exactly one process's RAM cannot be shared by two processes, cannot be
fetched by a third, and cannot be handed to whichever instance a lease happens to name:

- the scanner and the private API must MERGE, because they both need the key;
- the lease must go, because what a node holds in RAM is the truth about who can scan a monitor,
  and no table can know it;
- the balancer must ROUTE registrations, because a key sent to the wrong node would create a
  second custodian;
- coverage must learn to have HOLES, because a key that joins a running scan behind its own
  coverage has a range nobody read, and `scanned_through_height` is one number.

Fewer processes inside the future enclave is the owner's other stated goal, and it falls out of
the same decision.

## What this change delivers

- **`umbradb-shielded-monitor-node`** — one process: the public API, the dashboard, `/internal/*`
  for the balancer, and both scan queues. It holds every key it was sent, in RAM, and clears them
  on revoke, delete, a fenced drop and SIGTERM. It replaces `umbradb-shielded-monitor` (the
  scanner) and `umbradb-shielded-monitor-api`, which are **removed**.
- **Block-centric scanning.** Queue A reads each new block once, deserializes each transaction
  once, tests every live key against it, and commits ONE `advance-batch` for the whole block —
  every held monitor's associations, coverage advance and gap rows in one transaction. Queue B is
  a FIFO of `sync-key(fp)` (catch one new key up to the live watermark) and
  `back-sync(fp, from, to)` (re-read a range that was missed).
- **Gaps.** Migration `004_key_in_ram_and_gaps` relaxes the `monitors` CHECK to fingerprint-only
  and adds `monitor_gaps`. A key's first live pass compares its stored coverage with the height
  being scanned; a shortfall becomes a gap row written in the same transaction as the coverage
  move, plus a queued back-sync. "Complete" becomes `scanned_through_height = tip AND no gaps`.
- **Routing.** The balancer computes a registration's fingerprint from a Bech32m decode and a
  SHA-256 (no ledger WASM), verifies its hint with `GET /internal/holds`, falls back to a fan-out,
  and places an unheld key on the node with the fewest keys (then the shortest Queue B). It fills
  `heldBy` and `keyNeeded` on the monitor read routes from a fan-out, answers
  `GET /v1/monitors/<id>/holder`, and never forwards `/internal/*`.
- **Storage API**: `POST advance-batch`, `POST monitors/<id>/fill-gap`, `GET monitors/<id>/gaps`,
  registration by fingerprint; `key-material` and the three lease routes answer **410**.
- Dashboard badges for custody (`key needed`, `held by`) and a gaps column; a 2-node Compose
  overlay and `--split` demo; the deployment, API and node docs; SECURITY.md's trust model.

## Non-goals

Authentication, encryption of associations, a second network lane, and moving the balancer inside
the enclave. The balancer touching a key transiently in order to fingerprint it is recorded as
open point **OP-1** and accepted for the alpha.

## Breaking changes

Stated in full in `docs/shielded-monitor-deployment.md` ("Migrating from the 00009-08
deployment"): two bins and two image commands removed, four storage routes now 410, registration
takes a fingerprint instead of a key, the scanner-only environment variables are gone, and
**every viewing key must be re-sent** after the upgrade because none was loaded from the database.
