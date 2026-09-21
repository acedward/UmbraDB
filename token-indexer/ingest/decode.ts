/* eslint-disable @typescript-eslint/no-explicit-any */
import { isSystemTransaction } from "../../chain-archive-sync/tx-replay-decoder.js";
import { NIGHT_COLOR_HEX, tokenColorHex } from "../color.js";
import { KIND_SHIELDED_NATIVE, KIND_UNSHIELDED_NATIVE, type NativeKindByte } from "./payload.js";

/**
 * Project 00020 — what one archived transaction says about contracts and minting (spec §6.3,
 * FR-001).
 *
 * Everything here is read out of the transaction's own PUBLIC bytes; nothing is executed and
 * nothing is fetched. Three facts come out:
 *
 *  - every `ContractDeploy` (its address), so a contract is known from its first block;
 *  - every `ContractCall` (address, entry point), so a contract deployed before the archive's
 *    first block is still discovered at its next call;
 *  - per call and per transcript, the `effects.shieldedMints` / `effects.unshieldedMints` maps and
 *    the NUMBER of `log` ops in the transcript's program.
 *
 * The mint maps are the ledger's own declaration, checked against execution before the call was
 * applied (`onchain-runtime/src/context.rs`), which is why a mint can be treated as a FACT rather
 * than as a claim. The `log` count is the other half of the design: a contract event's *contents*
 * come from the VM stack and are not in the transaction at all, but the *presence and count* of
 * the `log` opcode is — so the scanner knows exactly which `(transaction, contract)` pairs emitted
 * and how many events, with no watch list and no subscription.
 *
 * The ledger module is INJECTED (never imported here) for the same reason
 * `chain-archive-sync/tx-replay-decoder.ts` injects it: the walk stays unit-testable and this file
 * typechecks in an environment without the WASM package loaded.
 */

export interface TranscriptFacts {
  /** `log` opcodes in this transcript's program — the number of events this call emitted here. */
  logOps: number;
  /** domainSep (lowercase hex) → amount, from `effects.shieldedMints`. */
  shieldedMints: Map<string, bigint>;
  /** domainSep (lowercase hex) → amount, from `effects.unshieldedMints`. */
  unshieldedMints: Map<string, bigint>;
}

export interface DecodedContractAction {
  /** The intent segment this action sat in — the key of `tx.intents`, and what a
   *  `PARTIAL_SUCCESS` transaction's `segments[].id` refers to. */
  segment: number;
  /** Index of the action within `intent.actions` — part of `token_mints`' primary key. */
  callIndex: number;
  kind: "deploy" | "call" | "maintenance";
  /** Contract address, lowercase hex. */
  address: string;
  /** Present for a call; a deploy and a maintenance update have none. */
  entryPoint: string | undefined;
  guaranteed: TranscriptFacts | undefined;
  fallible: TranscriptFacts | undefined;
}

export interface DecodedTransactionActions {
  /** `undefined` for a system transaction (which carries no contract actions at all). */
  actions: DecodedContractAction[] | undefined;
  isSystem: boolean;
}

function hex(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value).toLowerCase();
}

/** An entry point is `Uint8Array | string` in the ledger typings; on chain it is an ASCII circuit
 *  name (`"mint"`, observed live). Bytes are rendered as hex so nothing is ever lossy. */
function entryPointOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) {
    const text = Buffer.from(raw).toString("utf8");
    return /^[\x20-\x7e]+$/.test(text) ? text : Buffer.from(raw).toString("hex");
  }
  return String(raw);
}

function transcriptFacts(transcript: any): TranscriptFacts | undefined {
  if (transcript === undefined || transcript === null) return undefined;
  const program: unknown[] = transcript.program ?? [];
  let logOps = 0;
  for (const op of program) {
    // The `log` opcode is the BARE string `'log'` in `Op<R>` — never an object form, so an
    // equality test is exact rather than a heuristic (`ledger-v9.d.ts:216-263`).
    if (op === "log") logOps++;
  }
  const toMap = (source: unknown): Map<string, bigint> => {
    const out = new Map<string, bigint>();
    if (source === undefined || source === null) return out;
    for (const [domainSep, amount] of source as Iterable<[string, bigint]>) {
      out.set(hex(domainSep), BigInt(amount));
    }
    return out;
  };
  const effects = transcript.effects ?? {};
  return {
    logOps,
    shieldedMints: toMap(effects.shieldedMints),
    unshieldedMints: toMap(effects.unshieldedMints),
  };
}

/**
 * Decodes one archived `tx_raw` payload into its contract actions.
 *
 * @param ledger the loaded ledger module (`loadLedgerV9()`), injected.
 * @param rawBytes exactly the bytes the archive stores (role `tx_raw`).
 * @throws if the bytes are not a Midnight transaction payload, or if an action's runtime shape is
 *   one this walk does not recognise — an unrecognised action is NEVER silently skipped, because
 *   that would lose mints without any signal.
 */
export function decodeTransactionActions(ledger: any, rawBytes: Uint8Array): DecodedTransactionActions {
  if (isSystemTransaction(rawBytes)) return { actions: undefined, isSystem: true };

  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", rawBytes);
  const actions: DecodedContractAction[] = [];
  if (tx.intents === undefined || tx.intents === null) return { actions, isSystem: false };

  for (const [segmentRaw, intent] of tx.intents) {
    const segment = Number(segmentRaw);
    const list: any[] = intent.actions ?? [];
    for (let callIndex = 0; callIndex < list.length; callIndex++) {
      const action = list[callIndex];
      const name = classify(ledger, action);
      actions.push({
        segment,
        callIndex,
        kind: name,
        address: hex(action.address),
        entryPoint: name === "call" ? entryPointOf(action.entryPoint) : undefined,
        guaranteed: name === "call" ? transcriptFacts(action.guaranteedTranscript) : undefined,
        fallible: name === "call" ? transcriptFacts(action.fallibleTranscript) : undefined,
      });
    }
  }
  return { actions, isSystem: false };
}

/**
 * `ContractAction<P> = ContractCall<P> | ContractDeploy | MaintenanceUpdate` — decided by
 * `instanceof` against the SAME module instance that produced the object (one cached dynamic
 * import), with a structural fallback for the case where a future build hands back a plain object.
 * Anything else throws rather than being dropped.
 */
function classify(ledger: any, action: any): "deploy" | "call" | "maintenance" {
  if (ledger.ContractCall !== undefined && action instanceof ledger.ContractCall) return "call";
  if (ledger.ContractDeploy !== undefined && action instanceof ledger.ContractDeploy) return "deploy";
  if (ledger.MaintenanceUpdate !== undefined && action instanceof ledger.MaintenanceUpdate) return "maintenance";

  const ctor = action?.constructor?.name;
  if (ctor === "ContractCall") return "call";
  if (ctor === "ContractDeploy") return "deploy";
  if (ctor === "MaintenanceUpdate") return "maintenance";

  if (action?.entryPoint !== undefined) return "call";
  if (action?.initialState !== undefined) return "deploy";

  throw new Error(
    `decodeTransactionActions: unrecognised contract action (constructor ${JSON.stringify(ctor)}) — ` +
    "refusing to skip it, because a silently dropped action loses mints with no signal",
  );
}

/** One mint the scanner will record: a single entry of one transcript's mint map. */
export interface ObservedMint {
  segment: number;
  callIndex: number;
  address: string;
  domainSep: string;
  /** The MIP §3 kind byte this mint effect maps to: 0 unshielded native from `unshieldedMints`,
   *  1 shielded native from `shieldedMints`. A mint is native by definition (MIP §6.3), so the two
   *  ledger kinds can never come from here. */
  kind: NativeKindByte;
  amount: bigint;
  entryPoint: string | undefined;
  section: "guaranteed" | "fallible";
}

/**
 * Applies spec FR-002's counting rule to one decoded transaction: which of its declared mints
 * actually took effect, and how many events the scanner must therefore look up.
 *
 * - a GUARANTEED transcript's effects count unless the whole transaction failed;
 * - a FALLIBLE transcript's effects count only if that call's intent SEGMENT succeeded.
 *
 * `segments` comes from the archive (`chain_archive.transactions.segments`, spec FR-002). For a
 * `SUCCESS` transaction it is absent and every segment succeeded; for `PARTIAL_SUCCESS` it is
 * required, and its absence is an explicit error naming the transaction rather than a guess
 * (spec §6.3 step 4).
 */
export function countedEffects(
  decoded: DecodedTransactionActions,
  result: "success" | "partial_success" | "failure",
  segments: readonly { id: number; success: boolean }[] | null,
  txHashHex: string,
): { mints: ObservedMint[]; logOpsByAddress: Map<string, number>; callAddresses: Set<string>; deployAddresses: Set<string> } {
  const mints: ObservedMint[] = [];
  const logOpsByAddress = new Map<string, number>();
  const callAddresses = new Set<string>();
  const deployAddresses = new Set<string>();
  if (decoded.actions === undefined) {
    return { mints, logOpsByAddress, callAddresses, deployAddresses };
  }

  const { guaranteedCounts, segmentSucceeded } = countingRule(result, segments, txHashHex);

  for (const action of decoded.actions) {
    if (action.kind === "deploy") {
      deployAddresses.add(action.address);
      continue;
    }
    if (action.kind !== "call") continue;
    callAddresses.add(action.address);

    const sections: [("guaranteed" | "fallible"), TranscriptFacts | undefined, boolean][] = [
      ["guaranteed", action.guaranteed, guaranteedCounts],
      ["fallible", action.fallible, segmentSucceeded(action.segment)],
    ];
    for (const [section, facts, counts] of sections) {
      if (facts === undefined || !counts) continue;
      if (facts.logOps > 0) {
        logOpsByAddress.set(action.address, (logOpsByAddress.get(action.address) ?? 0) + facts.logOps);
      }
      for (const [domainSep, amount] of facts.shieldedMints) {
        mints.push({ segment: action.segment, callIndex: action.callIndex, address: action.address,
          domainSep, kind: KIND_SHIELDED_NATIVE, amount, entryPoint: action.entryPoint, section });
      }
      for (const [domainSep, amount] of facts.unshieldedMints) {
        mints.push({ segment: action.segment, callIndex: action.callIndex, address: action.address,
          domainSep, kind: KIND_UNSHIELDED_NATIVE, amount, entryPoint: action.entryPoint, section });
      }
    }
  }
  return { mints, logOpsByAddress, callAddresses, deployAddresses };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Project 00023 — every PUBLIC occurrence of a token in one transaction (spec §6.2, FR-001).
 *
 * `decodeTransactionActions` above answers "what did this transaction mint?". `decodeTokenFlows`
 * below answers the owner's question: "where did this token move, and what does the chain let
 * anyone see about it?". One pass over the same deserialised transaction produces four things:
 *
 *  - `activity` — the rows the scanner stores. **Counted only** (owner decision Q10, "skip
 *    failed"): a movement that did not happen must never appear in a token's list.
 *  - `offers`   — one record per zswap offer, counted or not. This is the privacy measurement: an
 *    offer whose `deltas` map is EMPTY is balanced, and a balanced offer publishes nothing about
 *    which colour moved (ledger `normalize_deltas` drops every zero; the verifier rejects a stored
 *    zero — spec §0). 64 of the archive's 117 offers are of that kind.
 *  - `calls`    — one record per contract call, with every public field of each transcript. A
 *    LEDGER token's only visible activity, listed under the owner's note that the executing code
 *    is not available to us (Q4).
 *  - `view`     — the spec §4 document minus the block fields, for `GET /v1/transactions/:hash`,
 *    which decodes on request (Q5). It carries the UNCOUNTED sections too, marked, so nothing is
 *    hidden — it is simply not attributed to a token.
 *
 * **DUST produces no activity row, ever** (owner decision Q13): 681 of 683 archived transactions
 * pay a DUST fee, so a DUST list would be a list of the whole chain. Its spends and registrations
 * appear in `view` and nowhere else.
 *
 * The ledger module stays INJECTED, exactly as above, so this walk is unit-testable against the
 * fake ledger and typechecks without the WASM package loaded.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

export type ActivitySection = "guaranteed" | "fallible";

/** The seven ways a colour can appear in public data (spec FR-001). */
export type ActivityRole =
  | "utxo_out" | "utxo_in" | "contract_in" | "contract_out" | "mint" | "shielded_delta" | "reward";

/** The sign, carried beside an UNSIGNED amount (the plan's "Amounts" decision). `mint` is in the
 *  union because spec §5 declares it; no row is written with it — the ROLE already says a mint is
 *  a mint, and its direction is `in` like every other arrival. */
export type ActivityDirection = "in" | "out" | "mint" | "pool_in" | "pool_out";

/** One row of `token_index.token_activity`, before the block fields the scanner adds. */
export interface ActivityRecord {
  segment: number;
  section: ActivitySection;
  role: ActivityRole;
  itemIndex: number;
  /** 32-byte colour, lowercase hex. Never absent — DUST is not tracked. */
  color: string;
  /** 0 unshielded native, 1 shielded native — decided by the EVIDENCE's privacy (FR-003). */
  kind: NativeKindByte;
  /** Unsigned; `direction` carries the sign. */
  amount: bigint;
  direction: ActivityDirection;
  /** 32-byte `UserAddress`, hex — `utxo_out`, `utxo_in` (via `addressFromKey`) and `reward`. */
  owner: string | undefined;
  /** `<tag>:<hex>` of the `SignatureVerifyingKey` — `utxo_in` and `reward`. */
  ownerKey: string | undefined;
  /** `utxo_out`: the intent hash this output belongs to. `utxo_in`: the intent hash of the UTXO
   *  being SPENT. `reward`: the `01`-prefixed identifier's payload, the ledger's own name for the
   *  reward output. */
  intentHash: string | undefined;
  /** `utxo_out`: the intent-wide output index the indexer uses — guaranteed outputs first, then
   *  fallible (`chain-archive-sync/tx-replay-decoder.ts` established it against real rows).
   *  `utxo_in`: the output number of the UTXO being spent. */
  outputNo: number | undefined;
  /** Contract address — `contract_in`, `contract_out`, `mint`. */
  address: string | undefined;
  entryPoint: string | undefined;
  callIndex: number | undefined;
  /** `mint` rows only: the key of the mint map. */
  domainSep: string | undefined;
}

/** One row of `token_index.shielded_offers` — the privacy measurement (FR-018). */
export interface OfferRecord {
  section: ActivitySection;
  /** The intent segment for a fallible offer; 0 for the transaction-level guaranteed offer. */
  segment: number;
  inputs: number;
  outputs: number;
  transients: number;
  /** Number of colours whose net imbalance this offer publishes. 0 = balanced = undisclosed. */
  deltas: number;
  counted: boolean;
}

/** Gas as the ledger reports it; decimal strings because every component is a `bigint`. */
export interface GasView {
  readTime: string;
  computeTime: string;
  bytesWritten: string;
  bytesDeleted: string;
}

/** A transcript's `effects`, every map rendered (spec §4). */
export interface EffectsView {
  shieldedMints: { domainSep: string; amount: string }[];
  unshieldedMints: { domainSep: string; amount: string }[];
  unshieldedInputs: { color: string; amount: string }[];
  unshieldedOutputs: { color: string; amount: string }[];
  claimedShieldedReceives: string[];
  claimedShieldedSpends: string[];
  claimedNullifiers: string[];
  claimedContractCalls: { sequence: string; address: string; entryPoint: string; commitment: string }[];
  /** Count only: its map key is a `(TokenType, PublicAddress)` tuple, no archived transaction
   *  carries one, and inventing a rendering for a shape nobody has seen would be a guess. */
  claimedUnshieldedSpends: number;
}

export interface TranscriptView {
  ops: number;
  logOps: number;
  gas: GasView;
  effects: EffectsView;
  /** Did this section count under FR-002? The row it would have produced exists only if it did. */
  counted: boolean;
}

/** One row of `token_index.contract_calls` (FR-020, US7). */
export interface CallRecord {
  segment: number;
  callIndex: number;
  address: string;
  entryPoint: string | undefined;
  guaranteed: TranscriptView | undefined;
  fallible: TranscriptView | undefined;
}

/** The same offer as {@link OfferRecord}, with the contents the transaction view prints. The
 *  counts stay beside the lists on purpose: `deltaCount` 0 is the whole privacy statement, and a
 *  reader should be able to see it without counting an array. */
export interface OfferView {
  section: ActivitySection;
  segment: number;
  counted: boolean;
  inputCount: number;
  outputCount: number;
  transientCount: number;
  deltaCount: number;
  /** Every colour whose net imbalance is public, with the exact amount (spec §0). Empty means the
   *  offer is BALANCED and the ledger says nothing at all about which colour moved. */
  deltas: { color: string; delta: string; direction: "pool_in" | "pool_out" }[];
  inputs: { nullifier: string; contractAddress: string | null }[];
  outputs: { commitment: string; contractAddress: string | null }[];
  transients: { commitment: string; nullifier: string; contractAddress: string | null }[];
}

export interface UnshieldedOfferView {
  counted: boolean;
  inputs: {
    value: string; color: string;
    /** Spec §4 spells this one as the ledger's own `{tag, value}` pair, unlike the `<tag>:<hex>`
     *  string an {@link ActivityRecord} carries — a row is a table cell, this is a document. */
    ownerKey: { tag: string; value: string };
    ownerAddress: string;
    spentIntentHash: string; spentOutputNo: number;
  }[];
  outputs: { index: number; value: string; color: string; owner: string }[];
  signatures: number;
}

export interface DustActionsView {
  /** A WALLET-set time inside the transaction, not the block time (spec US3 scenario 2). */
  ctime: string | null;
  spends: { vFee: string; oldNullifier: string; newCommitment: string }[];
  registrations: { nightKey: string; dustAddress: string | null; allowFeePayment: string }[];
}

export interface ActionView {
  index: number;
  kind: "deploy" | "call" | "maintenance";
  address: string;
  entryPoint: string | null;
  communicationCommitment: string | null;
  guaranteed: TranscriptView | null;
  fallible: TranscriptView | null;
}

export interface IntentView {
  segment: number;
  /** A WALLET-set expiry inside the transaction, never the block time (US3 scenario 2). */
  ttl: string | null;
  intentHash: string;
  guaranteedUnshieldedOffer: UnshieldedOfferView | null;
  fallibleUnshieldedOffer: UnshieldedOfferView | null;
  dustActions: DustActionsView | null;
  actions: ActionView[];
}

export interface RewardsView {
  value: string;
  owner: string;
  ownerKey: string;
  nonce: string;
  kind: string;
}

/** The spec §4 document, minus the fields that come from the archive rather than from the bytes
 *  (`blockHeight`, `blockHash`, `txPosition`, `protocolVersion`, `result`, `segments`) and minus
 *  the stored activity rows — the API route adds both. */
export interface PublicTransactionView {
  txHash: string;
  /** What the transaction says its own hash is. Equal to `txHash` for every archived transaction
   *  measured on 2026-09-21; carried so a disagreement would be visible rather than silent. */
  selfReportedTxHash: string | null;
  isSystem: boolean;
  /** The transaction's own byte length — spec §4's "`rawBytes` (length)". */
  rawBytes: number;
  identifiers: string[];
  /** The sum of `vFee` over every DUST spend — what the transaction OFFERS for its fee.
   *
   *  **Measured 2026-09-21 (spec §4's VERIFY): this is NOT equal to the indexer's `fee`.** On all
   *  four recorded fixtures the offered amount exceeds the indexer's number by 25–53 % (e.g.
   *  248 379 650 240 359 vs 162 873 142 857 143 on `deposit-toMap`), which is what a wallet's fee
   *  margin looks like: `Transaction.feesWithMargin` offers more than `Transaction.fees` requires.
   *  The archive stores neither number, so this field is the only one derivable from the bytes.
   *  Recorded as question Q18. */
  feeSpeck: string;
  bindingRandomness: boolean;
  offers: OfferView[];
  intents: IntentView[];
  rewards: RewardsView | null;
}

export interface DecodedTokenFlows {
  /** COUNTED rows only (FR-002, Q10). */
  activity: ActivityRecord[];
  offers: OfferRecord[];
  calls: CallRecord[];
  view: PublicTransactionView;
  /** The 00020 facts, from the SAME deserialisation — `Transaction.deserialize` costs ≈ 6 ms on
   *  this host (measured over 200 archived transactions, 2026-09-21), so the scanner does it once
   *  and reads everything off one walk rather than paying twice per transaction. These four are
   *  exactly what {@link countedEffects} produces, and that function stays as the unit-testable
   *  statement of FR-002's rule. */
  mints: ObservedMint[];
  deployAddresses: Set<string>;
  callAddresses: Set<string>;
  logOpsByAddress: Map<string, number>;
}

/**
 * FR-002's counting rule, in one place: a GUARANTEED section counts unless the whole transaction
 * failed; a FALLIBLE section counts only if its intent SEGMENT succeeded.
 *
 * Shared by {@link countedEffects} (mints, 00020) and {@link decodeTokenFlows} (everything else),
 * so the two can never drift into two different notions of "it happened".
 */
export function countingRule(
  result: "success" | "partial_success" | "failure",
  segments: readonly { id: number; success: boolean }[] | null,
  txHashHex: string,
): { guaranteedCounts: boolean; segmentSucceeded: (segment: number) => boolean } {
  const guaranteedCounts = result !== "failure";
  const segmentSucceeded = (segment: number): boolean => {
    if (result === "failure") return false;
    if (result === "success") return true;
    if (segments === null || segments === undefined) {
      throw new Error(
        `transaction ${txHashHex} is partial_success but the archive has no segments for it — ` +
        "run `token-indexer backfill-results` for its block; refusing to guess which segment applied",
      );
    }
    const entry = segments.find((s) => s.id === segment);
    // A segment the indexer did not report inside a PARTIAL_SUCCESS result did not succeed.
    if (entry === undefined) return false;
    return entry.success;
  };
  return { guaranteedCounts, segmentSucceeded };
}

const big = (value: unknown): string => BigInt(value as bigint).toString();

/** A `Date` the ledger hands back (`Intent.ttl`, `DustActions.ctime`) as an ISO string. These are
 *  values the WALLET put inside the transaction, and the view labels them as such — they are never
 *  the block's time, which this lineage's archive does not have at all (Q1). */
function isoOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(String(value));
  return Number.isNaN(asDate.getTime()) ? String(value) : asDate.toISOString();
}

/**
 * The raw 32-byte colour behind a contract effect map's key.
 *
 * The mint maps are keyed by a hex STRING; `unshieldedInputs` / `unshieldedOutputs` are keyed by a
 * `TokenType` OBJECT (`{tag: 'unshielded', raw}`) — spec §0's edge case, observed live. A DUST key
 * (`{tag: 'dust'}`, a unit variant with no bytes) is the one shape that is legitimately skipped
 * rather than decoded: DUST is not tracked (Q13). Anything else THROWS naming the transaction,
 * because a silently dropped flow loses a token movement with no signal (FR-015).
 */
function colorOfEffectKey(key: unknown, txHashHex: string, where: string): string | undefined {
  if (typeof key === "string") return key.toLowerCase();
  if (key instanceof Uint8Array) return Buffer.from(key).toString("hex");
  if (typeof key === "object" && key !== null) {
    const tag = (key as { tag?: unknown }).tag;
    if (tag === "dust") return undefined; // never tracked, never an error
    const raw = (key as { raw?: unknown }).raw;
    if (typeof raw === "string") return raw.toLowerCase();
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("hex");
  }
  throw new Error(
    `decodeTokenFlows: transaction ${txHashHex} has a ${where} key of an unrecognised shape ` +
    `(${JSON.stringify(key, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v))}) — ` +
    "refusing to skip it, because a silently dropped flow loses a token movement with no signal",
  );
}

/** A `SignatureVerifyingKey` as the ledger carries it: `{tag, value}` (`{tag:'schnorr', value}` on
 *  chain today). Spec §4 renders it in this shape inside the transaction view. */
function ownerKeyPair(key: unknown): { tag: string; value: string } {
  if (typeof key === "object" && key !== null && "tag" in key) {
    const k = key as { tag: unknown; value?: unknown };
    return { tag: String(k.tag), value: hex(k.value) };
  }
  return { tag: "unknown", value: hex(key) };
}

/** The same key as one string, `<tag>:<hex>` — what an {@link ActivityRecord} and the
 *  `token_activity.owner_key` column carry, because a row is one cell wide. */
function ownerKeyOf(key: unknown): string {
  const pair = ownerKeyPair(key);
  return `${pair.tag}:${pair.value}`;
}

function gasView(gas: unknown): GasView {
  const g = (gas ?? {}) as Record<string, unknown>;
  const at = (name: string): string => (g[name] === undefined || g[name] === null ? "0" : big(g[name]));
  return {
    readTime: at("readTime"),
    computeTime: at("computeTime"),
    bytesWritten: at("bytesWritten"),
    bytesDeleted: at("bytesDeleted"),
  };
}

function sizeOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  const size = (value as { size?: unknown }).size;
  return typeof size === "number" ? size : 0;
}

/**
 * ── Why every set-derived list below is SORTED (measured 2026-09-21) ───────────────────────────
 *
 * The ledger's `Effects` are Rust **sets and maps**, and the WASM hands their contents back in an
 * order that is not stable: deserialising the *same bytes twice in the same process* produced
 * `claimedNullifiers` in two different orders (caught by `[[token-activity-rebuild-equal]]` before
 * this sort existed). The typings say `Nullifier[]`, which hides it.
 *
 * That order is not information — a set has none — but three things of ours depend on it:
 *
 *  1. `token_activity.item_index` is a per-`(segment, section, role)` counter, so an unsorted mint
 *     or flow map would give the SAME row a different primary key on a re-scan, and
 *     `ON CONFLICT DO NOTHING` would then insert a duplicate instead of doing nothing (FR-004);
 *  2. `rebuild` must reproduce a live run byte-for-byte (FR-005), `contract_calls.guaranteed`
 *     jsonb included;
 *  3. the goldens must be a function of the transaction, or they flake.
 *
 * So each list is ordered by its own content: a colour, a domain separator, a commitment. Lists
 * that are genuinely ORDERED on chain — an offer's inputs/outputs/transients, an intent's actions
 * and its unshielded outputs, whose positions ARE their identity — are never reordered.
 */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function effectsView(effects: unknown, txHashHex: string): EffectsView {
  const e = (effects ?? {}) as Record<string, any>;
  const pairs = (source: unknown): [unknown, bigint][] =>
    source === undefined || source === null ? [] : [...(source as Iterable<[unknown, bigint]>)];
  const named = (source: unknown): { domainSep: string; amount: string }[] =>
    pairs(source)
      .map(([key, amount]) => ({ domainSep: hex(key), amount: big(amount) }))
      .sort((a, b) => byString(a.domainSep, b.domainSep));
  const coloured = (source: unknown, where: string): { color: string; amount: string }[] => {
    const out: { color: string; amount: string }[] = [];
    for (const [key, amount] of pairs(source)) {
      const color = colorOfEffectKey(key, txHashHex, where);
      if (color === undefined) continue; // a DUST key — not tracked (Q13)
      out.push({ color, amount: big(amount) });
    }
    return out.sort((a, b) => byString(a.color, b.color));
  };
  const list = (source: unknown): string[] =>
    (source === undefined || source === null ? [] : [...(source as Iterable<unknown>)].map(hex)).sort(byString);
  return {
    shieldedMints: named(e.shieldedMints),
    unshieldedMints: named(e.unshieldedMints),
    unshieldedInputs: coloured(e.unshieldedInputs, "effects.unshieldedInputs"),
    unshieldedOutputs: coloured(e.unshieldedOutputs, "effects.unshieldedOutputs"),
    claimedShieldedReceives: list(e.claimedShieldedReceives),
    claimedShieldedSpends: list(e.claimedShieldedSpends),
    claimedNullifiers: list(e.claimedNullifiers),
    claimedContractCalls: (e.claimedContractCalls === undefined || e.claimedContractCalls === null
      ? []
      : [...(e.claimedContractCalls as Iterable<unknown[]>)]
    ).map((entry) => ({
      sequence: entry[0] === undefined ? "0" : big(entry[0]),
      address: hex(entry[1]),
      entryPoint: entryPointOf(entry[2]) ?? "",
      commitment: hex(entry[3]),
    })).sort((a, b) => byString(
      `${a.sequence.padStart(20, "0")}|${a.address}|${a.entryPoint}|${a.commitment}`,
      `${b.sequence.padStart(20, "0")}|${b.address}|${b.entryPoint}|${b.commitment}`,
    )),
    claimedUnshieldedSpends: sizeOf(e.claimedUnshieldedSpends),
  };
}

function transcriptView(transcript: unknown, counted: boolean, txHashHex: string): TranscriptView | undefined {
  if (transcript === undefined || transcript === null) return undefined;
  const t = transcript as { program?: unknown[]; gas?: unknown; effects?: unknown };
  const program: unknown[] = t.program ?? [];
  let logOps = 0;
  for (const op of program) if (op === "log") logOps++;
  return {
    ops: program.length,
    logOps,
    gas: gasView(t.gas),
    effects: effectsView(t.effects, txHashHex),
    counted,
  };
}

/** The intent segments in ascending order. The ledger hands back a `Map`, whose iteration order is
 *  insertion order; sorting makes the walk — and therefore every `item_index` and every golden —
 *  a function of the transaction alone, which is what makes `rebuild` byte-equal (FR-005). */
function sortedEntries(map: unknown): [number, any][] {
  if (map === undefined || map === null) return [];
  const out: [number, any][] = [...(map as Iterable<[unknown, unknown]>)]
    .map(([key, value]) => [Number(key), value] as [number, any]);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Every public occurrence of a token in one archived transaction.
 *
 * @param ledger the loaded ledger module (`loadLedgerV9()`), injected.
 * @param rawBytes exactly the bytes the archive stores (role `tx_raw`).
 * @param result the archived transaction result (FR-002).
 * @param segments the archived per-segment outcomes; required for `partial_success`.
 * @param txHashHex the archive's own hash for the transaction — used in every error message and as
 *   the view's identity.
 * @throws if the bytes are not a Midnight transaction payload, or if an effect key has a shape this
 *   walk does not recognise (FR-015).
 */
export function decodeTokenFlows(
  ledger: any,
  rawBytes: Uint8Array,
  result: "success" | "partial_success" | "failure",
  segments: readonly { id: number; success: boolean }[] | null,
  txHashHex: string,
): DecodedTokenFlows {
  const emptyView: PublicTransactionView = {
    txHash: txHashHex, selfReportedTxHash: null, isSystem: true, rawBytes: rawBytes.length,
    identifiers: [], feeSpeck: "0", bindingRandomness: false, offers: [], intents: [], rewards: null,
  };
  // A system transaction exposes only `serialize/deserialize/toString` in the WASM, the archive
  // holds none on Stagenet, and the owner put them out of scope (Q11). It is reported as what it
  // is rather than decoded as something it is not.
  if (isSystemTransaction(rawBytes)) {
    return {
      activity: [], offers: [], calls: [], view: emptyView,
      mints: [], deployAddresses: new Set(), callAddresses: new Set(), logOpsByAddress: new Map(),
    };
  }

  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", rawBytes);
  const { guaranteedCounts, segmentSucceeded } = countingRule(result, segments, txHashHex);

  const activity: ActivityRecord[] = [];
  const offers: OfferRecord[] = [];
  const calls: CallRecord[] = [];
  const offerViews: OfferView[] = [];
  const intentViews: IntentView[] = [];
  const mints: ObservedMint[] = [];
  const deployAddresses = new Set<string>();
  const callAddresses = new Set<string>();
  const logOpsByAddress = new Map<string, number>();
  let feeSpeck = 0n;

  // `item_index` is the position within its own `(segment, section, role)` list — which is exactly
  // what the primary key needs to be total, and what makes a re-scan idempotent (FR-004).
  const nextIndex = new Map<string, number>();
  const take = (segment: number, section: ActivitySection, role: ActivityRole): number => {
    const key = `${segment}|${section}|${role}`;
    const at = nextIndex.get(key) ?? 0;
    nextIndex.set(key, at + 1);
    return at;
  };
  const push = (
    counted: boolean,
    row: Omit<ActivityRecord, "itemIndex"> & { itemIndex?: number },
  ): void => {
    // Only counted rows are stored (Q10). The index is consumed either way, so the numbering of a
    // transaction's rows does not depend on which of its segments happened to succeed.
    const itemIndex = take(row.segment, row.section, row.role);
    if (!counted) return;
    activity.push({ ...row, itemIndex });
  };

  // ── rewards (NIGHT) ───────────────────────────────────────────────────────────────────────
  // The archive holds none on Stagenet; the path exists because a `ClaimRewards` transaction is
  // how NIGHT is distributed, and dropping it would lose every allocation on a chain that has one.
  let rewardsView: RewardsView | null = null;
  if (tx.rewards !== undefined && tx.rewards !== null) {
    const ownerAddress = hex(ledger.addressFromKey(tx.rewards.owner));
    // The ledger names the reward output through the transaction's `01`-prefixed identifier, the
    // same convention `chain-archive-sync/tx-replay-decoder.ts` established against real rows.
    const rewardIdentifier = identifiersOf(tx).find((id) => /^01[0-9a-f]{64}$/i.test(id));
    rewardsView = {
      value: big(tx.rewards.value),
      owner: ownerAddress,
      ownerKey: ownerKeyOf(tx.rewards.owner),
      nonce: hex(tx.rewards.nonce),
      kind: String(tx.rewards.kind ?? "Reward"),
    };
    push(guaranteedCounts, {
      segment: 0, section: "guaranteed", role: "reward",
      color: NIGHT_COLOR_HEX, kind: KIND_UNSHIELDED_NATIVE, amount: BigInt(tx.rewards.value),
      direction: "in",
      owner: ownerAddress, ownerKey: ownerKeyOf(tx.rewards.owner),
      intentHash: rewardIdentifier === undefined ? undefined : rewardIdentifier.slice(2),
      outputNo: 0,
      address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
    });
  }

  // ── zswap offers ──────────────────────────────────────────────────────────────────────────
  // The transaction-level GUARANTEED offer sits outside every intent and is recorded under segment
  // 0 (spec §6.1); a fallible offer is recorded under its own segment.
  const walkOffer = (offer: any, section: ActivitySection, segment: number, counted: boolean): void => {
    if (offer === undefined || offer === null) return;
    // The ledger stores deltas sorted and the verifier rejects an unsorted set
    // (`zswap/src/verify.rs:323-326`), so this sort changes nothing on a valid offer — it is here
    // so `item_index` is a function of the colour rather than of the WASM's iteration order, for
    // the same reason the effect lists above are sorted.
    const deltaPairs: [string, bigint][] = (offer.deltas === undefined || offer.deltas === null
      ? []
      : [...(offer.deltas as Iterable<[unknown, bigint]>)].map(([k, v]) => [hex(k), BigInt(v)] as [string, bigint])
    ).sort((a, b) => byString(a[0], b[0]));
    const inputs: any[] = offer.inputs ?? [];
    const outputs: any[] = offer.outputs ?? [];
    const transients: any[] = offer.transients ?? [];

    const record: OfferRecord = {
      section, segment,
      inputs: inputs.length, outputs: outputs.length, transients: transients.length,
      deltas: deltaPairs.length, counted,
    };
    offers.push(record);
    offerViews.push({
      section, segment, counted,
      inputCount: inputs.length, outputCount: outputs.length,
      transientCount: transients.length, deltaCount: deltaPairs.length,
      // A NEGATIVE delta means value entered the shielded pool (a mint, a contract paying in); a
      // positive one means it left. The amount is exact and public either way (spec §0).
      deltas: deltaPairs.map(([color, delta]) => ({
        color,
        delta: delta.toString(),
        direction: delta < 0n ? "pool_in" as const : "pool_out" as const,
      })),
      inputs: inputs.map((i) => ({
        nullifier: hex(i.nullifier),
        contractAddress: i.contractAddress === undefined || i.contractAddress === null ? null : hex(i.contractAddress),
      })),
      outputs: outputs.map((o) => ({
        commitment: hex(o.commitment),
        contractAddress: o.contractAddress === undefined || o.contractAddress === null ? null : hex(o.contractAddress),
      })),
      transients: transients.map((t) => ({
        commitment: hex(t.commitment),
        nullifier: hex(t.nullifier),
        contractAddress: t.contractAddress === undefined || t.contractAddress === null ? null : hex(t.contractAddress),
      })),
    });

    for (const [color, delta] of deltaPairs) {
      push(counted, {
        segment, section, role: "shielded_delta",
        color, kind: KIND_SHIELDED_NATIVE,
        amount: delta < 0n ? -delta : delta,
        direction: delta < 0n ? "pool_in" : "pool_out",
        owner: undefined, ownerKey: undefined, intentHash: undefined, outputNo: undefined,
        address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
      });
    }
  };
  walkOffer(tx.guaranteedOffer, "guaranteed", 0, guaranteedCounts);
  for (const [segment, offer] of sortedEntries(tx.fallibleOffer)) {
    walkOffer(offer, "fallible", segment, segmentSucceeded(segment));
  }

  // ── intents ───────────────────────────────────────────────────────────────────────────────
  for (const [segment, intent] of sortedEntries(tx.intents)) {
    // An intent's hash is a function of the SEGMENT it is evaluated in, and an intent is evaluated
    // in two: its guaranteed part runs in segment 0, its fallible part in its own segment. The UTXO
    // a created output becomes is therefore identified by `intentHash(0)` when the output sat in the
    // guaranteed unshielded offer and by `intentHash(segment)` when it sat in the fallible one.
    // Measured against the indexer's own `unshieldedCreatedOutputs[].intentHash` on three recorded
    // transactions (00023 task C5): `ucom-transfer` (guaranteed) → `intentHash(0) = d3fe93c4…`,
    // which is what the indexer filed it under, while `intentHash(1) = 566e2053…` is not;
    // `night-transfer` (fallible, segment 1) and `night-passthrough` (fallible, segment 15274) →
    // `intentHash(segment)`, again exactly the indexer's value. The intent's own identity in the
    // §4 view stays `intentHash(segment)` — that is the hash of the intent in the segment it is
    // keyed by.
    const intentHash = hex(intent.intentHash(segment));
    const utxoIntentHash: Record<ActivitySection, string> = {
      guaranteed: hex(intent.intentHash(0)),
      fallible: intentHash,
    };
    const sections: Record<ActivitySection, UnshieldedOfferView | null> =
      { guaranteed: null, fallible: null };
    // The indexer numbers `output_index` across the intent's FULL output list, guaranteed section
    // first, then fallible. One shared counter reproduces that numbering — and it advances over an
    // uncounted section too, because the numbering is a property of the transaction, not of what
    // took effect.
    let outputNo = 0;
    for (const section of ["guaranteed", "fallible"] as const) {
      const offer = section === "guaranteed" ? intent.guaranteedUnshieldedOffer : intent.fallibleUnshieldedOffer;
      if (offer === undefined || offer === null) continue;
      const counted = section === "guaranteed" ? guaranteedCounts : segmentSucceeded(segment);
      const inputs: any[] = offer.inputs ?? [];
      const outputs: any[] = offer.outputs ?? [];
      const view: UnshieldedOfferView = { counted, inputs: [], outputs: [], signatures: (offer.signatures ?? []).length };

      for (const input of inputs) {
        const ownerAddress = hex(ledger.addressFromKey(input.owner));
        view.inputs.push({
          value: big(input.value), color: hex(input.type),
          ownerKey: ownerKeyPair(input.owner), ownerAddress,
          spentIntentHash: hex(input.intentHash), spentOutputNo: Number(input.outputNo),
        });
        push(counted, {
          segment, section, role: "utxo_in",
          color: hex(input.type), kind: KIND_UNSHIELDED_NATIVE,
          amount: BigInt(input.value), direction: "out",
          owner: ownerAddress, ownerKey: ownerKeyOf(input.owner),
          intentHash: hex(input.intentHash), outputNo: Number(input.outputNo),
          address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
        });
      }
      for (const output of outputs) {
        const index = outputNo++;
        view.outputs.push({
          index, value: big(output.value), color: hex(output.type), owner: hex(output.owner),
        });
        push(counted, {
          segment, section, role: "utxo_out",
          color: hex(output.type), kind: KIND_UNSHIELDED_NATIVE,
          amount: BigInt(output.value), direction: "in",
          owner: hex(output.owner), ownerKey: undefined,
          intentHash: utxoIntentHash[section], outputNo: index,
          address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
        });
      }
      sections[section] = view;
    }

    // DUST: decoded for the view, summed into `feeSpeck`, and never turned into a row (Q13).
    const dust = intent.dustActions;
    let dustView: DustActionsView | null = null;
    if (dust !== undefined && dust !== null) {
      const spends: any[] = dust.spends ?? [];
      const registrations: any[] = dust.registrations ?? [];
      for (const spend of spends) feeSpeck += BigInt(spend.vFee);
      dustView = {
        ctime: isoOrNull(dust.ctime),
        spends: spends.map((s) => ({
          vFee: big(s.vFee), oldNullifier: hex(s.oldNullifier), newCommitment: hex(s.newCommitment),
        })),
        registrations: registrations.map((r) => ({
          nightKey: ownerKeyOf(r.nightKey),
          dustAddress: r.dustAddress === undefined || r.dustAddress === null ? null : hex(r.dustAddress),
          allowFeePayment: big(r.allowFeePayment ?? 0n),
        })),
      };
    }

    const actionViews: ActionView[] = [];
    const list: any[] = intent.actions ?? [];
    for (let callIndex = 0; callIndex < list.length; callIndex++) {
      const action = list[callIndex];
      const kind = classify(ledger, action);
      const address = hex(action.address);
      const entryPoint = kind === "call" ? entryPointOf(action.entryPoint) : undefined;
      const guaranteed = kind === "call"
        ? transcriptView(action.guaranteedTranscript, guaranteedCounts, txHashHex) : undefined;
      const fallible = kind === "call"
        ? transcriptView(action.fallibleTranscript, segmentSucceeded(segment), txHashHex) : undefined;

      actionViews.push({
        index: callIndex, kind, address,
        entryPoint: entryPoint ?? null,
        communicationCommitment: kind === "call" && action.communicationCommitment !== undefined
          ? hex(action.communicationCommitment) : null,
        guaranteed: guaranteed ?? null,
        fallible: fallible ?? null,
      });

      if (kind === "deploy") deployAddresses.add(address);
      if (kind !== "call") continue;
      callAddresses.add(address);
      calls.push({ segment, callIndex, address, entryPoint, guaranteed, fallible });

      for (const [section, transcript] of [
        ["guaranteed", guaranteed] as const, ["fallible", fallible] as const,
      ]) {
        if (transcript === undefined) continue;
        const counted = transcript.counted;
        if (counted && transcript.logOps > 0) {
          logOpsByAddress.set(address, (logOpsByAddress.get(address) ?? 0) + transcript.logOps);
        }
        // A mint effect is a protocol-level mint, so it lands on a NATIVE kind and the map it came
        // from decides which (MIP §6.3). Its colour is derived from `(domainSep, address)` — the
        // same derivation `token_mints` already uses, repeated here so ONE list carries everything
        // (FR-001).
        for (const [mintKind, entries] of [
          [KIND_SHIELDED_NATIVE, transcript.effects.shieldedMints] as const,
          [KIND_UNSHIELDED_NATIVE, transcript.effects.unshieldedMints] as const,
        ]) {
          for (const entry of entries) {
            push(counted, {
              segment, section, role: "mint",
              color: tokenColorHex(entry.domainSep, address), kind: mintKind,
              amount: BigInt(entry.amount), direction: "in",
              owner: undefined, ownerKey: undefined, intentHash: undefined, outputNo: undefined,
              address, entryPoint, callIndex, domainSep: entry.domainSep,
            });
            // The same fact in the 00020 shape, for `token_mints` and its counters.
            if (counted) {
              mints.push({
                segment, callIndex, address, domainSep: entry.domainSep, kind: mintKind,
                amount: BigInt(entry.amount), entryPoint, section,
              });
            }
          }
        }
        for (const [role, direction, entries] of [
          ["contract_in", "in", transcript.effects.unshieldedInputs] as const,
          ["contract_out", "out", transcript.effects.unshieldedOutputs] as const,
        ]) {
          for (const entry of entries) {
            push(counted, {
              segment, section, role,
              color: entry.color, kind: KIND_UNSHIELDED_NATIVE,
              amount: BigInt(entry.amount), direction,
              owner: undefined, ownerKey: undefined, intentHash: undefined, outputNo: undefined,
              address, entryPoint, callIndex, domainSep: undefined,
            });
          }
        }
      }
    }

    intentViews.push({
      segment,
      ttl: isoOrNull(intent.ttl),
      intentHash,
      guaranteedUnshieldedOffer: sections.guaranteed,
      fallibleUnshieldedOffer: sections.fallible,
      dustActions: dustView,
      actions: actionViews,
    });
  }

  let bindingRandomness = false;
  try { bindingRandomness = typeof tx.bindingRandomness === "bigint"; } catch { bindingRandomness = false; }
  let selfReportedTxHash: string | null = null;
  try { selfReportedTxHash = hex(tx.transactionHash()); } catch { selfReportedTxHash = null; }

  return {
    activity, offers, calls,
    mints, deployAddresses, callAddresses, logOpsByAddress,
    view: {
      txHash: txHashHex,
      selfReportedTxHash,
      isSystem: false,
      rawBytes: rawBytes.length,
      identifiers: identifiersOf(tx),
      feeSpeck: feeSpeck.toString(),
      bindingRandomness,
      offers: offerViews,
      intents: intentViews,
      rewards: rewardsView,
    },
  };
}

function identifiersOf(tx: any): string[] {
  try {
    const ids = tx.identifiers();
    return ids === undefined || ids === null ? [] : [...(ids as Iterable<unknown>)].map((id) => String(id).toLowerCase());
  } catch {
    return [];
  }
}
