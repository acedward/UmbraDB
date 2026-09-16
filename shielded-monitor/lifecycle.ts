import { IllegalLifecycleTransitionError } from "./errors.js";

/**
 * The monitor lifecycle state machine (organizer spec FR-015, as simplified by owner decision
 * Q33).
 *
 * **A viewing key is GIVEN or it is DELETED.** There is nothing in between: no pause, no resume,
 * no revoke. A consumer that no longer wants a monitor deletes it, and deleting destroys the key
 * in the holder's RAM and every row that described it. The states that remain are the ones the
 * SYSTEM reaches on its own — converging, caught up, or stopped fail-closed — plus the tombstone
 * `deleted`. Nothing a consumer can ask for produces a state that must later be un-asked.
 *
 * Pure: no SQL, no I/O, no key material. The store applies this table; it does not re-derive it.
 * Keeping the machine in its own dependency-free module is what makes the property test in
 * `test/shielded-monitor/lifecycle.property.test.ts` able to exhaust it without a database, in
 * the shape `Formal/STORAGE_ALGEBRA.md` §5 uses for the storage laws.
 */

/**
 * Every state a monitor can occupy.
 *
 * **Narrower than the database's CHECK, deliberately.** Migration `001_core.ts` still admits
 * `paused` and `revoked` as literals, and it is not edited (it belongs to an already-open PR, and
 * rewriting a shipped migration is not something this repository does). The code simply never
 * writes them: there is no event that produces one, so no row this system creates can hold one.
 * A database upgraded from a pre-Q33 deployment may still carry such rows; they are read as they
 * are and never scanned, because {@link isScannable} admits neither.
 */
export const MONITOR_STATES = [
  "backfilling",
  "live",
  "failed",
  "stale_source",
  "deleted",
] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/** Every lifecycle event. `delete` is terminal from every state and is the only one a consumer
 *  can ask for; the other three are the system's own. */
export const LIFECYCLE_EVENTS = [
  "register",
  "go_live",
  "fail",
  "mark_stale_source",
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
 * - `noop` — the event is admitted but changes nothing (a re-issued `delete` on a monitor that is
 *   already gone). The caller bumps NOTHING. This matters: organizer spec FR-016 requires delete
 *   to be idempotent, and if an idempotent re-issue bumped the epoch, a client that retries on a
 *   timeout could fence a healthy worker off its own monitor indefinitely.
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
 *
 * Every non-deleted state admits `delete`, which is what "a key is given or it is deleted" means
 * as a table: there is no state a consumer can be stuck in.
 */
const TABLE: {
  readonly [S in MonitorState]: { readonly [E in LifecycleEvent]?: MonitorState };
} = {
  // Scanning from `requestedStart` towards the tip.
  backfilling: {
    go_live: "live",
    fail: "failed",
    mark_stale_source: "stale_source",
    delete: "deleted",
  },
  // Caught up with the archive tip and following it.
  live: {
    go_live: "live", // idempotent: already live
    fail: "failed",
    mark_stale_source: "stale_source",
    delete: "deleted",
  },
  // Terminal, fail-closed: an unsupported protocol version or an undecodable transaction
  // (organizer spec's edge cases). Only deletion leaves it.
  failed: {
    fail: "failed", // idempotent
    delete: "deleted",
  },
  // Terminal: the archive this monitor was bound to was rebuilt (organizer spec FR-013).
  stale_source: {
    mark_stale_source: "stale_source", // idempotent
    delete: "deleted",
  },
  // Absorbing.
  deleted: {
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
export function transitionOrThrow(
  from: MonitorState, event: LifecycleEvent,
): Exclude<TransitionOutcome, { kind: "illegal" }> {
  const outcome = transition(from, event);
  if (outcome.kind === "illegal") throw new IllegalLifecycleTransitionError(from, event);
  return outcome;
}
