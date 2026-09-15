import { DustSyncError } from "./errors.js";
import type { DustGenerationValue, DustQdo } from "./ledger.js";
import type { DustGenerationItem, DustGenerationWire, DustOutputWire } from "./types.js";

/**
 * The one place §4's wire encodings become WASM values, and the range arithmetic §5.5 steps 3 and
 * 6 are built on.
 *
 * Pure and dependency-free, so both directions of the contract — "this is what the node sends"
 * and "this is what the ledger accepts" — can be tested without a node, a database or the WASM.
 */

/** A decimal string from the node → `bigint`. Refuses anything else rather than coercing: `BigInt`
 *  happily accepts `""` (0) and `"0x10"` (16), and both would be silently wrong values here. */
export function toBigInt(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]{0,79})$/.test(value)) {
    throw new DustSyncError("DUST_SYNC_HTTP", `${field} is not a decimal integer`, { field });
  }
  return BigInt(value);
}

/** Integer unix SECONDS → the `Date` the WASM bindings expect (`js_date_to_seconds` truncates, so
 *  a whole second in is the same second out). */
export function dateFromSeconds(seconds: number, field: string): Date {
  if (!Number.isInteger(seconds)) {
    throw new DustSyncError("DUST_SYNC_HTTP", `${field} is not an integer unix second`, { field });
  }
  return new Date(seconds * 1000);
}

/** `Date` → integer unix seconds, for reporting a state's own timestamps back as §4 encodes them. */
export function secondsFromDate(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** A `dustInitialUtxo`'s `payload.output` → the `QualifiedDustOutput` the ledger accepts. */
export function qdoFromWire(output: DustOutputWire): DustQdo {
  const seq = Number(toBigInt(output.seq, "output.seq"));
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 0xffff_ffff) {
    throw new DustSyncError("DUST_SYNC_HTTP", "output.seq is outside u32", { seq: output.seq });
  }
  return {
    initialValue: toBigInt(output.initialValue, "output.initialValue"),
    owner: toBigInt(output.owner, "output.owner"),
    nonce: toBigInt(output.nonce, "output.nonce"),
    seq,
    ctime: dateFromSeconds(output.ctime, "output.ctime"),
    backingNight: requireHex(output.backingNight, "output.backingNight"),
    mtIndex: toBigInt(output.mtIndex, "output.mtIndex"),
  };
}

/** A generation entry → the `DustGenerationInfo` the ledger accepts. `dtime: null` on the wire is
 *  "no end time", which the bindings spell as `undefined` (and the ledger as `Timestamp::MAX`). */
export function generationFromWire(entry: DustGenerationItem | DustGenerationWire): DustGenerationValue {
  return {
    value: toBigInt(entry.value, "generation.value"),
    owner: toBigInt(entry.owner, "generation.owner"),
    nonce: requireHex(entry.nonce, "generation.nonce"),
    dtime: entry.dtime === null ? undefined : dateFromSeconds(entry.dtime, "generation.dtime"),
  };
}

function requireHex(value: string, field: string): string {
  if (!/^[0-9a-f]*$/.test(value) || value.length % 2 !== 0) {
    throw new DustSyncError("DUST_SYNC_HTTP", `${field} is not lowercase hex without 0x`, { field });
  }
  return value;
}

/** Hex without `0x` → bytes, for a segment's `update`. */
export function bytesFromHex(value: string, field: string): Uint8Array {
  const clean = requireHex(value, field);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** One inclusive `[start, end]` range of a tree. */
export interface Range {
  readonly start: bigint;
  readonly end: bigint;
}

/**
 * The complement of `own` within `[0, firstFree − 1]`: exactly the ranges §5.5 asks the node to
 * cut, ascending and non-overlapping.
 *
 * Two edge cases of the spec fall out of the arithmetic rather than being special-cased:
 * adjacent own leaves (`l`, `l+1`) produce no range between them, and an own leaf that IS the
 * tree's last leaf produces no trailing range. A range with `start > end` is therefore never
 * emitted, which is what FR-014 refuses.
 */
export function gapRanges(own: readonly bigint[], firstFree: bigint): Range[] {
  const ranges: Range[] = [];
  let cursor = 0n;
  for (const index of own) {
    if (index < cursor) {
      throw new DustSyncError("DUST_SYNC_INVALID_INPUT", "own leaf indices must be sorted and unique", {
        index: index.toString(10),
      });
    }
    if (index >= firstFree) {
      // The node's trees are behind a row its table already returned. Reported as index lag by
      // the caller, which can wait; inserting here would earn a `NonLinearInsertion` instead.
      throw new DustSyncError("DUST_SYNC_INDEX_LAG", "an own leaf is at or past the tree's firstFree", {
        index: index.toString(10),
        firstFree: firstFree.toString(10),
      });
    }
    if (index > cursor) ranges.push({ start: cursor, end: index - 1n });
    cursor = index + 1n;
  }
  if (cursor < firstFree) ranges.push({ start: cursor, end: firstFree - 1n });
  return ranges;
}

/** `ranges=s-e,s-e,…` as §4 spells it. */
export function rangesParam(ranges: readonly Range[]): string {
  return ranges.map((range) => `${range.start.toString(10)}-${range.end.toString(10)}`).join(",");
}

/** At most this many ranges per `GET /v1/dust/segments` (spec §4; the node refuses 257). A wallet
 *  with more gaps than this splits them over several requests, which the sync then requires to
 *  report the same `atEventId`. */
export const MAX_RANGES_PER_REQUEST = 256;

/** At most this many nullifiers per `POST /v1/dust/lookup` (spec §4, FR-015). */
export const MAX_NULLIFIERS_PER_REQUEST = 1_000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
