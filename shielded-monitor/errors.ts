import { StorageError } from "../src/interfaces/storage-errors.js";

/**
 * Project B's typed error surface.
 *
 * Follows `design/design-interfaces.md` §1.1's single idiom — thrown errors extending
 * `StorageError`, carrying a stable `code` discriminant and a machine-readable `retryable` — but
 * these classes are deliberately **not** re-exported from `src/index.ts`. The published barrel's
 * `{code → meaning → retryable}` catalog is frozen by
 * `test/api-surface/error-catalog-drift.test.ts` against `docs/ERROR-CATALOG.md`, and project B is
 * not part of the published storage surface. This is the same position `chain-archive-sync`'s own
 * error classes hold (`test/api-surface/excluded-not-exported.test.ts`).
 */

/** Discriminants for this module's errors. */
export type ShieldedMonitorErrorCode =
  | "SHIELDED_MONITOR_INVALID_VIEWING_KEY"
  | "SHIELDED_MONITOR_NOT_FOUND"
  | "SHIELDED_MONITOR_REVOKED"
  | "SHIELDED_MONITOR_FENCED"
  | "SHIELDED_MONITOR_ILLEGAL_TRANSITION";

/**
 * Why a viewing key was refused. **Diagnostic only** — never returned to a caller, never put in
 * the message, and never logged next to the input. Organizer spec FR-001 requires that every
 * intake failure yields ONE generic client error, so a caller must not be able to tell a bad
 * checksum from a wrong network; this field exists so an operator debugging their own deployment
 * can still tell, from a value that contains nothing derived from the key.
 */
export type ViewingKeyRejection =
  | "not-a-string"
  | "bech32m"
  | "network-hrp"
  | "ledger-rejected"
  | "non-canonical"
  | "ledger-unavailable";

/**
 * The single, generic message every key-intake failure carries (organizer spec FR-001).
 *
 * It is a module-level constant rather than an inline string precisely so the "every rejection is
 * indistinguishable" property is one fact in one place that a test can assert against, instead of
 * several string literals that could drift apart.
 */
export const INVALID_VIEWING_KEY_MESSAGE =
  "invalid viewing key for this deployment's network";

/**
 * Thrown by every viewing-key intake failure. Carries no fragment of the submitted key — not in
 * the message, not in a property, not in `cause` (the underlying error is deliberately dropped,
 * because a Bech32m or ledger error could quote the input).
 */
export class InvalidViewingKeyError extends StorageError {
  readonly code = "SHIELDED_MONITOR_INVALID_VIEWING_KEY" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly rejection: ViewingKeyRejection) {
    super(INVALID_VIEWING_KEY_MESSAGE);
  }
}

/** No monitor with that id exists — or one exists in state `deleted`, which callers must not be
 *  able to distinguish from "never existed" (organizer spec US3 scenario 4). */
export class MonitorNotFoundError extends StorageError {
  readonly code = "SHIELDED_MONITOR_NOT_FOUND" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly monitorId: string) {
    super(`no such monitor: ${monitorId}`);
  }
}

/** The monitor exists but has been revoked; processing has stopped and reads are refused
 *  (organizer spec FR-016). */
export class MonitorRevokedError extends StorageError {
  readonly code = "SHIELDED_MONITOR_REVOKED" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly monitorId: string) {
    super(`monitor is revoked: ${monitorId}`);
  }
}

/** Why a fenced write was refused. `epoch` means the monitor moved on under the caller; `state`
 *  means it is no longer scannable. Both are safe to log: neither carries key material. */
export type FenceRejection = "epoch" | "state";

/**
 * A coverage advance was refused by the epoch fence (organizer spec FR-012, US3 scenario 1).
 *
 * `non-retryable` is the honest classification: retrying the *same* call cannot succeed. The
 * worker's correct response is to reload the monitor and decide again, which is a different call
 * with different arguments.
 */
export class MonitorFencedError extends StorageError {
  readonly code = "SHIELDED_MONITOR_FENCED" as const;
  readonly retryable = "non-retryable" as const;
  constructor(
    readonly monitorId: string,
    readonly rejection: FenceRejection,
    readonly observed: { readonly epoch: bigint; readonly state: string },
  ) {
    super(
      `monitor ${monitorId} rejected a fenced write (${rejection}): ` +
        `stored epoch ${observed.epoch}, state ${observed.state}`,
    );
  }
}

/** A lifecycle event was issued that the transition table does not admit from the current state
 *  (organizer spec FR-015). Idempotent re-issues are NOT this error — they are no-ops. */
export class IllegalLifecycleTransitionError extends StorageError {
  readonly code = "SHIELDED_MONITOR_ILLEGAL_TRANSITION" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly from: string, readonly event: string) {
    super(`illegal lifecycle transition: ${event} is not admitted from state ${from}`);
  }
}
