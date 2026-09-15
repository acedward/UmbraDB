import { readFileSync } from "node:fs";

/**
 * The committed 5 000-event preprod DUST fixture, and the one place its framing is decoded.
 *
 * WHY A SECOND, BIGGER FIXTURE than `test/fixtures/ledger-vectors/dust-events-preprod-300.*`:
 * project A's mapping tests only need to see each of the three event kinds; the node's mirror has
 * to be exercised over several replay BATCHES (the default is 1 000 events per call), and its
 * segment routes have to cut real gaps around leaves that are far enough apart for the cut to
 * mean something. 300 events produce 244 commitment leaves and one batch; 5 000 produce 3 989
 * commitment and 1 381 generation leaves across five batches.
 *
 * WHY A CONTIGUOUS PREFIX and not a sampled mix: `DustLocalState` inserts leaves strictly
 * linearly and throws `NonLinearInsertion` otherwise, so a subset that skips events cannot be
 * replayed at all. This is the first 5 000 events of preprod's own stream, from genesis.
 *
 * Framing: repeated `u32` big-endian length followed by that many bytes of `Event.serialize()` —
 * the same framing the 300-event fixture uses, so one decoder serves both.
 *
 * THE ROOTS IN THE SIBLING `.json` ARE NOT A MIRROR TEST ON THEIR OWN. They were produced with
 * `replayRawEventsRetainingAll`, and the stock `replayRawEvents` reaches exactly the same ones
 * (the `.json` records that it was checked). Root equality therefore cannot tell a correctly
 * built mirror from one that collapsed its trees; only cutting a segment can. See
 * `dust-mirror.test.ts`.
 */

const FIXTURE_URL = new URL("./fixtures/dust-events-preprod-5000.bin", import.meta.url);
const META_URL = new URL("./fixtures/dust-events-preprod-5000.json", import.meta.url);

export interface DustNodeFixtureMeta {
  readonly source: string;
  readonly fetchedUtc: string;
  readonly net: string;
  readonly note: string;
  readonly events: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly tags: Readonly<Record<string, number>>;
  readonly ledgerBuild: string;
  readonly finalCommitmentFirstFree: string;
  readonly finalGenerationFirstFree: string;
  readonly stockReplayRootsAreIdentical: boolean;
  readonly rootsAfterEveryFiveHundredDustEvents: readonly {
    readonly dustEvents: number;
    readonly commitmentFirstFree: string;
    readonly generationFirstFree: string;
    readonly commitmentRoot: string;
    readonly generatingRoot: string;
  }[];
}

/** The fixture's raw bytes, undecoded — for a checksum. */
export function readDustNodeFixtureBlob(): Buffer {
  return readFileSync(FIXTURE_URL);
}

/** The recorded provenance and expected roots. */
export function readDustNodeFixtureMeta(): DustNodeFixtureMeta {
  return JSON.parse(readFileSync(META_URL, "utf8")) as DustNodeFixtureMeta;
}

/** Each event's serialized bytes, in stream order. */
export function readDustNodeFixtureEvents(): Uint8Array[] {
  const blob = readDustNodeFixtureBlob();
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
