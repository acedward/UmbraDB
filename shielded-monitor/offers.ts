import { isSupportedProtocolVersion } from "../chain-archive-sync/extrinsic-decoder.js";
import { loadLedgerV8 } from "../chain-archive-sync/tx-replay-decoder.js";

/**
 * The one place project B touches the ledger: turning an archived transaction's raw bytes into
 * the zswap OFFERS a viewing key's relevance predicate is evaluated against, and turning a
 * serialized viewing key into an `EncryptionSecretKey` handle.
 *
 * Nothing here knows what a monitor is, what relevance means, or where the bytes came from. That
 * is deliberate: the scanner (00009-03) owns the predicate and the lifecycle; this module owns
 * the ledger call and the version gate, so the one place where a wrong ledger build or an
 * unsupported protocol version could silently produce wrong answers is small enough to audit.
 *
 * **Ledger v8 only (owner decision Q1).** The vendored build PR #1 already pins is the only
 * ledger this project loads: no v9 module, no adapter layer, no new dependency. A protocol
 * version outside v8's supported ranges throws {@link UnsupportedProtocolVersionError} rather
 * than being decoded anyway -- v9's wire tags differ (`transaction[v12]` against v8's
 * `transaction[v9]`), so decoding one with the other yields either an opaque WASM error
 * attributed to the wrong cause or, worse, bytes that parse into something meaningless.
 *
 * **Why offers and not the predicate.** `EncryptionSecretKey.test(offer)` is the relevance
 * predicate and it lives in the WASM; splitting extraction out means the scanner can enumerate
 * "the guaranteed offer and every fallible segment's offer" -- the exact set the reference
 * indexer tests (`indexer-common/src/domain/ledger/transaction.rs`) -- without every caller
 * re-deriving which fields of a deserialized transaction those are.
 */

/** The ledger build these offers were extracted with, recorded as association provenance
 *  (`spec/00009` FR-009). It must name the BUILD, not just the version: this is the vendored
 *  `vendor/ledger-v8-syshash` artifact, whose behaviour differs from the published
 *  `@midnight-ntwrk/ledger-v8` of the same version number (it carries the
 *  `SystemTransaction.transactionHash()` export). Kept in step with
 *  `chain-archive-sync/sync-service.ts`'s `LEDGER_STATE_VERSION` -- bumping the vendored ledger
 *  MUST bump both, because a match recorded under a build identifier that did not produce it is
 *  provenance that lies. */
export const LEDGER_BUILD_ID = "ledger-v8@8.1.0-syshash.4";

/** The matching-rule version recorded alongside each association. Bumped whenever what counts as
 *  a match changes (which offers are examined, which key API is used) even if the ledger build
 *  does not, so a stored association always says which rule produced it. */
export const MATCHING_RULE_VERSION = "shielded-monitor/relevance/v1";

/** ASCII self-tag prefix a standard (non-system) archived transaction payload carries. System
 *  transactions and reward claims carry no zswap offers and are never relevant
 *  (`spec/00009` edge cases), so they are rejected here rather than silently returning empty. */
const STANDARD_TX_TAG_PREFIX = "midnight:transaction";

/**
 * A transaction's protocol version is outside the set the vendored ledger v8 build decodes.
 *
 * Typed, and fail-CLOSED by contract: the scanner must stop the monitor rather than treat the
 * block as scanned-with-no-matches (`spec/00009` FR-007, and the "unsupported protocol version"
 * edge case). An unreadable transaction is not an irrelevant one, and the difference is invisible
 * afterwards -- a monitor that recorded the range as scanned would never revisit it.
 */
export class UnsupportedProtocolVersionError extends Error {
  readonly code = "UNSUPPORTED_PROTOCOL_VERSION" as const;
  constructor(readonly protocolVersion: number) {
    super(
      `protocol version ${protocolVersion} is outside the set the vendored ledger build ` +
        `${LEDGER_BUILD_ID} decodes. Refusing to deserialize: a later ledger's bytes read with ` +
        "the v8 codec produce a wrong answer, not an error, and a monitor must not record such a " +
        "range as scanned.",
    );
  }
}

/** The transaction bytes are not a standard Midnight transaction payload at all. */
export class NotAStandardTransactionError extends Error {
  readonly code = "NOT_A_STANDARD_TRANSACTION" as const;
  constructor(readonly tag: string) {
    super(
      `these bytes carry the self-tag ${JSON.stringify(tag)}, not "${STANDARD_TX_TAG_PREFIX}". ` +
        "System and reward-claim transactions hold no zswap offers and are never relevant; " +
        "callers must skip them by `kind` rather than ask for their offers.",
    );
  }
}

/**
 * The zswap offers of one archived transaction: the transaction-level guaranteed offer, plus one
 * offer per fallible SEGMENT.
 *
 * Segments are kept separate and keyed by their own id because a match's provenance must name
 * WHICH segment matched (`spec/00009` FR-008, US1 scenario 3): a positive whose only matching
 * output sits in a fallible segment is still `appliedOutcome = "unknown"`, and flattening the
 * segments away would make that distinction unrecordable.
 *
 * The offer values are opaque ledger WASM handles. They are typed `unknown` on purpose -- the
 * vendored module ships no usable TypeScript surface for them, and pretending otherwise with a
 * hand-written `any`-shaped interface would document a contract nothing checks. The only
 * legitimate thing to do with one is pass it to `EncryptionSecretKey.test`.
 */
export interface ExtractedOffers {
  /** `undefined` when the transaction has no guaranteed offer (legal: an intent-only or
   *  fallible-only transaction). */
  guaranteed?: unknown;
  /** Empty when the transaction has no fallible sections. */
  fallible: Map<number, unknown>;
}

/** Handle to a deserialized `EncryptionSecretKey`, with the one operation the scanner needs and
 *  the `free`/`clear` the caller must run when done (key material must not sit in WASM memory
 *  longer than a batch). */
export interface EncryptionSecretKeyHandle {
  /** The ledger's own relevance predicate: true when any output or transient of `offer`
   *  trial-decrypts under this key. */
  test(offer: unknown): boolean;
  /** Zeroes the key inside the WASM heap and releases the handle. Always call it, in a
   *  `finally`, and exactly once -- the handle is unusable afterwards. */
  clear(): void;
}

/** The lazily-loaded, memoized vendored ledger module. One instance per process: the WASM is
 *  several megabytes and stateless for these calls. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ledgerPromise: Promise<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadLedger(): Promise<any> {
  ledgerPromise ??= loadLedgerV8();
  return ledgerPromise;
}

/** Throws {@link UnsupportedProtocolVersionError} unless the vendored ledger build decodes this
 *  version. Shares `isSupportedProtocolVersion` with ingest rather than re-listing the ranges, so
 *  the reader and the writer cannot disagree about what this archive can decode. */
export function assertProtocolVersionSupported(protocolVersion: number): void {
  if (!isSupportedProtocolVersion(protocolVersion)) {
    throw new UnsupportedProtocolVersionError(protocolVersion);
  }
}

/**
 * Deserialize one archived transaction and return its zswap offers.
 *
 * `rawBytes` are exactly what the archive stores as the `tx_raw` blob -- the inner
 * `pallet_midnight::send_mn_transaction` payload -- so no unwrapping happens here.
 *
 * The marker triple `("signature", "proof", "binding")` matches
 * `chain-archive-sync/tx-replay-decoder.ts`'s deserialize call, which is verified against real
 * devnet and testnet bytes: an archived on-chain transaction is signed, proven and bound, and its
 * own self-tag says so.
 */
export async function extractOffers(
  rawBytes: Uint8Array, protocolVersion: number,
): Promise<ExtractedOffers> {
  assertProtocolVersionSupported(protocolVersion);
  const tag = new TextDecoder("utf-8", { fatal: false })
    .decode(rawBytes.subarray(0, STANDARD_TX_TAG_PREFIX.length));
  if (tag !== STANDARD_TX_TAG_PREFIX) throw new NotAStandardTransactionError(tag);

  const ledger = await loadLedger();
  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", rawBytes);
  const fallible = new Map<number, unknown>();
  if (tx.fallibleOffer !== undefined && tx.fallibleOffer !== null) {
    for (const [segmentId, offer] of tx.fallibleOffer) {
      if (offer === undefined || offer === null) continue;
      fallible.set(Number(segmentId), offer);
    }
  }
  const guaranteed = tx.guaranteedOffer === null ? undefined : tx.guaranteedOffer;
  return guaranteed === undefined ? { fallible } : { guaranteed, fallible };
}

/**
 * Deserialize a serialized `EncryptionSecretKey` into a handle usable with
 * {@link ExtractedOffers}.
 *
 * `bytes` are the ledger's own serialization -- what
 * `ZswapSecretKeys.encryptionSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize()`
 * produces and what a Bech32m `mn_shield-esk…` payload carries. Validation IS deserialization:
 * the WASM refuses anything that is not a key, which is what makes it the right validator
 * (`spec/00009` FR-001).
 *
 * The returned handle owns WASM memory. Call `clear()` when the batch is done -- in a `finally`,
 * not on the happy path only.
 */
export async function deserializeEncryptionSecretKey(
  bytes: Uint8Array,
): Promise<EncryptionSecretKeyHandle> {
  const ledger = await loadLedger();
  const key = ledger.EncryptionSecretKey.deserialize(bytes);
  return {
    test: (offer: unknown): boolean => Boolean(key.test(offer)),
    clear: (): void => {
      // `clear()` zeroes the secret in the WASM heap; `free()` releases the allocation. Both,
      // in that order: freeing without clearing returns the bytes to the allocator intact, and
      // clearing without freeing leaks an allocation per monitor per batch.
      key.clear();
      key.free();
    },
  };
}
