import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { IllegalLifecycleTransitionError } from "../../shielded-monitor/errors.js";
import {
  INITIAL_STATE,
  LIFECYCLE_EVENTS,
  MONITOR_STATES,
  SCANNABLE_STATES,
  isScannable,
  planDelete,
  refusesReads,
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

  describe("the exact transitions FR-015 names", () => {
    const expected: readonly (readonly [MonitorState, LifecycleEvent, MonitorState])[] = [
      ["backfilling", "go_live", "live"],
      ["backfilling", "pause", "paused"],
      ["live", "pause", "paused"],
      ["paused", "resume", "backfilling"],
      ["backfilling", "fail", "failed"],
      ["live", "fail", "failed"],
      ["paused", "fail", "failed"],
      ["backfilling", "mark_stale_source", "stale_source"],
      ["live", "mark_stale_source", "stale_source"],
      ["paused", "mark_stale_source", "stale_source"],
      ["backfilling", "revoke", "revoked"],
      ["live", "revoke", "revoked"],
      ["paused", "revoke", "revoked"],
      ["failed", "revoke", "revoked"],
      ["stale_source", "revoke", "revoked"],
      ["revoked", "delete", "deleted"],
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

    it("resume never goes straight to live (the tip moved while the monitor slept)", () => {
      const outcome = transition("paused", "resume");
      expect(outcome.kind === "applied" ? outcome.to : undefined).toBe("backfilling");
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

    it("`revoked` only ever leads to `deleted`", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
          const final = events.reduce(step, { state: "revoked", epoch: 0n });
          expect(["revoked", "deleted"]).toContain(final.state);
        }),
        { numRuns: 300 },
      );
    });

    it("once revoked, no sequence ever makes the monitor scannable again", () => {
      fc.assert(
        fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
          let model: Model = { state: "revoked", epoch: 0n };
          for (const event of events) {
            model = step(model, event);
            expect(isScannable(model.state)).toBe(false);
          }
        }),
        { numRuns: 300 },
      );
    });

    it("a fresh monitor is scannable and stops being scannable the moment it is paused, failed, stale or revoked", () => {
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

  describe("delete travels through revoked (FR-015's `any -> revoked -> deleted`)", () => {
    it("plans two transitions from every non-terminal state, one from revoked, none from deleted", () => {
      for (const state of MONITOR_STATES) {
        const plan = planDelete(state);
        if (state === "deleted") expect(plan).toStrictEqual([]);
        else if (state === "revoked") expect(plan).toStrictEqual(["delete"]);
        else expect(plan).toStrictEqual(["revoke", "delete"]);
      }
    });

    it("every planned sequence actually reaches `deleted` and is legal at every step", () => {
      for (const state of MONITOR_STATES) {
        let model: Model = { state, epoch: 0n };
        for (const event of planDelete(state)) {
          expect(transition(model.state, event).kind).not.toBe("illegal");
          model = step(model, event);
        }
        expect(model.state).toBe("deleted");
      }
    });

    it("a delete from a live state bumps the epoch twice, so the fence closes at the revoke", () => {
      let model: Model = { state: "live", epoch: 5n };
      for (const event of planDelete(model.state)) model = step(model, event);
      expect(model).toStrictEqual({ state: "deleted", epoch: 7n });
    });
  });

  describe("read refusal", () => {
    it("only `revoked` refuses reads; `deleted` is handled as not-found by the store instead", () => {
      for (const state of MONITOR_STATES) {
        expect(refusesReads(state)).toBe(state === "revoked");
      }
    });
  });
});
