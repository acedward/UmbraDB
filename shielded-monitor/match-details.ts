import {
  GUARANTEED_SEGMENT_ID,
  LEDGER_BUILD_ID,
  loadLedger,
  type EncryptionSecretKeyHandle,
  type ExtractedOffers,
} from "./offers.js";

/**
 * The PUBLIC zswap data of one matched transaction, per segment (organizer sub-plan 00009-07).
 *
 * A match today is a block height, a position and a transaction hash — true, checkable, and
 * completely opaque to anyone looking at it. Everything this module records is already public on
 * chain: the commitment of every output (a new shielded coin), the nullifier of every input (a
 * spent one), the commitment/nullifier pair of every transient (a coin created and spent in the
 * same transaction) and the contract address of any entry delivered to a contract. None of it is
 * derived from the viewing key; the key is used for exactly one thing, and it is the thing this
 * module is careful about:
 *
 * ── `mine` is three-valued, and every value is entailed by the ledger ────────────────────────
 *
 * The sub-plan asked for `mine` per output via `esk.test(ZswapOffer.fromOutput(output))`. That
 * call is real and it is exact — **for an unproven output**. Every archived transaction is
 * proven, and for a proven output the ledger refuses:
 *
 * ```text
 *   ZswapOffer cannot be constructed from a proven or proof-erased output.
 * ```
 *
 * (`ledger-wasm/src/zswap_wasm.rs:592-608` in the pinned ledger source matches `UnprovenOutput`
 * only; `fromInput`, `fromTransient` and `Transaction.addCalls` refuse proven values the same
 * way.) `EncryptionSecretKey.test(offer)` itself is an `any()` over the ciphertexts of **all**
 * outputs and transients of an offer (`ledger-wasm/src/zswap_keys.rs:289-320`) and the WASM
 * exposes no per-entry variant, no ciphertext accessor, and no per-coin API that does not need
 * the full `ZswapSecretKeys` a viewing-key monitor does not hold. The reference Midnight indexer
 * sits on the same boundary. Recorded as organizer question **Q22 `[07]`**.
 *
 * So `mine` is `true | false | null`, and each value means something the ledger actually
 * entails:
 *
 * | value | meaning | why it is sound |
 * |---|---|---|
 * | `false` | this entry is NOT yours | either its segment's `test(offer)` was `false` — and `test` is an `any()` over every ciphertext in that offer, so a `false` there is a `false` for every entry of it — or the entry names a contract address, and a contract-owned entry carries no user ciphertext at all (the spec's documented false-negative class, asserted in `relevance.test.ts`) |
 * | `true` | this entry IS yours | its segment matched and, after removing the contract-owned entries, it is the ONLY candidate left; something in the segment decrypted, and there is nothing else it could have been. Or the exact isolation succeeded (unproven offers only) |
 * | `null` | not attributable with a viewing key alone | its segment matched and two or more candidates remain. The segment's {@link MatchSegmentDetail.mineAmong} says how many, so "one of these two outputs is yours" is still sayable — and it is the honest sentence |
 *
 * Exact isolation is still ATTEMPTED first, once per matched segment that the deduction cannot
 * settle. It costs one refused WASM call on the archived shape and it is what makes this module
 * upgrade itself for free if a future ledger relaxes the constraint — and
 * `match-details.test.ts` pins the measured refusal, so the finding cannot rot into folklore.
 */

/** Bumped when the SHAPE or the derivation of {@link MatchDetails} changes, so a stored row always
 *  says which rule produced it — the same discipline `MATCHING_RULE_VERSION` applies to matches.
 *  A backfill that re-computes a row under a new version overwrites the old value; a reader that
 *  cares can compare. */
export const MATCH_DETAILS_VERSION = "shielded-monitor/match-details/v1";

/** Per-list cap. A block may legally hold a transaction with thousands of outputs, and this JSON
 *  travels to a browser and into a `jsonb` column; an uncapped list would make one pathological
 *  transaction able to bloat both. The count BEFORE truncation is always kept
 *  ({@link MatchSegmentDetail.counts}), so a truncated list can never read as a short one. */
export const MAX_DETAIL_ENTRIES = 256;

/** `true` = yours, `false` = not yours, `null` = not attributable with a viewing key alone. */
export type MineAttribution = boolean | null;

/** One zswap OUTPUT: a new shielded coin created by this transaction. */
export interface MatchOutputDetail {
  /** Position within its segment's output list, as the ledger returns them. */
  readonly index: number;
  /** The coin commitment, hex, exactly as the WASM returns it. */
  readonly commitment: string;
  /** Present when the coin is delivered to a contract rather than encrypted to a user key. */
  readonly contractAddress?: string;
  readonly mine: MineAttribution;
}

/** One zswap INPUT: a coin this transaction spends. Inputs carry no ciphertext at all — the
 *  ledger's relevance predicate never examines them (receive-side only) — so there is no `mine`
 *  to state and none is invented. */
export interface MatchInputDetail {
  readonly index: number;
  /** The spent coin's nullifier, hex. */
  readonly nullifier: string;
  readonly contractAddress?: string;
}

/** One TRANSIENT: a coin created and spent inside the same transaction, so it carries both a
 *  commitment and a nullifier. `test` examines transient ciphertexts, so `mine` applies. */
export interface MatchTransientDetail {
  readonly index: number;
  readonly commitment: string;
  readonly nullifier: string;
  readonly contractAddress?: string;
  readonly mine: MineAttribution;
}

/** One zswap segment. Segment 0 is the guaranteed section (the ledger's own numbering — see
 *  {@link GUARANTEED_SEGMENT_ID}); every other id is a fallible segment. */
export interface MatchSegmentDetail {
  readonly segment: number;
  /** `EncryptionSecretKey.test(offer)` for this segment — the same call that decided the match. */
  readonly matched: boolean;
  readonly outputs: readonly MatchOutputDetail[];
  readonly inputs: readonly MatchInputDetail[];
  readonly transients: readonly MatchTransientDetail[];
  /** The TRUE sizes, before {@link MAX_DETAIL_ENTRIES} truncation. */
  readonly counts: { readonly outputs: number; readonly inputs: number; readonly transients: number };
  /** Present only when at least one list was truncated. */
  readonly truncated?: true;
  /** Present when the segment matched but no single entry could be pinned: the number of
   *  candidates (ciphertext-bearing outputs plus transients) among which AT LEAST ONE is yours.
   *  Always `>= 2` when present — one candidate is attributed as `mine: true` instead. */
  readonly mineAmong?: number;
}

/** The public zswap data of one matched transaction. Stored as `associations.details` (jsonb) and
 *  returned as the API's `details` object. */
export interface MatchDetails {
  /** {@link MATCH_DETAILS_VERSION} — which rule produced this row. */
  readonly version: string;
  /** The ledger build that read the bytes, so a row never has to be trusted to have been produced
   *  by the build that is loaded now. */
  readonly ledgerBuild: string;
  /** Ascending by segment id; the guaranteed section (0) first when present. */
  readonly segments: readonly MatchSegmentDetail[];
  readonly totals: {
    readonly outputs: number;
    readonly inputs: number;
    readonly transients: number;
    /** Entries (outputs + transients) attributed `mine: true`. */
    readonly mine: number;
    /** Entries attributed `mine: null` — candidates in a matched segment that could not be
     *  pinned. `mine + unattributed === 0` is possible and normal (a match in a segment whose
     *  only candidate is pinned gives `mine: 1`). */
    readonly unattributed: number;
  };
  /** Present when any list in any segment was truncated. */
  readonly truncated?: true;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Releases a WASM wrapper without letting a missing or throwing `free` take down a scan. The
 *  module registers a `FinalizationRegistry` for every wrapper, so this is hygiene for a
 *  long-running scanner (bounding how much WASM memory one batch can hold), never correctness. */
function release(handle: any): void {
  try {
    handle?.free?.();
  } catch {
    /* already freed, or a build without `free` — GC still reclaims it */
  }
}

/** Reads a WASM string getter that may legitimately be absent (`contractAddress` is
 *  `string | undefined`), normalising `null` to `undefined` so the JSON shape has one spelling
 *  for "not present". */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One ciphertext-bearing entry as it comes out of the ledger, before attribution. */
interface RawEntry {
  readonly kind: "output" | "transient";
  readonly index: number;
  readonly commitment: string;
  readonly nullifier?: string;
  readonly contractAddress?: string;
  /** The live WASM handle, kept only long enough to attempt exact isolation. */
  readonly handle: any;
}

/**
 * Attempts the sub-plan's exact attribution: isolate ONE entry into its own offer and ask the key.
 *
 * Returns `undefined` when the ledger refuses — which is what it does for every proven (i.e.
 * every archived) value, measured and recorded as Q22. Deliberately NOT silent about being a
 * best-effort path: the caller falls back to the deduction, which is sound on its own.
 */
function isolateAndTest(
  ledger: any, key: EncryptionSecretKeyHandle, entry: RawEntry,
): boolean | undefined {
  let singleton: any;
  try {
    singleton = entry.kind === "output"
      ? ledger.ZswapOffer.fromOutput(entry.handle)
      : ledger.ZswapOffer.fromTransient(entry.handle);
    return Boolean(key.test(singleton));
  } catch {
    // "ZswapOffer cannot be constructed from a proven or proof-erased output." — the archived
    // shape. Not an error: the caller has a sound fallback.
    return undefined;
  } finally {
    if (singleton !== undefined) release(singleton);
  }
}

/** Reads one WASM array getter defensively: the vendored module ships `any[]` for these, and a
 *  missing getter must degrade to "no entries", never to a thrown scan. */
function readArray(offer: any, name: "outputs" | "inputs" | "transients"): any[] {
  const value = offer?.[name];
  return Array.isArray(value) ? value : [];
}

/**
 * Builds the detail record for ONE matched transaction from offers that have already been
 * extracted and tested.
 *
 * `matchedSegments` is the set the relevance predicate produced, so the `matched` flags here are
 * the very booleans that decided the match rather than a second, possibly divergent evaluation.
 *
 * `key` is used ONLY for the optional exact-isolation attempt, and only for a matched segment
 * whose attribution the deduction cannot settle — so a transaction that is not a match costs no
 * extra trial decryption at all, and a matched one costs at most one refused WASM call per
 * ambiguous segment.
 */
export async function buildMatchDetails(
  offers: ExtractedOffers,
  key: EncryptionSecretKeyHandle,
  matchedSegments: Iterable<number>,
): Promise<MatchDetails> {
  const ledger = await loadLedger();
  const matched = new Set<number>(matchedSegments);

  const pairs: [number, unknown][] = [];
  if (offers.guaranteed !== undefined) pairs.push([GUARANTEED_SEGMENT_ID, offers.guaranteed]);
  for (const [segment, offer] of offers.fallible) pairs.push([segment, offer]);
  pairs.sort((a, b) => a[0] - b[0]);

  const segments: MatchSegmentDetail[] = [];
  let anyTruncated = false;
  let totalOutputs = 0;
  let totalInputs = 0;
  let totalTransients = 0;
  let totalMine = 0;
  let totalUnattributed = 0;

  for (const [segment, offer] of pairs) {
    const isMatched = matched.has(segment);
    const rawOutputs = readArray(offer, "outputs");
    const rawInputs = readArray(offer, "inputs");
    const rawTransients = readArray(offer, "transients");

    const counts = {
      outputs: rawOutputs.length,
      inputs: rawInputs.length,
      transients: rawTransients.length,
    };
    totalOutputs += counts.outputs;
    totalInputs += counts.inputs;
    totalTransients += counts.transients;
    const truncated =
      counts.outputs > MAX_DETAIL_ENTRIES ||
      counts.inputs > MAX_DETAIL_ENTRIES ||
      counts.transients > MAX_DETAIL_ENTRIES;
    if (truncated) anyTruncated = true;

    const readEntry = (kind: "output" | "transient") => (handle: any, index: number): RawEntry => {
      const contractAddress = optionalString(handle?.contractAddress);
      return {
        kind,
        index,
        commitment: String(handle?.commitment ?? ""),
        ...(kind === "transient" ? { nullifier: String(handle?.nullifier ?? "") } : {}),
        ...(contractAddress === undefined ? {} : { contractAddress }),
        handle,
      };
    };
    const outputEntries = rawOutputs.slice(0, MAX_DETAIL_ENTRIES).map(readEntry("output"));
    const transientEntries = rawTransients.slice(0, MAX_DETAIL_ENTRIES).map(readEntry("transient"));

    // ── Attribution ─────────────────────────────────────────────────────────────────────────
    //
    // A candidate is an entry that can carry a user ciphertext at all, i.e. one NOT delivered to
    // a contract. `test` is an `any()` over exactly those ciphertexts, so:
    //   - segment not matched  → nothing in it decrypted → every entry is `false`, certainly;
    //   - segment matched      → a contract-owned entry is still `false`, certainly, and if the
    //                            candidates reduce to one, that one is `true`, certainly.
    const isCandidate = (e: RawEntry): boolean => e.contractAddress === undefined;
    const candidates = isMatched
      ? [...outputEntries, ...transientEntries].filter(isCandidate)
      : [];

    const mineOf = new Map<RawEntry, MineAttribution>();
    if (!isMatched) {
      for (const e of [...outputEntries, ...transientEntries]) mineOf.set(e, false);
    } else {
      for (const e of [...outputEntries, ...transientEntries]) {
        mineOf.set(e, isCandidate(e) ? null : false);
      }
      if (candidates.length === 1) {
        mineOf.set(candidates[0]!, true);
      } else if (candidates.length > 1) {
        // Try the exact route before settling for `null`. On archived (proven) bytes every call
        // here is refused and the map is left as it is; on unproven offers it resolves the
        // segment completely.
        let resolvedAny = false;
        for (const e of candidates) {
          const exact = isolateAndTest(ledger, key, e);
          if (exact === undefined) break;
          mineOf.set(e, exact);
          resolvedAny = true;
        }
        if (resolvedAny && candidates.some((e) => mineOf.get(e) === null)) {
          // A partial resolution would be a mixture of two derivations; refuse it and keep the
          // deduction's answer, which is uniform.
          for (const e of candidates) mineOf.set(e, null);
        }
      }
    }

    const outputs: MatchOutputDetail[] = outputEntries.map((e) => ({
      index: e.index,
      commitment: e.commitment,
      ...(e.contractAddress === undefined ? {} : { contractAddress: e.contractAddress }),
      mine: mineOf.get(e) ?? null,
    }));
    const transients: MatchTransientDetail[] = transientEntries.map((e) => ({
      index: e.index,
      commitment: e.commitment,
      nullifier: e.nullifier ?? "",
      ...(e.contractAddress === undefined ? {} : { contractAddress: e.contractAddress }),
      mine: mineOf.get(e) ?? null,
    }));
    const inputs: MatchInputDetail[] = rawInputs.slice(0, MAX_DETAIL_ENTRIES).map((handle, index) => {
      const contractAddress = optionalString(handle?.contractAddress);
      const entry: MatchInputDetail = {
        index,
        nullifier: String(handle?.nullifier ?? ""),
        ...(contractAddress === undefined ? {} : { contractAddress }),
      };
      release(handle);
      return entry;
    });

    for (const e of [...outputEntries, ...transientEntries]) release(e.handle);
    for (const handle of rawOutputs.slice(MAX_DETAIL_ENTRIES)) release(handle);
    for (const handle of rawTransients.slice(MAX_DETAIL_ENTRIES)) release(handle);
    for (const handle of rawInputs.slice(MAX_DETAIL_ENTRIES)) release(handle);

    const pinned = [...outputs, ...transients].filter((e) => e.mine === true).length;
    const unattributed = [...outputs, ...transients].filter((e) => e.mine === null).length;
    totalMine += pinned;
    totalUnattributed += unattributed;

    segments.push({
      segment,
      matched: isMatched,
      outputs,
      inputs,
      transients,
      counts,
      ...(truncated ? { truncated: true as const } : {}),
      ...(unattributed > 0 ? { mineAmong: candidates.length } : {}),
    });
  }

  return {
    version: MATCH_DETAILS_VERSION,
    ledgerBuild: LEDGER_BUILD_ID,
    segments,
    totals: {
      outputs: totalOutputs,
      inputs: totalInputs,
      transients: totalTransients,
      mine: totalMine,
      unattributed: totalUnattributed,
    },
    ...(anyTruncated ? { truncated: true as const } : {}),
  };
}
