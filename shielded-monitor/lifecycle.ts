import { IllegalLifecycleTransitionError } from "./errors.js";

/**
 * The monitor lifecycle state machine (organizer spec FR-015).
 *
 * Pure: no SQL, no I/O, no key material. The store applies this table; it does not re-derive it.
 * Keeping the machine in its own dependency-free module is what makes the property test in
 * `test/shielded-monitor/lifecycle.property.test.ts` able to exhaust it without a database, in
 * the shape `Formal/STORAGE_ALGEBRA.md` §5 uses for the storage laws.
 */

/** Every state a monitor can occupy. Mirrors the `state` CHECK in
 *  `src/postgres/migrations/shielded_monitor/001_core.ts`. */
export const MONITOR_STATES = [
  "backfilling",
  "live",
  "paused",
  "failed",
  "stale_source",
  "revoked",
  "deleted",
] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/** Every lifecycle event. `delete` is the only one whose effect depends on more than the current
 *  state: from a non-revoked state it is applied as `revoke` then `delete` (see
 *  {@link planDelete}), so the spec's `any → revoked → deleted` path is honoured literally and a
 *  deleted monitor's audit trail always shows the revoke. */
export const LIFECYCLE_EVENTS = [
  "register",
  "go_live",
  "pause",
  "resume",
  "fail",
  "mark_stale_source",
  "revoke",
  "delete",
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** The state a freshly registered monitor starts in (organizer spec US1 scenario 1). */
export const INITIAL_STATE: MonitorState = "backfilling";

/** States in which a scanner may advance coverage. The store's fencing predicate uses exactly
 *  this set, so "scannable" is one fact in one place. */
export const SCANNABLE_STATES: readonly MonitorState[] = ["backfilling", "live"];

/** True when a monitor in this state may have its coverage advanced. */
export function isScannable(state: MonitorState): boolean {
  return SCANNABLE_STATES.includes(state);
}

/**
 * The outcome of applying an event to a state.
 *
 * - `applied` — a real transition; the caller bumps the epoch by one and appends a lifecycle
 *   event.
 * - `noop` — the event is admitted but changes nothing (a re-issued `pause` on an already-paused
 *   monitor, a `revoke` on an already-revoked one). The caller bumps NOTHING. This matters:
 *   organizer spec FR-016 requires revoke and delete to be idempotent, and if an idempotent
 *   re-issue bumped the epoch, a client that retries on a timeout could fence a healthy worker
 *   off its own monitor indefinitely.
 * - `illegal` — the table does not admit the event from this state.
 */
export type TransitionOutcome =
  | { readonly kind: "applied"; readonly to: MonitorState }
  | { readonly kind: "noop"; readonly to: MonitorState }
  | { readonly kind: "illegal" };

/**
 * The transition table, written out in full rather than derived from predicates.
 *
 * `undefined` for a `(state, event)` pair means "illegal"; the table is total over
 * {@link MONITOR_STATES} × {@link LIFECYCLE_EVENTS} in the sense that {@link transition} returns
 * a defined outcome for every pair, which the property test asserts by exhausting the product.
 *
 * `register` appears only as the initial event and is never applied to an existing state — the
 * store creates the row directly — so it is illegal from every state here.
 */
const TABLE: {
  readonly [S in MonitorState]: { readonly [E in LifecycleEvent]?: MonitorState };
} = {
  // Scanning from `requestedStart` towards the tip.
  backfilling: {
    go_live: "live",
    pause: "paused",
    fail: "failed",
    mark_stale_source: "stale_source",
    revoke: "revoked",
  },
  // Caught up with the archive tip and following it.
  live: {
    go_live: "live", // idempotent: already live
    pause: "paused",
    fail: "failed",
    mark_stale_source: "stale_source",
    revoke: "revoked",
  },
  // Coverage frozen by the consumer; matches stay readable (organizer spec US3 scenario 1).
  paused: {
    pause: "paused", // idempotent
    // Resume returns to `backfilling`, never straight to `live`: whatever the pre-pause state
    // was, the tip moved while the monitor slept, so `live` would be a claim that is false at the
    // moment it is made. The scanner promotes it back to `live` when coverage reaches the tip.
    // Organizer spec FR-011/FR-020 are explicit that unscanned history must never be presented
    // as caught up.
    resume: "backfilling",
    fail: "failed",
    mark_stale_source: "stale_source",
    revoke: "revoked",
  },
  // Terminal, fail-closed: an unsupported protocol version or an undecodable transaction
  // (organizer spec's edge cases). Only revocation/deletion leaves it.
  failed: {
    fail: "failed", // idempotent
    revoke: "revoked",
  },
  // Terminal: the archive this monitor was bound to was rebuilt (organizer spec FR-013).
  stale_source: {
    mark_stale_source: "stale_source", // idempotent
    revoke: "revoked",
  },
  // Processing stopped and reads refused; the only way out is deletion.
  revoked: {
    revoke: "revoked", // idempotent
    delete: "deleted",
  },
  // Absorbing.
  deleted: {
    revoke: "deleted", // idempotent: nothing left to revoke
    delete: "deleted", // idempotent
  },
};

/** Applies `event` to `from` per the table above. Total: every `(state, event)` pair yields a
 *  defined {@link TransitionOutcome}. */
export function transition(from: MonitorState, event: LifecycleEvent): TransitionOutcome {
  const to = TABLE[from][event];
  if (to === undefined) return { kind: "illegal" };
  return to === from ? { kind: "noop", to } : { kind: "applied", to };
}

/** {@link transition}, throwing {@link IllegalLifecycleTransitionError} instead of returning
 *  `{kind: "illegal"}`. The store uses this so an illegal transition is a typed error at the
 *  boundary rather than a silently ignored request. */
export function transitionOrThrow(from: MonitorState, event: LifecycleEvent): TransitionOutcome {
  const outcome = transition(from, event);
  if (outcome.kind === "illegal") throw new IllegalLifecycleTransitionError(from, event);
  return outcome;
}

/**
 * The event sequence a `delete` expands to from a given state.
 *
 * Organizer spec FR-015 spells the deletion path as `any → revoked → deleted`. Honouring that
 * literally means a delete issued against a live monitor performs two transitions, with two epoch
 * bumps and two lifecycle events, so the fence closes at the revoke and the audit trail always
 * shows it. From `revoked` it is one event; from `deleted` it is none.
 */
export function planDelete(from: MonitorState): readonly LifecycleEvent[] {
  if (from === "deleted") return [];
  if (from === "revoked") return ["delete"];
  return ["revoke", "delete"];
}

/** True when a state must refuse consumer reads of status and associations (organizer spec
 *  FR-016, US3 scenario 3). `deleted` is handled separately as not-found, since a caller must not
 *  be able to distinguish a deleted monitor from one that never existed. */
export function refusesReads(state: MonitorState): boolean {
  return state === "revoked";
}
