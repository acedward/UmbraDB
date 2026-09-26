import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { chooseMetadata } from "../ingest/fold.js";
import {
  decodeUtf8, integerOfValue, metadataPartIndex, valueTextOf, type NameVariant,
} from "../ingest/payload.js";
import { ownerAddress } from "./bech32m.js";

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

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Project 00024-01 task B6 — WHERE EVERY VALUE CAME FROM (spec 00024 FR-016b, US6).
 *
 * "The API returns the origin with every value it serves: origin ∈ mip-0018 | public-interface |
 * chain | derived | none plus the evidence." Additive (FR-015): no existing field changes meaning;
 * tokens gain `origins` (one {@link OriginJson} per served value), traits, metadata events, mints
 * and activity rows gain their own `origin`. `public-interface` joins in project 00024-02; the page
 * starts showing these in 00024-03.
 *
 *  - `mip-0018` — a MIP-0018 declaration (the standard's name, or the superseded draft's, told apart
 *    by `nameVariant`), with its PACKAGE evidence: part event ids, transaction, block, position,
 *    segment, part count and phase.
 *  - `chain` — a fact the ledger verified: a counted mint, an activity row, a colour seen in public
 *    data.
 *  - `derived` — computed by this indexer from other evidence, with the rule it applied.
 *  - `none` — no source provides the value, with the reason.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

export type OriginKind = "mip-0018" | "public-interface" | "chain" | "derived" | "none";

/** The [Y] package a MIP-0018 value came from. A draft-name declaration is a one-part "package"
 *  with no segment and no phase: that name is not opted into [Y] (spec 00024 FR-006). */
export interface PackageEvidenceJson {
  /** The key whose declaration this is, when it is not implied by the field. */
  key: string | null;
  nameVariant: NameVariant;
  /** Every part's indexer event id, in ledger emission order; the first is the package's id (P1). */
  eventIds: number[];
  txHash: string | null;
  blockHeight: number;
  txPosition: number;
  segment: number | null;
  parts: number;
  phase: string | null;
}

export interface OriginJson {
  origin: OriginKind;
  /** `mip-0018`: the package (or, for a draft-name `metadata/<n>` assembly, every part key's).
   *  `chain`: where on chain. Absent for `derived` and `none` unless the rule used some. */
  evidence?: PackageEvidenceJson | PackageEvidenceJson[] | Record<string, unknown>;
  /** `derived`: the rule applied. */
  rule?: string;
  /** `none`: why no source provides the value. */
  reason?: string;
}

/** One origin per value a token serves. `mints` covers `mintCount`, `totalMinted`,
 *  `firstMintHeight` and `lastMintHeight`. */
export interface TokenOriginsJson {
  name: OriginJson;
  symbol: OriginJson;
  decimals: OriginJson;
  tokenUri: OriginJson;
  metadata: OriginJson;
  color: OriginJson;
  status: OriginJson;
  mints: OriginJson;
}

export const STATUS_RULE =
  "MIP-0018 §7.2: an observed mint only → observed; an applied declaration only → declared; both → " +
  "described (00023: a colour with no contract behind it → seen; the two seeded rows → builtin)";
export const COLOR_RULE = "MIP-0018 §4: tokenType(domainSep, contractAddress), derived from the contract and its domain separator";
const MINT_RULE = "counted mint effects of the archived transactions (00020 FR-002)";

/** A token as the API serves it, before {@link TokenIndexQueries.withOrigins} adds the origins. */
export interface TokenBaseJson {
  /** `null` while the row's status is `seen`: a colour proves a token exists, and a colour is a
   *  commitment — the contract behind it is not recoverable from it (00023 US5, FR-019). */
  address: string | null;
  domainSep: string | null;
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
  /** What the ledger lets anyone read about this token's movements (00023 §5, US4/US7):
   *   - `full`                 kind 0 — every unshielded UTXO and contract flow is public;
   *   - `disclosed-imbalances` kind 1 — only an offer's NET imbalance is public; a balanced
   *                            shielded transfer publishes no colour at all (spec §0);
   *   - `calls-only`           kinds 2/3 — no colour and no UTXOs; the contract's calls are the
   *                            only public trace, and the code they execute is not available to us;
   *   - `not-tracked`          the built-in DUST row — every transaction pays a fee, so DUST is
   *                            deliberately not indexed per token (owner decision Q13). */
  shieldedVisibility: "full" | "disclosed-imbalances" | "calls-only" | "not-tracked";
  mintCount: number;
  totalMinted: string;
  firstMintHeight: number | null;
  lastMintHeight: number | null;
  firstSeenHeight: number;
  metadataUpdatedHeight: number | null;
  deployHeight: number | null;
}

/** A token as the API serves it: every value with its origin (spec 00024 FR-016b). */
export interface TokenJson extends TokenBaseJson {
  origins: TokenOriginsJson;
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
  address: Buffer | null; domain_sep: Buffer | null; kind: number; privacy: string; storage: string;
  color: Buffer | null;
  name: string | null; symbol: string | null; decimals: number | null; token_uri: string | null;
  metadata: unknown; status: string; mint_count: string; total_minted: string;
  first_mint_height: string | null; last_mint_height: string | null; first_seen_height: string;
  metadata_updated_height: string | null; deploy_height: string | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/** DUST is the one row with a native kind and no colour at all — the ledger types it as a unit
 *  variant (00020 Q30) — and it is also the one token this indexer deliberately does not track
 *  (owner decision Q13). Every other row's visibility follows from its kind alone. */
function shieldedVisibilityOf(
  kind: number, color: Buffer | null, status: string,
): TokenJson["shieldedVisibility"] {
  if (status === "builtin" && color === null) return "not-tracked";
  if (kind >= 2) return "calls-only";
  return kind === 1 ? "disclosed-imbalances" : "full";
}

function toToken(row: TokenRow): TokenBaseJson {
  return {
    address: row.address === null ? null : row.address.toString("hex"),
    domainSep: row.domain_sep === null ? null : row.domain_sep.toString("hex"),
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
    shieldedVisibility: shieldedVisibilityOf(row.kind, row.color, row.status),
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
  /** `val-type` 2 as a decimal string — up to 31 bytes wide, so never a JSON number. Read under
   *  `nameVariant`'s rules: MIP-0018's Compact `Uint<8·N>` is little-endian, the superseded draft's
   *  integer was big-endian. */
  integer: string | null;
  /** Which event name set this key: `mip-0018` for the standard, `legacy-mip-xxxx` for the
   *  superseded draft the already-deployed reference contracts still emit (owner Q27). It is the
   *  rule set the value was judged and decoded under, and what the page badges "pre-MIP name". */
  nameVariant: NameVariant;
  /** Non-`null` when this is an Appendix A key whose value broke Appendix A's rule for it: the
   *  trait stands, the column it would feed does not (MIP §5.3). */
  projectionError: string | null;
  updatedHeight: number;
  updatedTxHash: string | null;
  eventId: number;
  /** Project 00024-01: the [Y] package that set this value — its physical intent, part count, every
   *  part's event id (the first is `eventId`, P1), its phase, and its transaction position. `null`
   *  segment/phase for a draft-name declaration (not opted into [Y]). */
  segment: number | null;
  parts: number;
  partEventIds: number[];
  phase: string | null;
  txPosition: number;
  origin: OriginJson;
}

interface KvEvidenceRow {
  key_text: string | null; name_variant: NameVariant; updated_event_id: string; updated_height: string;
  updated_tx_position: number; tx_hash: Buffer | null; segment: number | null; parts: number | null;
  part_event_ids: string[] | null; phase: string | null;
}

function packageEvidence(row: KvEvidenceRow): PackageEvidenceJson {
  const eventId = Number(row.updated_event_id);
  return {
    key: row.key_text,
    nameVariant: row.name_variant,
    eventIds: row.part_event_ids === null ? [eventId] : row.part_event_ids.map(Number),
    txHash: row.tx_hash === null ? null : row.tx_hash.toString("hex"),
    blockHeight: Number(row.updated_height),
    txPosition: row.updated_tx_position,
    segment: row.segment,
    parts: row.parts ?? 1,
    phase: row.phase,
  };
}

/**
 * The origin of every value one token serves, from the token row and the kv rows (with their
 * packages) behind its projected columns — a pure function, so the rules are stated in one place.
 */
export function originsOf(
  token: TokenBaseJson,
  kv: readonly (KvEvidenceRow & {
    val_type: number; projection_error: string | null;
    /** The stored value, for the `metadata` keys (the choice between a whole document and an
     *  assembly depends on the bytes — 01-D audit F5). */
    val_len?: number | null; value?: Buffer | null;
  })[],
): TokenOriginsJson {
  const status: OriginJson = {
    origin: "derived", rule: token.status === "builtin" ? "a seeded built-in row (00020 owner decision Q7)" : STATUS_RULE,
    evidence: { mintCount: token.mintCount, declared: token.status === "declared" || token.status === "described" },
  };
  const mints: OriginJson = token.mintCount > 0
    ? {
      origin: "chain", rule: MINT_RULE,
      evidence: { mintCount: token.mintCount, firstMintHeight: token.firstMintHeight, lastMintHeight: token.lastMintHeight },
    }
    : { origin: "none", reason: token.status === "builtin" ? "a built-in token is never minted by a contract" : "no observed mint" };

  if (token.status === "builtin") {
    const seeded: OriginJson = { origin: "derived", rule: "a seeded built-in row: the ledger's own token (00020 owner decision Q7)" };
    const none: OriginJson = { origin: "none", reason: "a built-in row carries no declaration" };
    return {
      name: seeded, symbol: seeded, decimals: seeded, tokenUri: none, metadata: none,
      color: token.color === null
        ? { origin: "none", reason: "DUST has no colour on this ledger (00020 Q30)" }
        : { origin: "derived", rule: "the ledger's native token type (nativeToken())" },
      status, mints,
    };
  }

  const color: OriginJson = token.kind >= 2
    ? { origin: "none", reason: "a ledger kind has no colour (MIP-0018 §3)" }
    : token.address === null
      ? { origin: "chain", rule: "a colour observed in public data whose issuer is not knowable (00023 US5)", evidence: { firstSeenHeight: token.firstSeenHeight } }
      : { origin: "derived", rule: COLOR_RULE, evidence: { address: token.address, domainSep: token.domainSep } };

  if (token.address === null || token.domainSep === null) {
    const none: OriginJson = { origin: "none", reason: "no contract is known for this colour (status seen)" };
    return { name: none, symbol: none, decimals: none, tokenUri: none, metadata: none, color, status, mints };
  }

  const byKey = new Map(kv.map((row) => [row.key_text, row]));
  const field = (key: string, value: unknown): OriginJson => {
    const row = byKey.get(key);
    if (value !== null && value !== undefined && row !== undefined) return { origin: "mip-0018", evidence: packageEvidence(row) };
    if (row === undefined) return { origin: "none", reason: "no declaration" };
    if (row.val_type === 5) return { origin: "none", reason: "cleared by a Null declaration", evidence: packageEvidence(row) };
    if (row.projection_error !== null) {
      return { origin: "none", reason: `declared but not projected: ${row.projection_error}`, evidence: packageEvidence(row) };
    }
    return { origin: "none", reason: "declared but not projected under this name's rules", evidence: packageEvidence(row) };
  };

  // `metadata` is either ONE declaration under the key `metadata` (MIP-0018: of any length, a [Y]
  // package) or, under the superseded draft name only, an assembly of `metadata/<n>` parts. Which
  // one is decided by the SAME function the fold projects with (`chooseMetadata`), so the evidence
  // is always the declaration(s) the served document came from — never a newer part of an
  // assembly that is incomplete or does not parse (01-D audit F5).
  // The evidence is built from the chosen ROWS, not looked up again by key text: two byte keys can
  // share a text (01-D audit round 2, N3).
  let metadata = field("metadata", token.metadata);
  if (token.metadata !== null) {
    const choice = chooseMetadata(kv
      .filter((row) => row.key_text === "metadata" || (row.key_text !== null && metadataPartIndex(row.key_text) !== undefined))
      .map((row) => ({ ...row, val_len: row.val_len ?? 0, value: row.value ?? Buffer.alloc(0) })));
    if (choice.source === "assembly") {
      metadata = { origin: "mip-0018", evidence: choice.rows.map(packageEvidence) };
    } else if (choice.source === "whole") {
      metadata = { origin: "mip-0018", evidence: packageEvidence(choice.rows[0]!) };
    }
  }

  return {
    name: field("name", token.name),
    symbol: field("symbol", token.symbol),
    decimals: field("decimals", token.decimals),
    tokenUri: field("tokenUri", token.tokenUri),
    metadata,
    color, status, mints,
  };
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
 *  first seen — then the row's PHYSICAL key `(tokenKey, kind)` so ties are total. `builtin` is 0
 *  for the built-ins and 1 otherwise; `height` is that sort height.
 *
 *  The tie-break moved from `(address, domainSep, kind)` to `(tokenKey, kind)` in 00023: a `seen`
 *  row has no contract address to break a tie on, while `token_key` is the primary key and
 *  therefore total over every row. Cursors issued by a 00021 build are not accepted — the index is
 *  reindexed from scratch anyway (owner decision Q3). */
export interface TokenCursor {
  builtin: 0 | 1;
  height: number;
  tokenKey: string;
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

/** The read snapshot of the request being served, when there is one (01-D audit F6). */
const requestSnapshot = new AsyncLocalStorage<UmbraDBSql>();

/** Test seam (01-D audit round 2, N4): runs between a route's token read and the origins read, so
 *  a test can commit a fold there and prove the two reads share one snapshot through HTTP. */
export interface TokenQueryHooks {
  beforeOrigins?: () => Promise<void>;
}

export class TokenIndexQueries {
  constructor(
    private readonly baseSql: UmbraDBSql,
    private readonly schema: string,
    private readonly net: string,
    /** The archive schema, for the `result` every activity row is served with and for the
     *  on-request transaction decode (00023 §6.4). Defaults to the conventional name so the
     *  00020/00021 call sites need no change. */
    private readonly archiveSchema: string = "chain_archive",
    /** Test seam only. */
    private readonly hooks: TokenQueryHooks = {},
  ) {}

  /** Every statement runs in the current request's snapshot ({@link inSnapshot}), when there is one. */
  private get sql(): UmbraDBSql { return requestSnapshot.getStore() ?? this.baseSql; }

  /**
   * Runs `fn` with EVERY query of this object inside one read-only `REPEATABLE READ` transaction —
   * one database snapshot (01-D audit F6). A token route reads the token rows, then the declarations
   * behind them ({@link withOrigins}), then often traits and mints: separate statements, and a fold
   * committing between two of them could pair a value with another value's evidence (a rename, or a
   * Null that cleared it). Inside a snapshot every statement sees the same committed state. Nested
   * calls join the snapshot already open.
   */
  async inSnapshot<T>(fn: () => Promise<T>): Promise<T> {
    if (requestSnapshot.getStore() !== undefined) return fn();
    return this.baseSql.begin("isolation level repeatable read read only", (tx) =>
      requestSnapshot.run(tx as unknown as UmbraDBSql, fn)) as Promise<T>;
  }

  private get s(): string { return this.schema; }

  private get a(): string { return this.archiveSchema; }

  /**
   * Adds `origins` to every token (spec 00024 FR-016b): one query for the declarations behind the
   * projected columns of the whole batch, then a pure function per token.
   */
  async withOrigins<T extends TokenBaseJson>(tokens: T[]): Promise<(T & { origins: TokenOriginsJson })[]> {
    await this.hooks.beforeOrigins?.();
    const sql = this.sql;
    const keyOf = (address: string, domainSep: string, kind: number): string => `${address}:${domainSep}:${kind}`;
    const wanted = [...new Set(tokens
      .filter((t) => t.status !== "builtin" && t.address !== null && t.domainSep !== null)
      .map((t) => keyOf(t.address!, t.domainSep!, t.kind)))];
    type OriginKvRow = KvEvidenceRow & {
      val_type: number; projection_error: string | null; val_len: number | null; value: Buffer | null; token: string;
    };
    const byToken = new Map<string, OriginKvRow[]>();
    if (wanted.length > 0) {
      const rows = await sql<OriginKvRow[]>`
        SELECT encode(kv.address, 'hex') || ':' || encode(kv.domain_sep, 'hex') || ':' || kv.kind::text AS token,
               kv.key_text, kv.name_variant, kv.val_type, kv.projection_error,
               CASE WHEN kv.key_text = 'metadata' OR kv.key_text LIKE 'metadata/%' THEN kv.val_len END AS val_len,
               CASE WHEN kv.key_text = 'metadata' OR kv.key_text LIKE 'metadata/%' THEN kv.value END AS value,
               kv.updated_event_id::text, kv.updated_height::text, kv.updated_tx_position,
               e.tx_hash, e.segment, e.parts, e.part_event_ids::text[] AS part_event_ids, e.phase
        FROM ${sql(this.s)}.token_metadata_kv kv
        LEFT JOIN ${sql(this.s)}.token_metadata_events e
          ON e.net = kv.net AND e.event_id = kv.updated_event_id
        WHERE kv.net = ${this.net}
          AND (kv.key_text IN ('name', 'symbol', 'decimals', 'tokenUri', 'metadata') OR kv.key_text LIKE 'metadata/%')
          AND encode(kv.address, 'hex') || ':' || encode(kv.domain_sep, 'hex') || ':' || kv.kind::text
              = ANY(${sql.array(wanted)}::text[])
      `;
      for (const row of rows) {
        const list = byToken.get(row.token) ?? [];
        list.push(row);
        byToken.set(row.token, list);
      }
    }
    return tokens.map((t) => ({
      ...t,
      origins: originsOf(t, t.address === null || t.domainSep === null ? [] : byToken.get(keyOf(t.address, t.domainSep, t.kind)) ?? []),
    }));
  }

  async listTokens(filters: TokenListFilters): Promise<Page<TokenListItemJson>> {
    const sql = this.sql;
    const cursor = filters.cursor;
    // `q` matches a name or symbol prefix (case-insensitively) or an EXACT colour/address hex —
    // the exact forms are what a wallet pastes, the prefix is what a person types.
    const q = filters.q?.trim() ?? "";
    const qHex = /^[0-9a-fA-F]{64}$/.test(q) ? Buffer.from(q.toLowerCase(), "hex") : null;
    const rows = await sql<(TokenRow & {
      token_key: Buffer; ds_count: number | null; ds_first: string[] | null;
      sort_group: number; sort_height: string;
    })[]>`
      SELECT t.token_key, t.address, t.domain_sep, t.kind, t.privacy, t.storage, t.color, t.name,
             t.symbol, t.decimals, t.token_uri, t.metadata, t.status, t.mint_count::text,
             t.total_minted::text,
             t.first_mint_height::text, t.last_mint_height::text, t.first_seen_height::text,
             t.metadata_updated_height::text, c.deploy_height::text,
             d.n AS ds_count, d.first5 AS ds_first,
             (t.status <> 'builtin')::int AS sort_group,
             COALESCE(t.first_mint_height, t.first_seen_height)::text AS sort_height
      FROM ${sql(this.s)}.tokens t
      LEFT JOIN ${sql(this.s)}.contracts c ON c.net = t.net AND c.address = t.address
      -- The contract's distinct domain separators, ordered by when each was first seen. Served by
      -- the (net, address, domain_sep) index; skipped for the built-ins, whose zero address is a
      -- sentinel and not a contract, and for seen rows, which have no contract at all.
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n,
               (array_agg(encode(x.domain_sep, 'hex') ORDER BY x.fs, x.domain_sep))[1:5] AS first5
        FROM (
          SELECT o.domain_sep, min(o.first_seen_height) AS fs
          FROM ${sql(this.s)}.tokens o
          WHERE o.net = t.net AND o.address = t.address AND o.status <> 'builtin'
          GROUP BY o.domain_sep
        ) x
      ) d ON t.status <> 'builtin' AND t.address IS NOT NULL
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
                 t.token_key, t.kind)
                > (${cursor?.builtin ?? 0}::int,
                   -${cursor?.height ?? 0}::bigint,
                   ${cursor === undefined ? Buffer.alloc(0) : Buffer.from(cursor.tokenKey, "hex")},
                   ${cursor?.kind ?? 0}::smallint))
      ORDER BY (t.status <> 'builtin')::int,
               COALESCE(t.first_mint_height, t.first_seen_height) DESC,
               t.token_key, t.kind
      LIMIT ${filters.limit + 1}
    `;
    const keys = new Map<TokenListItemJson, Omit<TokenCursor, "kind">>();
    const withOrigins = await this.withOrigins(rows.map(toToken));
    const items: TokenListItemJson[] = rows.map((row, index) => {
      const item: TokenListItemJson = {
        ...withOrigins[index]!,
        contractDomainSeps: row.ds_count === null
          ? null
          : { count: row.ds_count, first: row.ds_first ?? [] },
      };
      keys.set(item, {
        builtin: row.sort_group === 0 ? 0 : 1,
        height: Number(row.sort_height),
        tokenKey: row.token_key.toString("hex"),
      });
      return item;
    });
    return this.paginate(items, filters.limit, (last) => encodeCursor({
      ...keys.get(last)!, kind: last.kind,
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
    return this.withOrigins(rows.map(toToken));
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
    return row === undefined ? undefined : (await this.withOrigins([toToken(row)]))[0];
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
    return this.withOrigins(rows.map(toToken));
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
    return this.withOrigins(rows.map(toToken));
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
    const rows = await sql<(KvEvidenceRow & {
      key_hex: string; val_type: number; val_len: number; value: Buffer; projection_error: string | null;
    })[]>`
      SELECT kv.key_hex, kv.key_text, kv.name_variant, kv.val_type, kv.val_len, kv.value,
             kv.projection_error, kv.updated_height::text, kv.updated_event_id::text,
             kv.updated_tx_position, e.tx_hash, e.segment, e.parts,
             e.part_event_ids::text[] AS part_event_ids, e.phase
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
        integer: r.val_type === 2 ? integerOfValue(bytes, r.name_variant) : null,
        nameVariant: r.name_variant,
        projectionError: r.projection_error,
        updatedHeight: Number(r.updated_height),
        updatedTxHash: r.tx_hash === null ? null : r.tx_hash.toString("hex"),
        eventId: Number(r.updated_event_id),
        segment: r.segment,
        parts: r.parts ?? 1,
        partEventIds: r.part_event_ids === null ? [Number(r.updated_event_id)] : r.part_event_ids.map(Number),
        phase: r.phase,
        txPosition: r.updated_tx_position,
        origin: { origin: "mip-0018", evidence: packageEvidence(r) } satisfies OriginJson,
      };
    });
  }

  async mints(
    address: string, domainSep: string, kind: number,
    opts: { limit: number; cursor?: { blockHeight: number; txHash: string; segment: number; callIndex: number } },
  ): Promise<Page<{
    blockHeight: number; txHash: string; txPosition: number; segment: number; callIndex: number;
    entryPoint: string | null; kind: number; privacy: string; amount: string; origin: OriginJson;
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
      origin: {
        origin: "chain", rule: MINT_RULE,
        evidence: { txHash: r.tx_hash.toString("hex"), blockHeight: Number(r.block_height), txPosition: r.tx_position, segment: r.segment, callIndex: r.call_index },
      } satisfies OriginJson,
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
    value: string; text: string | null; integer: string | null; nameVariant: NameVariant;
    applied: boolean; rejectReason: string | null;
    txPosition: number; segment: number | null; parts: number; partEventIds: number[];
    phase: string | null; payloadLength: number; payloadSha256: string; origin: OriginJson;
  }>> {
    const sql = this.sql;
    const rows = await sql<{
      event_id: string; block_height: string; tx_hash: Buffer; domain_sep: Buffer; kind_byte: number;
      key: Buffer; key_hex: string; key_text: string | null; name_variant: NameVariant;
      val_type: number; val_len: number;
      value: Buffer; applied: boolean; reject_reason: string | null;
      tx_position: number; segment: number | null; parts: number; part_event_ids: string[];
      phase: string | null; payload: Buffer;
    }[]>`
      SELECT event_id::text, block_height::text, tx_hash, domain_sep, kind_byte, key, key_hex,
             key_text, name_variant, val_type, val_len, value, applied, reject_reason,
             tx_position, segment, parts, part_event_ids::text[] AS part_event_ids, phase, payload
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
        // …and an integer only under the rules of the name it was emitted with: MIP-0018's
        // `Uint<8·N>` is little-endian, the superseded draft's integer was big-endian.
        integer: r.val_type === 2 ? integerOfValue(bytes, r.name_variant) : null,
        nameVariant: r.name_variant,
        applied: r.applied,
        rejectReason: r.reject_reason,
        // Project 00024-01: the [Y] package this row is (a draft-name row is one event).
        txPosition: r.tx_position,
        segment: r.segment,
        parts: r.parts,
        partEventIds: r.part_event_ids.map(Number),
        phase: r.phase,
        // The merged payload's length and SHA-256 — what `cmse verify` reports for the same
        // package, so the two readers can be compared without shipping the bytes (spec SC-003).
        payloadLength: r.payload.length,
        payloadSha256: createHash("sha256").update(r.payload).digest("hex"),
        origin: {
          origin: "mip-0018",
          evidence: {
            key: r.key_text, nameVariant: r.name_variant, eventIds: r.part_event_ids.map(Number),
            txHash: r.tx_hash.toString("hex"), blockHeight: Number(r.block_height), txPosition: r.tx_position,
            segment: r.segment, parts: r.parts, phase: r.phase,
          },
        } satisfies OriginJson,
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
    origins: Pick<TokenOriginsJson, "name" | "symbol" | "decimals" | "metadata">;
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
      origins: Pick<TokenOriginsJson, "name" | "symbol" | "decimals" | "metadata">;
    }> = {};
    for (const row of await this.withOrigins(rows.map(toToken))) {
      // A registry entry is a wallet's re-derivation check: colour ⇒ `(address, domainSep, kind)`.
      // A row that has no contract behind it (00023's `seen`) has nothing to check against, and the
      // status filter above already excludes it — this guard is what says so in the type system.
      if (row.color === null || row.address === null || row.domainSep === null) continue;
      out[row.color] = {
        address: row.address, domainSep: row.domainSep, kind: row.kind, privacy: row.privacy,
        name: row.name, symbol: row.symbol, decimals: row.decimals, metadata: row.metadata,
        // Additive (00024-01, FR-016b): where each of those four values came from.
        origins: {
          name: row.origins.name, symbol: row.origins.symbol, decimals: row.origins.decimals,
          metadata: row.origins.metadata,
        },
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
    return this.withOrigins(rows.map(toToken));
  }

  /* ── project 00023: the activity reads (spec §5) ────────────────────────────────────────── */

  private toActivity(row: ActivityRow): ActivityJson {
    const ownerHex = row.owner === null ? null : row.owner.toString("hex");
    return {
      txHash: row.tx_hash.toString("hex"),
      blockHeight: Number(row.block_height),
      txPosition: row.tx_position,
      result: row.result,
      segment: row.segment,
      section: row.section,
      role: row.role,
      itemIndex: row.item_index,
      color: row.color.toString("hex"),
      kind: row.kind,
      amount: row.amount,
      direction: row.direction,
      // Bech32m REPLACES the hex on the page (Q9); `ownerHex` stays for machine consumers.
      owner: ownerHex === null ? null : ownerAddress(this.net, ownerHex),
      ownerHex,
      ownerKey: row.owner_key,
      intentHash: row.intent_hash === null ? null : row.intent_hash.toString("hex"),
      outputNo: row.output_no,
      address: row.address === null ? null : row.address.toString("hex"),
      entryPoint: row.entry_point,
      callIndex: row.call_index,
      domainSep: row.domain_sep === null ? null : row.domain_sep.toString("hex"),
      origin: {
        origin: "chain",
        rule: "a counted public token movement of an archived transaction (00023 FR-001/FR-002)",
        evidence: {
          txHash: row.tx_hash.toString("hex"), blockHeight: Number(row.block_height), txPosition: row.tx_position,
          segment: row.segment, section: row.section, role: row.role, itemIndex: row.item_index,
        },
      },
      token: row.t_kind === null ? null : {
        address: row.t_address === null ? null : row.t_address.toString("hex"),
        domainSep: row.t_domain_sep === null ? null : row.t_domain_sep.toString("hex"),
        kind: row.t_kind,
        name: row.t_name,
        symbol: row.t_symbol,
        decimals: row.t_decimals,
        status: row.t_status ?? "seen",
      },
    };
  }

  /**
   * One colour's activity, newest first (FR-006/FR-008).
   *
   * For the two NATIVE kinds a token's physical key IS its colour, so this one query serves both
   * `GET /v1/colors/:color/transactions` and `GET /v1/contracts/:a/tokens/:d/:kind/transactions`.
   * A LEDGER kind has no colour at all and therefore no activity row — the route answers an empty
   * page and the page shows the contract's calls instead (US7).
   */
  async activityOfColor(color: string, filters: ActivityFilters): Promise<Page<ActivityJson>> {
    const sql = this.sql;
    const c = filters.cursor;
    const rows = await sql<ActivityRow[]>`
      SELECT a.tx_hash, a.block_height::text, a.tx_position, tx.result,
             a.segment, a.section, a.role, a.item_index, a.color, a.kind, a.amount::text,
             a.direction, a.owner, a.owner_key, a.intent_hash, a.output_no, a.address,
             a.entry_point, a.call_index, a.domain_sep,
             t.address AS t_address, t.domain_sep AS t_domain_sep, t.kind AS t_kind,
             t.name AS t_name, t.symbol AS t_symbol, t.decimals AS t_decimals, t.status AS t_status
      FROM ${sql(this.s)}.token_activity a
      LEFT JOIN ${sql(this.s)}.tokens t
        ON t.net = a.net AND t.token_key = a.color AND t.kind = a.kind
      LEFT JOIN ${sql(this.a)}.transactions tx
        ON tx.net = a.net AND tx.tx_hash = a.tx_hash AND tx.block_height = a.block_height
      WHERE a.net = ${this.net} AND a.color = ${Buffer.from(color, "hex")}
        AND (${filters.kind ?? null}::smallint IS NULL OR a.kind = ${filters.kind ?? null})
        AND (${filters.role ?? null}::text IS NULL OR a.role = ${filters.role ?? null})
        -- Height is DESCENDING, so the row comparison carries it negated.
        AND (${c === undefined ? null : c.blockHeight}::bigint IS NULL
             OR (-a.block_height, a.tx_hash, a.segment, a.section, a.role, a.item_index)
                > (-${c?.blockHeight ?? 0}::bigint,
                   ${c === undefined ? Buffer.alloc(0) : Buffer.from(c.txHash, "hex")},
                   ${c?.segment ?? 0}::int, ${c?.section ?? ""}::text, ${c?.role ?? ""}::text,
                   ${c?.itemIndex ?? 0}::int))
      ORDER BY a.block_height DESC, a.tx_hash, a.segment, a.section, a.role, a.item_index
      LIMIT ${filters.limit + 1}
    `;
    return this.paginate(rows.map((r) => this.toActivity(r)), filters.limit, (last) => encodeCursor({
      blockHeight: last.blockHeight, txHash: last.txHash, segment: last.segment,
      section: last.section, role: last.role, itemIndex: last.itemIndex,
    } satisfies ActivityCursor));
  }

  /** One token's activity. `tokenKey` is the row's physical key, which for a native kind is its
   *  colour — see {@link activityOfColor}. */
  async activityOfToken(
    tokenKey: string, kind: number, filters: Omit<ActivityFilters, "kind">,
  ): Promise<Page<ActivityJson>> {
    return this.activityOfColor(tokenKey, { ...filters, kind });
  }

  /** Every stored row of one transaction, for the transaction view's "Activity" section (§4). */
  async activityOfTx(txHash: string): Promise<ActivityJson[]> {
    const sql = this.sql;
    const rows = await sql<ActivityRow[]>`
      SELECT a.tx_hash, a.block_height::text, a.tx_position, tx.result,
             a.segment, a.section, a.role, a.item_index, a.color, a.kind, a.amount::text,
             a.direction, a.owner, a.owner_key, a.intent_hash, a.output_no, a.address,
             a.entry_point, a.call_index, a.domain_sep,
             t.address AS t_address, t.domain_sep AS t_domain_sep, t.kind AS t_kind,
             t.name AS t_name, t.symbol AS t_symbol, t.decimals AS t_decimals, t.status AS t_status
      FROM ${sql(this.s)}.token_activity a
      LEFT JOIN ${sql(this.s)}.tokens t
        ON t.net = a.net AND t.token_key = a.color AND t.kind = a.kind
      LEFT JOIN ${sql(this.a)}.transactions tx
        ON tx.net = a.net AND tx.tx_hash = a.tx_hash AND tx.block_height = a.block_height
      WHERE a.net = ${this.net} AND a.tx_hash = ${Buffer.from(txHash, "hex")}
      ORDER BY a.segment, a.section, a.role, a.item_index
    `;
    return rows.map((r) => this.toActivity(r));
  }

  /** Every zswap offer on the chain, newest first; `undisclosed` narrows to the ones whose colour
   *  the ledger does not publish (FR-018, US4's chain-wide figure). */
  async shieldedOffers(
    opts: { undisclosed?: boolean; limit: number; cursor?: ShieldedOfferCursor },
  ): Promise<Page<ShieldedOfferJson>> {
    const sql = this.sql;
    const c = opts.cursor;
    const rows = await sql<{
      tx_hash: Buffer; block_height: string; tx_position: number; section: string; segment: number;
      inputs: number; outputs: number; transients: number; deltas: number;
      undisclosed: boolean; counted: boolean;
    }[]>`
      SELECT tx_hash, block_height::text, tx_position, section, segment,
             inputs, outputs, transients, deltas, undisclosed, counted
      FROM ${sql(this.s)}.shielded_offers
      WHERE net = ${this.net}
        AND (${opts.undisclosed === undefined ? null : opts.undisclosed}::boolean IS NULL
             OR undisclosed = ${opts.undisclosed ?? false})
        AND (${c === undefined ? null : c.blockHeight}::bigint IS NULL
             OR (-block_height, tx_hash, section, segment)
                > (-${c?.blockHeight ?? 0}::bigint,
                   ${c === undefined ? Buffer.alloc(0) : Buffer.from(c.txHash, "hex")},
                   ${c?.section ?? ""}::text, ${c?.segment ?? 0}::int))
      ORDER BY block_height DESC, tx_hash, section, segment
      LIMIT ${opts.limit + 1}
    `;
    const items: ShieldedOfferJson[] = rows.map((r) => ({
      txHash: r.tx_hash.toString("hex"),
      blockHeight: Number(r.block_height),
      txPosition: r.tx_position,
      section: r.section,
      segment: r.segment,
      inputs: r.inputs,
      outputs: r.outputs,
      transients: r.transients,
      deltas: r.deltas,
      undisclosed: r.undisclosed,
      counted: r.counted,
    }));
    return this.paginate(items, opts.limit, (last) => encodeCursor({
      blockHeight: last.blockHeight, txHash: last.txHash, section: last.section, segment: last.segment,
    } satisfies ShieldedOfferCursor));
  }

  /** Every call of one contract, newest first, with every public field of each transcript — the
   *  only activity a LEDGER token has, listed under the owner's public-data note (Q4, US7). */
  async callsOfContract(
    address: string, opts: { limit: number; cursor?: ContractCallCursor },
  ): Promise<Page<ContractCallJson>> {
    const sql = this.sql;
    const c = opts.cursor;
    const rows = await sql<{
      tx_hash: Buffer; block_height: string; tx_position: number; segment: number;
      call_index: number; address: Buffer; entry_point: string | null;
      guaranteed: unknown; fallible: unknown;
    }[]>`
      SELECT tx_hash, block_height::text, tx_position, segment, call_index, address, entry_point,
             guaranteed, fallible
      FROM ${sql(this.s)}.contract_calls
      WHERE net = ${this.net} AND address = ${Buffer.from(address, "hex")}
        AND (${c === undefined ? null : c.blockHeight}::bigint IS NULL
             OR (-block_height, tx_hash, segment, call_index)
                > (-${c?.blockHeight ?? 0}::bigint,
                   ${c === undefined ? Buffer.alloc(0) : Buffer.from(c.txHash, "hex")},
                   ${c?.segment ?? 0}::int, ${c?.callIndex ?? 0}::int))
      ORDER BY block_height DESC, tx_hash, segment, call_index
      LIMIT ${opts.limit + 1}
    `;
    const items: ContractCallJson[] = rows.map((r) => ({
      txHash: r.tx_hash.toString("hex"),
      blockHeight: Number(r.block_height),
      txPosition: r.tx_position,
      segment: r.segment,
      callIndex: r.call_index,
      address: r.address.toString("hex"),
      entryPoint: r.entry_point,
      guaranteed: r.guaranteed ?? null,
      fallible: r.fallible ?? null,
    }));
    return this.paginate(items, opts.limit, (last) => encodeCursor({
      blockHeight: last.blockHeight, txHash: last.txHash, segment: last.segment, callIndex: last.callIndex,
    } satisfies ContractCallCursor));
  }

  /**
   * Names for a set of colours, at one kind — what spec §5's `deltas[] {color, delta, tokenName?}`
   * needs. Resolved at read time like every other identity in this API: a delta names a colour, and
   * whether anyone has named that colour is a separate, later fact.
   */
  async tokenNamesOfColors(
    colors: readonly string[], kind: number,
  ): Promise<Record<string, { name: string | null; symbol: string | null; status: string }>> {
    if (colors.length === 0) return {};
    const sql = this.sql;
    const keys = colors.map((c) => Buffer.from(c, "hex"));
    const rows = await sql<{ token_key: Buffer; name: string | null; symbol: string | null; status: string }[]>`
      SELECT token_key, name, symbol, status FROM ${sql(this.s)}.tokens
      WHERE net = ${this.net} AND kind = ${kind} AND token_key IN ${sql(keys)}
    `;
    const out: Record<string, { name: string | null; symbol: string | null; status: string }> = {};
    for (const row of rows) {
      out[row.token_key.toString("hex")] = { name: row.name, symbol: row.symbol, status: row.status };
    }
    return out;
  }

  /** The read-time counts spec §5 adds to a `Token`. Computed rather than stored, so they can
   *  never disagree with the rows they count. */
  async tokenCounts(tokenKey: string, kind: number): Promise<TokenActivityCounts> {
    const sql = this.sql;
    const key = Buffer.from(tokenKey, "hex");
    const rows = await sql<{
      activity_count: string; last_height: string | null; disclosed: string; undisclosed: string;
    }[]>`
      SELECT
        (SELECT count(*) FROM ${sql(this.s)}.token_activity
          WHERE net = ${this.net} AND color = ${key} AND kind = ${kind})            AS activity_count,
        (SELECT max(block_height)::text FROM ${sql(this.s)}.token_activity
          WHERE net = ${this.net} AND color = ${key} AND kind = ${kind})            AS last_height,
        (SELECT count(DISTINCT tx_hash) FROM ${sql(this.s)}.token_activity
          WHERE net = ${this.net} AND color = ${key} AND kind = ${kind}
            AND role = 'shielded_delta')                                            AS disclosed,
        (SELECT count(*) FROM ${sql(this.s)}.shielded_offers
          WHERE net = ${this.net} AND undisclosed)                                  AS undisclosed
    `;
    const row = rows[0]!;
    const counts: TokenActivityCounts = {
      activityCount: Number(row.activity_count),
      lastActivityHeight: row.last_height === null ? null : Number(row.last_height),
    };
    // Only a SHIELDED native token has a disclosure story to tell: the transactions whose offer
    // delta named its colour, against the chain-wide number of offers that named none (US4).
    if (kind === 1) {
      counts.disclosedTransactions = Number(row.disclosed);
      counts.undisclosedShieldedOffers = Number(row.undisclosed);
    }
    return counts;
  }

  /**
   * One archived transaction's bytes and archived facts, by hash (FR-007).
   *
   * Canonical blocks only, exactly like the scanner's own batch query: a transaction that only
   * ever existed on an orphaned block is not part of the chain this index describes.
   */
  async archivedTransaction(txHash: string): Promise<{
    txHash: string; blockHeight: number; blockHash: string; txPosition: number;
    kind: string; protocolVersion: number;
    result: "success" | "partial_success" | "failure" | null;
    segments: { id: number; success: boolean }[] | null;
    raw: Buffer;
  } | undefined> {
    const sql = this.sql;
    const rows = await sql<{
      tx_hash: Buffer; block_height: string; block_hash: Buffer; position: number; kind: string;
      protocol_version: number; result: string | null;
      segments: { id: number; success: boolean }[] | null; data: Buffer;
    }[]>`
      SELECT t.tx_hash, t.block_height::text, t.block_hash, t.position, t.kind, t.protocol_version,
             t.result, t.segments, b.data
      FROM ${sql(this.a)}.transactions t
      JOIN ${sql(this.a)}.blocks bl
        ON bl.net = t.net AND bl.height = t.block_height AND bl.block_hash = t.block_hash
      JOIN ${sql(this.a)}.chain_blobs b ON b.hash = t.raw_blob_hash
      WHERE t.net = ${this.net} AND t.tx_hash = ${Buffer.from(txHash, "hex")} AND bl.is_canonical
      ORDER BY t.block_height
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      txHash: row.tx_hash.toString("hex"),
      blockHeight: Number(row.block_height),
      blockHash: row.block_hash.toString("hex"),
      txPosition: row.position,
      kind: row.kind,
      protocolVersion: row.protocol_version,
      result: row.result as "success" | "partial_success" | "failure" | null,
      segments: row.segments,
      raw: row.data,
    };
  }
}


/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Project 00023 — the activity reads (spec §5, §6.4).
 *
 * Every list is newest first and keyset-paged on the row's own natural order,
 * `(block_height DESC, tx_hash, segment, section, role, item_index)`, so a row the live scanner
 * inserts between two pages cannot make a reader skip or repeat one.
 *
 * Each row is served with two things it does not itself store: the transaction's `result`, joined
 * from the ARCHIVE (the archive stays the only source of facts — spec §1), and the token identity,
 * joined from `tokens` on `(token_key, kind)`. Because every colour public data proves exists now
 * has a row (`seen` at worst, US5), that second join effectively always hits — and the colour route
 * and the token route can never disagree (FR-008).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The token an activity row belongs to, as §4's "resolved token" (plus `status`, so a page can
 *  badge a `seen` row without a second request). */
export interface ActivityTokenJson {
  address: string | null;
  domainSep: string | null;
  kind: number;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  status: string;
}

/** One `token_activity` row on the wire (spec §5's `Activity`). */
export interface ActivityJson {
  txHash: string;
  blockHeight: number;
  txPosition: number;
  /** The archived transaction result. Always `success` or `partial_success` for a STORED row —
   *  only counted rows are stored (Q10) — and `null` only if the archive lost the transaction. */
  result: string | null;
  segment: number;
  section: string;
  role: string;
  itemIndex: number;
  color: string;
  kind: number;
  /** Decimal string, UNSIGNED: `direction` carries the sign (FR-014). */
  amount: string;
  direction: string;
  /** The owner as a wallet shows it — Bech32m, REPLACING the hex (owner decision Q9). */
  owner: string | null;
  /** The same 32 bytes as hex, for machine consumers that join by address. The page never shows
   *  it (Q9); it is here so a consumer never has to decode Bech32m to match a row. */
  ownerHex: string | null;
  ownerKey: string | null;
  intentHash: string | null;
  outputNo: number | null;
  /** A CONTRACT address — hex, never Bech32m (owner decision Q9). */
  address: string | null;
  entryPoint: string | null;
  callIndex: number | null;
  domainSep: string | null;
  /** Project 00024-01 (FR-016b): always `chain` — where on chain this movement is. */
  origin: OriginJson;
  token: ActivityTokenJson | null;
}

/** The ordering key of the last activity row served. */
export interface ActivityCursor {
  blockHeight: number;
  txHash: string;
  segment: number;
  section: string;
  role: string;
  itemIndex: number;
}

export interface ActivityFilters {
  role?: string;
  kind?: number;
  limit: number;
  cursor?: ActivityCursor;
}

/** One `shielded_offers` row on the wire (FR-018). */
export interface ShieldedOfferJson {
  txHash: string;
  blockHeight: number;
  txPosition: number;
  section: string;
  segment: number;
  inputs: number;
  outputs: number;
  transients: number;
  deltas: number;
  /** `true` when the offer is BALANCED and the ledger therefore publishes no colour for it at
   *  all — "any of these may be this token; the ledger does not say" (US4). */
  undisclosed: boolean;
  counted: boolean;
}

export interface ShieldedOfferCursor {
  blockHeight: number;
  txHash: string;
  section: string;
  segment: number;
}

/** One `contract_calls` row on the wire (FR-020, US7). */
export interface ContractCallJson {
  txHash: string;
  blockHeight: number;
  txPosition: number;
  segment: number;
  callIndex: number;
  address: string;
  entryPoint: string | null;
  guaranteed: unknown;
  fallible: unknown;
}

export interface ContractCallCursor {
  blockHeight: number;
  txHash: string;
  segment: number;
  callIndex: number;
}

/** The read-time counts spec §5 adds to a `Token`. */
export interface TokenActivityCounts {
  activityCount: number;
  lastActivityHeight: number | null;
  /** Kind 1 only: how many transactions published this colour through an offer delta, and how
   *  many shielded offers CHAIN-WIDE publish no colour at all. The second number is the honest
   *  denominator beside the first — "these are the ones the ledger does not name" (US4). */
  disclosedTransactions?: number;
  undisclosedShieldedOffers?: number;
}

interface ActivityRow {
  tx_hash: Buffer; block_height: string; tx_position: number; result: string | null;
  segment: number; section: string; role: string; item_index: number;
  color: Buffer; kind: number; amount: string; direction: string;
  owner: Buffer | null; owner_key: string | null; intent_hash: Buffer | null; output_no: number | null;
  address: Buffer | null; entry_point: string | null; call_index: number | null;
  domain_sep: Buffer | null;
  t_address: Buffer | null; t_domain_sep: Buffer | null; t_kind: number | null;
  t_name: string | null; t_symbol: string | null; t_decimals: number | null; t_status: string | null;
}

export function utf8OrNull(bytes: Buffer | Uint8Array): string | null {
  return decodeUtf8(bytes instanceof Buffer ? new Uint8Array(bytes) : bytes) ?? null;
}
