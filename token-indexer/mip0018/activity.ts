/**
 * Token activity (project 00026, sub-plan C2; owner decision Q3; spec FR-021, US5): the public token flows of every
 * applied transaction part, written by the MIP-0018 scan (`scan.ts`, one call per transaction inside the block's
 * Postgres transaction) into `mip0018_activity` (migration `003_mip0018_activity`, where the roles are described),
 * and the keyset-paginated reads the API serves (`activityForColor`, `metadataTransactionsForContract`).
 *
 * Fresh code; PR #19's `decodeTokenFlows` (00023) was read as an idea source only. Pitfalls carried over: the output
 * of a guaranteed unshielded offer belongs to the UTXO `intentHash(0)`, of a fallible one to `intentHash(segment)`;
 * an intent's output numbering runs over its guaranteed outputs, then its fallible ones (whether or not they
 * applied); ledger `Map`s iterate in random order, so every effect map is sorted.
 *
 * What is public and therefore shown: unshielded UTXOs (owner, amount), a contract's unshielded effects, Zswap offer
 * deltas (an unbalanced offer's net amount per color — a balanced shielded transfer publishes nothing), mint effects,
 * and the chain position of MIP-0018 events. Nothing of a failed segment or a FAILURE transaction (same rule as the
 * mints and events: `partApplied`). DUST has no color and no row; NIGHT's unshielded UTXOs are recorded under color
 * 32 zero bytes; a Zswap delta of the zero color (the shielded native token, not NIGHT) is not recorded.
 */
import { addressFromKey, ContractCall, Transaction } from "@midnightntwrk/ledger-v9";
import type { ISql } from "postgres";
import { normHex, NIGHT_COLOR, type Part, partApplied, type Phase, type TransactionOutcome } from "./applied-parts.ts";
import { tokenColor } from "./color.ts";

/** A connection or the scan's block transaction (the same handle type as `fields.ts`). */
export type Queryable = ISql<{ bigint: bigint }>;

export type ActivityRole = "mint" | "utxo-created" | "utxo-spent" | "contract-in" | "contract-out" | "shielded-offer" | "metadata-event";

/** One `mip0018_activity` row (column names), every column present. */
export interface ActivityRow {
  network: string;
  block_height: number;
  tx_index: number;
  item_index: number;
  tx_hash: Buffer;
  role: ActivityRole;
  phase: Phase | null;
  segment_id: number | null;
  color: Buffer | null;
  amount: string | null;
  direction: "in" | "out" | null;
  contract_address: Buffer | null;
  action_index: number | null;
  entry_point: string | null;
  domain_sep: Buffer | null;
  kind: 1 | 2 | null;
  wallet_address: Buffer | null;
  recipient_contract: Buffer | null;
  intent_hash: Buffer | null;
  output_index: number | null;
  events_accepted: number | null;
  events_rejected: number | null;
  first_event_index: number | null;
}

type TokenTypeLike = { tag: string; raw?: string };
type PublicAddressLike = { tag: string; address: string };
type TranscriptLike = {
  effects: {
    shieldedMints: Map<string, bigint>;
    unshieldedMints: Map<string, bigint>;
    unshieldedInputs?: Map<TokenTypeLike, bigint>;
    unshieldedOutputs?: Map<TokenTypeLike, bigint>;
    claimedUnshieldedSpends?: Map<[TokenTypeLike, PublicAddressLike], bigint>;
  };
};
type UtxoSpendLike = { type: string; value: bigint; owner: unknown; intentHash: string; outputNo: number };
type UtxoOutputLike = { type: string; value: bigint; owner: string };
type UnshieldedOfferLike = { inputs: UtxoSpendLike[]; outputs: UtxoOutputLike[] } | undefined | null;
type ZswapOfferLike = { deltas: Map<string, bigint> } | undefined | null;
type IntentLike = {
  actions: unknown[];
  guaranteedUnshieldedOffer?: UnshieldedOfferLike;
  fallibleUnshieldedOffer?: UnshieldedOfferLike;
  intentHash(segment: number): string;
};

/** The parts of a ledger-v9 `Transaction` the activity reads (also what a synthetic test transaction provides). */
export interface ActivityTransactionLike {
  intents?: Map<number, IntentLike>;
  guaranteedOffer?: ZswapOfferLike;
  fallibleOffer?: Map<number, ZswapOfferLike>;
}

/** The scan's event rows of the block (only `tx_index`, position, contract and classification are read). */
export interface ActivityEventRef {
  tx_index: number;
  event_index: number;
  contract_address: Buffer;
  classification: string;
}

export interface TransactionActivityInput {
  network: string;
  height: number;
  txIndex: number;
  /** Lowercase hex (the archive's hash). */
  txHash: string;
  tx: ActivityTransactionLike;
  outcome: TransactionOutcome;
  /** The block's event rows; those of `txIndex` give the metadata-event rows. */
  events: readonly ActivityEventRef[];
}

export class ActivityDecodeError extends Error {
  override name = "ActivityDecodeError";
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const buf = (h: string): Buffer => Buffer.from(normHex(h), "hex");

/** Deserializes archived bytes for the activity (the scan's default; synthetic tests pass their own). */
export function activityTransaction(raw: Uint8Array): ActivityTransactionLike {
  return Transaction.deserialize("signature", "proof", "binding", raw) as unknown as ActivityTransactionLike;
}

/** The color of a contract-effect token type; `undefined` for DUST (no color). Any other shape stops the scan. */
function colorOfTokenType(t: TokenTypeLike, txHash: string): string | undefined {
  if (t.tag === "dust") return undefined;
  if ((t.tag === "unshielded" || t.tag === "shielded") && typeof t.raw === "string") return normHex(t.raw);
  throw new ActivityDecodeError(`transaction ${txHash}: a contract effect has a token type of an unknown shape (tag ${String(t.tag)})`);
}

function sortedAmounts(m: Map<TokenTypeLike, bigint> | undefined, txHash: string): Array<[string, bigint]> {
  const out: Array<[string, bigint]> = [];
  for (const [t, a] of m ?? new Map<TokenTypeLike, bigint>()) {
    const c = colorOfTokenType(t, txHash);
    if (c !== undefined) out.push([c, BigInt(a)]);
  }
  return out.sort(([a], [b]) => byString(a, b));
}

type Draft = Omit<ActivityRow, "network" | "block_height" | "tx_index" | "item_index" | "tx_hash">;
type Add = (part: Part, d: Partial<Draft> & Pick<Draft, "role">) => void;

const EMPTY: Draft = {
  role: "mint", phase: null, segment_id: null, color: null, amount: null, direction: null, contract_address: null,
  action_index: null, entry_point: null, domain_sep: null, kind: null, wallet_address: null, recipient_contract: null,
  intent_hash: null, output_index: null, events_accepted: null, events_rejected: null, first_event_index: null,
};

/**
 * The activity rows of one transaction, in the ledger's execution order (guaranteed phase: the transaction's
 * guaranteed Zswap offer, then each intent by ascending segment — its guaranteed unshielded offer, then its calls'
 * guaranteed transcripts; then each fallible segment ascending — its Zswap offer, its fallible unshielded offer, its
 * calls' fallible transcripts), applied parts only, then one metadata-event row per contract (order of first event).
 */
export function transactionActivity(input: TransactionActivityInput): ActivityRow[] {
  const { tx, outcome, txHash } = input;
  const guaranteed: Draft[] = [];
  const fallible = new Map<number, Draft[]>();
  const add: Add = (part, d) => {
    if (!partApplied(part, outcome)) return;
    const list = part.phase === "guaranteed" ? guaranteed : (fallible.get(part.segment) ?? []);
    if (part.phase === "fallible") fallible.set(part.segment, list);
    list.push({ ...EMPTY, phase: part.phase, segment_id: part.segment, ...d });
  };
  const offerDeltas = (part: Part, offer: ZswapOfferLike): void => {
    if (offer === undefined || offer === null) return;
    const deltas = [...offer.deltas].map(([c, v]) => [normHex(String(c)), BigInt(v)] as const).sort(([a], [b]) => byString(a, b));
    for (const [color, delta] of deltas) {
      if (color === NIGHT_COLOR || delta === 0n) continue; // the zero color here is the shielded native token, not NIGHT
      add(part, { role: "shielded-offer", color: buf(color), amount: (delta < 0n ? -delta : delta).toString(), direction: delta < 0n ? "in" : "out" });
    }
  };

  offerDeltas({ phase: "guaranteed", segment: 0 }, tx.guaranteedOffer);
  const fallibleOffers = new Map(tx.fallibleOffer ?? new Map<number, ZswapOfferLike>());
  for (const [segment, intent] of [...(tx.intents ?? new Map<number, IntentLike>())].sort(([a], [b]) => a - b)) {
    offerDeltas({ phase: "fallible", segment }, fallibleOffers.get(segment));
    fallibleOffers.delete(segment);
    unshieldedOffers(segment, intent, outcome, add);
    intent.actions.forEach((action, actionIndex) => {
      if (!(action instanceof ContractCall)) return; // deploys and maintenance updates move no tokens
      const contract = normHex(String(action.address));
      const entryPoint = typeof action.entryPoint === "string" ? action.entryPoint : Buffer.from(action.entryPoint as Uint8Array).toString("utf8");
      for (const [phase, t] of [["guaranteed", action.guaranteedTranscript], ["fallible", action.fallibleTranscript]] as const) {
        if (t !== undefined && t !== null) transcriptRows({ phase, segment }, t as unknown as TranscriptLike, contract, actionIndex, entryPoint, txHash, add);
      }
    });
  }
  // A fallible Zswap offer whose segment has no intent still belongs to that segment.
  for (const [segment, offer] of [...fallibleOffers].sort(([a], [b]) => a - b)) offerDeltas({ phase: "fallible", segment }, offer);

  const drafts = [...guaranteed, ...[...fallible].sort(([a], [b]) => a - b).flatMap(([, l]) => l), ...metadataDrafts(input)];
  return drafts.map((d, itemIndex) => ({
    network: input.network, block_height: input.height, tx_index: input.txIndex, item_index: itemIndex, tx_hash: buf(txHash), ...d,
  }));
}

/** An intent's unshielded offers: spends (the spent UTXO's identity) and outputs (`intentHash(0)` when guaranteed). */
function unshieldedOffers(segment: number, intent: IntentLike, outcome: TransactionOutcome, add: Add): void {
  let outputIndex = 0; // intent-wide: guaranteed outputs first, then fallible, applied or not
  for (const phase of ["guaranteed", "fallible"] as const) {
    const offer = phase === "guaranteed" ? intent.guaranteedUnshieldedOffer : intent.fallibleUnshieldedOffer;
    if (offer === undefined || offer === null) continue;
    const part: Part = { phase, segment };
    for (const i of offer.inputs) {
      add(part, {
        role: "utxo-spent", color: buf(String(i.type)), amount: BigInt(i.value).toString(), direction: "out",
        wallet_address: buf(String(addressFromKey(i.owner as Parameters<typeof addressFromKey>[0]))),
        intent_hash: buf(String(i.intentHash)), output_index: Number(i.outputNo),
      });
    }
    const first = outputIndex;
    outputIndex += offer.outputs.length;
    if (offer.outputs.length === 0 || !partApplied(part, outcome)) continue;
    const intentHash = buf(String(intent.intentHash(phase === "guaranteed" ? 0 : segment)));
    offer.outputs.forEach((o, k) => add(part, {
      role: "utxo-created", color: buf(String(o.type)), amount: BigInt(o.value).toString(), direction: "in",
      wallet_address: buf(String(o.owner)), intent_hash: intentHash, output_index: first + k,
    }));
  }
}

function transcriptRows(part: Part, t: TranscriptLike, contract: string, actionIndex: number, entryPoint: string, txHash: string, add: Add): void {
  const at = { contract_address: buf(contract), action_index: actionIndex, entry_point: entryPoint };
  // Recipients the transcript claims per color (unshielded only); attached to the one row that funds them.
  const claimed = new Map<string, Array<{ to: PublicAddressLike; amount: bigint }>>();
  for (const [[tt, to], amount] of t.effects.claimedUnshieldedSpends ?? new Map<[TokenTypeLike, PublicAddressLike], bigint>()) {
    const c = colorOfTokenType(tt, txHash);
    if (c !== undefined) claimed.set(c, [...(claimed.get(c) ?? []), { to, amount: BigInt(amount) }]);
  }
  const outputs = sortedAmounts(t.effects.unshieldedOutputs, txHash);
  const mints: Array<[1 | 2, string, bigint, string]> = [];
  for (const [kind, m] of [[1, t.effects.shieldedMints], [2, t.effects.unshieldedMints]] as const)
    for (const [ds, amount] of [...m].map(([d, a]) => [normHex(String(d)), BigInt(a)] as const).sort(([a], [b]) => byString(a, b)))
      mints.push([kind, ds, amount, tokenColor(ds, contract)]);
  const funders = (color: string): number =>
    mints.filter(([k, , , c]) => k === 2 && c === color).length + outputs.filter(([c]) => c === color).length;
  const recipient = (color: string, amount: bigint): Partial<Draft> => {
    const r = claimed.get(color);
    if (r === undefined || r.length !== 1 || r[0]!.amount !== amount || funders(color) !== 1) return {};
    const to = r[0]!.to;
    if (to.tag === "user") return { wallet_address: buf(to.address) };
    return to.tag === "contract" ? { recipient_contract: buf(to.address) } : {};
  };
  for (const [kind, ds, amount, color] of mints) {
    add(part, { role: "mint", ...at, color: buf(color), amount: amount.toString(), direction: "in", domain_sep: buf(ds), kind, ...(kind === 2 ? recipient(color, amount) : {}) });
  }
  for (const [color, amount] of sortedAmounts(t.effects.unshieldedInputs, txHash))
    add(part, { role: "contract-in", ...at, color: buf(color), amount: amount.toString(), direction: "in" });
  for (const [color, amount] of outputs)
    add(part, { role: "contract-out", ...at, color: buf(color), amount: amount.toString(), direction: "out", ...recipient(color, amount) });
}

/** One row per contract with accepted or rejected MIP-0018 events in the transaction (never `ignore`, Q19). */
function metadataDrafts(input: TransactionActivityInput): Draft[] {
  const byContract = new Map<string, { contract: Buffer; accepted: number; rejected: number; first: number }>();
  const events = input.events
    .filter((e) => e.tx_index === input.txIndex && (e.classification === "accept" || e.classification === "reject"))
    .sort((a, b) => a.event_index - b.event_index);
  for (const e of events) {
    const k = e.contract_address.toString("hex");
    const entry = byContract.get(k) ?? { contract: e.contract_address, accepted: 0, rejected: 0, first: e.event_index };
    if (e.classification === "accept") entry.accepted++;
    else entry.rejected++;
    byContract.set(k, entry);
  }
  return [...byContract.values()].map((m) => ({
    ...EMPTY, role: "metadata-event" as const, contract_address: m.contract,
    events_accepted: m.accepted, events_rejected: m.rejected, first_event_index: m.first,
  }));
}

/** Writes one block's activity rows (idempotent), inside the scan's block transaction. */
export async function writeActivity(tx: Queryable, schema: string, rows: readonly ActivityRow[]): Promise<void> {
  for (const r of rows) await tx`INSERT INTO ${tx(schema)}.mip0018_activity ${tx(r as unknown as Record<string, unknown>)} ON CONFLICT DO NOTHING`;
}

/** Removes every activity row above `height` (with the scan's `removeAbove`, in its transaction). */
export async function removeActivityAbove(tx: Queryable, schema: string, network: string, height: number): Promise<void> {
  await tx`DELETE FROM ${tx(schema)}.mip0018_activity WHERE network = ${network} AND block_height > ${height}`;
}
