import { readFileSync } from "node:fs";
import type { LedgerEventRef } from "../../chain-archive-sync/ledger-replay.js";

/**
 * The committed preprod DUST ledger-event fixture, and the one place its framing is decoded.
 *
 * WHY A REAL PREPROD PREFIX rather than only the genesis vectors this repo already carries: the
 * genesis system transactions produce `dustInitialUtxo` and `dustGenerationDtimeUpdate` events but
 * NO `dustSpendProcessed` -- a spend needs a fee-paying transaction, which genesis has none of. A
 * third of the mapping (`kind = 3`: nullifier, commitment index, fee, declared time) would
 * otherwise be tested only against something this repo made up.
 *
 * WHY A CONTIGUOUS PREFIX and not a hand-picked mix of the three kinds: `DustLocalState` inserts
 * leaves strictly linearly and throws `NonLinearInsertion` otherwise, so a subset that skips
 * events cannot be replayed at all. The fixture is the first 300 events of the stream, from
 * genesis.
 *
 * Framing: repeated `u32` big-endian length followed by that many bytes of `Event.serialize()`.
 * Provenance, tag mix, checksum and the expected tree roots every 50 DUST events are in the
 * sibling `.json`.
 */

const FIXTURE_URL = new URL("../fixtures/ledger-vectors/dust-events-preprod-300.bin", import.meta.url);
const META_URL = new URL("../fixtures/ledger-vectors/dust-events-preprod-300.json", import.meta.url);

export interface DustFixtureMeta {
  source: string;
  fetchedUtc: string;
  net: string;
  note: string;
  events: number;
  bytes: number;
  sha256: string;
  tags: Record<string, number>;
  ledgerBuild: string;
  rootsAfterEveryFiftyDustEvents: {
    dustEvents: number;
    commitmentRoot: string;
    generatingRoot: string;
  }[];
}

/** The fixture's raw bytes, undecoded -- for a checksum, or to re-frame them elsewhere. */
export function readDustFixtureBlob(): Buffer {
  return readFileSync(FIXTURE_URL);
}

/** The recorded provenance and expected roots. */
export function readDustFixtureMeta(): DustFixtureMeta {
  return JSON.parse(readFileSync(META_URL, "utf8")) as DustFixtureMeta;
}

/** Each event's serialized bytes, in stream order. */
export function readDustFixtureEvents(): Uint8Array[] {
  const blob = readDustFixtureBlob();
  const events: Uint8Array[] = [];
  let offset = 0;
  while (offset < blob.length) {
    const length = blob.readUInt32BE(offset);
    offset += 4;
    events.push(new Uint8Array(blob.subarray(offset, offset + length)));
    offset += length;
  }
  return events;
}

/**
 * The fixture as the refs `LedgerReplay` would have captured, so the mapping can be exercised
 * without a chain.
 *
 * `txPosition`/`eventIndex` are synthesized by grouping consecutive events that share a
 * transaction hash -- which is what a block's event list actually looks like -- rather than
 * invented per event, so the ordering assertions mean something.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readDustFixtureRefs(ledger: any): LedgerEventRef[] {
  const refs: LedgerEventRef[] = [];
  let txPosition = -1;
  let eventIndex = 0;
  let previousHash: string | undefined;
  for (const raw of readDustFixtureEvents()) {
    const event = ledger.Event.deserialize(raw);
    const content = event.content;
    const txHash = String(event.source?.transactionHash ?? "").replace(/^0x/, "").toLowerCase();
    if (txHash !== previousHash) {
      txPosition += 1;
      eventIndex = 0;
      previousHash = txHash;
    }
    refs.push({
      txPosition,
      eventIndex: eventIndex++,
      txKind: "system",
      txHash,
      tag: typeof content?.tag === "string" ? content.tag : "",
      raw,
      content,
    });
  }
  return refs;
}
