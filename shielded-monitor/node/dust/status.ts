import type { DustMirrorStatus, DustServedParameters } from "./mirror.js";

/**
 * The `dust` block of `GET /internal/status` (`spec/00016-dust-wallet-sync.md` §4; plan 00016
 * D2.3, D2.5b).
 *
 * Every field is a count, a height, a byte figure or a fixed code — the same rule the rest of
 * `/internal/status` follows. Nothing here is derived from a viewing key, a DUST key, an owner or
 * a nullifier, and `lastError` carries this module's own message, never the database driver's
 * (see `routes.ts` on why a driver message is not safe to surface on this path).
 *
 * ── Why both `rss` and `externalBytes` ──────────────────────────────────────────────────────
 * The retained mirror's cost lives in the WebAssembly heap, which Node reports as `external`
 * (Phase 2F-bis fitted 2 032 B per leaf against it, R² ≈ 0.99). `rss` is what an operator's
 * container limit is written in. They answer different questions and neither substitutes for the
 * other: `external` is the number to watch for a leak in the fold, `rss` the one that gets a
 * process killed. SC-004 is stated against `rss`, so both are reported and Phase 4 measures them
 * on preprod (question Q-14 — the projection is ≈ 2.4 GB against a 1.5 GB target).
 *
 * They are process-wide, not mirror-only: there is one mirror per process, and attributing a
 * share of a shared heap would be a guess dressed as a measurement.
 */
export interface DustStatusBlock {
  /** `false` when `DUST_DATABASE_URL` is unset — the routes then answer `503 DUST_DISABLED`. */
  readonly enabled: boolean;
  readonly producer: "ingest" | "none";
  readonly ready: boolean;
  readonly applied: { readonly eventId: string; readonly height: string };
  readonly snapshotEventId: string | null;
  /** Resident set size of this process, bytes. */
  readonly rss: number;
  /** Node's `external` — the WebAssembly heap plus other off-heap buffers, bytes. */
  readonly externalBytes: number;
  /**
   * Where the DUST parameters this node serves came from (question **Q-22 option C**):
   *
   *   - `chain` — a `chain_archive.dust_parameters` row, written by the ingest from the ledger
   *     state it was already holding. This is the ordinary answer on an archive ingested with
   *     replay validation on.
   *   - `unknown` — the archive records none (ingested before migration 010, or with replay
   *     validation off), so the ledger's INITIAL DUST parameters are in use. They have been the
   *     right values on every Midnight network so far, but a guess that happens to be right must
   *     not read the same as a fact.
   *   - `changed-at-<height>` — a row appeared above the one the mirror's state was built from,
   *     i.e. the chain changed its DUST parameters mid-chain, and the mirror rebuilt from zero for
   *     it (a `DustLocalState`'s parameters cannot be swapped in place).
   *
   * This REPLACED `parametersCheck`, whose `"ok" | "skipped" | "mismatch"` could not distinguish
   * "skipped" from "still running" and whose implementation is what question Q-22 is about.
   */
  readonly parametersSource: string;
  /** Height of the row above, or `null` under `unknown`. */
  readonly parametersHeight: string | null;
  /** The three values `GET /v1/dust/tip` serves, decimal strings (spec §4 `params`). */
  readonly parameters: DustServedParameters;
  /**
   * Which path this mirror's start took (question **Q-23 option A**): `snapshot` when the file was
   * small enough to restore, `replay` when there was none or it exceeded
   * `DUST_STATE_SNAPSHOT_MAX_BYTES` and folding from zero was the faster and the responsive path.
   */
  readonly startPath: "snapshot" | "replay";
  /** Milliseconds from the mirror's start to the first time it was caught up, or `null` while it
   *  still is not. The number SC-003 is stated against. */
  readonly startMs: number | null;
  readonly lastError: string | null;
}

/** The block a node reports when the module is off. */
export function disabledDustStatus(): DustStatusBlock {
  const memory = process.memoryUsage();
  return {
    enabled: false,
    producer: "none",
    ready: false,
    applied: { eventId: "0", height: "0" },
    snapshotEventId: null,
    rss: memory.rss,
    externalBytes: memory.external,
    parametersSource: "unknown",
    parametersHeight: null,
    // Zeros, not the ledger's initial values: a disabled module has loaded no WASM and must not
    // load any to answer a status request. `enabled: false` is what a reader goes by.
    parameters: { nightDustRatio: "0", generationDecayRate: "0", dustGracePeriodSeconds: "0" },
    startPath: "replay",
    startMs: null,
    lastError: null,
  };
}

export function dustStatusBlock(mirror: DustMirrorStatus): DustStatusBlock {
  const memory = process.memoryUsage();
  return {
    enabled: true,
    producer: mirror.producer,
    ready: mirror.ready,
    applied: mirror.applied,
    snapshotEventId: mirror.snapshotEventId,
    rss: memory.rss,
    externalBytes: memory.external,
    parametersSource: mirror.parametersSource,
    parametersHeight: mirror.parametersHeight,
    parameters: mirror.parameters,
    startPath: mirror.startPath,
    startMs: mirror.startMs,
    lastError: mirror.lastError,
  };
}
