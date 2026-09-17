import type { ISql } from "postgres";
import { tokenColor } from "../color.js";
import type { ObservedMint } from "./decode.js";
import {
  MAX_METADATA_PARTS,
  isWellKnownKey,
  metadataPartIndex,
  parseTokenMetadata,
  type ParsedTokenMetadata,
  type TokenKind,
} from "./payload.js";

/**
 * Project 00020 — the fold: the ONLY place `token_index.tokens` is written, apart from the two
 * built-in seeds and `rebuild` (spec FR-017(d)).
 *
 * The owner's three row-source rules (spec §3), implemented literally:
 *
 *  1. A row is created or changed by exactly two kinds of evidence — an **observed mint**, or an
 *     **applied `TokenMetadata` event**.
 *  2. **Minting is always native.** An observed mint sets `storage = 'native'` unconditionally and
 *     `kind` from the effect map it came from. No event can change either afterwards.
 *  3. Only an emitted event can describe a **ledger** token, and an event may also describe a
 *     native one.
 *
 * ── How `status` is computed (spec §6.2) ───────────────────────────────────────────────────────
 * Never incrementally, always **derived** from the evidence already stored, by
 * {@link recomputeToken}: the row's own mint counters plus one query over `token_metadata_events`.
 * That is what makes a `rebuild` byte-identical to an uninterrupted run and what makes the order in
 * which a mint and its metadata happen to arrive irrelevant.
 *
 * | observed mint | applied metadata | status |
 * |---|---|---|
 * | yes | no  | `observed` |
 * | no  | yes | `declared` |
 * | yes | yes, no event declares ledger | `described` |
 * | yes | yes, some applied event declares ledger (kind bit 1 set) | `inconsistent` |
 *
 * **Why "the other bit 0" of FR-017(c) cannot arise** (recorded as question Q33): an event is
 * folded into the row `(address, domainSep, kind-from-bit-0)` — bit 0 SELECTS the row rather than
 * describing it, so an event can never disagree with a mint about bit 0; it would simply be about
 * the neighbouring row, which is exactly the legitimate "one colour, two kinds" case. The
 * contradiction FR-017(c) is really about is bit 1: a declaration of `ledger` for a token the chain
 * was observed minting natively. That is what sets `inconsistent`.
 */

export interface TokenKey {
  address: string;
  domainSep: string;
  kind: TokenKind;
}

const hexBuf = (hex: string): Buffer => Buffer.from(hex, "hex");

/** Upserts `contracts` for an address the scanner has just seen. `deployHeight`/`deployTxHash` are
 *  set only by a real `ContractDeploy`; a call on a contract deployed before the archive's first
 *  block leaves them NULL forever, which is honest — the archive genuinely never saw it. */
export async function upsertContract(
  sql: ISql, schema: string, net: string,
  row: { address: string; height: number; deployTxHash?: string; isDeploy: boolean; isCall: boolean },
): Promise<void> {
  await sql`
    INSERT INTO ${sql(schema)}.contracts (net, address, deploy_tx_hash, deploy_height, first_seen_height, last_call_height)
    VALUES (
      ${net}, ${hexBuf(row.address)},
      ${row.isDeploy && row.deployTxHash !== undefined ? hexBuf(row.deployTxHash) : null},
      ${row.isDeploy ? row.height : null},
      ${row.height},
      ${row.isCall ? row.height : null}
    )
    ON CONFLICT (net, address) DO UPDATE SET
      deploy_tx_hash    = COALESCE(${sql(schema)}.contracts.deploy_tx_hash, EXCLUDED.deploy_tx_hash),
      deploy_height     = COALESCE(${sql(schema)}.contracts.deploy_height, EXCLUDED.deploy_height),
      first_seen_height = LEAST(${sql(schema)}.contracts.first_seen_height, EXCLUDED.first_seen_height),
      last_call_height  = GREATEST(
        COALESCE(${sql(schema)}.contracts.last_call_height, EXCLUDED.last_call_height),
        COALESCE(EXCLUDED.last_call_height, ${sql(schema)}.contracts.last_call_height))
  `;
}

/**
 * Records one counted mint: a `token_mints` row (idempotent on its natural key) and the token row's
 * counters. Returns `true` when the mint was new, `false` when this exact mint was already
 * recorded — which is what makes a re-scan of the same block change nothing.
 */
export async function applyMint(
  sql: ISql, schema: string, net: string,
  mint: ObservedMint,
  ctx: { txHash: string; blockHeight: number; txPosition: number },
): Promise<boolean> {
  const inserted = await sql`
    INSERT INTO ${sql(schema)}.token_mints
      (net, tx_hash, block_height, tx_position, segment, call_index, entry_point, address, domain_sep, kind, amount)
    VALUES
      (${net}, ${hexBuf(ctx.txHash)}, ${ctx.blockHeight}, ${ctx.txPosition}, ${mint.segment},
       ${mint.callIndex}, ${mint.entryPoint ?? null}, ${hexBuf(mint.address)}, ${hexBuf(mint.domainSep)},
       ${mint.kind}, ${mint.amount.toString()})
    ON CONFLICT (net, tx_hash, segment, call_index, kind, domain_sep) DO NOTHING
  `;
  if (inserted.count === 0) return false;

  // Rule 2: a mint is always native, and its kind comes from the effect map it came from.
  const color = Buffer.from(tokenColor(hexBuf(mint.domainSep), hexBuf(mint.address)));
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, storage, color, status,
       mint_count, total_minted, first_mint_height, last_mint_height, first_seen_height)
    VALUES
      (${net}, ${hexBuf(mint.address)}, ${hexBuf(mint.domainSep)}, ${mint.kind}, 'native', ${color}, 'observed',
       1, ${mint.amount.toString()}, ${ctx.blockHeight}, ${ctx.blockHeight}, ${ctx.blockHeight})
    ON CONFLICT (net, address, domain_sep, kind) DO UPDATE SET
      storage           = 'native',
      color             = EXCLUDED.color,
      mint_count        = ${sql(schema)}.tokens.mint_count + 1,
      total_minted      = ${sql(schema)}.tokens.total_minted + EXCLUDED.total_minted,
      first_mint_height = LEAST(COALESCE(${sql(schema)}.tokens.first_mint_height, EXCLUDED.first_mint_height), EXCLUDED.first_mint_height),
      last_mint_height  = GREATEST(COALESCE(${sql(schema)}.tokens.last_mint_height, EXCLUDED.last_mint_height), EXCLUDED.last_mint_height),
      first_seen_height = LEAST(${sql(schema)}.tokens.first_seen_height, EXCLUDED.first_seen_height)
  `;
  await recomputeToken(sql, schema, net, { address: mint.address, domainSep: mint.domainSep, kind: mint.kind });
  return true;
}

/** One contract event as the lookup delivers it, before parsing. */
export interface RawContractEvent {
  /** The indexer's own `ContractEvent.id` — the idempotency key for the whole pipeline. */
  eventId: number;
  contractAddress: string;
  txHash: string;
  blockHeight: number;
  /** `pad(32, "TokenMetadata")` as hex, for a `MiscContractEvent`. */
  nameHex: string;
  /** The 256-byte payload, hex. */
  payloadHex: string;
}

export interface AppliedEventOutcome {
  stored: boolean;
  applied: boolean;
  rejectReason: string | undefined;
  /** The payload was not 256 bytes, so the schema's own CHECK makes it unstorable (question Q31):
   *  counted and logged, never padded, truncated or silently dropped. */
  unstorable: boolean;
}

/**
 * Stores one `TokenMetadata` event and, if it is applicable, folds it into the token.
 *
 * Idempotent on `(net, event_id)` — the indexer's own event id — so re-looking-up a transaction
 * after a short answer, or redelivering an event, changes nothing.
 */
export async function applyMetadataEvent(
  sql: ISql, schema: string, net: string, event: RawContractEvent,
): Promise<AppliedEventOutcome> {
  const payload = Buffer.from(event.payloadHex, "hex");
  let parsed: ParsedTokenMetadata;
  try {
    parsed = parseTokenMetadata(new Uint8Array(payload));
  } catch (error) {
    // A payload that is not 256 bytes cannot be stored at all (the column's CHECK) — question Q31.
    // It is counted and surfaced by the caller rather than crashing the scan batch.
    return {
      stored: false, applied: false, unstorable: true,
      rejectReason: error instanceof Error ? error.message : String(error),
    };
  }

  const domainSep = Buffer.from(parsed.domainSep);
  const inserted = await sql`
    INSERT INTO ${sql(schema)}.token_metadata_events
      (net, event_id, address, tx_hash, block_height, payload, domain_sep, kind_byte, key, key_text, len, value, applied, reject_reason)
    VALUES
      (${net}, ${event.eventId}, ${hexBuf(event.contractAddress)}, ${hexBuf(event.txHash)}, ${event.blockHeight},
       ${payload}, ${domainSep}, ${parsed.kindByte}, ${Buffer.from(parsed.key)}, ${parsed.keyText ?? null},
       ${Math.min(parsed.len, 190)}, ${Buffer.from(parsed.value)}, ${parsed.applied}, ${parsed.rejectReason ?? null})
    ON CONFLICT (net, event_id) DO NOTHING
  `;
  if (inserted.count === 0) {
    // Already stored — nothing to re-fold; the fold is a pure function of the stored evidence.
    return { stored: false, applied: parsed.applied, rejectReason: parsed.rejectReason, unstorable: false };
  }
  if (!parsed.applied) {
    return { stored: true, applied: false, rejectReason: parsed.rejectReason, unstorable: false };
  }

  const key: TokenKey = {
    address: event.contractAddress,
    domainSep: Buffer.from(parsed.domainSep).toString("hex"),
    kind: parsed.kind,
  };

  // Last write wins per (token, key), ordered by (block height, indexer event id) — the indexer's
  // ids are assigned in evaluation order, so two events in one transaction order correctly.
  await sql`
    INSERT INTO ${sql(schema)}.token_metadata_kv
      (net, address, domain_sep, kind, key_text, value, len, updated_event_id, updated_height)
    VALUES
      (${net}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)}, ${key.kind}, ${parsed.keyText!},
       ${Buffer.from(parsed.valueBytes)}, ${parsed.len}, ${event.eventId}, ${event.blockHeight})
    ON CONFLICT (net, address, domain_sep, kind, key_text) DO UPDATE SET
      value            = EXCLUDED.value,
      len              = EXCLUDED.len,
      updated_event_id = EXCLUDED.updated_event_id,
      updated_height   = EXCLUDED.updated_height
    WHERE (${sql(schema)}.token_metadata_kv.updated_height, ${sql(schema)}.token_metadata_kv.updated_event_id)
          < (EXCLUDED.updated_height, EXCLUDED.updated_event_id)
  `;

  // Rule 1: the event creates the row if no mint has. Storage/kind come from the kind byte, but
  // only rule 3's way — `recomputeToken` below refuses to move them once a mint exists.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, storage, color, status, first_seen_height,
       metadata_updated_height, metadata_updated_event_id)
    VALUES
      (${net}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)}, ${key.kind},
       ${parsed.storage},
       ${parsed.storage === "native" ? Buffer.from(tokenColor(parsed.domainSep, hexBuf(key.address))) : null},
       'declared', ${event.blockHeight}, ${event.blockHeight}, ${event.eventId})
    ON CONFLICT (net, address, domain_sep, kind) DO UPDATE SET
      first_seen_height         = LEAST(${sql(schema)}.tokens.first_seen_height, EXCLUDED.first_seen_height),
      metadata_updated_height   = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_height, EXCLUDED.metadata_updated_height), EXCLUDED.metadata_updated_height),
      metadata_updated_event_id = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_event_id, EXCLUDED.metadata_updated_event_id), EXCLUDED.metadata_updated_event_id)
  `;

  await recomputeToken(sql, schema, net, key);
  return { stored: true, applied: true, rejectReason: undefined, unstorable: false };
}

/**
 * Re-derives everything about one token that is a function of its stored evidence: the projected
 * display fields, `storage`, `color` and `status`. Called after every mint and every applied event,
 * and by `rebuild`.
 *
 * Never touches a `builtin` row — NIGHT and DUST have no contract and no evidence, and a row at the
 * all-zero address can never be produced by the scanner anyway.
 */
export async function recomputeToken(
  sql: ISql, schema: string, net: string, key: TokenKey,
): Promise<void> {
  const address = hexBuf(key.address);
  const domainSep = hexBuf(key.domainSep);

  const rows = await sql<{ mint_count: string; status: string }[]>`
    SELECT mint_count::text, status FROM ${sql(schema)}.tokens
    WHERE net = ${net} AND address = ${address} AND domain_sep = ${domainSep} AND kind = ${key.kind}
  `;
  const row = rows[0];
  if (row === undefined || row.status === "builtin") return;
  const hasMint = BigInt(row.mint_count) > 0n;

  // The evidence: every APPLIED event for this row, newest last. `kind_byte & 1` selects the row's
  // own kind, so an event about the neighbouring kind is correctly not this row's business.
  const events = await sql<{ kind_byte: number; declares_ledger: boolean; event_id: string; block_height: string }[]>`
    SELECT kind_byte, (kind_byte & 2) = 2 AS declares_ledger, event_id::text, block_height::text
    FROM ${sql(schema)}.token_metadata_events
    WHERE net = ${net} AND address = ${address} AND domain_sep = ${domainSep}
      AND applied AND (kind_byte & 1) = ${key.kind === "shielded" ? 1 : 0}
    ORDER BY block_height, event_id
  `;
  const hasMetadata = events.length > 0;
  const declaresLedger = events.some((e) => e.declares_ledger);
  const latest = events[events.length - 1];

  const status = hasMint
    ? (hasMetadata ? (declaresLedger ? "inconsistent" : "described") : "observed")
    : (hasMetadata ? "declared" : "observed");

  // Rule 2: an observed mint pins storage to native forever. Otherwise the latest applied event's
  // kind byte decides, and a ledger token has no derivable colour.
  const storage = hasMint ? "native" : (latest?.declares_ledger === true ? "ledger" : "native");
  const color = storage === "native"
    ? Buffer.from(tokenColor(new Uint8Array(domainSep), new Uint8Array(address)))
    : null;

  const projected = await projectedFields(sql, schema, net, key);

  await sql`
    UPDATE ${sql(schema)}.tokens SET
      status                    = ${status},
      storage                   = ${storage},
      color                     = ${color},
      name                      = ${projected.name},
      symbol                    = ${projected.symbol},
      decimals                  = ${projected.decimals},
      token_uri                 = ${projected.tokenUri},
      metadata                  = ${projected.metadata === null ? null : sql.json(projected.metadata as never)},
      metadata_updated_height   = ${latest === undefined ? null : Number(latest.block_height)},
      metadata_updated_event_id = ${latest === undefined ? null : Number(latest.event_id)}
    WHERE net = ${net} AND address = ${address} AND domain_sep = ${domainSep} AND kind = ${key.kind}
  `;
}

export interface ProjectedFields {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenUri: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The well-known keys of `token_metadata_kv`, projected into the `tokens` columns.
 *
 * `metadata` may arrive whole (`metadata`) or split (`metadata/0 … metadata/<n>`, owner decision
 * Q6: at most 16 parts). A split document is applied only when parts `0..max` are ALL present and
 * their concatenation parses as a JSON object; until then the column keeps whatever complete value
 * it last had — which is why the assembly runs here, over the stored parts, rather than at the
 * moment one part arrives.
 */
export async function projectedFields(
  sql: ISql, schema: string, net: string, key: TokenKey,
): Promise<ProjectedFields> {
  const rows = await sql<{ key_text: string; value: Buffer; len: number }[]>`
    SELECT key_text, value, len FROM ${sql(schema)}.token_metadata_kv
    WHERE net = ${net} AND address = ${hexBuf(key.address)} AND domain_sep = ${hexBuf(key.domainSep)}
      AND kind = ${key.kind}
  `;
  const byKey = new Map(rows.map((r) => [r.key_text, r]));
  const text = (k: string): string | null => {
    const row = byKey.get(k);
    if (row === undefined) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(row.value.subarray(0, row.len));
    } catch {
      return null;
    }
  };

  const decimalsRow = byKey.get("decimals");
  const parts: string[] = [];
  let maxPart = -1;
  for (const [k] of byKey) {
    const index = metadataPartIndex(k);
    if (index !== undefined && index < MAX_METADATA_PARTS) maxPart = Math.max(maxPart, index);
  }
  let assembled: string | null = null;
  if (maxPart >= 0) {
    let complete = true;
    for (let i = 0; i <= maxPart; i++) {
      const piece = text(`metadata/${i}`);
      if (piece === null) { complete = false; break; }
      parts.push(piece);
    }
    if (complete) assembled = parts.join("");
  }

  const whole = text("metadata");
  let metadata: Record<string, unknown> | null = null;
  for (const candidate of [assembled, whole]) {
    if (candidate === null) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        metadata = value as Record<string, unknown>;
      }
    } catch { /* an incomplete or malformed document simply does not project */ }
  }

  const uri = text("tokenUri");
  return {
    name: text("name"),
    symbol: text("symbol"),
    decimals: decimalsRow === undefined || decimalsRow.len !== 1 ? null : decimalsRow.value[0]!,
    tokenUri: uri,
    metadata,
  };
}

/** Exported for the API and the tests: the keys that become columns rather than traits. */
export { isWellKnownKey };
