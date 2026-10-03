/**
 * Token activity: the public token flows of every applied transaction part, written by the MIP-0018 scan (`scan.ts`,
 * one call per transaction inside the block's Postgres transaction) into `mip0018_activity` (migration
 * `003_mip0018_activity`, where the roles are described), and the keyset-paginated reads the API serves
 * (`activityForColor`, `metadataTransactionsForContract`).
 *
 * Ledger rules this module depends on: the output of a guaranteed unshielded offer belongs to the UTXO
 * `intentHash(0)`, of a fallible one to `intentHash(segment)`; an intent's output numbering runs over its guaranteed
 * outputs, then its fallible ones (whether or not they applied); ledger `Map`s iterate in random order, so every
 * effect map is sorted.
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
import { walletAddress } from "./bech32m.ts";
import { tokenColor } from "./color.ts";
import { ENTRY_POINT_MAX_BYTES, entryPointBytes, type EntryPointJson, entryPointJson } from "./entry-point.ts";

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
  /** The entry point's exact bytes (arbitrary on the ledger; `bytea`). */
  entry_point: Buffer | null;
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
      const entryPoint = entryPointBytes(action.entryPoint as Uint8Array | string); // exact bytes, never a lossy UTF-8 decode
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

function transcriptRows(part: Part, t: TranscriptLike, contract: string, actionIndex: number, entryPoint: Buffer, txHash: string, add: Add): void {
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

/** One row per contract with accepted or rejected MIP-0018 events in the transaction (never `ignore`). */
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

/* ── Reads (what the API serves: `GET /v1/tokens/{color}/activity` and `GET /v1/contracts/{address}/activity`) ─────── */

/** Largest page a read returns. */
export const ACTIVITY_PAGE_MAX = 500;
/** Page size when none is given. */
export const ACTIVITY_PAGE_DEFAULT = 100;

/** A bad read request (limit, cursor, color, contract) — an HTTP 400 for the API. */
export class ActivityQueryError extends Error {
  override name = "ActivityQueryError";
}

export interface ActivityItem {
  /** Chain position: block height, transaction position in the block, row position in the transaction. */
  height: number;
  txIndex: number;
  itemIndex: number;
  txHash: string;
  role: ActivityRole;
  phase?: Phase;
  segment?: number;
  color?: string;
  /** Unsigned decimal; `direction` gives the sign relative to the role's subject. */
  amount?: string;
  direction?: "in" | "out";
  contract?: string;
  actionIndex?: number;
  /** The entry point: its exact bytes as hex, and a `text` form only when printable (`entry-point.ts`). */
  entryPoint?: EntryPointJson;
  domainSep?: string;
  kind?: 1 | 2;
  /** A wallet (`UserAddress`) as Bech32m — never hex. */
  wallet?: string;
  /** A contract recipient (hex — never Bech32m). */
  recipientContract?: string;
  /** The UTXO created, or the UTXO spent. */
  utxo?: { intentHash: string; outputIndex: number };
  /** `metadata-event` rows: classification counts and the first event's index in the transaction's event log. */
  events?: { accepted: number; rejected: number; firstEventIndex: number };
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Opaque; absent on the last page. */
  nextCursor?: string;
}

export interface ActivityPageOptions {
  /** 1…{@link ACTIVITY_PAGE_MAX} (default {@link ACTIVITY_PAGE_DEFAULT}). */
  limit?: number;
  cursor?: string;
  /** Chain order, oldest first (default) or newest first. */
  order?: "asc" | "desc";
}

interface DbActivityRow {
  block_height: bigint | number;
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
  /** At most {@link ENTRY_POINT_MAX_BYTES} bytes (the listing reads a prefix); `entry_point_length` = the full length. */
  entry_point: Buffer | null;
  entry_point_length?: number | null;
  domain_sep: Buffer | null;
  kind: number | null;
  wallet_address: Buffer | null;
  recipient_contract: Buffer | null;
  intent_hash: Buffer | null;
  output_index: number | null;
  events_accepted: number | null;
  events_rejected: number | null;
  first_event_index: number | null;
}

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const MAX_POSITION: [string, number, number] = ["9223372036854775807", 2147483647, 2147483647];
const MIN_POSITION: [string, number, number] = ["-1", -1, -1];

function hex32(what: string, value: string): Buffer {
  if (!HEX32.test(value)) throw new ActivityQueryError(`${what} must be 32 bytes of hex`);
  return Buffer.from(normHex(value), "hex");
}

interface CursorBody {
  v: 1;
  /** Subject: `c:<color>` or `m:<contract>`. */
  s: string;
  o: "asc" | "desc";
  p: [number, number, number];
}

function encodeCursor(c: CursorBody): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, subject: string, order: "asc" | "desc"): [string, number, number] {
  let c: unknown;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error("shape");
    c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ActivityQueryError("cursor is not a cursor of this API");
  }
  const b = c as Partial<CursorBody>;
  const p = b.p;
  if (b.v !== 1 || !Array.isArray(p) || p.length !== 3 || !p.every((x) => Number.isSafeInteger(x) && (x as number) >= 0))
    throw new ActivityQueryError("cursor is not a cursor of this API");
  // Only the canonical form this API issues (the decode/encode round trip gives the same string):
  // no extra or reordered keys, no whitespace, no other number or base64url spelling.
  if (typeof b.s !== "string" || (b.o !== "asc" && b.o !== "desc") || encodeCursor({ v: 1, s: b.s, o: b.o, p: [p[0], p[1], p[2]] as [number, number, number] }) !== cursor)
    throw new ActivityQueryError("cursor is not a cursor of this API");
  if (b.s !== subject || b.o !== order) throw new ActivityQueryError("cursor belongs to another listing or order");
  return [String(p[0]), p[1] as number, p[2] as number];
}

function pageOptions(o: ActivityPageOptions): { limit: number; order: "asc" | "desc" } {
  const limit = o.limit ?? ACTIVITY_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE_MAX) throw new ActivityQueryError(`limit must be an integer from 1 to ${ACTIVITY_PAGE_MAX}`);
  const order = o.order ?? "asc";
  if (order !== "asc" && order !== "desc") throw new ActivityQueryError("order must be asc or desc");
  return { limit, order };
}

/** One stored row as the API serves it (bytes as hex, wallet addresses as Bech32m, absent fields omitted). */
export function activityItem(network: string, r: DbActivityRow): ActivityItem {
  const h = (b: Buffer | null): string | undefined => (b === null ? undefined : b.toString("hex"));
  const item: ActivityItem = { height: Number(r.block_height), txIndex: r.tx_index, itemIndex: r.item_index, txHash: r.tx_hash.toString("hex"), role: r.role };
  if (r.phase !== null) item.phase = r.phase;
  if (r.segment_id !== null) item.segment = r.segment_id;
  if (r.color !== null) item.color = h(r.color);
  if (r.amount !== null) item.amount = String(r.amount);
  if (r.direction !== null) item.direction = r.direction;
  if (r.contract_address !== null) item.contract = h(r.contract_address);
  if (r.action_index !== null) item.actionIndex = r.action_index;
  if (r.entry_point !== null) item.entryPoint = entryPointJson(r.entry_point, r.entry_point_length ?? r.entry_point.length);
  if (r.domain_sep !== null) item.domainSep = h(r.domain_sep);
  if (r.kind !== null) item.kind = r.kind as 1 | 2;
  if (r.wallet_address !== null) item.wallet = walletAddress(network, r.wallet_address.toString("hex"));
  if (r.recipient_contract !== null) item.recipientContract = h(r.recipient_contract);
  if (r.intent_hash !== null && r.output_index !== null) item.utxo = { intentHash: r.intent_hash.toString("hex"), outputIndex: r.output_index };
  if (r.events_accepted !== null && r.events_rejected !== null && r.first_event_index !== null)
    item.events = { accepted: r.events_accepted, rejected: r.events_rejected, firstEventIndex: r.first_event_index };
  return item;
}

/** The stored columns of an activity row as a listing serves them (an entry point as its first bytes and its length). */
function rowColumns(sql: Queryable) {
  return sql`
    a.block_height, a.tx_index, a.item_index, a.tx_hash, a.role, a.phase, a.segment_id, a.color, a.amount, a.direction,
    a.contract_address, a.action_index,
    substring(a.entry_point FROM 1 FOR ${ENTRY_POINT_MAX_BYTES}) AS entry_point, octet_length(a.entry_point) AS entry_point_length,
    a.domain_sep, a.kind, a.wallet_address, a.recipient_contract, a.intent_hash, a.output_index`;
}

/**
 * Up to `n` metadata transactions of `contract` after (`asc`) or before (`desc`) the position `pos`, in that order:
 * one row per transaction with a LISTED event of the contract (`mip0018_listed_events`, kept by the apply path; MIP
 * "Applying records": a withdrawn identity MUST NOT be referenced in metadata history) — its rejected events (they
 * describe no identity) and the accepted events of an identity's current description, which has a field now and
 * began at its last revival. Counts and the first listed event's index; values are never read.
 *
 * Bounded by what it serves: a recursive index skip scan over the contract's listed events finds each next transaction
 * with one probe; the transaction's stored `metadata-event` row and the counts of its
 * listed events are read by key. Events of withdrawn identities are not in the listed table at all, so hidden history
 * is never read, however long it is. The recursion is read lazily and yields the transactions in chain order (as the
 * token list's identity skip scan in `api-views.ts`), so `LIMIT n` ends it.
 */
function metadataRows(
  sql: Queryable, schema: string, network: string, contract: Buffer, pos: readonly [string, number, number], order: "asc" | "desc", n: number,
) {
  const s = sql(schema);
  const [h, t, i] = pos;
  const asc = order === "asc";
  const from = asc ? sql`(l.block_height, l.tx_index) >= (${h}::bigint, ${t}::int)` : sql`(l.block_height, l.tx_index) <= (${h}::bigint, ${t}::int)`;
  const next = asc ? sql`(l.block_height, l.tx_index) > (g.block_height, g.tx_index)` : sql`(l.block_height, l.tx_index) < (g.block_height, g.tx_index)`;
  const by = asc ? sql`l.block_height, l.tx_index` : sql`l.block_height DESC, l.tx_index DESC`;
  const after = asc
    ? sql`(a.block_height, a.tx_index, a.item_index) > (${h}::bigint, ${t}::int, ${i}::int)`
    : sql`(a.block_height, a.tx_index, a.item_index) < (${h}::bigint, ${t}::int, ${i}::int)`;
  return sql`
    WITH RECURSIVE g AS (
      (SELECT l.block_height, l.tx_index FROM ${s}.mip0018_listed_events l
       WHERE l.network = ${network} AND l.contract_address = ${contract} AND ${from}
       ORDER BY ${by} LIMIT 1)
      UNION ALL
      SELECT x.block_height, x.tx_index FROM g CROSS JOIN LATERAL (
        SELECT l.block_height, l.tx_index FROM ${s}.mip0018_listed_events l
        WHERE l.network = ${network} AND l.contract_address = ${contract} AND ${next}
        ORDER BY ${by} LIMIT 1) x
    )
    SELECT a.*, c.accepted AS events_accepted, c.rejected AS events_rejected, c.first AS first_event_index
    FROM g
    CROSS JOIN LATERAL (
      SELECT ${rowColumns(sql)} FROM ${s}.mip0018_activity a
      WHERE a.network = ${network} AND a.role = 'metadata-event' AND a.contract_address = ${contract}
        AND a.block_height = g.block_height AND a.tx_index = g.tx_index
      LIMIT 1 -- one row per (transaction, contract); the LIMIT also keeps this a lookup per transaction, never a join over all
    ) a
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE l.classification = 'accept')::int AS accepted,
             count(*) FILTER (WHERE l.classification = 'reject')::int AS rejected,
             min(l.event_index) AS first
      FROM ${s}.mip0018_listed_events l
      WHERE l.network = ${network} AND l.contract_address = ${contract} AND l.block_height = g.block_height AND l.tx_index = g.tx_index
    ) c
    WHERE ${after}
    LIMIT ${n}`;
}

function page(network: string, rows: readonly DbActivityRow[], limit: number, subject: string, order: "asc" | "desc"): ActivityPage {
  const items = rows.slice(0, limit).map((r) => activityItem(network, r));
  const last = items.at(-1);
  return rows.length > limit && last !== undefined
    ? { items, nextCursor: encodeCursor({ v: 1, s: subject, o: order, p: [last.height, last.txIndex, last.itemIndex] }) }
    : { items };
}

/**
 * A color's activity in chain order (keyset pagination): its own rows (mints, UTXOs, contract flows, offer deltas)
 * and the metadata transactions of the contract that minted it (none for a color whose mint is outside the indexed
 * range, e.g. NIGHT) — counting only listed events: rejected ones, and accepted ones of an identity's current
 * description (a withdrawn identity's metadata transactions are not referenced, nor a revived identity's transactions
 * from before its last withdrawal). DUST has no color and therefore no activity. Bounded by the page: at most
 * `limit + 1` rows of each kind are read — the color's own rows by an ordered index range scan, the metadata transactions by `metadataRows` — then merged in chain order.
 */
export async function activityForColor(
  sql: Queryable, network: string, color: string, o: ActivityPageOptions = {}, schema = "mip0018",
): Promise<ActivityPage & { contract?: string }> {
  const c = hex32("color", color);
  const { limit, order } = pageOptions(o);
  const subject = `c:${c.toString("hex")}`;
  const pos = o.cursor === undefined ? (order === "asc" ? MIN_POSITION : MAX_POSITION) : decodeCursor(o.cursor, subject, order);
  const [h, t, i] = pos;
  const s = sql(schema);
  const minted = await sql<{ contract_address: Buffer }[]>`
    SELECT contract_address FROM ${s}.mip0018_mints WHERE network = ${network} AND color = ${c} LIMIT 1`;
  const contract = minted[0]?.contract_address ?? null;
  const own = order === "asc"
    ? sql`
        SELECT ${rowColumns(sql)}, a.events_accepted, a.events_rejected, a.first_event_index FROM ${s}.mip0018_activity a
        WHERE a.network = ${network} AND a.color = ${c} AND (a.block_height, a.tx_index, a.item_index) > (${h}::bigint, ${t}::int, ${i}::int)
        ORDER BY a.block_height, a.tx_index, a.item_index LIMIT ${limit + 1}`
    : sql`
        SELECT ${rowColumns(sql)}, a.events_accepted, a.events_rejected, a.first_event_index FROM ${s}.mip0018_activity a
        WHERE a.network = ${network} AND a.color = ${c} AND (a.block_height, a.tx_index, a.item_index) < (${h}::bigint, ${t}::int, ${i}::int)
        ORDER BY a.block_height DESC, a.tx_index DESC, a.item_index DESC LIMIT ${limit + 1}`;
  const rows = contract === null
    ? await sql<DbActivityRow[]>`${own}`
    : await sql<DbActivityRow[]>`
        SELECT * FROM ((${own}) UNION ALL (${metadataRows(sql, schema, network, contract, pos, order, limit + 1)})) u
        ORDER BY ${order === "asc" ? sql`u.block_height, u.tx_index, u.item_index` : sql`u.block_height DESC, u.tx_index DESC, u.item_index DESC`}
        LIMIT ${limit + 1}`;
  const p = page(network, rows, limit, subject, order);
  return contract === null ? p : { ...p, contract: contract.toString("hex") };
}

/**
 * A contract's metadata transactions in chain order (keyset pagination): one row per transaction with listed MIP-0018
 * events of that contract — rejected ones, or accepted ones of an identity's current description — what a kind-3
 * identity (no color) shows as its activity. Counts and the event-log reference only;
 * never decoded values. Bounded by the page (`metadataRows`).
 */
export async function metadataTransactionsForContract(
  sql: Queryable, network: string, contract: string, o: ActivityPageOptions = {}, schema = "mip0018",
): Promise<ActivityPage> {
  const a = hex32("contract", contract);
  const { limit, order } = pageOptions(o);
  const subject = `m:${a.toString("hex")}`;
  const pos = o.cursor === undefined ? (order === "asc" ? MIN_POSITION : MAX_POSITION) : decodeCursor(o.cursor, subject, order);
  const rows = await sql<DbActivityRow[]>`${metadataRows(sql, schema, network, a, pos, order, limit + 1)}`;
  return page(network, rows, limit, subject, order);
}
