import type { ISql } from "postgres";
import { tokenColor } from "../color.js";
import type { ObservedMint } from "./decode.js";
import {
  MAX_METADATA_BYTES,
  MAX_METADATA_PARTS,
  decodeUtf8,
  isNativeKind,
  isWellKnownKey,
  metadataPartIndex,
  parseTokenMetadata,
  type ParsedTokenMetadata,
} from "./payload.js";

/**
 * Project 00021 — the fold: the ONLY place `token_index.tokens` is written, apart from the two
 * built-in seeds and `rebuild`.
 *
 * ── The identity is the full `kind` byte (MIP §4, spec D4/FR-103) ──────────────────────────────
 * A token is `(contractAddress, domainSep, kind)` where `kind` is the whole byte: 0 unshielded
 * native, 1 shielded native, 2 unshielded ledger, 3 shielded ledger. Each is a distinct row, even
 * under one domain separator. Everything else follows from that one decision:
 *
 *  1. A row is created or changed by exactly two kinds of evidence — an **observed mint** (a fact
 *     the ledger verified) or an **applied metadata event** (a claim the contract made).
 *  2. A mint can only ever be kind 0 or 1: a mint effect is a protocol-level mint, so it lands on a
 *     native row and never touches a ledger one (MIP §6.3).
 *  3. A declaration populates **exactly its own kind's row and no other**. Declaring kind 2 says
 *     nothing about kind 0.
 *
 * ── Why there is no `inconsistent` any more (MIP §6.3/§7.2, spec D4) ───────────────────────────
 * 00020 folded a declaration and a mint onto ONE row keyed by the privacy bit, so a contract that
 * described its balance book (kind 2) while minting UTXOs (kind 0) produced a row whose stored
 * facts disagreed, and the fold flagged it `inconsistent`. Under the MIP those are two different
 * tokens: the "Ledger Liar" of the reference set now yields an **observed kind-0 row without a
 * name** and a **declared kind-2 row with one**, which is the accurate picture and not an error.
 * The MIP says so in as many words ("Detecting contradictions between the two … was considered and
 * rejected"), and a consumer MAY hint that the rows share a domain separator — which the API does,
 * through `GET /v1/contracts/:address/tokens/:domainSep`.
 *
 * ── How `status` is computed (MIP §7.2) ────────────────────────────────────────────────────────
 * Never incrementally, always **derived** from the evidence already stored, by
 * {@link recomputeToken}: the row's own mint counters plus one query over `token_metadata_events`
 * for that exact kind byte. That is what makes a `rebuild` byte-identical to an uninterrupted run
 * and what makes the order in which a mint and its metadata arrive irrelevant.
 *
 * | observed mint | any applied declaration | status |
 * |---|---|---|
 * | yes | no  | `observed`  (a native kind nobody has described) |
 * | no  | yes | `declared`  (every ledger kind lives here permanently) |
 * | yes | yes | `described` (only a native kind can reach it) |
 *
 * ── Appendix A failures never reject (MIP §5.3, spec D7/FR-105) ────────────────────────────────
 * Every accepted key/value is stored verbatim in `token_metadata_kv`. A well-known key whose value
 * breaks Appendix A's rule for it is stored too, with `projection_error` set; {@link projectedFields}
 * then refuses to project that row into its `tokens` column, and the event still counts as a
 * declaration. Rejection is reserved for the transport rules of MIP §2.2/§3, which `payload.ts`
 * owns.
 */

export interface TokenKey {
  address: string;
  domainSep: string;
  /** The MIP §3 byte, 0–3 — the third component of the identity, not a label. */
  kind: number;
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
 *
 * The row it lands on is `(address, domainSep, kind)` with the mint's own native kind byte, so a
 * declaration for another kind can neither create nor relabel it (MIP §6.3).
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

  const color = Buffer.from(tokenColor(hexBuf(mint.domainSep), hexBuf(mint.address)));
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, color, status,
       mint_count, total_minted, first_mint_height, last_mint_height, first_seen_height)
    VALUES
      (${net}, ${hexBuf(mint.address)}, ${hexBuf(mint.domainSep)}, ${mint.kind}, ${color}, 'observed',
       1, ${mint.amount.toString()}, ${ctx.blockHeight}, ${ctx.blockHeight}, ${ctx.blockHeight})
    ON CONFLICT (net, address, domain_sep, kind) DO UPDATE SET
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
  /** `pad(32, "mip-xxxx:token-metadata[v1]")` as hex, for a `MiscContractEvent`. */
  nameHex: string;
  /** The 256-byte payload, hex. */
  payloadHex: string;
}

export interface AppliedEventOutcome {
  stored: boolean;
  applied: boolean;
  rejectReason: string | undefined;
  /** Non-`undefined` when the event was applied but its well-known key broke Appendix A's rule:
   *  the trait is stored, the column is not written, and the caller may surface the flag. */
  projectionError: string | undefined;
  /** The payload was LONGER than 256 bytes, so the column's own CHECK makes it unstorable
   *  (question Q31): counted and logged, never truncated or silently dropped. A payload SHORTER
   *  than 256 is not unstorable — it is zero-extended, because the VM trims trailing NULs. */
  unstorable: boolean;
}

/**
 * Stores one `mip-xxxx:token-metadata[v1]` event and, if it is applicable, folds it into the token.
 *
 * Idempotent on `(net, event_id)` — the indexer's own event id — so re-looking-up a transaction
 * after a short answer, or redelivering an event, changes nothing.
 */
export async function applyMetadataEvent(
  sql: ISql, schema: string, net: string, event: RawContractEvent,
): Promise<AppliedEventOutcome> {
  let parsed: ParsedTokenMetadata;
  try {
    parsed = parseTokenMetadata(new Uint8Array(Buffer.from(event.payloadHex, "hex")));
  } catch (error) {
    // A payload longer than 256 bytes cannot be stored at all (the column's CHECK) — question Q31.
    // It is counted and surfaced by the caller rather than crashing the scan batch.
    return {
      stored: false, applied: false, unstorable: true, projectionError: undefined,
      rejectReason: error instanceof Error ? error.message : String(error),
    };
  }

  // The PADDED 256 bytes, never the (possibly NUL-trimmed) wire form: the column's CHECK requires
  // exactly 256, and the two differ only in trailing zeros the VM removed (see payload.ts).
  const payload = Buffer.from(parsed.payload);
  const domainSep = Buffer.from(parsed.domainSep);
  const inserted = await sql`
    INSERT INTO ${sql(schema)}.token_metadata_events
      (net, event_id, address, tx_hash, block_height, payload, domain_sep, kind_byte,
       key, key_hex, key_text, val_type, val_len, value, applied, reject_reason)
    VALUES
      (${net}, ${event.eventId}, ${hexBuf(event.contractAddress)}, ${hexBuf(event.txHash)}, ${event.blockHeight},
       ${payload}, ${domainSep}, ${parsed.kindByte},
       ${Buffer.from(parsed.key)}, ${parsed.keyHex}, ${parsed.keyText ?? null},
       ${parsed.valType}, ${parsed.valLen}, ${Buffer.from(parsed.value)},
       ${parsed.applied}, ${parsed.rejectReason ?? null})
    ON CONFLICT (net, event_id) DO NOTHING
  `;
  if (inserted.count === 0) {
    // Already stored — nothing to re-fold; the fold is a pure function of the stored evidence.
    return {
      stored: false, applied: parsed.applied, rejectReason: parsed.rejectReason,
      projectionError: parsed.projectionError, unstorable: false,
    };
  }
  if (!parsed.applied) {
    return {
      stored: true, applied: false, rejectReason: parsed.rejectReason,
      projectionError: undefined, unstorable: false,
    };
  }

  const key: TokenKey = {
    address: event.contractAddress,
    domainSep: Buffer.from(parsed.domainSep).toString("hex"),
    kind: parsed.kindByte,
  };

  // Last write wins per (token, key), ordered by (block height, indexer event id) — the indexer's
  // ids are assigned in evaluation order, so two events in one transaction order correctly
  // (MIP §6.2). The key's identity is its trimmed BYTES (§5.1), so `key_hex` is what conflicts.
  await sql`
    INSERT INTO ${sql(schema)}.token_metadata_kv
      (net, address, domain_sep, kind, key_hex, key_text, val_type, val_len, value,
       projection_error, updated_event_id, updated_height)
    VALUES
      (${net}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)}, ${key.kind},
       ${parsed.keyHex}, ${parsed.keyText ?? null}, ${parsed.valType}, ${parsed.valLen},
       ${Buffer.from(parsed.valueBytes)}, ${parsed.projectionError ?? null},
       ${event.eventId}, ${event.blockHeight})
    ON CONFLICT (net, address, domain_sep, kind, key_hex) DO UPDATE SET
      key_text         = EXCLUDED.key_text,
      val_type         = EXCLUDED.val_type,
      val_len          = EXCLUDED.val_len,
      value            = EXCLUDED.value,
      projection_error = EXCLUDED.projection_error,
      updated_event_id = EXCLUDED.updated_event_id,
      updated_height   = EXCLUDED.updated_height
    WHERE (${sql(schema)}.token_metadata_kv.updated_height, ${sql(schema)}.token_metadata_kv.updated_event_id)
          < (EXCLUDED.updated_height, EXCLUDED.updated_event_id)
  `;

  // The event creates the row if no mint has — for ITS OWN kind byte and no other. A ledger kind
  // has no colour at all (MIP §3), which the schema also enforces.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, color, status, first_seen_height,
       metadata_updated_height, metadata_updated_event_id)
    VALUES
      (${net}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)}, ${key.kind},
       ${isNativeKind(key.kind) ? Buffer.from(tokenColor(parsed.domainSep, hexBuf(key.address))) : null},
       'declared', ${event.blockHeight}, ${event.blockHeight}, ${event.eventId})
    ON CONFLICT (net, address, domain_sep, kind) DO UPDATE SET
      first_seen_height         = LEAST(${sql(schema)}.tokens.first_seen_height, EXCLUDED.first_seen_height),
      metadata_updated_height   = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_height, EXCLUDED.metadata_updated_height), EXCLUDED.metadata_updated_height),
      metadata_updated_event_id = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_event_id, EXCLUDED.metadata_updated_event_id), EXCLUDED.metadata_updated_event_id)
  `;

  await recomputeToken(sql, schema, net, key);
  return {
    stored: true, applied: true, rejectReason: undefined,
    projectionError: parsed.projectionError, unstorable: false,
  };
}

/**
 * Re-derives everything about one token that is a function of its stored evidence: the projected
 * display fields, `color` and `status`. Called after every mint and every applied event, and by
 * `rebuild`.
 *
 * `privacy` and `storage` are NOT recomputed — they are generated columns of the kind byte, so
 * there is nothing to decide. Neither is the colour a matter of opinion: a native kind derives it
 * from `(domainSep, address)` and a ledger kind has none (MIP §3, §4).
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

  // The evidence: every APPLIED event for THIS kind byte, newest last. An event for another kind is
  // another token's business entirely (MIP §6.3) — that is the whole of the D4 change.
  const events = await sql<{ event_id: string; block_height: string }[]>`
    SELECT event_id::text, block_height::text
    FROM ${sql(schema)}.token_metadata_events
    WHERE net = ${net} AND address = ${address} AND domain_sep = ${domainSep}
      AND applied AND kind_byte = ${key.kind}
    ORDER BY block_height, event_id
  `;
  const hasMetadata = events.length > 0;
  const latest = events[events.length - 1];

  // MIP §7.2's three states. `builtin` is handled above and never reaches here.
  const status = hasMint ? (hasMetadata ? "described" : "observed") : (hasMetadata ? "declared" : "observed");

  const color = isNativeKind(key.kind)
    ? Buffer.from(tokenColor(new Uint8Array(domainSep), new Uint8Array(address)))
    : null;

  const projected = await projectedFields(sql, schema, net, key);

  await sql`
    UPDATE ${sql(schema)}.tokens SET
      status                    = ${status},
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

interface KvRow {
  key_hex: string;
  key_text: string | null;
  val_type: number;
  val_len: number;
  value: Buffer;
  projection_error: string | null;
  updated_event_id: string;
}

/**
 * Appendix A's keys, projected out of `token_metadata_kv` into the `tokens` columns.
 *
 * A row whose `projection_error` is set is skipped here and nowhere else: it stays a trait, fully
 * visible through the API and the page, and its column simply has no value from it (MIP §5.3, spec
 * FR-105). `projection_error` was computed once, when the event was applied, by
 * `payload.ts`'s `projectionErrorFor` — so this function never re-litigates Appendix A, it only
 * reads the verdict.
 *
 * **Recorded decision (question Q10).** A projection failure leaves the column with no value from
 * that key rather than with the key's last GOOD value. The alternative — keeping the previous
 * projectable value, which `token_metadata_events` would still allow us to find — makes the column
 * a function of the key's history rather than of its current value, and splits "what the trait says"
 * from "what the column says" in a way the page would then have to explain. Everything here stays a
 * pure function of the CURRENT stored evidence, which is what makes `rebuild` reproduce a live run
 * exactly.
 *
 * `metadata` may arrive whole (`metadata`) or split (`metadata/0 … metadata/15`, Appendix A: at
 * most 16 parts, 3 024 bytes). A split document is applied only when parts `0..max` are ALL present,
 * all type 3, and their concatenation parses as a JSON object. When both forms are present Appendix
 * A says the most recently COMPLETED one wins, which is decided here by the highest event id behind
 * each candidate.
 */
export async function projectedFields(
  sql: ISql, schema: string, net: string, key: TokenKey,
): Promise<ProjectedFields> {
  const rows = await sql<KvRow[]>`
    SELECT key_hex, key_text, val_type, val_len, value, projection_error, updated_event_id::text
    FROM ${sql(schema)}.token_metadata_kv
    WHERE net = ${net} AND address = ${hexBuf(key.address)} AND domain_sep = ${hexBuf(key.domainSep)}
      AND kind = ${key.kind}
  `;
  // Only projectable rows with a spellable key can reach a column; everything else is a trait.
  const byKey = new Map<string, KvRow>();
  for (const row of rows) {
    if (row.key_text === null || row.projection_error !== null) continue;
    byKey.set(row.key_text, row);
  }

  const text = (k: string): string | null => {
    const row = byKey.get(k);
    if (row === undefined) return null;
    return decodeUtf8(new Uint8Array(row.value.subarray(0, row.val_len))) ?? null;
  };

  const decimalsRow = byKey.get("decimals");

  // --- the split document -----------------------------------------------------------------
  let maxPart = -1;
  for (const k of byKey.keys()) {
    const index = metadataPartIndex(k);
    if (index !== undefined && index < MAX_METADATA_PARTS) maxPart = Math.max(maxPart, index);
  }
  let assembled: { document: string; eventId: bigint } | null = null;
  if (maxPart >= 0) {
    const parts: string[] = [];
    let eventId = 0n;
    let complete = true;
    for (let i = 0; i <= maxPart; i++) {
      const row = byKey.get(`metadata/${i}`);
      const piece = text(`metadata/${i}`);
      if (row === undefined || piece === null) { complete = false; break; }
      parts.push(piece);
      const id = BigInt(row.updated_event_id);
      if (id > eventId) eventId = id;
    }
    const document = parts.join("");
    // Appendix A caps the assembly at 16 parts / 3 024 bytes; the per-part rules already bound it,
    // and this is the belt that says so out loud.
    if (complete && Buffer.byteLength(document, "utf8") <= MAX_METADATA_BYTES) {
      assembled = { document, eventId };
    }
  }

  const wholeRow = byKey.get("metadata");
  const whole = wholeRow === undefined ? null
    : { document: text("metadata") ?? "", eventId: BigInt(wholeRow.updated_event_id) };

  // "A single-part `metadata` and a multi-part `metadata/<n>` for the same token SHOULD NOT both be
  // emitted; if they are, the most recently completed one wins" (Appendix A).
  const candidates = [assembled, whole].filter((c): c is { document: string; eventId: bigint } => c !== null);
  candidates.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  let metadata: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.document);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        metadata = value as Record<string, unknown>;
      }
    } catch { /* an incomplete or malformed document simply does not project */ }
  }

  return {
    name: text("name"),
    symbol: text("symbol"),
    // Appendix A's `decimals` is `val-type` 2 with `val-len == 1`, so the single byte IS the value;
    // `projection_error` has already refused anything else.
    decimals: decimalsRow === undefined ? null : decimalsRow.value[0] ?? null,
    tokenUri: text("tokenUri"),
    metadata,
  };
}

/** Exported for the API and the tests: the keys that become columns rather than traits. */
export { isWellKnownKey };
