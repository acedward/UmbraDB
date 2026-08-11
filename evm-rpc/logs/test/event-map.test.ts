import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Interface, keccak256 as ethersKeccak } from "ethers";
import {
  EventMapError,
  KNOWN_EVENT_TYPES,
  TRANSFER_TOPIC0,
  defaultAddressMapper,
  mapEvents,
  midnightTopic0,
  splitCompleteTransactions,
  toHex,
  type LogRow,
  type MapWarning,
  type MidnightEvent,
} from "../event-map.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

interface GoldenRow {
  address: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  topics: string[];
  data: string;
  sourceEventId: number;
  removed: boolean;
}

interface Golden {
  description: string;
  profile: "erc20" | "erc721" | "misc";
  events: MidnightEvent[];
  expected: GoldenRow[];
  expectedWarnings: string[];
}

function serialise(row: LogRow): GoldenRow {
  return {
    address: toHex(row.address),
    blockNumber: row.blockNumber,
    blockHash: toHex(row.blockHash),
    txHash: toHex(row.txHash),
    txIndex: row.txIndex,
    logIndex: row.logIndex,
    topics: row.topics.map(toHex),
    data: toHex(row.data),
    sourceEventId: row.sourceEventId,
    removed: row.removed,
  };
}

function loadGolden(name: string): Golden {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.golden.json`), "utf8")) as Golden;
}

function runGolden(golden: Golden): { rows: LogRow[]; warnings: MapWarning[] } {
  const warnings: MapWarning[] = [];
  const rows = mapEvents(golden.events, golden.profile, undefined, {
    onWarning: (w) => warnings.push(w),
  });
  return { rows, warnings };
}

const goldenNames = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".golden.json"))
  .map((f) => f.replace(/\.golden\.json$/, ""))
  .sort();

// ===========================================================================================
// Part 1 — the goldens, byte-exact. These lock behaviour; Part 2 is what argues it is CORRECT.
// ===========================================================================================

describe("mapEvents golden files (evm-rpc/logs/test/golden)", () => {
  it("has a fixture for every case C-G1 enumerates", () => {
    expect(goldenNames).toEqual([
      "burn-unpaired-spend",
      "erc20-pair",
      "erc721-pair",
      "mint-unpaired-receive",
      "misc-contract-event",
      "misc-profile-unshielded",
      "multi-event-tx-log-index",
      "pairing-ambiguity",
      "standard-completeness-events",
      "tx-index-unavailable",
    ]);
  });

  for (const name of goldenNames) {
    it(`${name}: rows and warnings match byte-exactly`, () => {
      const golden = loadGolden(name);
      const { rows, warnings } = runGolden(golden);
      expect(rows.map(serialise)).toEqual(golden.expected);
      expect(warnings.map((w) => w.code)).toEqual(golden.expectedWarnings);
      // Every topic is exactly 32 bytes and topic0 is always present — the table's bytea(32)
      // columns would otherwise reject the row at insert time rather than here.
      for (const row of rows) {
        expect(row.topics.length).toBeGreaterThanOrEqual(1);
        expect(row.topics.length).toBeLessThanOrEqual(4);
        for (const topic of row.topics) expect(topic.length).toBe(32);
        expect(row.address.length).toBe(20);
        expect(row.blockHash.length).toBe(32);
        expect(row.txHash.length).toBe(32);
      }
    });
  }

  it("is deterministic — mapping the same input twice yields identical rows", () => {
    for (const name of goldenNames) {
      const golden = loadGolden(name);
      expect(runGolden(golden).rows.map(serialise)).toEqual(runGolden(golden).rows.map(serialise));
    }
  });
});

// ===========================================================================================
// Part 2 — correctness against INDEPENDENT oracles (ethers), not against event-map's own output.
// ===========================================================================================

describe("mapEvents correctness vs independent oracles", () => {
  it("derives EVM addresses as keccak256(bytes32)[12:32], cross-checked with ethers.keccak256", () => {
    const identities = ["a1".repeat(32), "b0".repeat(32), "11".repeat(32), "07".repeat(32)];
    for (const hex of identities) {
      const oracle = ethersKeccak(Buffer.from(hex, "hex")).slice(-40); // last 20 bytes
      expect(toHex(defaultAddressMapper({ kind: "midnight", hex }))).toBe(oracle);
    }
  });

  it("passes an already-20-byte identity through untouched (Part E's Ethereum-native path)", () => {
    const ethAddress = "742d35cc6634c0532925a3b844bc454e4438f44e";
    expect(toHex(defaultAddressMapper({ kind: "midnight", hex: ethAddress }))).toBe(ethAddress);
  });

  it("emits an erc20 Transfer that ethers.Interface.parseLog decodes with the right from/to/value", () => {
    const golden = loadGolden("erc20-pair");
    const { rows } = runGolden(golden);
    const iface = new Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const row = rows[0]!;
    const parsed = iface.parseLog({
      topics: row.topics.map((t) => `0x${toHex(t)}`),
      data: `0x${toHex(row.data)}`,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("Transfer");
    // The decoded from/to must equal the addresses the ORACLE derives from the fixture identities.
    expect(parsed!.args.from.toLowerCase()).toBe(
      `0x${ethersKeccak(Buffer.from("a1".repeat(32), "hex")).slice(-40)}`,
    );
    expect(parsed!.args.to.toLowerCase()).toBe(
      `0x${ethersKeccak(Buffer.from("b0".repeat(32), "hex")).slice(-40)}`,
    );
    expect(parsed!.args.value).toBe(1000n);
  });

  it("emits an erc721 Transfer whose indexed tokenId ethers decodes as 42", () => {
    const { rows } = runGolden(loadGolden("erc721-pair"));
    const iface = new Interface([
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    ]);
    const row = rows[0]!;
    const parsed = iface.parseLog({
      topics: row.topics.map((t) => `0x${toHex(t)}`),
      data: `0x${toHex(row.data)}`,
    });
    expect(parsed!.name).toBe("Transfer");
    expect(parsed!.args.tokenId).toBe(42n);
    // ERC721 and ERC20 Transfer share one signature hash — the profile changes the ENCODING only.
    expect(toHex(row.topics[0]!)).toBe(toHex(TRANSFER_TOPIC0));
  });

  it("decodes the mint and burn rows as Transfers against address(0)", () => {
    const iface = new Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const parse = (row: LogRow) =>
      iface.parseLog({ topics: row.topics.map((t) => `0x${toHex(t)}`), data: `0x${toHex(row.data)}` })!;

    const mint = parse(runGolden(loadGolden("mint-unpaired-receive")).rows[0]!);
    expect(mint.args.from).toBe("0x0000000000000000000000000000000000000000");
    expect(mint.args.value).toBe(5000n);

    const burn = parse(runGolden(loadGolden("burn-unpaired-spend")).rows[0]!);
    expect(burn.args.to).toBe("0x0000000000000000000000000000000000000000");
    expect(burn.args.value).toBe(250n);
  });

  it("uses keccak256 of the NAME BYTES (not a signature string) as a Misc event's topic0", () => {
    const golden = loadGolden("misc-contract-event");
    const nameHex = golden.events[0]!.name!;
    const { rows } = runGolden(golden);
    expect(`0x${toHex(rows[0]!.topics[0]!)}`).toBe(ethersKeccak(Buffer.from(nameHex, "hex")));
    expect(toHex(rows[0]!.data)).toBe(golden.events[0]!.payload);
  });

  it("derives every Midnight<TypeName>() completeness topic0 via ethers, and they are all distinct", () => {
    const seen = new Map<string, string>();
    for (const type of KNOWN_EVENT_TYPES) {
      if (type === "MiscContractEvent") continue; // name-hashed, not signature-hashed
      const oracle = ethersKeccak(Buffer.from(`Midnight${type}()`, "utf8"));
      expect(`0x${toHex(midnightTopic0(type))}`).toBe(oracle);
      expect(seen.has(oracle), `topic0 collision between ${seen.get(oracle)} and ${type}`).toBe(false);
      seen.set(oracle, type);
    }
    // ...and none of them collides with the ERC20 Transfer topic0.
    expect(seen.has(`0x${toHex(TRANSFER_TOPIC0)}`)).toBe(false);
  });
});

// ===========================================================================================
// Part 3 — pairing, ordering and the batch-boundary contract
// ===========================================================================================

describe("pairing and ordering rules", () => {
  it("pairs FIFO on ambiguity and leaves the surplus receive as a mint", () => {
    const golden = loadGolden("pairing-ambiguity");
    const { rows, warnings } = runGolden(golden);
    expect(rows).toHaveLength(2);
    // The spend paired with the LOWER-id candidate (601 = BOB), not 602.
    expect(toHex(rows[0]!.topics[2]!).slice(24)).toBe(
      ethersKeccak(Buffer.from("b0".repeat(32), "hex")).slice(-40),
    );
    // The surplus receive (602 = CAROL) became a mint keyed on its own id.
    expect(rows[1]!.sourceEventId).toBe(602);
    expect(toHex(rows[1]!.topics[1]!)).toBe("0".repeat(64));
    expect(warnings[0]!.code).toBe("pair-ambiguous");
    expect(warnings[0]!.eventIds).toEqual([600, 601, 602]);
  });

  it("does not pair across differing domainSep / tokenType / amount", () => {
    const base = loadGolden("erc20-pair");
    for (const mutate of [
      (e: MidnightEvent) => ({ ...e, amount: "999" }),
      (e: MidnightEvent) => ({ ...e, tokenType: "5e".repeat(32) }),
      (e: MidnightEvent) => ({ ...e, domainSep: "5e".repeat(32) }),
    ]) {
      const events = [base.events[0]!, mutate(base.events[1]!)];
      const rows = mapEvents(events, "erc20");
      // No pair => a burn (unpaired spend) AND a mint (unpaired receive): two logs, not one.
      expect(rows).toHaveLength(2);
      expect(toHex(rows[0]!.topics[2]!)).toBe("0".repeat(64)); // burn: to = 0
      expect(toHex(rows[1]!.topics[1]!)).toBe("0".repeat(64)); // mint: from = 0
    }
  });

  it("does not pair across different transactions even with identical pair keys", () => {
    const base = loadGolden("erc20-pair");
    const events = [
      base.events[0]!,
      { ...base.events[1]!, transactionId: 8 },
    ];
    const rows = mapEvents(events, "erc20");
    expect(rows).toHaveLength(2);
    // Each is alone in its own transaction, so each is log_index 0 of that transaction.
    expect(rows.map((r) => r.logIndex)).toEqual([0, 0]);
  });

  it("assigns log_index 0-based per transaction by the keyed source event id", () => {
    const { rows } = runGolden(loadGolden("multi-event-tx-log-index"));
    expect(rows.map((r) => r.logIndex)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.sourceEventId)).toEqual([700, 702, 703]);
  });

  it("keys a pair on the LOWER of its two event ids, so replay dedups on one id", () => {
    const { rows } = runGolden(loadGolden("erc20-pair"));
    expect(rows[0]!.sourceEventId).toBe(100);
  });

  it("ignores the order events are handed to it in", () => {
    const golden = loadGolden("multi-event-tx-log-index");
    const shuffled = [...golden.events].reverse();
    expect(mapEvents(shuffled, golden.profile).map(serialise)).toEqual(golden.expected);
  });
});

describe("splitCompleteTransactions (batch-boundary safety)", () => {
  const event = (id: number, transactionId: number): MidnightEvent => ({
    __typename: "PausedEvent",
    id,
    contractAddress: "11".repeat(32),
    transactionId,
    transaction: { hash: "e1".repeat(32), block: { height: 1, hash: "bb".repeat(32) } },
  });

  it("holds back the trailing transaction and releases everything before it", () => {
    const { complete, pending } = splitCompleteTransactions([
      event(1, 10), event(2, 10), event(3, 11), event(4, 12), event(5, 12),
    ]);
    expect(complete.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(pending.map((e) => e.id)).toEqual([4, 5]);
  });

  it("holds back everything when the whole batch is one transaction", () => {
    const { complete, pending } = splitCompleteTransactions([event(1, 10), event(2, 10)]);
    expect(complete).toEqual([]);
    expect(pending.map((e) => e.id)).toEqual([1, 2]);
  });

  it("is empty-safe and sorts by id regardless of arrival order", () => {
    expect(splitCompleteTransactions([])).toEqual({ complete: [], pending: [] });
    const { complete, pending } = splitCompleteTransactions([event(3, 11), event(1, 10), event(2, 10)]);
    expect(complete.map((e) => e.id)).toEqual([1, 2]);
    expect(pending.map((e) => e.id)).toEqual([3]);
  });

  it("prevents the split-pair corruption it exists to prevent", () => {
    // A Spend/Receive pair straddling a delivery batch edge: mapping the batch RAW yields a bogus
    // burn, while mapping only the `complete` half yields nothing yet (correct — wait for the rest).
    const golden = loadGolden("erc20-pair");
    const firstBatch = [golden.events[0]!]; // spend only
    expect(mapEvents(firstBatch, "erc20")).toHaveLength(1); // the corruption, if fed raw
    expect(toHex(mapEvents(firstBatch, "erc20")[0]!.topics[2]!)).toBe("0".repeat(64)); // bogus burn
    expect(splitCompleteTransactions(firstBatch).complete).toEqual([]); // ...and what we actually do
  });
});

// ===========================================================================================
// Part 4 — failure modes
// ===========================================================================================

describe("failure modes", () => {
  it("skips an unknown event type with a warning instead of crashing (indexer forward-compat)", () => {
    const warnings: MapWarning[] = [];
    const rows = mapEvents(
      [
        {
          __typename: "SomeFutureEvent",
          id: 1,
          contractAddress: "11".repeat(32),
          transactionId: 1,
          transaction: { hash: "e1".repeat(32), block: { height: 1, hash: "bb".repeat(32) } },
        },
      ],
      "erc20",
      undefined,
      { onWarning: (w) => warnings.push(w) },
    );
    expect(rows).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["unknown-event-type"]);
  });

  it("throws EventMapError when a KNOWN type is missing a field the SDL declares non-null", () => {
    const golden = loadGolden("erc20-pair");
    const broken = { ...golden.events[0]!, amount: null };
    expect(() => mapEvents([broken], "erc20")).toThrow(EventMapError);
  });

  it("throws when an AddressOrContract's discriminator and populated branch disagree", () => {
    const golden = loadGolden("erc20-pair");
    const broken = {
      ...golden.events[0]!,
      sender: { kind: "USER" as const, userAddress: null, contractAddress: "07".repeat(32) },
    };
    expect(() => mapEvents([broken], "erc20")).toThrow(EventMapError);
  });

  it("rejects a malformed hex value rather than silently truncating it", () => {
    const golden = loadGolden("erc20-pair");
    expect(() => mapEvents([{ ...golden.events[0]!, tokenType: "zz" }], "erc721")).toThrow(/not a hex/);
    expect(() => mapEvents([{ ...golden.events[0]!, tokenType: "abc" }], "erc721")).toThrow(/odd length/);
  });

  it("rejects an amount that is negative or overflows uint256", () => {
    const golden = loadGolden("erc20-pair");
    expect(() => mapEvents([{ ...golden.events[0]!, amount: "-1" }], "erc20")).toThrow(/negative/);
    expect(() =>
      mapEvents([{ ...golden.events[0]!, amount: (2n ** 256n).toString() }], "erc20"),
    ).toThrow(/exceeds uint256/);
    expect(() => mapEvents([{ ...golden.events[0]!, amount: "1.5" }], "erc20")).toThrow(
      /not an integer/,
    );
  });

  it("warns rather than inventing a tx_index when block.transactions was not selected", () => {
    const { rows, warnings } = runGolden(loadGolden("tx-index-unavailable"));
    expect(rows[0]!.txIndex).toBe(0);
    expect(warnings.map((w) => w.code)).toEqual(["tx-index-unavailable"]);
  });

  it("maps an empty batch to no rows", () => {
    expect(mapEvents([], "erc20")).toEqual([]);
  });
});
