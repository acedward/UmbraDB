import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeReplayFromCheckpoint } from "../../chain-archive-sync/sync-service.js";

/**
 * Question Q-24 / issue `00019`, option B: the resume deserialize must announce itself.
 *
 * WHY THIS IS WORTH A TEST rather than being "just a log line". The behaviour under test is not
 * the message, it is the OBSERVABILITY of a call that was measured on preprod taking more than 73
 * minutes of one core without finishing (a 52 882 323 B checkpoint at height 375 199). Because
 * `LedgerState.deserialize` is one synchronous WASM call that never yields, the size and the
 * warning can only reach an operator if they are emitted BEFORE it starts -- so this asserts the
 * ORDER as well as the text, and asserts the elapsed field afterwards with an injected clock,
 * which is why the function takes one.
 *
 * The ledger here is the file-local fake of the `ledger-replay` tests: `fromSerialized` touches
 * exactly `LedgerState.deserialize` and `WellFormedStrictness`, so a real WASM build would add
 * minutes and prove nothing extra.
 */

/** The marker the fake pushes when the (fake) deserialize runs, interleaved with the log lines. */
const DESERIALIZE = "<deserialize>";

function fakeLedger(trace: string[], deserialized: unknown) {
  return {
    LedgerState: {
      deserialize: (bytes: Uint8Array) => {
        trace.push(`${DESERIALIZE}${bytes.length}`);
        return deserialized;
      },
    },
    WellFormedStrictness: class { enforceBalancing = true; },
  };
}

describe("resume checkpoint deserialize is announced before it starts and timed after it ends", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the height, the byte count and the many-minutes warning before deserializing, and the elapsed seconds after", () => {
    const trace: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      trace.push(String(args[0]));
    });
    const state = { serialize: () => new Uint8Array([7, 7]) };
    // A clock that advances 3.5 s across the call: the elapsed field is part of the contract, so
    // the test states what it must say rather than asserting "some number".
    let ticks = 0;
    const now = () => (ticks++ === 0 ? 1_000 : 4_500);

    const replay = resumeReplayFromCheckpoint(
      fakeLedger(trace, state), new Uint8Array(52_882_323), 375_199, undefined, now,
    );

    expect(warn).toHaveBeenCalledTimes(2);
    // ORDER is the point: warn, then the call that does not yield, then the timing line.
    expect(trace).toHaveLength(3);
    expect(trace[1]).toBe(`${DESERIALIZE}52882323`);

    const before = trace[0]!;
    expect(before).toContain("resuming ledger replay from checkpoint at height 375199");
    expect(before).toContain("deserializing 52882323 bytes");
    expect(before).toContain("on a large archive this takes many minutes");

    const after = trace[2]!;
    expect(after).toContain("checkpoint deserialized in 3.5 s");
    expect(after).toContain("52882323 bytes");
    expect(after).toContain("height 375199");

    // And it is still a working replay over the deserialized state, not a logging wrapper that
    // dropped it: the state the fake returned is the one the replay carries.
    expect(Array.from(replay.serialize())).toEqual([7, 7]);
  });

  it("reports the elapsed time it actually measured, not a constant", () => {
    // Counterweight to the row above: an implementation that hard-coded "3.5 s", or that timed
    // something other than the deserialize, would satisfy one assertion and fail this one.
    const trace: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      trace.push(String(args[0]));
    });
    let ticks = 0;
    const now = () => (ticks++ === 0 ? 500 : 500 + 4_401_000);

    resumeReplayFromCheckpoint(
      fakeLedger(trace, { serialize: () => new Uint8Array() }), new Uint8Array(16), 42, undefined, now,
    );

    expect(trace[0]).toContain("deserializing 16 bytes");
    expect(trace[2]).toContain("checkpoint deserialized in 4401.0 s");
  });

  it("is the only way the sync service resumes replay from a checkpoint blob", () => {
    // Q-24 option B is worth nothing if a later edit reintroduces a bare `fromSerialized` on a
    // checkpoint blob: the log lines would still exist and would simply never be reached. The two
    // resume sites -- the ingest's own and the DUST backfill's -- are named here by the variable
    // that holds the blob. The two GENESIS sites are deliberately not covered: a genesis snapshot
    // is small and cold-start silence is not the defect this closes.
    const source = readFileSync(
      new URL("../../chain-archive-sync/sync-service.ts", import.meta.url), "utf8",
    ).split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

    expect(source).not.toMatch(/LedgerReplay\.fromSerialized\(\s*ledger,\s*resumeFrom\.stateBytes/);
    expect(source).not.toMatch(/LedgerReplay\.fromSerialized\(\s*ledger,\s*checkpoint\.stateBytes/);
    expect(source).toMatch(/resumeReplayFromCheckpoint\(\s*\n?\s*ledger,\s*resumeFrom\.stateBytes/);
    expect(source).toMatch(/resumeReplayFromCheckpoint\(\s*\n?\s*ledger,\s*checkpoint\.stateBytes/);
    // Positive control for the two negative assertions above: the pattern they use does match the
    // genesis sites, so a passing test means "no checkpoint site", not "the regex matches nothing".
    expect(source).toMatch(/LedgerReplay\.fromSerialized\(\s*ledger,\s*genesisState/);
  });
});
