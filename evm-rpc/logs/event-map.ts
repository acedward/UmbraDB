/**
 * C-G1 — the pure Midnight-event -> EVM-log-row mapping. NO I/O of any kind: no database, no
 * network, no clock. Everything this module needs arrives in its arguments, which is what makes
 * the golden-file tests in `test/golden/` a real contract rather than a smoke test, and what lets
 * `test/verify-parity.ts` re-run the identical mapping over raw GraphQL output and compare it
 * against what `eth_getLogs` served out of Postgres.
 *
 * The normative specification of this mapping is `LOGMAP.md`, in this directory. That document is
 * a CONTRACT shared with Part D (`EVENTS.md` in the token-dapp repo must stay identical to it) and
 * with Part B (receipts read the `logs` rows this produces). Change one, change all three.
 *
 * Coded against the indexer's v4 SDL as snapshotted in `schema-v4.snapshot.graphql` (copied from
 * `midnight-indexer/indexer-api/graphql/schema-v4.graphql` at v2.0.0-rc.4) so this repo does not
 * depend on a sibling checkout to be reviewable.
 */

import { keccak256, keccak256Utf8 } from "./keccak256.js";

// ===========================================================================================
// Wire types (the shape the indexer's `contractEvents` query/subscription returns)
// ===========================================================================================

/** Per-contract ABI interpretation, from the `WATCH_CONTRACTS_FILE` entry for the address. */
export type AbiProfile = "erc20" | "erc721" | "misc";

/**
 * `AddressOrContract` from the SDL: a tagged union where exactly one of the two hex fields is
 * populated, discriminated by `kind`. For Part D's contract the USER branch carries the OZ witness
 * accountId (`persistentHash(sk)`) — an identity, NOT a spendable key.
 */
export interface AddressOrContract {
  kind: "USER" | "CONTRACT";
  userAddress?: string | null;
  contractAddress?: string | null;
}

export interface EventBlock {
  height: number;
  hash: string;
  /**
   * Optional. The SDL gives an event no transaction-index-within-block field, so `tx_index` is
   * recovered by locating `transaction.hash` in its block's transaction list. When the caller did
   * not select this (or the hash is not found), `tx_index` falls back to 0 and a warning is
   * raised — see `LOGMAP.md` §"tx_index" and Open question Q2 in the plan.
   */
  transactions?: readonly { hash: string }[] | null;
}

export interface EventTransaction {
  hash: string;
  block: EventBlock;
}

/**
 * One contract event, as a flat bag of every field any concrete type contributes. The wire really
 * is this shape once inline fragments are collapsed into a single JSON object, and a flat bag maps
 * onto "be total over what actually arrives" better than a strict union would: an unknown
 * `__typename` from a newer indexer is skipped with a warning rather than crashing the ingester,
 * while a KNOWN type missing a field the SDL declares non-null throws, because that means the
 * schema contract this module is built on has broken and silently emitting a wrong log would
 * corrupt logs-derived balances.
 */
export interface MidnightEvent {
  __typename: string;
  id: number;
  /**
   * The SDL's "maximum ID of all contract events". Optional here because the pure mapping never
   * needs it, but the ingester selects it: `id === maxId` means the indexer knows of no newer
   * event at all, which is one of the three conditions that let a held-back trailing transaction
   * be flushed (see {@link splitCompleteTransactions} and `ingest.ts`).
   */
  maxId?: number;
  contractAddress: string;
  transactionId: number;
  transaction: EventTransaction;
  // --- concrete-type fields (each present only on the types that declare it) ---
  sender?: AddressOrContract | null;
  recipient?: AddressOrContract | null;
  domainSep?: string | null;
  tokenType?: string | null;
  amount?: string | null;
  nullifier?: string | null;
  commitment?: string | null;
  ciphertext?: string | null;
  receivingContractAddress?: string | null;
  name?: string | null;
  payload?: string | null;
}

// ===========================================================================================
// Output row
// ===========================================================================================

/**
 * One `evm_rpc.logs` row, minus the identity columns only the database can assign (`id`, and
 * `address_id`, which the ingester resolves through `evm_rpc.address_map`). `address` is the
 * 20-byte EVM address the mapper derived; the ingester turns it into `address_id`.
 */
export interface LogRow {
  /** 20-byte EVM address of the EMITTING contract. */
  address: Uint8Array;
  blockNumber: number;
  /** 32 bytes. */
  blockHash: Uint8Array;
  /** 32 bytes. */
  txHash: Uint8Array;
  txIndex: number;
  /** 0-based position among the logs THIS mapping produced for this transaction. */
  logIndex: number;
  /** 1..4 entries, each exactly 32 bytes. `topics[0]` is always present. */
  topics: Uint8Array[];
  data: Uint8Array;
  /**
   * The source event `id` this row is keyed on — `UNIQUE` in the table, which is what makes the
   * at-least-once subscription safely replayable. For a Spend/Receive PAIR it is the LOWER of the
   * two ids (the spend); the partner id is deliberately not recorded, see `LOGMAP.md`
   * §"Idempotency".
   */
  sourceEventId: number;
  /** Always `false` in Part C — no reorg handling here (see `LOGMAP.md` §"Reorgs"). */
  removed: boolean;
}

// ===========================================================================================
// Diagnostics
// ===========================================================================================

export type MapWarningCode =
  /** Two or more equally-matching pair candidates; resolved FIFO (plan: "pairs FIFO and warns"). */
  | "pair-ambiguous"
  /** `block.transactions` absent or the tx hash not found in it — `tx_index` fell back to 0. */
  | "tx-index-unavailable"
  /** `__typename` is not one of the SDL's ContractEvent implementors; the event was skipped. */
  | "unknown-event-type";

export interface MapWarning {
  code: MapWarningCode;
  message: string;
  /** Source event ids the warning concerns. */
  eventIds: number[];
}

/** Thrown when a KNOWN event type is missing a field the v4 SDL declares non-null. */
export class EventMapError extends Error {
  readonly eventId: number;
  readonly typeName: string;
  constructor(message: string, typeName: string, eventId: number) {
    super(`event-map: ${message} (${typeName}, event id ${eventId})`);
    this.name = "EventMapError";
    this.typeName = typeName;
    this.eventId = eventId;
  }
}

export interface MapOptions {
  onWarning?: (warning: MapWarning) => void;
}

// ===========================================================================================
// Address mapping
// ===========================================================================================

export interface MidnightIdentity {
  /** `midnight` = a user accountId (bytes32); `contract` = a Midnight contract address. */
  kind: "midnight" | "contract";
  /** Unprefixed hex, as the indexer serves it. */
  hex: string;
}

/**
 * Maps a Midnight identity onto a 20-byte EVM address. Injected rather than hardcoded so Part E
 * can substitute the Ethereum-native path, where identities already ARE 20 bytes.
 */
export type AddressMapper = (identity: MidnightIdentity) => Uint8Array;

/**
 * `keccak256(bytes)[12:32]` — the low 20 bytes of the hash, matching how Ethereum derives an
 * address from a public key. A value that is ALREADY 20 bytes passes through untouched, which is
 * what makes Part E's pre-sized Ethereum identities work through the same mapper.
 */
export const defaultAddressMapper: AddressMapper = ({ hex }) => {
  const bytes = fromHex(hex);
  if (bytes.length === 20) return bytes;
  // Ethereum-native identities (Part E's eth-keyed circuits) travel through events as the
  // 20-byte address zero-LEFT-padded into the 32-byte Either user branch. Pass them through
  // verbatim instead of hashing, so logs carry the signer's real address. A genuine OZ
  // accountId (persistentHash output) starts with 12 zero bytes with probability 2^-96 —
  // treated as negligible; LOGMAP.md documents the rule.
  if (bytes.length === 32 && bytes.subarray(0, 12).every((b) => b === 0)) {
    return bytes.subarray(12, 32);
  }
  return keccak256(bytes).slice(12, 32);
};

// ===========================================================================================
// Topic constants
// ===========================================================================================

/** `keccak256("Transfer(address,address,uint256)")` — asserted against the literal in the tests. */
export const TRANSFER_TOPIC0: Uint8Array = keccak256Utf8("Transfer(address,address,uint256)");

/**
 * The `Midnight<TypeName>()` completeness topics. The signature string is the GraphQL
 * `__typename` verbatim, so the constant is derivable mechanically from the SDL rather than from a
 * hand-maintained naming convention. `LOGMAP.md` tabulates the resulting hex values.
 */
export function midnightTopic0(typeName: string): Uint8Array {
  return keccak256Utf8(`Midnight${typeName}()`);
}

/** Every `ContractEvent` implementor in the v4 SDL. An event outside this set is skipped. */
export const KNOWN_EVENT_TYPES: readonly string[] = [
  "ShieldedSpendEvent",
  "ShieldedReceiveEvent",
  "ShieldedMintEvent",
  "ShieldedBurnEvent",
  "UnshieldedSpendEvent",
  "UnshieldedReceiveEvent",
  "UnshieldedMintEvent",
  "UnshieldedBurnEvent",
  "PausedEvent",
  "UnpausedEvent",
  "MiscContractEvent",
];

// ===========================================================================================
// Hex / word helpers
// ===========================================================================================

const HEX_RE = /^[0-9a-fA-F]*$/;

/** Parses unprefixed (or `0x`-prefixed) hex. Throws on odd length or a non-hex character. */
export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`event-map: hex string has odd length: "${hex}"`);
  if (!HEX_RE.test(body)) throw new Error(`event-map: not a hex string: "${hex}"`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const ZERO_WORD = new Uint8Array(32);
/** `address(0)` — the mint/burn counterparty in an ERC20/721 Transfer. */
const ZERO_ADDRESS = new Uint8Array(20);

/** Right-aligns `bytes` in a 32-byte word (EVM left-padding). Throws if longer than 32. */
function toWord(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new Error(`event-map: value of ${bytes.length} bytes does not fit a 32-byte word`);
  }
  if (bytes.length === 32) return bytes;
  const word = new Uint8Array(32);
  word.set(bytes, 32 - bytes.length);
  return word;
}

/**
 * The SDL serves `amount` as a decimal string. Parsed through ONE guarded helper so a malformed
 * value always surfaces as this module's typed message — `pairKey` parses amounts too, and an
 * unguarded `BigInt()` there would leak a raw `SyntaxError` from the pairing pass before the
 * encoding pass ever got a chance to classify it.
 */
export function parseAmount(decimal: string): bigint {
  let value: bigint;
  try {
    value = BigInt(decimal);
  } catch {
    throw new Error(`event-map: amount is not an integer string: "${decimal}"`);
  }
  if (value < 0n) throw new Error(`event-map: amount is negative: "${decimal}"`);
  if (value >= 1n << 256n) throw new Error(`event-map: amount exceeds uint256: "${decimal}"`);
  return value;
}

/** A decimal `amount` string as a big-endian uint256 word. */
function uint256Word(decimal: string): Uint8Array {
  let value: bigint = parseAmount(decimal);
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    word[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return word;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The populated branch of an `AddressOrContract`, as a `MidnightIdentity`. */
function identityOf(either: AddressOrContract, typeName: string, eventId: number): MidnightIdentity {
  if (either.kind === "USER") {
    if (either.userAddress == null) {
      throw new EventMapError("kind is USER but userAddress is null", typeName, eventId);
    }
    return { kind: "midnight", hex: either.userAddress };
  }
  if (either.kind === "CONTRACT") {
    if (either.contractAddress == null) {
      throw new EventMapError("kind is CONTRACT but contractAddress is null", typeName, eventId);
    }
    return { kind: "contract", hex: either.contractAddress };
  }
  throw new EventMapError(`unknown AddressOrContract kind "${String(either.kind)}"`, typeName, eventId);
}

function requireField<K extends keyof MidnightEvent>(
  event: MidnightEvent,
  field: K,
): NonNullable<MidnightEvent[K]> {
  const value = event[field];
  if (value == null) {
    throw new EventMapError(`missing non-null field "${String(field)}"`, event.__typename, event.id);
  }
  return value as NonNullable<MidnightEvent[K]>;
}

// ===========================================================================================
// Transaction-completeness split (used by the ingester, spec'd in LOGMAP.md §"Batch boundaries")
// ===========================================================================================

/**
 * Splits an id-ordered event stream into the prefix whose transactions are provably COMPLETE and
 * a trailing remainder that may still be missing events.
 *
 * This exists because pairing is scoped to a transaction, and a Spend/Receive pair split across
 * two delivery batches would map to a bogus burn + a bogus mint instead of one Transfer. Events
 * arrive in monotonic `id` order and a transaction's events are contiguous in that order, so
 * every transaction EXCEPT the last one seen is complete; the last one is held back until an event
 * from a different transaction proves it closed. The ingester therefore only ever advances
 * `log_cursors.last_event_id` to a transaction boundary, and a restart re-reads the held tail.
 *
 * HOLDING BACK ALONE WOULD STALL AT THE TIP: a contract whose only activity so far is one transfer
 * has exactly one transaction in the stream, so `complete` is empty and nothing would ever be
 * written until some *second* transaction happened. `ingest.ts` therefore flushes the `pending`
 * tail on two further conditions this pure function cannot see — `id === maxId` (the indexer knows
 * of no newer event) and a bounded idle timeout — either of which proves the transaction closed,
 * since an indexer writes all of a block's events together.
 */
export function splitCompleteTransactions(events: readonly MidnightEvent[]): {
  complete: MidnightEvent[];
  pending: MidnightEvent[];
} {
  if (events.length === 0) return { complete: [], pending: [] };
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const lastTxId = ordered[ordered.length - 1]!.transactionId;
  const boundary = ordered.findIndex((event) => event.transactionId === lastTxId);
  return { complete: ordered.slice(0, boundary), pending: ordered.slice(boundary) };
}

// ===========================================================================================
// The mapping
// ===========================================================================================

/** One log-to-be, before `log_index` is assigned. */
interface PendingLog {
  primaryId: number;
  topics: Uint8Array[];
  data: Uint8Array;
}

/**
 * Maps contract events to `evm_rpc.logs` rows.
 *
 * `events` MUST contain every event of each transaction it mentions — pass it the `complete` half
 * of {@link splitCompleteTransactions}, never a raw delivery batch, or pairs straddling the batch
 * edge will map as an unpaired burn plus an unpaired mint.
 */
export function mapEvents(
  events: readonly MidnightEvent[],
  profile: AbiProfile,
  addressMapper: AddressMapper = defaultAddressMapper,
  options: MapOptions = {},
): LogRow[] {
  const warn = (warning: MapWarning): void => options.onWarning?.(warning);

  // Group by transaction, preserving first-seen (id) order of the transactions themselves.
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const byTransaction = new Map<number, MidnightEvent[]>();
  for (const event of ordered) {
    if (!KNOWN_EVENT_TYPES.includes(event.__typename)) {
      warn({
        code: "unknown-event-type",
        message: `skipping unknown event type "${event.__typename}"`,
        eventIds: [event.id],
      });
      continue;
    }
    const bucket = byTransaction.get(event.transactionId);
    if (bucket === undefined) byTransaction.set(event.transactionId, [event]);
    else bucket.push(event);
  }

  const rows: LogRow[] = [];
  for (const group of byTransaction.values()) {
    const pending = mapTransaction(group, profile, addressMapper, warn);
    // `log_index` is the 0-based position of the log within its transaction, ordered by the
    // source event id it is keyed on (LOGMAP.md §"log_index").
    pending.sort((a, b) => a.primaryId - b.primaryId);

    const first = group[0]!;
    const address = addressMapper({ kind: "contract", hex: first.contractAddress });
    const blockHash = fromHex(first.transaction.block.hash);
    const txHash = fromHex(first.transaction.hash);
    const txIndex = resolveTxIndex(first, warn);

    pending.forEach((log, index) => {
      rows.push({
        address,
        blockNumber: first.transaction.block.height,
        blockHash,
        txHash,
        txIndex,
        logIndex: index,
        topics: log.topics,
        data: log.data,
        sourceEventId: log.primaryId,
        removed: false,
      });
    });
  }
  return rows;
}

/** Recovers `tx_index` from the block's transaction list; 0 + a warning when unavailable. */
function resolveTxIndex(event: MidnightEvent, warn: (w: MapWarning) => void): number {
  const transactions = event.transaction.block.transactions;
  if (transactions != null) {
    const index = transactions.findIndex((tx) => tx.hash === event.transaction.hash);
    if (index >= 0) return index;
  }
  warn({
    code: "tx-index-unavailable",
    message:
      "block.transactions was not selected or did not contain this transaction hash; tx_index=0",
    eventIds: [event.id],
  });
  return 0;
}

function mapTransaction(
  group: readonly MidnightEvent[],
  profile: AbiProfile,
  addressMapper: AddressMapper,
  warn: (w: MapWarning) => void,
): PendingLog[] {
  const logs: PendingLog[] = [];
  const transferProfile = profile === "erc20" || profile === "erc721";

  // Under a Transfer-bearing profile, Unshielded Spend/Receive are consumed by the pairing pass
  // below; everything else maps one-to-one. Under `misc`, nothing is paired — the contract makes
  // no ERC20/721 claim, so its unshielded events keep their lossless Midnight* form.
  const spends: MidnightEvent[] = [];
  const receives: MidnightEvent[] = [];
  const singles: MidnightEvent[] = [];
  for (const event of group) {
    if (transferProfile && event.__typename === "UnshieldedSpendEvent") spends.push(event);
    else if (transferProfile && event.__typename === "UnshieldedReceiveEvent") receives.push(event);
    else singles.push(event);
  }

  // --- pairing pass: greedy, FIFO, in event-id order, keyed on (domainSep, tokenType, amount) ---
  const claimed = new Set<number>();
  for (const spend of spends) {
    const key = pairKey(spend);
    const candidates = receives.filter((r) => !claimed.has(r.id) && pairKey(r) === key);
    if (candidates.length === 0) {
      // Unpaired Spend => burn: Transfer(from = sender, to = 0x0).
      logs.push(
        transferLog(
          spend,
          addressMapper(identityOf(requireField(spend, "sender"), spend.__typename, spend.id)),
          ZERO_ADDRESS,
          spend,
          profile,
        ),
      );
      continue;
    }
    if (candidates.length > 1) {
      warn({
        code: "pair-ambiguous",
        message:
          `${candidates.length} equally-matching Receive candidates for Spend ${spend.id} ` +
          `(domainSep/tokenType/amount identical); pairing FIFO with ${candidates[0]!.id}`,
        eventIds: [spend.id, ...candidates.map((c) => c.id)],
      });
    }
    const receive = candidates[0]!;
    claimed.add(receive.id);
    logs.push(
      transferLog(
        spend,
        addressMapper(identityOf(requireField(spend, "sender"), spend.__typename, spend.id)),
        addressMapper(identityOf(requireField(receive, "recipient"), receive.__typename, receive.id)),
        spend,
        profile,
      ),
    );
  }
  for (const receive of receives) {
    if (claimed.has(receive.id)) continue;
    // Unpaired Receive => mint: Transfer(from = 0x0, to = recipient).
    logs.push(
      transferLog(
        receive,
        ZERO_ADDRESS,
        addressMapper(identityOf(requireField(receive, "recipient"), receive.__typename, receive.id)),
        receive,
        profile,
      ),
    );
  }

  for (const event of singles) logs.push(standardLog(event));
  return logs;
}

/** The pair identity: same transaction (guaranteed by the caller) + domainSep + tokenType + amount. */
function pairKey(event: MidnightEvent): string {
  return [
    normaliseHex(requireField(event, "domainSep")),
    normaliseHex(requireField(event, "tokenType")),
    parseAmount(requireField(event, "amount")).toString(),
  ].join("|");
}

function normaliseHex(hex: string): string {
  return toHex(fromHex(hex));
}

/**
 * `Transfer(address indexed from, address indexed to, uint256 value)`.
 *
 * erc20: `data = amount` as a uint256 word, no topic3.
 * erc721: `topic3 = tokenType` (the tokenId) and `data` is empty — the indexed-tokenId form
 * `Transfer(address,address,uint256)` that ERC721 shares its signature hash with ERC20.
 */
function transferLog(
  keyEvent: MidnightEvent,
  from: Uint8Array,
  to: Uint8Array,
  valueSource: MidnightEvent,
  profile: AbiProfile,
): PendingLog {
  const topics = [TRANSFER_TOPIC0, toWord(from), toWord(to)];
  let data: Uint8Array;
  if (profile === "erc721") {
    topics.push(toWord(fromHex(requireField(valueSource, "tokenType"))));
    data = new Uint8Array(0);
  } else {
    data = uint256Word(requireField(valueSource, "amount"));
  }
  return { primaryId: keyEvent.id, topics, data };
}

/**
 * The non-Transfer forms. `MiscContractEvent` is the contract-defined case
 * (`topic0 = keccak256(name)`, `data = payload`); everything else takes a
 * `keccak256("Midnight<TypeName>()")` topic0 with the per-type topic/data layout LOGMAP.md
 * tabulates. Address-typed fields keep their RAW Midnight bytes here rather than being squeezed
 * to 20 bytes: these events exist for completeness, no ERC20 tooling reads them, and the
 * 12-byte truncation would be lossy for no benefit — which is why, unlike `transferLog`, this
 * helper takes no `AddressMapper` at all.
 */
function standardLog(event: MidnightEvent): PendingLog {
  const type = event.__typename;

  if (type === "MiscContractEvent") {
    const name = fromHex(requireField(event, "name"));
    return {
      primaryId: event.id,
      topics: [keccak256(name)],
      data: fromHex(requireField(event, "payload")),
    };
  }

  const topics: Uint8Array[] = [midnightTopic0(type)];
  const data: Uint8Array[] = [];

  switch (type) {
    case "ShieldedSpendEvent":
      topics.push(toWord(fromHex(requireField(event, "nullifier"))));
      break;
    case "ShieldedReceiveEvent":
      topics.push(toWord(fromHex(requireField(event, "commitment"))));
      data.push(
        event.receivingContractAddress == null
          ? ZERO_WORD
          : toWord(fromHex(event.receivingContractAddress)),
      );
      // `ciphertext` is variable-length; it is appended raw as the tail (LOGMAP.md).
      if (event.ciphertext != null) data.push(fromHex(event.ciphertext));
      break;
    case "ShieldedMintEvent":
      topics.push(toWord(fromHex(requireField(event, "commitment"))));
      topics.push(toWord(fromHex(requireField(event, "domainSep"))));
      data.push(uint256Word(event.amount ?? "0"));
      break;
    case "ShieldedBurnEvent":
      topics.push(toWord(fromHex(requireField(event, "nullifier"))));
      data.push(uint256Word(event.amount ?? "0"));
      break;
    case "UnshieldedMintEvent":
      topics.push(toWord(fromHex(requireField(event, "tokenType"))));
      topics.push(toWord(fromHex(requireField(event, "domainSep"))));
      data.push(uint256Word(requireField(event, "amount")));
      break;
    case "UnshieldedBurnEvent": {
      const sender = requireField(event, "sender");
      topics.push(toWord(fromHex(requireField(event, "tokenType"))));
      topics.push(toWord(fromHex(identityOf(sender, type, event.id).hex)));
      data.push(kindWord(sender));
      data.push(uint256Word(requireField(event, "amount")));
      break;
    }
    // Reached only under the `misc` profile — a Transfer-bearing profile routes these through
    // the pairing pass instead.
    case "UnshieldedSpendEvent":
    case "UnshieldedReceiveEvent": {
      const either = requireField(event, type === "UnshieldedSpendEvent" ? "sender" : "recipient");
      topics.push(toWord(fromHex(requireField(event, "tokenType"))));
      topics.push(toWord(fromHex(identityOf(either, type, event.id).hex)));
      data.push(kindWord(either));
      data.push(uint256Word(requireField(event, "amount")));
      data.push(toWord(fromHex(requireField(event, "domainSep"))));
      break;
    }
    case "PausedEvent":
    case "UnpausedEvent":
      // No own fields: topic0 alone, empty data.
      break;
    default:
      throw new EventMapError(`no mapping rule for known type "${type}"`, type, event.id);
  }

  return { primaryId: event.id, topics, data: concatBytes(data) };
}

/** `0` for a USER branch, `1` for a CONTRACT branch, as a uint256 word. */
function kindWord(either: AddressOrContract): Uint8Array {
  return uint256Word(either.kind === "CONTRACT" ? "1" : "0");
}
