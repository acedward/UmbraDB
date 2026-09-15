import type { DustEventKind, DustEventRecord, Hex32 } from "../src/interfaces/chain-archive-store.js";
import type { LedgerEventRef } from "./ledger-replay.js";

/**
 * WASM `Event.content` -> `chain_archive.dust_events` columns
 * (`spec/00016-dust-wallet-sync.md` §5.2, encodings §4).
 *
 * PURE ON PURPOSE. Nothing here touches a database, a node or the ledger state; the input is the
 * events `LedgerReplay` already captured and the output is rows. That is what lets the mapping be
 * tested against real chain events -- the committed genesis vectors and a real preprod sample --
 * without standing up anything, and it is the only place the three DUST tags are turned into the
 * `kind` values every later query filters on.
 *
 * THE SHAPES, read from `ledger-wasm/src/conversions.rs` (`PreEventDetails`) and confirmed against
 * real events from both a 1.0.0 devnet genesis and preprod:
 *
 *   dustInitialUtxo            { output: QualifiedDustOutput, generation: DustGenerationInfo,
 *                                generationIndex: bigint, blockTime: Date }
 *   dustGenerationDtimeUpdate  { update: { leafHash: hex, annotation: DustGenerationInfo,
 *                                path: [{ hash, goesLeft }] }, blockTime: Date }
 *   dustSpendProcessed         { commitment, commitmentIndex, nullifier, vFee,
 *                                declaredTime: Date, blockTime: Date }
 *
 * where `QualifiedDustOutput = { initialValue: bigint, owner: bigint, nonce: bigint, seq: number,
 * ctime: Date, backingNight: hex, mtIndex: bigint }` and `DustGenerationInfo = { value: bigint,
 * owner: bigint, nonce: hex, dtime?: Date }`.
 */

/** `dustInitialUtxo`. */
export const DUST_INITIAL_UTXO_TAG = "dustInitialUtxo";
/** `dustGenerationDtimeUpdate`. */
export const DUST_GENERATION_DTIME_UPDATE_TAG = "dustGenerationDtimeUpdate";
/** `dustSpendProcessed`. */
export const DUST_SPEND_PROCESSED_TAG = "dustSpendProcessed";

/**
 * The event tags the ingest keeps (FR-001), and the `kind` each maps to.
 *
 * Every OTHER ledger event is dropped, including the `ParamChange` and zswap events that also
 * travel in the indexer's `dustLedgerEvents` stream: a `DustLocalState` ignores them entirely
 * (measured -- replaying with and without them yields identical tree roots), so storing them
 * would cost bytes and buy nothing. See Q-9 for the one consequence that is not nothing: a future
 * DUST parameter change would not be visible here.
 */
export const DUST_EVENT_KIND_BY_TAG: Readonly<Record<string, DustEventKind>> = Object.freeze({
  [DUST_INITIAL_UTXO_TAG]: 1,
  [DUST_GENERATION_DTIME_UPDATE_TAG]: 2,
  [DUST_SPEND_PROCESSED_TAG]: 3,
});

/** The three tags, for `LedgerReplayOptions.captureEventTags`. */
export const DUST_EVENT_TAGS: readonly string[] = Object.freeze(Object.keys(DUST_EVENT_KIND_BY_TAG));

/** A field element or magnitude as the archive stores it: a decimal string (spec §4). The WASM
 *  hands these over as `BigInt`, and `numeric` is the only Postgres type that keeps a 254-bit
 *  value exactly. */
function decimal(value: unknown): string {
  return BigInt(value as bigint | number | string).toString(10);
}

/** A `u64` tree index, kept as `bigint` so it never rounds through a `number`. */
function index(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

/** Lowercase hex without `0x`, the archive's convention for every byte string. */
function hex(value: unknown): string {
  return String(value).replace(/^0x/, "").toLowerCase();
}

/**
 * A WASM `Date` as integer unix SECONDS (spec §4).
 *
 * The ledger's own times are whole seconds (`Timestamp::to_secs`), so this is lossless; flooring
 * rather than rounding matches `LedgerReplay`'s own ms->s conversion, so a time never moves
 * forward by a second somewhere in the pipeline.
 */
function unixSeconds(value: unknown): number {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`dust event carries a non-finite timestamp (${String(value)})`);
  }
  return Math.floor(ms / 1000);
}

/** `undefined`/`null` stay absent; anything else becomes unix seconds. A DUST generation entry
 *  with no end time is the normal case, not a decode failure. */
function optionalUnixSeconds(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : unixSeconds(value);
}

/**
 * The leaf index a `TreeInsertionPath` describes.
 *
 * `TreeInsertionPath.path` is documented "from the leaf up"
 * (`transient-crypto/src/merkle_tree.rs`), one entry per level of the 32-deep tree, each saying
 * whether the path went LEFT at that branch. Left is a 0 bit, right a 1, and the first entry is
 * the branch immediately above the leaf -- so the entries are the index's bits, least significant
 * first.
 *
 * WHY THIS AND NOT A DATABASE LOOKUP. A `dustGenerationDtimeUpdate` names its generation entry
 * only through this path and the entry's own initial nonce; the spec's fallback was to look the
 * nonce up in the already-stored kind-1 rows. That is one indexed `SELECT` per kind-2 event --
 * roughly 300 000 of them over preprod's history, in the ingest's hot path, plus an expression
 * index to make them cheap. The path carries the answer for free. Checked against the nonce
 * lookup on every kind-2 event of the committed genesis vectors (13/13 exact), and cross-checked
 * again at map time whenever the matching kind-1 row is in the same block (see
 * {@link mapDustEvents}).
 */
export function generationIndexFromInsertionPath(path: unknown): bigint {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error(
      "dustGenerationDtimeUpdate carries no insertion path, so the generation entry it updates " +
        "cannot be identified. Refusing to guess an index: a dtime written against the wrong " +
        "entry would silently stop the wrong wallet's DUST from growing.",
    );
  }
  let result = 0n;
  for (const [level, entry] of (path as { goesLeft?: unknown }[]).entries()) {
    if (typeof entry?.goesLeft !== "boolean") {
      throw new Error(
        `dustGenerationDtimeUpdate insertion path entry ${level} has no goesLeft flag; the ` +
          "generation index cannot be decoded from it.",
      );
    }
    if (!entry.goesLeft) result |= 1n << BigInt(level);
  }
  return result;
}

/** The DUST-side view of a `QualifiedDustOutput`, in the spec's §4 encodings. */
function outputPayload(output: Record<string, unknown>): Record<string, unknown> {
  return {
    initialValue: decimal(output.initialValue),
    owner: decimal(output.owner),
    nonce: decimal(output.nonce),
    seq: decimal(output.seq),
    ctime: unixSeconds(output.ctime),
    backingNight: hex(output.backingNight),
    mtIndex: decimal(output.mtIndex),
  };
}

/** The DUST-side view of a `DustGenerationInfo`, in the spec's §4 encodings. `dtime` is `null`
 *  rather than absent so a JSON consumer can tell "no end time" from "field not written". */
function generationPayload(generation: Record<string, unknown>): Record<string, unknown> {
  return {
    value: decimal(generation.value),
    owner: decimal(generation.owner),
    nonce: hex(generation.nonce),
    dtime: optionalUnixSeconds(generation.dtime) ?? null,
  };
}

/** Where the events of one block came from, so a row can name its block without the caller
 *  repeating itself per event. */
export interface DustEventBlockContext {
  net: string;
  blockHeight: number;
  blockHash: Hex32;
}

/**
 * Map one block's captured ledger events to `dust_events` rows, in the order they were produced.
 *
 * Non-DUST events are skipped rather than rejected: `LedgerReplay` is normally configured to
 * capture only the three tags, but the mapping must stay correct if it is handed more.
 *
 * `dustCommitment` is computed with the ledger's own free function -- the commitment is not in
 * the event, and re-deriving it in JavaScript would be a second implementation of a hash the
 * chain already defines. The function is injected rather than imported so this module stays free
 * of the WASM (the rest of `chain-archive-sync` loads it through `loadLedgerV8`).
 */
export function mapDustEvents(
  block: DustEventBlockContext,
  events: readonly LedgerEventRef[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dustCommitment: (output: any) => bigint | string,
): DustEventRecord[] {
  const rows: DustEventRecord[] = [];
  /** Initial nonce (hex) -> generation index, for this block's own kind-1 rows. Used only to
   *  CHECK the path-derived index of a kind-2 event in the same block, never to supply it. */
  const generationIndexByNonce = new Map<string, bigint>();

  for (const event of events) {
    const kind = DUST_EVENT_KIND_BY_TAG[event.tag];
    if (kind === undefined) continue;
    const content = event.content as Record<string, any>;
    const base = {
      net: block.net,
      blockHeight: block.blockHeight,
      blockHash: block.blockHash,
      txPosition: event.txPosition,
      eventIndex: event.eventIndex,
      txHash: event.txHash,
      raw: event.raw,
    };

    if (kind === 1) {
      const output = content.output as Record<string, unknown>;
      const generation = content.generation as Record<string, unknown>;
      const generationIndex = index(content.generationIndex);
      generationIndexByNonce.set(hex(generation.nonce), generationIndex);
      rows.push({
        ...base,
        kind: 1,
        owner: decimal(output.owner),
        commitment: decimal(dustCommitment(output)),
        commitmentIndex: index(output.mtIndex),
        generationIndex,
        blockTime: unixSeconds(content.blockTime),
        dtime: optionalUnixSeconds(generation.dtime),
        payload: {
          output: outputPayload(output),
          generation: generationPayload(generation),
        },
      });
      continue;
    }

    if (kind === 2) {
      const update = content.update as Record<string, any>;
      const annotation = update.annotation as Record<string, unknown>;
      const generationIndex = generationIndexFromInsertionPath(update.path);
      // The cross-check the path derivation replaced, kept where it is free: when the entry this
      // update touches was CREATED in this same block, the kind-1 row already says which index it
      // got. Disagreement means one of the two readings of the event is wrong, and writing a
      // dtime against the wrong generation entry is exactly the silent corruption this refuses.
      const fromNonce = generationIndexByNonce.get(hex(annotation.nonce));
      if (fromNonce !== undefined && fromNonce !== generationIndex) {
        throw new Error(
          `height ${block.blockHeight}: a dustGenerationDtimeUpdate's insertion path decodes to ` +
            `generation index ${generationIndex}, but the dustInitialUtxo in this same block that ` +
            `created nonce ${hex(annotation.nonce)} was given index ${fromNonce}. The event's own ` +
            "two identifications of the generation entry disagree, so one of them would attach " +
            "this end time to the wrong entry. Refusing the block.",
        );
      }
      rows.push({
        ...base,
        kind: 2,
        generationIndex,
        blockTime: unixSeconds(content.blockTime),
        dtime: optionalUnixSeconds(annotation.dtime),
        payload: {
          annotation: generationPayload(annotation),
          leafHash: hex(update.leafHash),
          pathLength: Array.isArray(update.path) ? update.path.length : 0,
        },
      });
      continue;
    }

    rows.push({
      ...base,
      kind: 3,
      commitment: decimal(content.commitment),
      commitmentIndex: index(content.commitmentIndex),
      nullifier: decimal(content.nullifier),
      vFee: decimal(content.vFee),
      declaredTime: unixSeconds(content.declaredTime),
      blockTime: unixSeconds(content.blockTime),
      payload: {},
    });
  }

  return rows;
}
