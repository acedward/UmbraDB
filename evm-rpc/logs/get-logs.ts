/**
 * C-G3 — `eth_getLogs`, served entirely from `evm_rpc.logs`. No indexer call on this path: a
 * JSON-RPC read must not depend on the ingester's upstream being reachable.
 *
 * Filter semantics follow **geth**, because that is what the ecosystem's clients assume:
 *   - `address`: absent | a single address | an array (OR);
 *   - `topics`: positional, with `null` wildcards and a nested array meaning OR at that position;
 *     a filter of length L additionally requires the log to HAVE at least L topics, matching
 *     go-ethereum's `filterLogs` (`if len(topics) > len(log.Topics) { return false }`) — a `null`
 *     placeholder is a wildcard over the VALUE, not permission for the position to be missing;
 *   - `fromBlock`/`toBlock`: a hex quantity or `latest` / `earliest` / `pending` / `safe` /
 *     `finalized`;
 *   - `blockHash`: mutually exclusive with the range (`-32602` if combined);
 *   - more than 10 000 results: `-32005 "query returned more than 10000 results"`.
 */

import { JSON_RPC_LIMIT_EXCEEDED, JsonRpcError, registerMethod } from "../registry-shim.js";
import { toHex } from "./event-map.js";
import { lookupAddressIds, type SqlLike } from "./address-map.js";
import {
  invalidParams,
  parseAddressList,
  parseHexBytes,
  parseTopicPositions,
  type TopicPosition,
} from "./log-filter.js";

export const MAX_RESULTS = 10_000;

/** The geth `eth_getLogs` result object. All quantities are minimal-form hex. */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
}

export interface GetLogsOptions {
  sql: SqlLike;
  schema: string;
  /**
   * Resolves the `latest` block tag. Part C has no chain head of its own — Part B owns that — so
   * this defaults to the highest block present in `logs` and is injectable so the Part F merge can
   * point it at Part B's real head without touching this file's logic.
   */
  resolveLatestBlock?: () => Promise<number>;
}

// ===========================================================================================
// Parameter parsing
// ===========================================================================================

const invalid = invalidParams;

/** Parses a `0x`-prefixed quantity. Rejects a bare decimal, which geth also rejects. */
function parseQuantity(value: string, field: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw invalid(`${field} is not a hex quantity: "${value}"`);
  }
  return Number.parseInt(value.slice(2), 16);
}

export interface ParsedFilter {
  addresses: Uint8Array[] | null;
  topics: TopicPosition[];
  fromBlock: number | "latest" | "earliest";
  toBlock: number | "latest" | "earliest";
  blockHash: Uint8Array | null;
}

const BLOCK_TAGS = new Set(["latest", "earliest", "pending", "safe", "finalized"]);

function parseBlockTag(value: unknown, field: string): number | "latest" | "earliest" {
  if (value === undefined || value === null) return "latest";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw invalid(`${field} must be a non-negative integer`);
    return value;
  }
  if (typeof value !== "string") throw invalid(`${field} must be a hex quantity or a block tag`);
  if (BLOCK_TAGS.has(value)) {
    if (value === "earliest") return "earliest";
    // `pending`, `safe` and `finalized` all collapse to `latest` here: Part C stores only
    // already-indexed logs, so there is no distinct pending or unfinalised set to serve.
    return "latest";
  }
  return parseQuantity(value, field);
}

export function parseFilter(rawParams: readonly unknown[]): ParsedFilter {
  const raw = rawParams[0];
  if (raw === undefined || raw === null) throw invalid("eth_getLogs requires a filter object");
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("eth_getLogs filter must be an object");
  }
  const filter = raw as Record<string, unknown>;

  const hasRange = filter.fromBlock !== undefined || filter.toBlock !== undefined;
  const hasBlockHash = filter.blockHash !== undefined && filter.blockHash !== null;
  if (hasBlockHash && hasRange) {
    throw invalid("blockHash is mutually exclusive with fromBlock/toBlock");
  }

  // `address` and `topics` are parsed by the SHARED primitives in `log-filter.ts`, so the SQL path
  // here and `subscribe.ts`'s in-memory matcher cannot drift apart on what a filter means.
  const addresses = parseAddressList(filter.address);
  const topics: TopicPosition[] = parseTopicPositions(filter.topics);

  return {
    addresses,
    topics,
    fromBlock: hasBlockHash ? "earliest" : parseBlockTag(filter.fromBlock, "fromBlock"),
    toBlock: hasBlockHash ? "latest" : parseBlockTag(filter.toBlock, "toBlock"),
    blockHash: hasBlockHash ? parseHexBytes(filter.blockHash, "blockHash", 32) : null,
  };
}

// ===========================================================================================
// Query
// ===========================================================================================

interface LogRecord {
  address_id: bigint;
  evm_addr: Buffer;
  block_number: bigint;
  block_hash: Buffer;
  tx_hash: Buffer;
  tx_index: number;
  log_index: number;
  topic0: Buffer;
  topic1: Buffer | null;
  topic2: Buffer | null;
  topic3: Buffer | null;
  data: Buffer;
  removed: boolean;
}

const TOPIC_COLUMNS = ["topic0", "topic1", "topic2", "topic3"] as const;

function quantity(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

export async function getLogs(options: GetLogsOptions, params: readonly unknown[]): Promise<RpcLog[]> {
  const { sql, schema } = options;
  const filter = parseFilter(params);

  // --- resolve the address filter to address_map ids -----------------------------------------
  let addressIds: bigint[] | null = null;
  if (filter.addresses !== null) {
    if (filter.addresses.length === 0) return [];
    const found = await lookupAddressIds(sql, schema, filter.addresses);
    addressIds = [...found.values()];
    // An address nothing has ever emitted from yields an EMPTY result, never an error.
    if (addressIds.length === 0) return [];
  }

  // --- resolve block bounds -------------------------------------------------------------------
  const resolveLatest =
    options.resolveLatestBlock ??
    (async () => {
      const rows = await sql<{ max: bigint | null }[]>`
        SELECT max(block_number) AS max FROM ${sql(schema)}.logs
      `;
      const max = rows[0]?.max;
      return max === null || max === undefined ? 0 : Number(max);
    });

  let fromBlock = 0;
  let toBlock = Number.MAX_SAFE_INTEGER;
  if (filter.blockHash === null) {
    fromBlock = filter.fromBlock === "earliest" ? 0 : filter.fromBlock === "latest" ? await resolveLatest() : filter.fromBlock;
    toBlock = filter.toBlock === "earliest" ? 0 : filter.toBlock === "latest" ? await resolveLatest() : filter.toBlock;
    // geth returns an empty set rather than an error for an inverted range.
    if (fromBlock > toBlock) return [];
  }

  // --- build the predicate --------------------------------------------------------------------
  const conditions: ReturnType<typeof sql>[] = [];
  if (filter.blockHash !== null) {
    conditions.push(sql`block_hash = ${Buffer.from(filter.blockHash)}`);
  } else {
    conditions.push(sql`block_number >= ${BigInt(fromBlock)}`);
    if (toBlock !== Number.MAX_SAFE_INTEGER) {
      conditions.push(sql`block_number <= ${BigInt(toBlock)}`);
    }
  }
  if (addressIds !== null) {
    conditions.push(sql`address_id IN ${sql(addressIds)}`);
  }
  filter.topics.forEach((position, index) => {
    const column = TOPIC_COLUMNS[index]!;
    if (position === null) {
      // Wildcard over the VALUE, but the position must EXIST (geth length rule).
      conditions.push(sql`${sql(column)} IS NOT NULL`);
      return;
    }
    conditions.push(sql`${sql(column)} IN ${sql(position.map((t) => Buffer.from(t)))}`);
  });

  const where = conditions.reduce((accumulated, condition) => sql`${accumulated} AND ${condition}`);

  // LIMIT is MAX_RESULTS + 1 so "too many" is detected without counting the whole table.
  const rows = await sql<LogRecord[]>`
    SELECT l.address_id, a.evm_addr, l.block_number, l.block_hash, l.tx_hash, l.tx_index,
           l.log_index, l.topic0, l.topic1, l.topic2, l.topic3, l.data, l.removed
    FROM ${sql(schema)}.logs l
    JOIN ${sql(schema)}.address_map a ON a.id = l.address_id
    WHERE ${where}
    ORDER BY l.block_number, l.tx_index, l.log_index
    LIMIT ${MAX_RESULTS + 1}
  `;

  if (rows.length > MAX_RESULTS) {
    throw new JsonRpcError(
      JSON_RPC_LIMIT_EXCEEDED,
      `query returned more than ${MAX_RESULTS} results`,
    );
  }

  return rows.map((row) => {
    const topics: string[] = [];
    for (const column of TOPIC_COLUMNS) {
      const value = row[column];
      if (value === null || value === undefined) break; // contiguous by DDL constraint
      topics.push(`0x${toHex(value)}`);
    }
    return {
      address: `0x${toHex(row.evm_addr)}`,
      topics,
      data: `0x${toHex(row.data)}`,
      blockNumber: quantity(row.block_number),
      blockHash: `0x${toHex(row.block_hash)}`,
      transactionHash: `0x${toHex(row.tx_hash)}`,
      transactionIndex: quantity(row.tx_index),
      logIndex: quantity(row.log_index),
      removed: row.removed,
    };
  });
}

/** Registers `eth_getLogs` on Part B's registry (the shim, until the Part F merge). */
export function registerGetLogs(options: GetLogsOptions): void {
  registerMethod("eth_getLogs", (params) => getLogs(options, params));
}
