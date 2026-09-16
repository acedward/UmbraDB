import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DUST_EVENT_KIND_BY_TAG,
  DUST_EVENT_TAGS,
  generationIndexFromInsertionPath,
  mapDustEvents,
} from "../../chain-archive-sync/dust-events.js";
import { LedgerReplay, type LedgerEventRef } from "../../chain-archive-sync/ledger-replay.js";
import { loadLedgerV8 } from "../../chain-archive-sync/tx-replay-decoder.js";
import {
  readDustFixtureBlob,
  readDustFixtureEvents,
  readDustFixtureMeta,
  readDustFixtureRefs,
} from "./dust-fixture.js";

/**
 * `spec/00016-dust-wallet-sync.md` §5.2 (parsing), §4 (encodings), FR-001/FR-002 -- plan test T1.1.
 *
 * Everything here runs against REAL ledger events: the five genesis system transactions this repo
 * already commits, and a 300-event contiguous prefix of preprod's own DUST stream (the only source
 * of a `dustSpendProcessed`, which genesis cannot produce). No database, no node, no network.
 */

const BLOCK = { net: "dust-test", blockHeight: 12, blockHash: "ab".repeat(32) };

const GENESIS_SYSTEM_TXS: { kind: "system"; rawBytes: Uint8Array }[] = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((line) => ({
  kind: "system" as const,
  rawBytes: new Uint8Array(Buffer.from(line.trim().split(/\s+/)[3]!, "hex")),
}));
const GENESIS_TX_HASHES: string[] = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((line) => line.trim().split(/\s+/)[2]!.toLowerCase());

/** Apply the genesis block with DUST capture on, and hand back the refs it produced. */
async function genesisCapture(): Promise<{ replay: LedgerReplay; events: LedgerEventRef[] }> {
  const replay = LedgerReplay.fromGenesis(await loadLedgerV8(), "undeployed", {
    captureEventTags: DUST_EVENT_TAGS,
  });
  replay.applyBlock({
    transactions: GENESIS_SYSTEM_TXS,
    blockTimestampMs: 1754395200000,
    parentBlockHashHex: "00".repeat(32),
    parentBlockTimestampMs: 0,
  });
  return { replay, events: [...replay.lastBlockEvents!] };
}

describe("dust event capture: the committed fixture is what it claims to be", () => {
  it("frames 300 real preprod events with the recorded checksum and tag mix", () => {
    // A fixture that silently changed -- re-fetched, re-ordered, truncated -- would make every
    // root assertion below a tautology against whatever it now holds.
    const meta = readDustFixtureMeta();
    const blob = readDustFixtureBlob();
    expect(blob.length).toBe(meta.bytes);
    expect(createHash("sha256").update(blob).digest("hex")).toBe(meta.sha256);
    const events = readDustFixtureEvents();
    expect(events.length).toBe(meta.events);
    expect(meta.tags).toEqual({
      notYetSupportedEventType: 2,
      dustInitialUtxo: 127,
      dustGenerationDtimeUpdate: 84,
      dustSpendProcessed: 87,
    });
  });
});

describe("dust event capture: raw bytes replay exactly as the objects do (FR-002 / A-3)", () => {
  it("concatenated Event.serialize() bytes give the same two roots as an object replay", async () => {
    // The property the whole design rests on: what the ingest stores is what the node replays.
    // If these diverge, every wallet's root comparison fails against a node that is not wrong.
    const ledger = await loadLedgerV8();
    const meta = readDustFixtureMeta();
    const dustRaw = readDustFixtureEvents().filter((raw) => {
      const tag = ledger.Event.deserialize(raw).content?.tag;
      return DUST_EVENT_KIND_BY_TAG[tag] !== undefined;
    });
    const sk = ledger.sampleDustSecretKey();
    const blank = (): unknown =>
      new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    const roots = (state: any): [string, string] =>
      [String(state.commitmentTreeRoot()), String(state.generatingTreeRoot())];

    const oneShot = (blank() as any).replayRawEvents(sk, Buffer.concat(dustRaw.map(Buffer.from))).state;
    const objects = (blank() as any).replayEvents(
      sk, dustRaw.map((raw) => ledger.Event.deserialize(raw)),
    );
    let batched: any = blank();
    for (let i = 0; i < dustRaw.length; i += 50) {
      batched = batched.replayRawEvents(
        sk, Buffer.concat(dustRaw.slice(i, i + 50).map(Buffer.from)),
      ).state;
    }

    const expected = meta.rootsAfterEveryFiftyDustEvents.at(-1)!;
    expect(roots(oneShot)).toEqual([expected.commitmentRoot, expected.generatingRoot]);
    expect(roots(objects)).toEqual(roots(oneShot));
    expect(roots(batched)).toEqual(roots(oneShot));
  });

  it("reaches the recorded roots at every 50-event checkpoint, not only at the end", async () => {
    // Equality only at the end would still hold if two compensating errors cancelled out. The
    // node replays in batches, so the intermediate states are what it actually serves from.
    const ledger = await loadLedgerV8();
    const meta = readDustFixtureMeta();
    const dustRaw = readDustFixtureEvents().filter(
      (raw) => DUST_EVENT_KIND_BY_TAG[ledger.Event.deserialize(raw).content?.tag] !== undefined,
    );
    const sk = ledger.sampleDustSecretKey();
    let state: any = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    let applied = 0;
    for (const checkpoint of meta.rootsAfterEveryFiftyDustEvents) {
      // Resumed from wherever the previous batch ended, not from `dustEvents - 50`: the final
      // checkpoint is a short batch, and inserting a leaf twice throws `NonLinearInsertion`.
      state = state.replayRawEvents(
        sk, Buffer.concat(dustRaw.slice(applied, checkpoint.dustEvents).map(Buffer.from)),
      ).state;
      applied = checkpoint.dustEvents;
      expect(String(state.commitmentTreeRoot()), `after ${checkpoint.dustEvents} events`)
        .toBe(checkpoint.commitmentRoot);
      expect(String(state.generatingTreeRoot()), `after ${checkpoint.dustEvents} events`)
        .toBe(checkpoint.generatingRoot);
    }
  });
});

describe("dust event capture: tags map to kinds and columns (spec §5.2, encodings §4)", () => {
  it("maps every fixture event to its kind, in stream order, dropping non-DUST events", async () => {
    const ledger = await loadLedgerV8();
    const refs = readDustFixtureRefs(ledger);
    const rows = mapDustEvents(BLOCK, refs, ledger.dustCommitment);

    // The two `notYetSupportedEventType` events (genesis `OverwriteParameters`) are dropped, and
    // nothing else is.
    expect(rows.length).toBe(refs.length - 2);
    expect(rows.map((r) => r.kind)).toEqual(
      refs.filter((r) => DUST_EVENT_KIND_BY_TAG[r.tag] !== undefined)
        .map((r) => DUST_EVENT_KIND_BY_TAG[r.tag]),
    );
    // Order is the contract (FR-001: "in ledger execution order"), so it is asserted as a total
    // order over (txPosition, eventIndex), not merely as a stable-looking sample.
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(
        a.txPosition < b.txPosition ||
        (a.txPosition === b.txPosition && a.eventIndex < b.eventIndex),
        `row ${i} must follow row ${i - 1} in (txPosition, eventIndex)`,
      ).toBe(true);
    }
    for (const row of rows) {
      expect(row.net).toBe(BLOCK.net);
      expect(row.blockHeight).toBe(BLOCK.blockHeight);
      expect(row.blockHash).toBe(BLOCK.blockHash);
      expect(row.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.raw.length).toBeGreaterThan(0);
      expect(Number.isInteger(row.blockTime)).toBe(true);
    }
  });

  it("encodes a dustInitialUtxo row per §4: decimal field elements, hex bytes, unix seconds", async () => {
    const ledger = await loadLedgerV8();
    const refs = readDustFixtureRefs(ledger);
    const rows = mapDustEvents(BLOCK, refs, ledger.dustCommitment);
    const initial = refs.find((r) => r.tag === "dustInitialUtxo")!;
    const row = rows.find((r) => r.kind === 1 && r.eventIndex === initial.eventIndex &&
      r.txPosition === initial.txPosition)!;
    const output = initial.content.output;

    expect(row.owner).toBe(BigInt(output.owner).toString(10));
    expect(row.commitment).toBe(BigInt(ledger.dustCommitment(output)).toString(10));
    expect(row.commitmentIndex).toBe(BigInt(output.mtIndex));
    expect(row.generationIndex).toBe(BigInt(initial.content.generationIndex));
    expect(row.blockTime).toBe(Math.floor((initial.content.blockTime as Date).getTime() / 1000));
    // A generation with no end time is the normal case and must be absent, never 0.
    expect(row.dtime).toBeUndefined();
    expect(row.nullifier).toBeUndefined();
    expect(row.vFee).toBeUndefined();
    expect(row.declaredTime).toBeUndefined();

    // The payload is what a wallet rebuilds its own QualifiedDustOutput from, so every field is
    // pinned -- including `backingNight`, which spec §5.2 lists as a column but §5.3's DDL does
    // not have (resolved in favour of the DDL; the value lives here).
    expect(row.payload).toEqual({
      output: {
        initialValue: BigInt(output.initialValue).toString(10),
        owner: BigInt(output.owner).toString(10),
        nonce: BigInt(output.nonce).toString(10),
        seq: String(output.seq),
        ctime: Math.floor((output.ctime as Date).getTime() / 1000),
        backingNight: String(output.backingNight).toLowerCase(),
        mtIndex: BigInt(output.mtIndex).toString(10),
      },
      generation: {
        value: BigInt(initial.content.generation.value).toString(10),
        owner: BigInt(initial.content.generation.owner).toString(10),
        nonce: String(initial.content.generation.nonce).toLowerCase(),
        dtime: null,
      },
    });
    expect(String(output.backingNight)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes a dustSpendProcessed row per §4 and carries no owner or generation index", async () => {
    const ledger = await loadLedgerV8();
    const refs = readDustFixtureRefs(ledger);
    const rows = mapDustEvents(BLOCK, refs, ledger.dustCommitment);
    const spend = refs.find((r) => r.tag === "dustSpendProcessed")!;
    const row = rows.find((r) => r.kind === 3 && r.txPosition === spend.txPosition &&
      r.eventIndex === spend.eventIndex)!;

    expect(row.commitment).toBe(BigInt(spend.content.commitment).toString(10));
    expect(row.commitmentIndex).toBe(BigInt(spend.content.commitmentIndex));
    expect(row.nullifier).toBe(BigInt(spend.content.nullifier).toString(10));
    expect(row.vFee).toBe(BigInt(spend.content.vFee).toString(10));
    expect(row.declaredTime).toBe(Math.floor((spend.content.declaredTime as Date).getTime() / 1000));
    expect(row.blockTime).toBe(Math.floor((spend.content.blockTime as Date).getTime() / 1000));
    expect(row.owner).toBeUndefined();
    expect(row.generationIndex).toBeUndefined();
    expect(row.dtime).toBeUndefined();
    expect(row.payload).toEqual({});
    // Nullifier and commitment are field elements: decimal, and never a hex string that would
    // silently parse as a different number.
    expect(row.nullifier).toMatch(/^[0-9]+$/);
    expect(row.commitment).toMatch(/^[0-9]+$/);
  });

  it("carries the new end time of a dustGenerationDtimeUpdate from the update's annotation", async () => {
    // spec §5.2's VERIFY: the annotation was only *believed* to carry the updated dtime, with a
    // path-decoding fallback if it did not. It does -- on every kind-2 event of the fixture.
    const ledger = await loadLedgerV8();
    const refs = readDustFixtureRefs(ledger);
    const rows = mapDustEvents(BLOCK, refs, ledger.dustCommitment);
    const updates = refs.filter((r) => r.tag === "dustGenerationDtimeUpdate");
    expect(updates.length).toBeGreaterThan(50);
    for (const update of updates) {
      const row = rows.find((r) => r.kind === 2 && r.txPosition === update.txPosition &&
        r.eventIndex === update.eventIndex)!;
      const annotation = update.content.update.annotation;
      expect(annotation.dtime, "the annotation must carry a dtime").toBeInstanceOf(Date);
      expect(row.dtime).toBe(Math.floor((annotation.dtime as Date).getTime() / 1000));
      expect(row.generationIndex).toBe(generationIndexFromInsertionPath(update.content.update.path));
      expect(row.owner, "kind 2 rows carry no owner; the kind-1 row has it").toBeUndefined();
      expect(row.commitment).toBeUndefined();
      expect(row.payload).toEqual({
        annotation: {
          value: BigInt(annotation.value).toString(10),
          owner: BigInt(annotation.owner).toString(10),
          nonce: String(annotation.nonce).toLowerCase(),
          dtime: Math.floor((annotation.dtime as Date).getTime() / 1000),
        },
        leafHash: String(update.content.update.leafHash).toLowerCase(),
        pathLength: 32,
      });
    }
  });
});

describe("dust event capture: the generation index comes from the insertion path", () => {
  it("agrees with the nonce lookup on every genesis dtime update", async () => {
    // The check that replaced a `SELECT` per kind-2 event. `TreeInsertionPath.path` is documented
    // "from the leaf up", so its goesLeft flags are the index's bits, least significant first --
    // this proves that reading against the independent source (the kind-1 row that created the
    // entry) on real chain events.
    const { events } = await genesisCapture();
    const byNonce = new Map<string, bigint>();
    for (const event of events) {
      if (event.tag !== "dustInitialUtxo") continue;
      byNonce.set(
        String(event.content.generation.nonce).toLowerCase(),
        BigInt(event.content.generationIndex),
      );
    }
    const updates = events.filter((e) => e.tag === "dustGenerationDtimeUpdate");
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      const nonce = String(update.content.update.annotation.nonce).toLowerCase();
      expect(byNonce.get(nonce), `nonce ${nonce} must have a kind-1 row in this block`)
        .toBe(generationIndexFromInsertionPath(update.content.update.path));
    }
  });

  it("decodes left/right bits least-significant-first and refuses a path it cannot read", () => {
    const left = { goesLeft: true };
    const right = { goesLeft: false };
    expect(generationIndexFromInsertionPath([left, left, left])).toBe(0n);
    expect(generationIndexFromInsertionPath([right, left, left])).toBe(1n);
    expect(generationIndexFromInsertionPath([left, right, left])).toBe(2n);
    expect(generationIndexFromInsertionPath([right, right, right])).toBe(7n);
    // 32 levels, only the top branch going right: 2^31, which a `number`-based decode would still
    // survive but a 33rd level would not -- hence bigint throughout.
    expect(generationIndexFromInsertionPath([...Array(31).fill(left), right])).toBe(2147483648n);
    expect(() => generationIndexFromInsertionPath([])).toThrow(/no insertion path/);
    expect(() => generationIndexFromInsertionPath(undefined)).toThrow(/no insertion path/);
    expect(() => generationIndexFromInsertionPath([left, {}])).toThrow(/goesLeft/);
  });

  it("refuses a block whose own kind-1 row contradicts a dtime update's path", async () => {
    // Writing an end time against the wrong generation entry stops the wrong wallet's DUST from
    // growing, silently. The two independent identifications must agree or the block is refused.
    const ledger = await loadLedgerV8();
    const { events } = await genesisCapture();
    const initial = events.find((e) => e.tag === "dustInitialUtxo")!;
    const update = events.find((e) => e.tag === "dustGenerationDtimeUpdate")!;
    const forged: LedgerEventRef = {
      ...update,
      content: {
        ...update.content,
        update: {
          ...update.content.update,
          annotation: {
            ...update.content.update.annotation,
            nonce: initial.content.generation.nonce,
          },
        },
      },
    };
    const contradicts =
      generationIndexFromInsertionPath(update.content.update.path) !==
      BigInt(initial.content.generationIndex);
    expect(contradicts, "the forged pairing must really be a contradiction").toBe(true);
    expect(() => mapDustEvents(BLOCK, [initial, forged], ledger.dustCommitment))
      .toThrow(/two identifications of the generation entry disagree/);
  });
});
