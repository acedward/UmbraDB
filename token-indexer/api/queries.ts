import type { UmbraDBSql } from "../../src/postgres/client.js";

/**
 * Project 00020 — every read the API makes (spec §5). One module, so the JSON shapes are defined
 * once and the routes stay thin.
 *
 * Hex is lowercase and unprefixed everywhere, as the indexer serves it and this repo stores it.
 * `totalMinted` is a decimal STRING: it sums `u64` amounts into a `numeric(39,0)` and would lose
 * precision as a JSON number.
 */

export interface TokenJson {
  address: string;
  domainSep: string;
  kind: string;
  storage: string | null;
  color: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenUri: string | null;
  metadata: unknown;
  status: string;
  mintCount: number;
  totalMinted: string;
  firstMintHeight: number | null;
  lastMintHeight: number | null;
  firstSeenHeight: number;
  metadataUpdatedHeight: number | null;
  deployHeight: number | null;
}

interface TokenRow {
  address: Buffer; domain_sep: Buffer; kind: string; storage: string | null; color: Buffer | null;
  name: string | null; symbol: string | null; decimals: number | null; token_uri: string | null;
  metadata: unknown; status: string; mint_count: string; total_minted: string;
  first_mint_height: string | null; last_mint_height: string | null; first_seen_height: string;
  metadata_updated_height: string | null; deploy_height: string | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

function toToken(row: TokenRow): TokenJson {
  return {
    address: row.address.toString("hex"),
    domainSep: row.domain_sep.toString("hex"),
    kind: row.kind,
    storage: row.storage,
    color: row.color === null ? null : row.color.toString("hex"),
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    tokenUri: row.token_uri,
    metadata: row.metadata ?? null,
    status: row.status,
    mintCount: Number(row.mint_count),
    totalMinted: row.total_minted,
    firstMintHeight: num(row.first_mint_height),
    lastMintHeight: num(row.last_mint_height),
    firstSeenHeight: Number(row.first_seen_height),
    metadataUpdatedHeight: num(row.metadata_updated_height),
    deployHeight: num(row.deploy_height),
  };
}

export interface TokenListFilters {
  kind?: string;
  storage?: string;
  status?: string;
  q?: string;
  limit: number;
  cursor?: TokenCursor;
}

/** Keyset cursor for `/v1/tokens`: the ordering key of the last row served. Keyset rather than
 *  `OFFSET` so a row inserted by the live scanner between two pages cannot make the reader skip or
 *  repeat a token. */
export interface TokenCursor {
  firstSeenHeight: number;
  address: string;
  domainSep: string;
  kind: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(raw: string): T {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as T;
}

export class TokenIndexQueries {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string,
    private readonly net: string,
  ) {}

  private get s(): string { return this.schema; }

  async listTokens(filters: TokenListFilters): Promise<Page<TokenJson>> {
    const sql = this.sql;
    const cursor = filters.cursor;
    // `q` matches a name or symbol prefix (case-insensitively) or an EXACT colour/address hex —
    // the exact forms are what a wallet pastes, the prefix is what a person types.
    const q = filters.q?.trim() ?? "";
    const qHex = /^[0-9a-fA-F]{64}$/.test(q) ? Buffer.from(q.toLowerCase(), "hex") : null;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net}
        AND (${filters.kind ?? null}::text IS NULL OR t.kind = ${filters.kind ?? null})
        AND (${filters.storage ?? null}::text IS NULL OR t.storage = ${filters.storage ?? null})
        AND (${filters.status ?? null}::text IS NULL OR t.status = ${filters.status ?? null})
        AND (${q === "" ? null : q}::text IS NULL
             OR lower(t.name) LIKE lower(${q}) || '%'
             OR lower(t.symbol) LIKE lower(${q}) || '%'
             OR t.color = ${qHex}
             OR t.address = ${qHex}
             OR t.domain_sep = ${qHex})
        AND (${cursor === undefined ? null : cursor.firstSeenHeight}::bigint IS NULL
             OR (t.first_seen_height, t.address, t.domain_sep, t.kind)
                > (${cursor?.firstSeenHeight ?? 0}::bigint,
                   ${cursor === undefined ? Buffer.alloc(0) : Buffer.from(cursor.address, "hex")},
                   ${cursor === undefined ? Buffer.alloc(0) : Buffer.from(cursor.domainSep, "hex")},
                   ${cursor?.kind ?? ""}))
      ORDER BY t.first_seen_height, t.address, t.domain_sep, t.kind
      LIMIT ${filters.limit + 1}
    `;
    return this.paginate(rows.map(toToken), filters.limit, (last) => encodeCursor({
      firstSeenHeight: last.firstSeenHeight, address: last.address,
      domainSep: last.domainSep, kind: last.kind,
    } satisfies TokenCursor));
  }

  private paginate<T>(items: T[], limit: number, cursorOf: (last: T) => string): Page<T> {
    if (items.length <= limit) return { items, nextCursor: null };
    const page = items.slice(0, limit);
    return { items: page, nextCursor: cursorOf(page[page.length - 1]!) };
  }

  async tokensByColor(color: string): Promise<TokenJson[]> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.color = ${Buffer.from(color, "hex")}
      ORDER BY t.kind
    `;
    return rows.map(toToken);
  }

  async token(address: string, domainSep: string, kind: string): Promise<TokenJson | undefined> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.address = ${Buffer.from(address, "hex")}
        AND t.domain_sep = ${Buffer.from(domainSep, "hex")} AND t.kind = ${kind}
    `;
    const row = rows[0];
    return row === undefined ? undefined : toToken(row);
  }

  async tokensOfContract(address: string): Promise<TokenJson[]> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.address = ${Buffer.from(address, "hex")}
      ORDER BY t.domain_sep, t.kind
    `;
    return rows.map(toToken);
  }

  async contract(address: string): Promise<{
    address: string; deployHeight: number | null; deployTxHash: string | null; lastCallHeight: number | null;
  } | undefined> {
    const sql = this.sql;
    const rows = await sql<{
      address: Buffer; deploy_height: string | null; deploy_tx_hash: Buffer | null; last_call_height: string | null;
    }[]>`
      SELECT address, deploy_height::text, deploy_tx_hash, last_call_height::text
      FROM ${sql(this.s)}.contracts
      WHERE net = ${this.net} AND address = ${Buffer.from(address, "hex")}
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      address: row.address.toString("hex"),
      deployHeight: num(row.deploy_height),
      deployTxHash: row.deploy_tx_hash === null ? null : row.deploy_tx_hash.toString("hex"),
      lastCallHeight: num(row.last_call_height),
    };
  }

  async pendingLookupsForContract(address: string): Promise<{
    txHash: string; address: string; blockHeight: number; expected: number; got: number;
    attempts: number; lastError: string | null;
  }[]> {
    const sql = this.sql;
    const rows = await sql<{
      tx_hash: Buffer; address: Buffer; block_height: string; expected_events: number;
      got_events: number; attempts: number; last_error: string | null;
    }[]>`
      SELECT tx_hash, address, block_height::text, expected_events, got_events, attempts, last_error
      FROM ${sql(this.s)}.pending_event_lookups
      WHERE net = ${this.net} AND address = ${Buffer.from(address, "hex")}
      ORDER BY block_height
    `;
    return rows.map((r) => ({
      txHash: r.tx_hash.toString("hex"),
      address: r.address.toString("hex"),
      blockHeight: Number(r.block_height),
      expected: r.expected_events,
      got: r.got_events,
      attempts: r.attempts,
      lastError: r.last_error,
    }));
  }

  /** Every key of one token with the event that set it (EIP-7496's `getTraitValue`). The tx hash
   *  comes from the event the key points at, so every value on the page is traceable to a
   *  transaction without a second request. */
  async metadataKeys(address: string, domainSep: string, kind: string): Promise<{
    key: string; value: string; len: number; text: string | null;
    updatedHeight: number; updatedTxHash: string | null; eventId: number;
  }[]> {
    const sql = this.sql;
    const rows = await sql<{
      key_text: string; value: Buffer; len: number; updated_height: string;
      updated_event_id: string; tx_hash: Buffer | null;
    }[]>`
      SELECT kv.key_text, kv.value, kv.len, kv.updated_height::text, kv.updated_event_id::text, e.tx_hash
      FROM ${sql(this.s)}.token_metadata_kv kv
      LEFT JOIN ${sql(this.s)}.token_metadata_events e
        ON e.net = kv.net AND e.event_id = kv.updated_event_id
      WHERE kv.net = ${this.net} AND kv.address = ${Buffer.from(address, "hex")}
        AND kv.domain_sep = ${Buffer.from(domainSep, "hex")} AND kv.kind = ${kind}
      ORDER BY kv.key_text
    `;
    return rows.map((r) => ({
      key: r.key_text,
      value: r.value.toString("hex"),
      len: r.len,
      text: utf8OrNull(r.value.subarray(0, r.len)),
      updatedHeight: Number(r.updated_height),
      updatedTxHash: r.tx_hash === null ? null : r.tx_hash.toString("hex"),
      eventId: Number(r.updated_event_id),
    }));
  }

  async mints(
    address: string, domainSep: string, kind: string,
    opts: { limit: number; cursor?: { blockHeight: number; txHash: string; segment: number; callIndex: number } },
  ): Promise<Page<{
    blockHeight: number; txHash: string; txPosition: number; segment: number; callIndex: number;
    entryPoint: string | null; kind: string; amount: string;
  }>> {
    const sql = this.sql;
    const c = opts.cursor;
    const rows = await sql<{
      block_height: string; tx_hash: Buffer; tx_position: number; segment: number;
      call_index: number; entry_point: string | null; kind: string; amount: string;
    }[]>`
      SELECT block_height::text, tx_hash, tx_position, segment, call_index, entry_point, kind, amount::text
      FROM ${sql(this.s)}.token_mints
      WHERE net = ${this.net} AND address = ${Buffer.from(address, "hex")}
        AND domain_sep = ${Buffer.from(domainSep, "hex")} AND kind = ${kind}
        AND (${c === undefined ? null : c.blockHeight}::bigint IS NULL
             OR (block_height, tx_hash, segment, call_index)
                > (${c?.blockHeight ?? 0}::bigint,
                   ${c === undefined ? Buffer.alloc(0) : Buffer.from(c.txHash, "hex")},
                   ${c?.segment ?? 0}::int, ${c?.callIndex ?? 0}::int))
      ORDER BY block_height, tx_hash, segment, call_index
      LIMIT ${opts.limit + 1}
    `;
    const items = rows.map((r) => ({
      blockHeight: Number(r.block_height),
      txHash: r.tx_hash.toString("hex"),
      txPosition: r.tx_position,
      segment: r.segment,
      callIndex: r.call_index,
      entryPoint: r.entry_point,
      kind: r.kind,
      amount: r.amount,
    }));
    return this.paginate(items, opts.limit, (last) => encodeCursor({
      blockHeight: last.blockHeight, txHash: last.txHash, segment: last.segment, callIndex: last.callIndex,
    }));
  }

  /** Raw `TokenMetadata` events of one contract, rejected ones included — the provenance panel.
   *  `applied` filters, `domainSep` narrows to one token (orchestrator's Q51). */
  async contractEvents(
    address: string,
    opts: { applied?: boolean; domainSep?: string; limit: number; cursor?: { eventId: number } },
  ): Promise<Page<{
    eventId: number; blockHeight: number; txHash: string; domainSep: string; kindByte: number;
    key: string; keyText: string | null; len: number; value: string; text: string | null;
    applied: boolean; rejectReason: string | null;
  }>> {
    const sql = this.sql;
    const rows = await sql<{
      event_id: string; block_height: string; tx_hash: Buffer; domain_sep: Buffer; kind_byte: number;
      key: Buffer; key_text: string | null; len: number; value: Buffer; applied: boolean;
      reject_reason: string | null;
    }[]>`
      SELECT event_id::text, block_height::text, tx_hash, domain_sep, kind_byte, key, key_text, len,
             value, applied, reject_reason
      FROM ${sql(this.s)}.token_metadata_events
      WHERE net = ${this.net} AND address = ${Buffer.from(address, "hex")}
        AND (${opts.applied === undefined ? null : opts.applied}::boolean IS NULL
             OR applied = ${opts.applied ?? false})
        AND (${opts.domainSep === undefined ? null : Buffer.from(opts.domainSep, "hex")}::bytea IS NULL
             OR domain_sep = ${opts.domainSep === undefined ? null : Buffer.from(opts.domainSep, "hex")})
        AND (${opts.cursor === undefined ? null : opts.cursor.eventId}::bigint IS NULL
             OR event_id > ${opts.cursor?.eventId ?? 0})
      ORDER BY event_id
      LIMIT ${opts.limit + 1}
    `;
    const items = rows.map((r) => ({
      eventId: Number(r.event_id),
      blockHeight: Number(r.block_height),
      txHash: r.tx_hash.toString("hex"),
      domainSep: r.domain_sep.toString("hex"),
      kindByte: r.kind_byte,
      key: r.key.toString("hex"),
      keyText: r.key_text,
      len: r.len,
      value: r.value.toString("hex"),
      text: utf8OrNull(r.value.subarray(0, Math.min(r.len, r.value.length))),
      applied: r.applied,
      rejectReason: r.reject_reason,
    }));
    return this.paginate(items, opts.limit, (last) => encodeCursor({ eventId: last.eventId }));
  }

  /** Every *described* native token keyed by colour — MIP-0011/0014's "off-chain registry keyed by
   *  colour", with the `(address, domainSep)` a wallet needs for its mandatory re-derivation check. */
  async registry(): Promise<Record<string, {
    address: string; domainSep: string; kind: string; name: string | null; symbol: string | null;
    decimals: number | null; metadata: unknown;
  }>> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, NULL::text AS deploy_height
      FROM ${sql(this.s)}.tokens t
      WHERE t.net = ${this.net} AND t.storage = 'native' AND t.color IS NOT NULL
        AND t.status IN ('described', 'builtin')
      ORDER BY t.first_seen_height
    `;
    const out: Record<string, {
      address: string; domainSep: string; kind: string; name: string | null; symbol: string | null;
      decimals: number | null; metadata: unknown;
    }> = {};
    for (const row of rows.map(toToken)) {
      if (row.color === null) continue;
      out[row.color] = {
        address: row.address, domainSep: row.domainSep, kind: row.kind,
        name: row.name, symbol: row.symbol, decimals: row.decimals, metadata: row.metadata,
      };
    }
    return out;
  }

  /** Candidates for the `tokenUri` resolver. Prefiltered in SQL by the cheap equalities, then
   *  refined in the route against the slug rules — the refinement needs string shaping Postgres
   *  would make unreadable, and the prefilter keeps the row count small. */
  async resolverCandidates(name: string): Promise<TokenJson[]> {
    const sql = this.sql;
    const asAddress = /^[0-9a-fA-F]{64}$/.test(name) ? Buffer.from(name.toLowerCase(), "hex") : null;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.storage, t.color, t.name, t.symbol, t.decimals,
             t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net}
        AND (t.address = ${asAddress}
             OR lower(t.symbol) = lower(${name})
             OR lower(t.name) LIKE lower(${name}) || '%')
      ORDER BY t.first_seen_height
      LIMIT 500
    `;
    return rows.map(toToken);
  }
}

export function utf8OrNull(bytes: Buffer | Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
