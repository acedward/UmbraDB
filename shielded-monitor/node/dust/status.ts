import type { DustMirrorStatus } from "./mirror.js";

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
  /** What the start-up DUST-parameter comparison (D2.6) could conclude. */
  readonly parametersCheck: "ok" | "skipped" | "mismatch";
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
    parametersCheck: "skipped",
    lastError: null,
  };
}

export function dustStatusBlock(
  mirror: DustMirrorStatus,
  parametersCheck: DustStatusBlock["parametersCheck"],
): DustStatusBlock {
  const memory = process.memoryUsage();
  return {
    enabled: true,
    producer: mirror.producer,
    ready: mirror.ready,
    applied: mirror.applied,
    snapshotEventId: mirror.snapshotEventId,
    rss: memory.rss,
    externalBytes: memory.external,
    parametersCheck,
    lastError: mirror.lastError,
  };
}
