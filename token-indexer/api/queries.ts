import type { UmbraDBSql } from "../../src/postgres/client.js";
import { decodeUtf8, integerOfValue, valueTextOf } from "../ingest/payload.js";

/**
 * Projects 00020/00021 — every read the API makes (spec 00020 §5 as amended by 00021 FR-106). One
 * module, so the JSON shapes are defined once and the routes stay thin.
 *
 * Hex is lowercase and unprefixed everywhere, as the indexer serves it and this repo stores it.
 * `totalMinted` is a decimal STRING: it sums `u64` amounts into a `numeric(39,0)` and would lose
 * precision as a JSON number. `integer` on a trait is a decimal string for the same reason — a
 * `val-type` 2 value may be 16 bytes wide (MIP §2.1).
 *
 * ── `kind` is a number now (FR-106, spec Q2) ───────────────────────────────────────────────────
 * The MIP's token identity is `(contractAddress, domainSep, kind)` where `kind` is the byte 0–3
 * (§3, §4), so that byte is what the API carries. `privacy` (`shielded|unshielded`) and `storage`
 * (`native|ledger`) travel beside it as the words a human reads; they are generated columns of the
 * byte, so they can never disagree with it.
 */

export interface TokenJson {
  address: string;
  domainSep: string;
  /** MIP §3's byte: 0 unshielded native, 1 shielded native, 2 unshielded ledger, 3 shielded ledger. */
  kind: number;
  privacy: string;
  storage: string;
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

/** How many distinct domain separators the row's contract has, and the first five of them (by
 *  first-seen height), so a list can flag a contract that issues several tokens without a second
 *  request per row. `null` on the built-in rows, which have no contract behind them. */
export interface ContractDomainSepsJson {
  count: number;
  first: string[];
}

/** A `/v1/tokens` item: the token, plus a summary of its contract's other domain separators. */
export interface TokenListItemJson extends TokenJson {
  contractDomainSeps: ContractDomainSepsJson | null;
}

interface TokenRow {
  address: Buffer; domain_sep: Buffer; kind: number; privacy: string; storage: string;
  color: Buffer | null;
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
    privacy: row.privacy,
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

/** One key of one token, as EIP-7496's `getTraitValue` would hand it over (MIP §5.2): the bytes,
 *  their declared type, and every rendering this API can do for the caller without guessing. */
export interface TraitJson {
  /** The key as text, or `null` when its bytes are not a NUL-free valid UTF-8 string (MIP §5.1). */
  key: string | null;
  /** The key's identity: its trimmed bytes as hex. Always present, always the primary key. */
  keyHex: string;
  valType: number;
  valLen: number;
  /** The `valLen` meaningful bytes, hex. */
  value: string;
  /** `val-type` 1/3/4 rendered as text, when the bytes decode. */
  text: string | null;
  /** `val-type` 2 as a decimal string — up to 16 big-endian bytes, so never a JSON number. */
  integer: string | null;
  /** Non-`null` when this is an Appendix A key whose value broke Appendix A's rule for it: the
   *  trait stands, the column it would feed does not (MIP §5.3). */
  projectionError: string | null;
  updatedHeight: number;
  updatedTxHash: string | null;
  eventId: number;
}

export interface TokenListFilters {
  /** The kind byte 0–3. */
  kind?: number;
  privacy?: string;
  storage?: string;
  status?: string;
  q?: string;
  limit: number;
  cursor?: TokenCursor;
}

/** Keyset cursor for `/v1/tokens`: the ordering key of the last row served. Keyset rather than
 *  `OFFSET` so a row inserted by the live scanner between two pages cannot make the reader skip or
 *  repeat a token.
 *
 *  The order is: the built-in rows first, then newest first by the height of the token's first
 *  mint — or, for a row that has never been minted (a declared ledger token), the height it was
 *  first seen — then `(address, domainSep, kind)` so ties are total. `builtin` is 0 for the
 *  built-ins and 1 otherwise; `height` is that sort height. */
export interface TokenCursor {
  builtin: 0 | 1;
  height: number;
  address: string;
  domainSep: string;
  kind: number;
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

  async listTokens(filters: TokenListFilters): Promise<Page<TokenListItemJson>> {
    const sql = this.sql;
    const cursor = filters.cursor;
    // `q` matches a name or symbol prefix (case-insensitively) or an EXACT colour/address hex —
    // the exact forms are what a wallet pastes, the prefix is what a person types.
    const q = filters.q?.trim() ?? "";
    const qHex = /^[0-9a-fA-F]{64}$/.test(q) ? Buffer.from(q.toLowerCase(), "hex") : null;
    const rows = await sql<(TokenRow & {
      ds_count: number | null; ds_first: string[] | null; sort_group: number; sort_height: string;
    })[]>`
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text,
             d.n AS ds_count, d.first5 AS ds_first,
             (t.status <> 'builtin')::int AS sort_group,
             COALESCE(t.first_mint_height, t.first_seen_height)::text AS sort_height
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      -- The contract's distinct domain separators, ordered by when each was first seen. Served by
      -- the (net, address, domain_sep) index; skipped for the built-ins, whose zero address is a
      -- sentinel and not a contract.
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n,
               (array_agg(encode(x.domain_sep, 'hex') ORDER BY x.fs, x.domain_sep))[1:5] AS first5
        FROM (
          SELECT o.domain_sep, min(o.first_seen_height) AS fs
          FROM ${sql(this.s)}.tokens o
          WHERE o.net = t.net AND o.address = t.address AND o.status <> 'builtin'
          GROUP BY o.domain_sep
        ) x
      ) d ON t.status <> 'builtin'
      WHERE t.net = ${this.net}
        AND (${filters.kind ?? null}::smallint IS NULL OR t.kind = ${filters.kind ?? null})
        AND (${filters.privacy ?? null}::text IS NULL OR t.privacy = ${filters.privacy ?? null})
        AND (${filters.storage ?? null}::text IS NULL OR t.storage = ${filters.storage ?? null})
        AND (${filters.status ?? null}::text IS NULL OR t.status = ${filters.status ?? null})
        AND (${q === "" ? null : q}::text IS NULL
             OR lower(t.name) LIKE lower(${q}) || '%'
             OR lower(t.symbol) LIKE lower(${q}) || '%'
             OR t.color = ${qHex}
             OR t.address = ${qHex}
             OR t.domain_sep = ${qHex})
        -- Height is DESCENDING, so the row comparison carries it negated.
        AND (${cursor === undefined ? null : cursor.height}::bigint IS NULL
             OR ((t.status <> 'builtin')::int, -COALESCE(t.first_mint_height, t.first_seen_height),
                 t.address, t.domain_sep, t.kind)
                > (${cursor?.builtin ?? 0}::int,
                   -${cursor?.height ?? 0}::bigint,
                   ${cursor === undefined ? Buffer.alloc(0) : Buffer.from(cursor.address, "hex")},
                   ${cursor === undefined ? Buffer.alloc(0) : Buffer.from(cursor.domainSep, "hex")},
                   ${cursor?.kind ?? 0}::smallint))
      ORDER BY (t.status <> 'builtin')::int,
               COALESCE(t.first_mint_height, t.first_seen_height) DESC,
               t.address, t.domain_sep, t.kind
      LIMIT ${filters.limit + 1}
    `;
    const keys = new Map<TokenListItemJson, Pick<TokenCursor, "builtin" | "height">>();
    const items: TokenListItemJson[] = rows.map((row) => {
      const item: TokenListItemJson = {
        ...toToken(row),
        contractDomainSeps: row.ds_count === null
          ? null
          : { count: row.ds_count, first: row.ds_first ?? [] },
      };
      keys.set(item, { builtin: row.sort_group === 0 ? 0 : 1, height: Number(row.sort_height) });
      return item;
    });
    return this.paginate(items, filters.limit, (last) => encodeCursor({
      ...keys.get(last)!, address: last.address, domainSep: last.domainSep, kind: last.kind,
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
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.color = ${Buffer.from(color, "hex")}
      ORDER BY t.kind
    `;
    return rows.map(toToken);
  }

  async token(address: string, domainSep: string, kind: number): Promise<TokenJson | undefined> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
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
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.address = ${Buffer.from(address, "hex")}
      ORDER BY t.domain_sep, t.kind
    `;
    return rows.map(toToken);
  }

  /**
   * Every row sharing one `(contractAddress, domainSep)` — MIP §4's "a consumer MAY link rows that
   * share `(contractAddress, domainSep)` as representations of one asset", made a route (FR-106).
   *
   * This is where the Ledger Liar stops looking like a contradiction: the observed kind-0 row and
   * the declared kind-2 row come back side by side, in kind order, as what they are.
   */
  async tokensOfContractDomain(address: string, domainSep: string): Promise<TokenJson[]> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      WHERE t.net = ${this.net} AND t.address = ${Buffer.from(address, "hex")}
        AND t.domain_sep = ${Buffer.from(domainSep, "hex")}
      ORDER BY t.kind
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

  /** Every key of one token with the event that set it (MIP §5.2). The tx hash comes from the event
   *  the key points at, so every value on the page is traceable to a transaction without a second
   *  request. Ordered by the key's text where it has one, then by its bytes. */
  async metadataKeys(address: string, domainSep: string, kind: number): Promise<TraitJson[]> {
    const sql = this.sql;
    const rows = await sql<{
      key_hex: string; key_text: string | null; val_type: number; val_len: number; value: Buffer;
      projection_error: string | null; updated_height: string; updated_event_id: string;
      tx_hash: Buffer | null;
    }[]>`
      SELECT kv.key_hex, kv.key_text, kv.val_type, kv.val_len, kv.value, kv.projection_error,
             kv.updated_height::text, kv.updated_event_id::text, e.tx_hash
      FROM ${sql(this.s)}.token_metadata_kv kv
      LEFT JOIN ${sql(this.s)}.token_metadata_events e
        ON e.net = kv.net AND e.event_id = kv.updated_event_id
      WHERE kv.net = ${this.net} AND kv.address = ${Buffer.from(address, "hex")}
        AND kv.domain_sep = ${Buffer.from(domainSep, "hex")} AND kv.kind = ${kind}
      ORDER BY kv.key_text NULLS LAST, kv.key_hex
    `;
    return rows.map((r) => {
      const bytes = new Uint8Array(r.value.subarray(0, Math.min(r.val_len, r.value.length)));
      return {
        key: r.key_text,
        keyHex: r.key_hex,
        valType: r.val_type,
        valLen: r.val_len,
        value: Buffer.from(bytes).toString("hex"),
        text: valueTextOf(r.val_type, bytes) ?? null,
        integer: r.val_type === 2 ? integerOfValue(bytes) : null,
        projectionError: r.projection_error,
        updatedHeight: Number(r.updated_height),
        updatedTxHash: r.tx_hash === null ? null : r.tx_hash.toString("hex"),
        eventId: Number(r.updated_event_id),
      };
    });
  }

  async mints(
    address: string, domainSep: string, kind: number,
    opts: { limit: number; cursor?: { blockHeight: number; txHash: string; segment: number; callIndex: number } },
  ): Promise<Page<{
    blockHeight: number; txHash: string; txPosition: number; segment: number; callIndex: number;
    entryPoint: string | null; kind: number; privacy: string; amount: string;
  }>> {
    const sql = this.sql;
    const c = opts.cursor;
    const rows = await sql<{
      block_height: string; tx_hash: Buffer; tx_position: number; segment: number;
      call_index: number; entry_point: string | null; kind: number; amount: string;
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
      // A mint is native by definition, so the only thing its kind byte adds is the privacy tag.
      privacy: (r.kind & 1) === 1 ? "shielded" : "unshielded",
      amount: r.amount,
    }));
    return this.paginate(items, opts.limit, (last) => encodeCursor({
      blockHeight: last.blockHeight, txHash: last.txHash, segment: last.segment, callIndex: last.callIndex,
    }));
  }

  /** Raw metadata events of one contract, rejected ones included — the provenance panel.
   *  `applied` filters, `domainSep` narrows to one token (orchestrator's Q51). Every field is the
   *  RAW byte the event carried, including a `kindByte` or a `valType` outside the MIP's range,
   *  because that byte is exactly what the `rejectReason` is about. */
  async contractEvents(
    address: string,
    opts: { applied?: boolean; domainSep?: string; limit: number; cursor?: { eventId: number } },
  ): Promise<Page<{
    eventId: number; blockHeight: number; txHash: string; domainSep: string; kindByte: number;
    key: string; keyHex: string; keyText: string | null; valType: number; valLen: number;
    value: string; text: string | null; applied: boolean; rejectReason: string | null;
  }>> {
    const sql = this.sql;
    const rows = await sql<{
      event_id: string; block_height: string; tx_hash: Buffer; domain_sep: Buffer; kind_byte: number;
      key: Buffer; key_hex: string; key_text: string | null; val_type: number; val_len: number;
      value: Buffer; applied: boolean; reject_reason: string | null;
    }[]>`
      SELECT event_id::text, block_height::text, tx_hash, domain_sep, kind_byte, key, key_hex,
             key_text, val_type, val_len, value, applied, reject_reason
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
    const items = rows.map((r) => {
      const bytes = new Uint8Array(r.value.subarray(0, Math.min(r.val_len, r.value.length)));
      return {
        eventId: Number(r.event_id),
        blockHeight: Number(r.block_height),
        txHash: r.tx_hash.toString("hex"),
        domainSep: r.domain_sep.toString("hex"),
        kindByte: r.kind_byte,
        key: r.key.toString("hex"),
        keyHex: r.key_hex,
        keyText: r.key_text,
        valType: r.val_type,
        valLen: r.val_len,
        value: Buffer.from(bytes).toString("hex"),
        // A rejected event may carry a reserved type; render its bytes as text only when the type
        // says they are text and they really decode.
        text: valueTextOf(r.val_type, bytes) ?? null,
        applied: r.applied,
        rejectReason: r.reject_reason,
      };
    });
    return this.paginate(items, opts.limit, (last) => encodeCursor({ eventId: last.eventId }));
  }

  /** Every *described* native token keyed by colour — MIP-0011/0014's "off-chain registry keyed by
   *  colour", with the `(address, domainSep, kind)` a wallet needs for its mandatory re-derivation
   *  check. Ledger kinds are absent by construction: they have no colour to key on (MIP §3). */
  async registry(): Promise<Record<string, {
    address: string; domainSep: string; kind: number; privacy: string; name: string | null;
    symbol: string | null; decimals: number | null; metadata: unknown;
  }>> {
    const sql = this.sql;
    const rows = await sql<TokenRow[]>`
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, NULL::text AS deploy_height
      FROM ${sql(this.s)}.tokens t
      WHERE t.net = ${this.net} AND t.storage = 'native' AND t.color IS NOT NULL
        AND t.status IN ('described', 'builtin')
      ORDER BY t.first_seen_height
    `;
    const out: Record<string, {
      address: string; domainSep: string; kind: number; privacy: string; name: string | null;
      symbol: string | null; decimals: number | null; metadata: unknown;
    }> = {};
    for (const row of rows.map(toToken)) {
      if (row.color === null) continue;
      out[row.color] = {
        address: row.address, domainSep: row.domainSep, kind: row.kind, privacy: row.privacy,
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
      SELECT t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name, t.symbol,
             t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text, t.total_minted::text,
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
  return decodeUtf8(bytes instanceof Buffer ? new Uint8Array(bytes) : bytes) ?? null;
}
