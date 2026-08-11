/**
 * Shared log-filter primitives: parsing an `address`/`topics` filter, and matching an already-built
 * log against it in JavaScript.
 *
 * Two consumers need the SAME semantics from opposite directions — `get-logs.ts` compiles a filter
 * into a SQL predicate over `evm_rpc.logs`, and `subscribe.ts` matches the ingester's live tail
 * in memory. Divergence between them would mean `eth_getLogs` and `eth_subscribe("logs", …)`
 * disagreeing about what a filter means, which is exactly the kind of bug nobody notices until a
 * client's balance reconciliation is off. Parsing lives here once, and
 * `test/subscribe.test.ts` cross-checks the JS matcher against the SQL path over identical rows.
 */

import { JSON_RPC_INVALID_PARAMS, JsonRpcError } from "../registry-shim.js";
import { fromHex, toHex } from "./event-map.js";

export function invalidParams(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_INVALID_PARAMS, message);
}

/** Parses a `0x`-prefixed byte string of an exact length. */
export function parseHexBytes(value: unknown, field: string, expectedBytes: number): Uint8Array {
  if (typeof value !== "string") throw invalidParams(`${field} must be a hex string`);
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw invalidParams(`${field} must be 0x-prefixed hex: "${value}"`);
  }
  let bytes: Uint8Array;
  try {
    bytes = fromHex(value);
  } catch (error) {
    throw invalidParams(
      `${field} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.length !== expectedBytes) {
    throw invalidParams(`${field} must be ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** One topic position: `null` = wildcard over the value, otherwise a non-empty OR-set. */
export type TopicPosition = Uint8Array[] | null;

/**
 * `address`: absent/null -> `null` (every watched contract); a single value or an array -> a list.
 * An explicitly empty array stays an empty list, which matches nothing — deliberately NOT collapsed
 * into "absent".
 */
export function parseAddressList(raw: unknown): Uint8Array[] | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => parseHexBytes(entry, "address", 20));
}

/** `topics`: positional, `null`/`[]` a wildcard, a nested array an OR-set. At most 4 positions. */
export function parseTopicPositions(raw: unknown): TopicPosition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidParams("topics must be an array");
  if (raw.length > 4) throw invalidParams("topics may have at most 4 positions");
  return raw.map((position, index) => {
    if (position === null || position === undefined) return null;
    const options = Array.isArray(position) ? position : [position];
    if (options.length === 0) return null; // geth treats [] at a position as a wildcard
    return options.map((entry) => parseHexBytes(entry, `topics[${index}]`, 32));
  });
}

export interface SubscriptionFilter {
  addresses: Uint8Array[] | null;
  topics: TopicPosition[];
}

/** The `eth_subscribe("logs", filter)` filter — address and topics only; there is no range on a
 *  live subscription, and geth ignores block bounds there. */
export function parseSubscriptionFilter(raw: unknown): SubscriptionFilter {
  if (raw === undefined || raw === null) return { addresses: null, topics: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidParams("logs subscription filter must be an object");
  }
  const filter = raw as Record<string, unknown>;
  return {
    addresses: parseAddressList(filter.address),
    topics: parseTopicPositions(filter.topics),
  };
}

/** The fields of a log this matcher needs — satisfied by `RpcLog`. */
export interface MatchableLog {
  address: string;
  topics: string[];
}

const strip = (hex: string): string => hex.replace(/^0x/, "").toLowerCase();

/**
 * Matches `log` against `filter`, with the same rules `get-logs.ts` compiles into SQL:
 *   - address: match any of the listed addresses (absent = match all, empty list = match none);
 *   - topics: position `i` must exist on the log whenever the filter has a position `i`
 *     (go-ethereum's `if len(topics) > len(log.Topics) { return false }`), and a non-null position
 *     must equal one of its options.
 */
export function matchesFilter(log: MatchableLog, filter: SubscriptionFilter): boolean {
  if (filter.addresses !== null) {
    const wanted = new Set(filter.addresses.map((a) => toHex(a).toLowerCase()));
    if (!wanted.has(strip(log.address))) return false;
  }
  if (filter.topics.length > log.topics.length) return false;
  for (const [index, position] of filter.topics.entries()) {
    if (position === null) continue; // wildcard over the value; presence already guaranteed above
    const actual = strip(log.topics[index]!);
    if (!position.some((option) => toHex(option).toLowerCase() === actual)) return false;
  }
  return true;
}
