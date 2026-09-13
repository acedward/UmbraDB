import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { IllegalLifecycleTransitionError } from "../../shielded-monitor/errors.js";
import {
  INITIAL_STATE,
  LIFECYCLE_EVENTS,
  MONITOR_STATES,
  SCANNABLE_STATES,
  isScannable,
  transition,
  transitionOrThrow,
  type LifecycleEvent,
  type MonitorState,
} from "../../shielded-monitor/lifecycle.js";

/**
 * The lifecycle laws (organizer spec FR-015), as `fc.property` over arbitrary event sequences —
 * the shape `Formal/STORAGE_ALGEBRA.md` §5 uses for the storage laws.
 *
 * The machine is pure, so these run without Docker and can exhaust the whole
 * state × event product rather than sampling it.
 */

/** A monitor as the pure machine sees it: a state and the fence. */
interface Model {
  readonly state: MonitorState;
  readonly epoch: bigint;
}

/** Applies one event the way `PgShieldedMonitorStore` does: an accepted transition bumps the
 *  epoch by exactly one, a no-op bumps nothing, an illegal event throws and changes nothing. */
function step(model: Model, event: LifecycleEvent): Model {
  const outcome = transition(model.state, event);
  if (outcome.kind === "illegal") return model;
  if (outcome.kind === "noop") return model;
  return { state: outcome.to, epoch: model.epoch + 1n };
}

const anyState = fc.constantFrom(...MONITOR_STATES);
const anyEvent = fc.constantFrom(...LIFECYCLE_EVENTS);

describe("monitor lifecycle state machine", () => {
  describe("the table is total and well-formed", () => {
    it("every (state, event) pair has a defined outcome", () => {
      for (const state of MONITOR_STATES) {
        for (const event of LIFECYCLE_EVENTS) {
          const outcome = transition(state, event);
          expect(["applied", "noop", "illegal"]).toContain(outcome.kind);
          if (outcome.kind !== "illegal") expect(MONITOR_STATES).toContain(outcome.to);
        }
      }
    });

    it("an `applied` outcome always changes the state and a `noop` never does", () => {
      for (const state of MONITOR_STATES) {
        for (const event of LIFECYCLE_EVENTS) {
          const outcome = transition(state, event);
          if (outcome.kind === "applied") expect(outcome.to).not.toBe(state);
          if (outcome.kind === "noop") expect(outcome.to).toBe(state);
        }
      }
    });

    it("`register` is never a transition from an existing state — the store creates the row", () => {
      for (const state of MONITOR_STATES) {
        expect(transition(state, "register").kind).toBe("illegal");
      }
    });

    it("transitionOrThrow throws exactly on the illegal pairs", () => {
      for (const state of MONITOR_STATES) {
        for (const event of LIFECYCLE_EVENTS) {
          const legal = transition(state, event).kind !== "illegal";
          if (legal) {
            expect(() => transitionOrThrow(state, event)).not.toThrow();
          } else {
            expect(() => transitionOrThrow(state, event)).toThrow(IllegalLifecycleTransitionError);
          }
        }
      }
    });
  });

  describe("the exact transitions FR-015 names, as owner decision Q33 leaves them", () => {
    // Give or delete: the only event a CONSUMER can cause is `delete`, and it is legal from every
    // state a monitor can be alive in. `go_live`, `fail` and `mark_stale_source` are the system's
    // own. There is no `pause`, no `resume` and no `revoke` anywhere in this table.
    const expected: readonly (readonly [MonitorState, LifecycleEvent, MonitorState])[] = [
      ["backfilling", "go_live", "live"],
      ["backfilling", "fail", "failed"],
      ["live", "fail", "failed"],
      ["backfilling", "mark_stale_source", "stale_source"],
      ["live", "mark_stale_source", "stale_source"],
      ["backfilling", "delete", "deleted"],
      ["live", "delete", "deleted"],
      ["failed", "delete", "deleted"],
      ["stale_source", "delete", "deleted"],
    ];

    for (const [from, event, to] of expected) {
      it(`${from} --${event}--> ${to}`, () => {
        const outcome = transition(from, event);
        expect(outcome.kind).toBe("applied");
        expect(outcome.kind === "applied" ? outcome.to : undefined).toBe(to);
      });
    }

    it("the table contains no state-changing transition beyond that list", () => {
      const actual: string[] = [];
      for (const state of MONITOR_STATES) {
        for (const event of LIFECYCLE_EVENTS) {
          const outcome = transition(state, event);
          if (outcome.kind === "applied") actual.push(`${state}|${event}|${outcome.to}`);
        }
      }
      expect(actual.sort()).toStrictEqual(expected.map(([f, e, t]) => `${f}|${e}|${t}`).sort());
    });

    it("every state a monitor can be alive in admits `delete`", () => {
      // The property that makes "a key is GIVEN or DELETED" true as a table rather than as a
      // slogan: there is no state a consumer can end up in that they cannot get out of.
      for (const state of MONITOR_STATES) {
        if (state === "deleted") continue;
        const outcome = transition(state, "delete");
        expect(outcome.kind, state).toBe("applied");
        expect(outcome.kind === "applied" ? outcome.to : undefined).toBe("deleted");
      }
    });
  });

  describe("laws over arbitrary event sequences", () => {
    it("the reached state is always a legal state", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
          const final = events.reduce(step, { state: INITIAL_STATE, epoch: 0n });
          expect(MONITOR_STATES).toContain(final.state);
        }),
        { numRuns: 500 },
      );
    });

    it("the epoch never decreases, and increases by exactly one per state change", () => {
      fc.assert(
        fc.property(anyState, fc.array(anyEvent, { maxLength: 40 }), (start, events) => {
          let model: Model = { state: start, epoch: 0n };
          for (const event of events) {
            const next = step(model, event);
            const changed = next.state !== model.state;
            expect(next.epoch - model.epoch).toBe(changed ? 1n : 0n);
            model = next;
          }
        }),
        { numRuns: 500 },
      );
    });

    it("an idempotent re-issue is free: repeating the last event never moves the epoch again", () => {
      fc.assert(
        fc.property(anyState, anyEvent, (start, event) => {
          const first = step({ state: start, epoch: 0n }, event);
          const second = step(first, event);
          expect(second.state).toBe(first.state);
          expect(second.epoch).toBe(first.epoch);
        }),
        { numRuns: 500 },
      );
    });

    it("`deleted` is absorbing: no event of any sequence leaves it", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
          const final = events.reduce(step, { state: "deleted", epoch: 0n });
          expect(final.state).toBe("deleted");
          expect(final.epoch).toBe(0n);
        }),
        { numRuns: 300 },
      );
    });

    it("once deleted, no sequence ever makes the monitor scannable again", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
          let model: Model = { state: "deleted", epoch: 0n };
          for (const event of events) {
            model = step(model, event);
            expect(isScannable(model.state)).toBe(false);
          }
        }),
        { numRuns: 300 },
      );
    });

    it("a fresh monitor is scannable and stops being scannable the moment it fails, goes stale or is deleted", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 20 }), (events) => {
          let model: Model = { state: INITIAL_STATE, epoch: 0n };
          expect(isScannable(model.state)).toBe(true);
          for (const event of events) {
            model = step(model, event);
            expect(isScannable(model.state)).toBe(SCANNABLE_STATES.includes(model.state));
          }
        }),
        { numRuns: 300 },
      );
    });
  });

  describe("delete is one transition, from anywhere (owner decision Q33)", () => {
    it("reaches `deleted` from every state in exactly one step, and bumps the epoch once", () => {
      // Before Q33 this travelled `any -> revoked -> deleted` and bumped the epoch twice. With
      // revoke gone there is one step and one bump — and one lifecycle event in the log, which is
      // the act the log exists to record.
      for (const state of MONITOR_STATES) {
        if (state === "deleted") continue;
        const model = step({ state, epoch: 5n }, "delete");
        expect(model).toStrictEqual({ state: "deleted", epoch: 6n });
      }
    });

    it("a second delete changes nothing at all, so a retried request cannot move the fence", () => {
      const once = step({ state: "live", epoch: 5n }, "delete");
      expect(step(once, "delete")).toStrictEqual(once);
    });
  });
});
