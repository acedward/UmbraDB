/**
 * The applied-parts decoder (`token-indexer/mip0018/applied-parts.ts`, sub-plans A3/B2): ledger execution order,
 * the applied-parts filter, zero extension of raw `Misc` data, colors — on a synthetic multi-intent transaction and
 * on the recorded Stagenet transactions of the MIP-0018 reference cases (A2 tapes, no network).
 *
 * Expected colors come from the reference repository (read-only, midnight-experiments/mip-0018 @ daec1f1):
 * `deployments/stagenet/cases/IDX/index/index-state.json` (the six colors of 714485–715183, contract and domainSep of
 * each), `cases/U1/index/index-state.json` (715409), and the colors the wallet SDK observed in its balances after
 * each case (`cases/{C02,C03,C04,C05,U1}/wallet-status.json`, keys of `shieldedBalances` / `unshieldedTokenBalances`).
 */
import { ContractCall, ContractDeploy, MaintenanceUpdate } from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";
import { loadTape } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import {
  appliedParts,
  decodeTransaction,
  logSites,
  NIGHT_COLOR,
  partApplied,
  RawDecodeError,
  readLogItem,
  type TransactionLike,
} from "../mip0018/applied-parts.ts";
import { tokenColor, tokenColorSha256 } from "../mip0018/color.ts";
import { EVENT_NAME, encodePayload, record, toHex } from "../vendor/mip0018/codec/src/index.ts";

const ADDRESS = "cc".repeat(32);
const DS = new Uint8Array(32).fill(0x11);

/** A log op's pushed value `[version, eventType, data]`; `data` = name ‖ payload with trailing zeros dropped. */
function logItem(label: string, eventType = 10) {
  const payload = encodePayload({ domainSep: DS, kind: 3 }, [record.utf8("name", label)]);
  const data = Uint8Array.from([...EVENT_NAME, ...payload]);
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--; // what the ledger keeps: trailing zero bytes of the whole item dropped
  const cell = (b: Uint8Array | number[]) => ({ tag: "cell", content: { value: [Uint8Array.from(b)], alignment: [] } });
  return { tag: "array", content: [cell([1]), cell([eventType]), cell(data.subarray(0, end))] };
}

function transcript(labels: string[], mints: { shielded?: Array<[string, bigint]>; unshielded?: Array<[string, bigint]> } = {}) {
  const program: unknown[] = [];
  for (const l of labels) program.push({ push: { value: logItem(l) } }, "log");
  return {
    program,
    effects: {
      shieldedMints: new Map(mints.shielded ?? []),
      unshieldedMints: new Map(mints.unshielded ?? []),
      unshieldedInputs: new Map(),
      unshieldedOutputs: new Map([[{ tag: "unshielded", raw: "ee".repeat(32) }, 5n]]),
      claimedUnshieldedSpends: new Map(),
    },
  };
}

/** A `ContractCall` (for `instanceof`) whose fields are plain test data. */
function call(entryPoint: string, guaranteed?: ReturnType<typeof transcript>, fallible?: ReturnType<typeof transcript>): ContractCall<never> {
  const c = Object.create(ContractCall.prototype) as ContractCall<never>;
  Object.defineProperties(c, {
    address: { value: ADDRESS },
    entryPoint: { value: entryPoint },
    guaranteedTranscript: { value: guaranteed },
    fallibleTranscript: { value: fallible },
  });
  return c;
}

function deploy(address: string): ContractDeploy {
  const d = Object.create(ContractDeploy.prototype) as ContractDeploy;
  Object.defineProperty(d, "address", { value: address });
  return d;
}

function maintenance(address: string): MaintenanceUpdate {
  const m = Object.create(MaintenanceUpdate.prototype) as MaintenanceUpdate;
  Object.defineProperties(m, { address: { value: address }, counter: { value: 3n }, updates: { value: [Object.assign(Object.create({ constructor: { name: "VerifierKeyInsert" } }), { operation: "x", vk: { version: "v3" } }), Object.assign(Object.create({ constructor: { name: "ReplaceAuthority" } }), {})] } });
  return m;
}

const labelOf = (payloadHex: string): string => {
  const p = Buffer.from(payloadHex, "hex");
  const len = p[33 + 1 + 4 + 1]!; // keyLen | "name" | valType | valLen
  return p.subarray(33 + 7, 33 + 7 + len).toString("utf8");
};

const DS_A = "a1".repeat(32);
const DS_B = "b2".repeat(32);

// Two intents inserted out of order: segment 7 (call a: guaranteed a1 a2 + shielded mint A, fallible a3 + fallible
// unshielded mint B; a deploy) and segment 3 (call b: guaranteed b1, fallible b2; call c: guaranteed c1; a maintenance
// update). A transaction-level guaranteed Zswap offer and a fallible one for segment 7 carry colors.
const synthetic: TransactionLike = {
  transactionHash: () => "AB".repeat(32),
  guaranteedOffer: { deltas: new Map([["dd".repeat(32), -10n], [NIGHT_COLOR, 1n]]) },
  fallibleOffer: new Map([[7, { deltas: new Map([["f7".repeat(32), -1n]]) }]]),
  intents: new Map<number, { actions: unknown[]; guaranteedUnshieldedOffer?: { inputs: Array<{ type: string }>; outputs: Array<{ type: string }> } }>([
    [7, { actions: [call("a", transcript(["a1", "a2"], { shielded: [[DS_A, 100n]] }), transcript(["a3"], { unshielded: [[DS_B, 7n]] })), deploy("de".repeat(32))] }],
    [3, {
      actions: [call("b", transcript(["b1"]), transcript(["b2"])), call("c", transcript(["c1"])), maintenance("0a".repeat(32))],
      guaranteedUnshieldedOffer: { inputs: [{ type: NIGHT_COLOR }], outputs: [{ type: "0x" + "AA".repeat(32) }] },
    }],
  ]),
};

describe("applied-parts decoder (00026 A3/B2)", () => {
  const d = decodeTransaction(synthetic);

  it("[[mip0018.decoder.ledger-order]] guaranteed part of every intent (ascending segment), then each fallible segment; actions and ops in order; trimmed Misc data zero-extended to 288", () => {
    expect(d.hash).toBe("ab".repeat(32));
    expect(d.segments).toEqual([3, 7]);
    expect(d.logs.map((l) => labelOf(l.payload!))).toEqual(["b1", "c1", "a1", "a2", "b2", "a3"]);
    expect(d.logs.map((l) => `${l.phase}/${l.segment}/${l.actionIndex}/${l.opIndex}`)).toEqual([
      "guaranteed/3/0/1", "guaranteed/3/1/1", "guaranteed/7/0/1", "guaranteed/7/0/3", "fallible/3/0/1", "fallible/7/0/1",
    ]);
    for (const l of d.logs) {
      expect(l.eventType).toBe("Misc");
      expect(l.name).toBe(toHex(EVENT_NAME)); // full 32-byte name although the raw item lost its trailing zeros
      expect(l.payload).toHaveLength(512); // full 256-byte payload
      expect(l.contractAddress).toBe(ADDRESS);
    }
    expect(d.mints.map((m) => `${m.phase}/${m.segment}/${m.kind}/${m.domainSep.slice(0, 4)}/${m.amount}`)).toEqual([
      "guaranteed/7/1/a1a1/100", "fallible/7/2/b2b2/7",
    ]);
    expect(d.calls.map((c) => `${c.segment}/${c.actionIndex}/${Buffer.from(c.entryPoint, "hex").toString("latin1")}/${c.phases.join("+")}`)).toEqual([
      "3/0/b/guaranteed+fallible", "3/1/c/guaranteed", "7/0/a/guaranteed+fallible",
    ]);
    expect(d.deploys).toEqual([{ phase: "fallible", segment: 7, actionIndex: 1, address: "de".repeat(32) }]);
    expect(d.maintenance).toMatchObject([{ phase: "fallible", segment: 3, actionIndex: 2, counter: 3n, updates: ["VerifierKeyInsert(x, v3)", "ReplaceAuthority"], operations: ["78", null] }]);
    // Colors of public data: NIGHT's zero color is never a seen token; hex normalized; ledger order.
    expect(d.sightings.map((s) => `${s.phase}/${s.segment}/${s.evidence}/${s.color.slice(0, 4)}`)).toEqual([
      "guaranteed/0/shielded-offer/dddd",
      "guaranteed/3/unshielded-utxo/aaaa",
      "guaranteed/3/contract-unshielded/eeee", "guaranteed/3/contract-unshielded/eeee", "guaranteed/7/contract-unshielded/eeee",
      "fallible/3/contract-unshielded/eeee",
      "fallible/7/shielded-offer/f7f7", "fallible/7/contract-unshielded/eeee",
    ]);
  });

  it("[[mip0018.decoder.applied-filter]] FAILURE applies nothing; PARTIAL_SUCCESS keeps the guaranteed part and successful segments only (a missing segment counts as failed)", () => {
    const partial = appliedParts(d, { result: "partial_success", segments: [{ id: 3, success: false }, { id: 7, success: true }] });
    expect(partial.logs.map((l) => `${labelOf(l.payload!)}#${l.eventIndex}`)).toEqual(["b1#0", "c1#1", "a1#2", "a2#3", "a3#4"]);
    expect(partial.mints.map((m) => m.kind)).toEqual([1, 2]);
    expect(partial.deploys).toHaveLength(1);
    expect(partial.maintenance).toHaveLength(0);

    // The failed-segment mint: segment 7 failed → its fallible unshielded mint (and its deploy) do not apply.
    const segment7Failed = appliedParts(d, { result: "partial_success", segments: [{ id: 3, success: true }, { id: 7, success: false }] });
    expect(segment7Failed.mints.map((m) => `${m.phase}/${m.kind}`)).toEqual(["guaranteed/1"]);
    expect(segment7Failed.deploys).toEqual([]);
    expect(segment7Failed.sightings.some((s) => s.color === "f7".repeat(32))).toBe(false);
    expect(appliedParts(d, { result: "partial_success", segments: [{ id: 3, success: true }] }).mints.map((m) => m.kind)).toEqual([1]);

    const ok = appliedParts(d, { result: "success", segments: null });
    expect(ok.logs.map((l) => labelOf(l.payload!))).toEqual(["b1", "c1", "a1", "a2", "b2", "a3"]);
    expect(ok.mints).toHaveLength(2);
    const failed = appliedParts(d, { result: "failure" });
    expect([failed.logs, failed.mints, failed.sightings, failed.deploys, failed.maintenance].every((x) => x.length === 0)).toBe(true);
    expect(partApplied({ phase: "guaranteed", segment: 0 }, { result: "partial_success", segments: [] })).toBe(true);
  });

  it("[[mip0018.decoder.unknown-action]] an unknown contract action, unreadable bytes or a log of another shape are reported, never skipped silently", () => {
    const unknown: TransactionLike = { transactionHash: () => "00".repeat(32), intents: new Map([[1, { actions: [{ some: "thing" }] }]]) };
    expect(() => decodeTransaction(unknown)).toThrow(RawDecodeError);
    expect(() => decodeTransaction(Uint8Array.from([1, 2, 3]))).toThrow(RawDecodeError);
    // A cell without atoms is no `[version, type, data]` triple: the ledger logs it as a `Misc` item that is no 288-byte item.
    expect(readLogItem({ tag: "cell" })).toMatchObject({ form: "bare", eventType: "Misc", undecodable: expect.stringContaining("neither") });
    const tooLong = { tag: "array", content: [{ tag: "cell", content: { value: [Uint8Array.from([1])] } }, { tag: "cell", content: { value: [Uint8Array.from([10])] } }, { tag: "cell", content: { value: [new Uint8Array(289).fill(1)] } }] };
    expect(readLogItem(tooLong)).toMatchObject({ eventType: "Misc", undecodable: expect.stringContaining("289") });
    const twoAtoms = { tag: "array", content: [{ tag: "cell", content: { value: [Uint8Array.from([1])] } }, { tag: "cell", content: { value: [Uint8Array.from([10])] } }, { tag: "cell", content: { value: [Uint8Array.from([1]), Uint8Array.from([2])] } }] };
    expect(readLogItem(twoAtoms)).toMatchObject({ form: "versioned", undecodable: expect.stringContaining("cell of one atom") });
    const other = readLogItem(logItem("x", 2));
    expect(other).toEqual({ form: "versioned", version: 1, eventTypeCode: 2, eventType: "ShieldedMint" }); // not Misc: no name/payload read
    const program = { program: ["log"], effects: { shieldedMints: new Map(), unshieldedMints: new Map() } };
    const lone = decodeTransaction({ transactionHash: () => "00".repeat(32), intents: new Map([[1, { actions: [call("z", program as never)] }]]) });
    expect(lone.logs[0]).toMatchObject({ unresolved: "log-operand-not-pushed", eventType: null }); // reported, never dropped
  });

  it("[[mip0018.decoder.log-semantics]] logged values follow the ledger's decode_event (a well-formed [u32, LogEventType, data] triple has its type; any other value is Misc version 0 with the whole value as data); a log op whose value the raw transaction does not show is unresolved (operand not pushed, or run on some paths only); a log op no successful run reaches logs nothing", () => {
    const cell = (b: Uint8Array | number[]) => ({ tag: "cell", content: { value: [Uint8Array.from(b)], alignment: [] } });
    const atoms = (...bs: number[][]) => ({ tag: "cell", content: { value: bs.map((b) => Uint8Array.from(b)), alignment: [] } });
    const wrapped = logItem("Hi");
    const bare = wrapped.content[2]!; // the same 288-byte name ‖ payload item (trailing zeros dropped), logged without the triple
    // The audit's probe P1: both are a Misc event named mip-0018:token-metadata[v1] with the same name and payload.
    const w = readLogItem(wrapped);
    const b = readLogItem(bare);
    expect(w).toMatchObject({ form: "versioned", version: 1, eventTypeCode: 10, eventType: "Misc", name: toHex(EVENT_NAME) });
    expect(b).toMatchObject({ form: "bare", version: 0, eventTypeCode: 10, eventType: "Misc", name: toHex(EVENT_NAME) });
    expect(b.payload).toBe(w.payload);
    expect(labelOf(b.payload!)).toBe("Hi");
    // Triples the ledger does not accept as versioned items are bare Misc values (their data = the whole array).
    const triple = (ver: unknown, et: unknown, data: unknown = bare) => ({ tag: "array", content: [ver, et, data] });
    for (const [what, v] of [
      ["version above u32", triple(cell([0, 0, 0, 0, 1]), cell([10]))],
      ["version atom over 16 bytes", triple(cell([1, ...new Array(16).fill(0)]), cell([10]))],
      ["version cell without atoms", triple({ tag: "cell", content: { value: [], alignment: [] } }, cell([10]))],
      ["version of two atoms", triple(atoms([1], [0]), cell([10]))],
      ["event type 11", triple(cell([1]), cell([11]))],
      ["event type above u8", triple(cell([1]), cell([10, 1]))],
      ["event type not a cell", triple(cell([1]), { tag: "null" })],
      ["two elements", { tag: "array", content: [cell([1]), cell([10])] }],
      ["four elements", { tag: "array", content: [cell([1]), cell([10]), bare, cell([0])] }],
    ] as const) {
      expect(readLogItem(v), what).toMatchObject({ form: "bare", version: 0, eventType: "Misc", undecodable: expect.stringContaining("neither") });
    }
    // Ledger integer rules: a 16-byte little-endian atom is a valid u32 1 (u128 range, then u32).
    expect(readLogItem(triple(cell([1, ...new Array(15).fill(0)]), cell([10, 0])))).toMatchObject({ form: "versioned", version: 1, eventType: "Misc", name: toHex(EVENT_NAME) });
    expect(readLogItem(triple(cell([0xff, 0xff, 0xff, 0xff]), cell([10])))).toMatchObject({ form: "versioned", version: 0xffff_ffff });
    // Other bare shapes: a null, a map-less array, a cell of two atoms, an oversized cell.
    expect(readLogItem({ tag: "null" })).toMatchObject({ form: "bare", undecodable: expect.any(String) });
    expect(readLogItem(atoms([1], [2]))).toMatchObject({ form: "bare", undecodable: expect.stringContaining("neither") });
    expect(readLogItem(cell(new Array(289).fill(1)))).toMatchObject({ form: "bare", undecodable: "Misc data is 289 bytes (> 288)" });
    // A versioned Misc triple whose data is not one cell.
    expect(readLogItem(triple(cell([1]), cell([10]), { tag: "array", content: [] }))).toMatchObject({ form: "versioned", undecodable: "Misc data is not a cell of one atom" });

    // Control flow (ledger vm.rs: after op p the VM goes on at p + 1, or p + 1 + skip after jmp / a branch whose cell is not empty).
    const X = { push: { storage: false, value: wrapped } };
    const pushCell = (b: number[]) => ({ push: { storage: false, value: cell(b) } });
    const statuses = (p: unknown[]) => logSites(p).map((s) => (s.status === "unresolved" ? `${s.opIndex}:${s.reason}` : `${s.opIndex}:${s.status}`));
    expect(statuses([X, "log"])).toEqual(["1:resolved"]);
    expect(statuses(["log"])).toEqual(["0:log-operand-not-pushed"]);
    expect(statuses([X, { dup: { n: 0 } }, "log"])).toEqual(["2:log-operand-not-pushed"]);
    expect(statuses([X, { swap: { n: 0 } }, "log"])).toEqual(["2:log-operand-not-pushed"]);
    expect(statuses([{ jmp: { skip: 2 } }, X, "log"])).toEqual(["2:never"]); // jumped over: the ledger logs nothing
    // A branch on a value of the contract's state: the skipped block runs on some paths only.
    expect(statuses([{ dup: { n: 0 } }, { branch: { skip: 2 } }, X, "log", { noop: { n: 1 } }])).toEqual(["3:log-conditionally-executed"]);
    // The paths meet again before the log: it runs on every path, from the push right before it.
    expect(statuses([{ dup: { n: 0 } }, { branch: { skip: 1 } }, { noop: { n: 1 } }, X, "log"])).toEqual(["4:resolved"]);
    // A branch that lands ON the log: on that path the pushed value was skipped.
    expect(statuses([{ dup: { n: 0 } }, { branch: { skip: 1 } }, X, "log"])).toEqual(["3:log-operand-not-pushed"]);
    // A branch on a pushed constant is decided: the empty cell does not skip, any other cell does.
    expect(statuses([pushCell([]), { branch: { skip: 2 } }, X, "log", { noop: { n: 1 } }])).toEqual(["3:resolved"]);
    expect(statuses([pushCell([1]), { branch: { skip: 2 } }, X, "log", { noop: { n: 1 } }])).toEqual(["3:never"]);
    expect(statuses([pushCell([0]), { branch: { skip: 2 } }, X, "log", { noop: { n: 1 } }])).toEqual(["3:never"]); // one zero byte is not empty
    // A run that jumps past the end fails: only the other path succeeds; with no successful path nothing is logged.
    expect(statuses([{ dup: { n: 0 } }, { branch: { skip: 1 } }, { jmp: { skip: 99 } }, X, "log"])).toEqual(["4:resolved"]);
    expect(statuses([X, "log", { jmp: { skip: 9 } }])).toEqual(["1:never"]);
    expect(() => logSites([{ jmp: {} }])).toThrow(RawDecodeError);
    // Hostile sizes stay linear-ish: 20 000 ops with branches.
    const big: unknown[] = [];
    for (let i = 0; i < 5_000; i++) big.push({ dup: { n: 0 } }, { branch: { skip: 1 } }, X, "log");
    const t0 = performance.now();
    expect(logSites(big).filter((s) => s.status !== "unresolved")).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(5_000);

    // In a transaction: unresolved logs keep their place in ledger order; never-run logs take none.
    const tr = (p: unknown[]) => ({ program: p, effects: { shieldedMints: new Map(), unshieldedMints: new Map() } });
    const d2 = decodeTransaction({
      transactionHash: () => "01".repeat(32),
      intents: new Map([[1, { actions: [call("w", tr([X, "log", { push: { storage: false, value: bare } }, "log", { dup: { n: 0 } }, "log", { jmp: { skip: 2 } }, X, "log"]) as never)] }]]),
    });
    expect(d2.logs.map((l) => `${l.opIndex}:${l.unresolved ?? `${l.form}/${l.eventType}`}`)).toEqual(["1:versioned/Misc", "3:bare/Misc", "5:log-operand-not-pushed"]);
    expect(appliedParts(d2, { result: "success" }).logs.map((l) => l.eventIndex)).toEqual([0, 1, 2]);
  });
});

// ── Recorded Stagenet transactions ────────────────────────────────────────────────────────────────────────────────

/** IDX (714485–715183) + U1 (715409) mints: color, contract, domainSep, kind (reference index states). */
const EXPECTED_MINTS: Record<string, { color: string; contract: string; domainSep: string; kind: 1 | 2 }> = {
  "714557": { kind: 1, color: "be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b", contract: "0ee5f31961f9df197055c49dda8f87275af50c3554ba701ffa1837537735e532", domainSep: "6d69702d303031383a6578616d706c653a736869656c64656400000000000000" },
  "714617": { kind: 2, color: "8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484", contract: "a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21", domainSep: "6d69702d303031383a6578616d706c653a756e736869656c6465640000000000" },
  "714643": { kind: 1, color: "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16", contract: "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f", domainSep: "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000" },
  "714649": { kind: 2, color: "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16", contract: "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f", domainSep: "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000" },
  "714683": { kind: 1, color: "81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1", contract: "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6", domainSep: "6d69702d303031383a6578616d706c653a66616d696c793a676f6c6400000000" },
  "714689": { kind: 1, color: "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d", contract: "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6", domainSep: "6d69702d303031383a6578616d706c653a66616d696c793a73696c7665720000" },
  "714802": { kind: 1, color: "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d", contract: "7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637", domainSep: "953ecfdd939bcb9df7bb4ddb9deeb4ebfa2447563c08f7973576c7ac492f9600" },
  "715409": { kind: 1, color: "89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0", contract: "11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b", domainSep: "6d69702d303031383a6578616d706c653a757067726164650000000000000000" },
};

/** Colors the wallet SDK reported in its balances after each case (`wallet-status.json`): [shielded, unshielded]. */
const WALLET_COLORS: Record<string, [string[], string[]]> = {
  C02: [["be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b"], []],
  C03: [[], ["8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484"]],
  C04: [["042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16"], ["042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16"]],
  C05: [["81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1", "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d"], []],
  U1: [["89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0"], []],
};

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

describe("applied-parts decoder on recorded Stagenet (00026 A3)", () => {
  const tapes = [loadTape("c04-714637-714663.tape.json"), loadTape("cases-sparse.tape.json")];
  const decoded = tapes.flatMap((t) => t.blocks.flatMap((b) => b.indexerBlock.transactions.map((tx) => ({
    height: b.height,
    indexer: tx,
    d: decodeTransaction(Buffer.from(tx.raw, "hex")),
  }))));

  it("[[mip0018.decoder.stagenet-mints]] every recorded mint gives the reference color, contract, domainSep and kind; kinds 1 and 2 of C04 share one color; colors equal the wallet's", () => {
    expect(decoded).toHaveLength(20);
    const mints: Record<string, { color: string; contract: string; domainSep: string; kind: number }> = {};
    for (const { height, indexer, d } of decoded) {
      expect(d.hash).toBe(noPrefix(indexer.hash));
      const status = (indexer as { transactionResult?: { status: string } }).transactionResult?.status;
      expect(status).toBe("SUCCESS");
      for (const m of appliedParts(d, { result: "success" }).mints) {
        expect(mints[String(height)]).toBeUndefined();
        const color = tokenColor(m.domainSep, m.contractAddress);
        expect(tokenColorSha256(m.domainSep, m.contractAddress)).toBe(color); // independent derivation
        mints[String(height)] = { color, contract: m.contractAddress, domainSep: m.domainSep, kind: m.kind };
        expect(m.phase).toBe("guaranteed");
      }
    }
    expect(mints).toEqual(EXPECTED_MINTS);
    const idx = new Set(Object.entries(mints).filter(([h]) => Number(h) <= 715183).map(([, m]) => m.color));
    expect(idx.size).toBe(6);
    expect(mints["714643"]!.color).toBe(mints["714649"]!.color);
    for (const [shielded, unshielded] of Object.values(WALLET_COLORS)) {
      for (const c of shielded) expect(Object.values(mints).some((m) => m.color === c && m.kind === 1)).toBe(true);
      for (const c of unshielded) expect(Object.values(mints).some((m) => m.color === c && m.kind === 2)).toBe(true);
    }
    // Public data carries the minted colors too (Zswap delta for a shielded mint, the UTXO for an unshielded one).
    const seenAt = (h: number) => decoded.filter((x) => x.height === h).flatMap((x) => x.d.sightings.map((s) => `${s.evidence}:${s.color}`));
    expect(seenAt(714643)).toEqual([`shielded-offer:${EXPECTED_MINTS["714643"]!.color}`]);
    // The unshielded mint's color: the wallet's UTXO and the contract's own unshielded-output effect.
    expect(seenAt(714649)).toEqual([`unshielded-utxo:${EXPECTED_MINTS["714649"]!.color}`, `contract-unshielded:${EXPECTED_MINTS["714649"]!.color}`]);
    expect(decoded.flatMap((x) => x.d.sightings).some((s) => s.color === NIGHT_COLOR)).toBe(false);
  });

  it("[[mip0018.decoder.stagenet-actions]] deploys, maintenance updates (C10 VerifierKeyRemove, U1 VerifierKeyInsert), multi-call transactions and Misc logs are recognised", () => {
    const at = (h: number) => decoded.filter((x) => x.height === h).map((x) => x.d);
    expect(at(714637)[0]!.deploys.map((x) => x.address)).toEqual(["86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f"]);
    expect(at(715183)[0]!.maintenance).toHaveLength(1);
    expect(at(715183)[0]!.maintenance[0]!.address.startsWith("048ec49a")).toBe(true); // C10's contract
    expect(at(715183)[0]!.maintenance[0]!.updates.join(" ")).toBe("VerifierKeyRemove(publishMetadata, v4)");
    expect(at(715183)[0]!.maintenance[0]!.operations).toEqual([Buffer.from("publishMetadata").toString("hex")]);
    expect(at(715428)[0]!.maintenance[0]!.updates.join(" ")).toMatch(/^VerifierKeyInsert\(publishMetadata, v[34]\)$/);
    expect(at(715428)[0]!.maintenance[0]!.address).toBe("11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b");
    // 714813: one transaction with TWO contract calls (another user's bridge withdrawal) — why a count of calls per
    // action (60 in 714485–715183) exceeds the reference's count of transactions with a call (58).
    const twoCalls = at(714813).filter((x) => x.calls.length === 2);
    expect(twoCalls).toHaveLength(1);
    expect(twoCalls[0]!.calls.map((c) => c.entryPoint)).toEqual([Buffer.from("startWithdraw").toString("hex"), Buffer.from("signBidirectional").toString("hex")]); // exact bytes (C4 H1)
    const all = decoded.map((x) => x.d);
    expect(all.flatMap((x) => x.calls)).toHaveLength(18);
    expect(all.flatMap((x) => x.deploys)).toHaveLength(1);
    expect(all.flatMap((x) => x.maintenance)).toHaveLength(2);
    const logs = all.flatMap((x) => x.logs);
    expect(logs).toHaveLength(11);
    expect(logs.every((l) => l.eventType === "Misc" && l.name !== undefined && l.payload?.length === 512)).toBe(true);
    // C10 (715177): the Appendix A event, a 127-byte raw item, decodes as the full 288-byte form.
    const c10 = at(715177)[0]!.logs;
    expect(c10).toHaveLength(1);
    expect(c10[0]!.name).toBe(toHex(EVENT_NAME));
    expect(c10[0]!.payload!.slice(190)).toBe("0".repeat(512 - 190)); // content ends at byte 95, then zero padding
  });
});
