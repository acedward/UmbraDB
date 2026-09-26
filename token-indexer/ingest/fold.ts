import { createHash } from "node:crypto";
import type { ISql } from "postgres";
import { tokenColor, tokenColorHex } from "../color.js";
import type { ObservedMint } from "./decode.js";
import {
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_PARTS,
  VAL_TYPE_NULL,
  decodeUtf8,
  integerOfValue,
  isNativeKind,
  isWellKnownKey,
  jsonNestingDepth,
  metadataPartIndex,
  nameVariantOf,
  parseTokenMetadata,
  type NameVariant,
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
 *
 * ── Project 00023: the row is keyed by its COLOUR, and a colour can exist alone ────────────────
 * A UTXO, a contract effect or a zswap delta proves that a colour exists without saying whose it
 * is, and a colour is a commitment — the `(contractAddress, domainSep)` behind it is NOT
 * recoverable from it. The physical key of `tokens` is therefore {@link tokenKeyOf}: the colour
 * itself for the two native kinds, a digest of the MIP identity for the two ledger kinds (which
 * have no colour at all). Three consequences live in this file:
 *
 *  4. {@link ensureSeenToken} is the FOURTH row source: a colour with no row gets one with status
 *     `seen`, `address`/`domainSep` NULL, named only by its own bytes (spec 00023 US5, FR-019).
 *  5. A mint or a declaration for that colour **completes the same row in place** — the key does
 *     not move, because the colour does not — and `COALESCE` is what fills the contract in without
 *     ever overwriting one that is already known.
 *  6. {@link recomputeToken} therefore works from `(tokenKey, kind)` and reads the contract off the
 *     row; a row that has none has no metadata either, and is `seen` by definition.
 */

/** The MIP §4 identity of a token: the contract that issued it, the separator it named it by, and
 *  the kind byte. Every row EXCEPT a `seen` one has it; `token_key` is what a `seen` row has
 *  instead, and what all four kinds are physically keyed by. */
export interface TokenKey {
  address: string;
  domainSep: string;
  /** The MIP §3 byte, 0–3 — the third component of the identity, not a label. */
  kind: number;
}

/** The physical identity of a `tokens` row: `(token_key, kind)` within a net. */
export interface TokenIdentity {
  /** 32 bytes as lowercase hex — see {@link tokenKeyOf}. */
  tokenKey: string;
  kind: number;
}

/** The domain separation of the ledger-kind key digest. It never leaves this schema — no consumer
 *  sees it, no route serves it — so it only has to be stable and collision-free against a colour,
 *  which a different hash function over a different input length already is. */
const LEDGER_KEY_DOMAIN = "umbra:ledger";

const hexBuf = (hex: string): Buffer => Buffer.from(hex, "hex");

/**
 * The physical key of a `tokens` row (spec 00023 FR-019; the plan's "Design decisions" table).
 *
 *  - **kinds 0 and 1 (native)**: the key IS the colour. A colour is `persistentCommit` over
 *    `(domainSep, address)`, so keying on it loses nothing that the MIP identity carried — and it
 *    gains the one thing the MIP identity cannot express: a colour whose issuer is unknown.
 *  - **kinds 2 and 3 (ledger)**: no colour exists (MIP §3 forbids deriving one), so the key is
 *    `sha256(LEDGER_KEY_DOMAIN || address || domainSep || kind)`. The kind byte is inside the
 *    digest so the two ledger kinds of one separator stay two rows.
 *
 * This is the ONLY place either is computed.
 */
export function tokenKeyOf(
  kind: number,
  source: { color: string } | { address: string; domainSep: string },
): string {
  if (isNativeKind(kind)) {
    if ("color" in source) return source.color.toLowerCase();
    return tokenColorHex(source.domainSep, source.address);
  }
  if ("color" in source) {
    throw new Error(
      `tokenKeyOf: kind ${kind} is a LEDGER kind and has no colour (MIP §3) — key it by its contract`,
    );
  }
  return createHash("sha256")
    .update(Buffer.from(LEDGER_KEY_DOMAIN, "utf8"))
    .update(hexBuf(source.address))
    .update(hexBuf(source.domainSep))
    .update(Buffer.from([kind]))
    .digest("hex");
}

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
  const tokenKey = tokenKeyOf(mint.kind, { color: color.toString("hex") });
  // `COALESCE` on the contract pair is how a `seen` row is COMPLETED IN PLACE (US5 scenario 2):
  // the colour keyed it before anyone knew who minted it, and this mint is the answer. `status` is
  // lifted off `seen` in the same statement because the schema forbids a `seen` row with a
  // contract (`tokens_seen_has_no_contract`); `recomputeToken` below then decides the real value.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, token_key, kind, address, domain_sep, color, status,
       mint_count, total_minted, first_mint_height, last_mint_height, first_seen_height)
    VALUES
      (${net}, ${hexBuf(tokenKey)}, ${mint.kind}, ${hexBuf(mint.address)}, ${hexBuf(mint.domainSep)},
       ${color}, 'observed',
       1, ${mint.amount.toString()}, ${ctx.blockHeight}, ${ctx.blockHeight}, ${ctx.blockHeight})
    ON CONFLICT (net, token_key, kind) DO UPDATE SET
      address           = COALESCE(${sql(schema)}.tokens.address, EXCLUDED.address),
      domain_sep        = COALESCE(${sql(schema)}.tokens.domain_sep, EXCLUDED.domain_sep),
      status            = CASE WHEN ${sql(schema)}.tokens.status = 'seen'
                               THEN 'observed' ELSE ${sql(schema)}.tokens.status END,
      color             = EXCLUDED.color,
      mint_count        = ${sql(schema)}.tokens.mint_count + 1,
      total_minted      = ${sql(schema)}.tokens.total_minted + EXCLUDED.total_minted,
      first_mint_height = LEAST(COALESCE(${sql(schema)}.tokens.first_mint_height, EXCLUDED.first_mint_height), EXCLUDED.first_mint_height),
      last_mint_height  = GREATEST(COALESCE(${sql(schema)}.tokens.last_mint_height, EXCLUDED.last_mint_height), EXCLUDED.last_mint_height),
      first_seen_height = LEAST(${sql(schema)}.tokens.first_seen_height, EXCLUDED.first_seen_height)
  `;
  await recomputeToken(sql, schema, net, { tokenKey, kind: mint.kind });
  return true;
}

/**
 * The FOURTH row source (spec 00023 US5, FR-019): a colour that public data proves exists, with no
 * row yet and nothing to say whose it is.
 *
 * Called by the scanner immediately before the `token_activity` row that references the colour, so
 * the colour route and the token route can never disagree (FR-008). Never downgrades: an existing
 * row — `observed`, `declared`, `described` or `builtin` — is left exactly as it is, because a
 * colour being seen again says nothing new about it.
 *
 * @returns `true` when a new `seen` row was created, which is what `/internal/status`'s
 *   `seenTokens` counter and the scan outcome count.
 */
export async function ensureSeenToken(
  sql: ISql, schema: string, net: string, color: string, kind: number, height: number,
): Promise<boolean> {
  if (!isNativeKind(kind)) {
    // Unreachable from the scanner: only a native kind has a colour at all, and only a colour can
    // be seen in public data. Stated as an error rather than a silent no-op, per the 00020 rule.
    throw new Error(`ensureSeenToken: kind ${kind} is a LEDGER kind and can never be seen as a colour`);
  }
  const inserted = await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
    VALUES
      (${net}, ${hexBuf(color)}, ${kind}, NULL, NULL, ${hexBuf(color)}, 'seen', ${height})
    ON CONFLICT (net, token_key, kind) DO NOTHING
  `;
  return inserted.count > 0;
}

/** A [Y] package's execution phase, from the archived transcripts of its APPLIED parts
 *  (`compact-multi-part-event` PR #1 §5; spec 00024 FR-002). `mixed` is a publisher error that is
 *  recorded and shown, never a reason to drop the package. */
export type PackagePhase = "guaranteed" | "fallible" | "mixed";

/**
 * One token-metadata declaration as the lookup delivers it, before parsing: a [Y] **package**
 * under the standard's name (project 00024-01), or one event under the superseded draft name
 * (which is not opted into [Y] and keeps its single-event behaviour, spec 00024 FR-006).
 *
 * A single event is the one-part case: `partEventIds` defaults to `[eventId]`.
 */
export interface RawContractEvent {
  /** The indexer's own `ContractEvent.id` — for a package, its FIRST part's id. The idempotency
   *  key for the whole pipeline, and (derivation P1) the package's position inside its
   *  transaction. */
  eventId: number;
  contractAddress: string;
  txHash: string;
  blockHeight: number;
  /** The transaction's index in its block — MIP-0018 §6.2's second ordering key. The lookup always
   *  supplies it; a direct caller that omits it (the fixture replays) places the event at 0. */
  txPosition?: number;
  /** The event's 32 padded name bytes as hex — `pad(32, "mip-0018:token-metadata[v1]")`, or the
   *  superseded draft name the deployed reference contracts still emit (owner Q27). This is what
   *  decides which validator runs: `nameVariantOf` maps it to a {@link NameVariant}. */
  nameHex: string;
  /** The payload, hex: `256 · parts` bytes for a package (the parts concatenated in ledger
   *  emission order, every byte kept); up to 256 for a draft-name event. */
  payloadHex: string;
  /** Every part's indexer event id in ledger emission order; `[eventId]` when absent. */
  partEventIds?: readonly number[];
  /** The physical intent of every part (`EventSource.physicalSegment`). REQUIRED for the
   *  standard's name — its rows are packages and carry their evidence (FR-003, FR-016b). */
  segment?: number;
  /** REQUIRED for the standard's name, like {@link segment}. */
  phase?: PackagePhase;
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
 * Stores one token-metadata event and, if it is applicable, folds it into the token.
 *
 * **The event's NAME decides which rules judge it** (MIP-0018 §8: the name is the version). The
 * name is mapped to a {@link NameVariant} here, once, and travels with every row the event
 * produces — `token_metadata_events.name_variant` and `token_metadata_kv.name_variant` — so the
 * page can mark the draft-name rows "pre-MIP name" and so the legacy path can be deleted in one
 * commit the day the reference contracts are redeployed (owner decision Q27).
 *
 * Idempotent on `(net, event_id)` — the indexer's own event id — so re-looking-up a transaction
 * after a short answer, or redelivering an event, changes nothing.
 */
export async function applyMetadataEvent(
  sql: ISql, schema: string, net: string, event: RawContractEvent,
): Promise<AppliedEventOutcome> {
  const nameVariant = nameVariantOf(event.nameHex);
  if (nameVariant === undefined) {
    // Unreachable through the scanner: `ingest/events.ts`'s `isTokenMetadataEvent` is the filter
    // that implements MIP §1's "Events of another type or name … MUST be ignored", so an event
    // reaching the fold has already been recognised. Stated as an error rather than a silent
    // default, because a default would pick a validator for bytes nobody claimed either name for.
    throw new Error(
      `applyMetadataEvent: event ${event.eventId} carries the unrecognised name ${event.nameHex} — `
      + "MIP §1 says a v1 consumer ignores it, so it must never reach the fold",
    );
  }
  const partEventIds = event.partEventIds ?? [event.eventId];
  if (partEventIds.length === 0 || partEventIds[0] !== event.eventId) {
    throw new Error(
      `applyMetadataEvent: package ${event.eventId} must list its own id as its first part ` +
      `(got [${partEventIds.join(", ")}])`,
    );
  }
  if (nameVariant === "legacy-mip-xxxx" && partEventIds.length !== 1) {
    // The draft name is not opted into [Y] (spec 00024 FR-006): nothing may group its events.
    throw new Error(`applyMetadataEvent: draft-name event ${event.eventId} cannot be a multi-part package`);
  }
  if (nameVariant === "mip-0018" && (event.segment === undefined || event.phase === undefined)) {
    // The standard's name follows [Y] (UC-1): its declarations are packages, read by the
    // multi-part reader, and a package always knows its intent and its phase.
    throw new Error(
      `applyMetadataEvent: mip-0018 declaration ${event.eventId} arrived without its package ` +
      "evidence (segment, phase) — it must come through the multi-part reader",
    );
  }
  const txPosition = event.txPosition ?? 0;

  let parsed: ParsedTokenMetadata;
  try {
    parsed = parseTokenMetadata(new Uint8Array(Buffer.from(event.payloadHex, "hex")), nameVariant);
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
      (net, event_id, part_event_ids, parts, segment, phase, address, tx_hash, block_height,
       tx_position, name_variant, payload, domain_sep, kind_byte,
       key, key_hex, key_text, val_type, val_len, value, applied, reject_reason)
    VALUES
      (${net}, ${event.eventId}, ${`{${partEventIds.join(",")}}`}::bigint[], ${partEventIds.length},
       ${event.segment ?? null}, ${event.phase ?? null},
       ${hexBuf(event.contractAddress)}, ${hexBuf(event.txHash)}, ${event.blockHeight},
       ${txPosition}, ${nameVariant}, ${payload}, ${domainSep}, ${parsed.kindByte},
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

  // Last write wins per (token, key) in MIP-0018 §6.2's canonical order: block, then transaction
  // position in the block, then ledger execution order inside the transaction — "an indexer's
  // monotonic event ID … does not define the normative order", so the id only breaks ties INSIDE
  // one transaction, where it follows ledger emission order. A [Y] package is positioned by its
  // FIRST part (derivation P1, `spec/00024-upstream-spec-changes.md`): `event.eventId` is that
  // part's id, so two packages whose parts interleave in one transaction order by where each
  // begins. The key's identity is its trimmed BYTES (§5.1), so `key_hex` is what conflicts.
  //
  // ── Null is a TOMBSTONE, not a DELETE (MIP-0018 §2.1 type 5, §6.2) ─────────────────────────
  // A `val-type` 5 event sets the current value of the exact key to Null. It lands here as an
  // ordinary last-write-wins upsert carrying `val_type = 5`, `val_len = 0` and zero value bytes —
  // and that row IS the cleared state: `projectedFields` below skips it, so the column it fed goes
  // back to NULL, while the key keeps its place in the table with the event that cleared it
  // (`updated_event_id`) beside it.
  //
  // DELETING the row instead would be wrong, and not only cosmetically: the `WHERE` clause below
  // is the only thing that stops an OLDER event arriving late — a retried short lookup, a
  // `pending_event_lookups` drain, a rebuild — from overwriting a newer value. With no row there
  // is nothing to compare against, so that older event would resurrect the value the Null
  // retired. The tombstone keeps the ordering guard, which is exactly what MIP §6.2's "last
  // accepted event is the current value" needs. History is untouched either way: every event,
  // Null included, stays in `token_metadata_events`.
  await sql`
    INSERT INTO ${sql(schema)}.token_metadata_kv
      (net, address, domain_sep, kind, key_hex, key_text, name_variant, val_type, val_len, value,
       projection_error, updated_event_id, updated_height, updated_tx_position)
    VALUES
      (${net}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)}, ${key.kind},
       ${parsed.keyHex}, ${parsed.keyText ?? null}, ${nameVariant}, ${parsed.valType}, ${parsed.valLen},
       ${Buffer.from(parsed.valueBytes)}, ${parsed.projectionError ?? null},
       ${event.eventId}, ${event.blockHeight}, ${txPosition})
    ON CONFLICT (net, address, domain_sep, kind, key_hex) DO UPDATE SET
      key_text         = EXCLUDED.key_text,
      name_variant     = EXCLUDED.name_variant,
      val_type         = EXCLUDED.val_type,
      val_len          = EXCLUDED.val_len,
      value            = EXCLUDED.value,
      projection_error = EXCLUDED.projection_error,
      updated_event_id = EXCLUDED.updated_event_id,
      updated_height   = EXCLUDED.updated_height,
      updated_tx_position = EXCLUDED.updated_tx_position
    WHERE (${sql(schema)}.token_metadata_kv.updated_height,
           ${sql(schema)}.token_metadata_kv.updated_tx_position,
           ${sql(schema)}.token_metadata_kv.updated_event_id)
          < (EXCLUDED.updated_height, EXCLUDED.updated_tx_position, EXCLUDED.updated_event_id)
  `;

  // The event creates the row if no mint has — for ITS OWN kind byte and no other. A ledger kind
  // has no colour at all (MIP §3), which the schema also enforces; a native kind's colour IS its
  // physical key, so a declaration about a colour already `seen` completes that very row (US5).
  const color = isNativeKind(key.kind)
    ? Buffer.from(tokenColor(parsed.domainSep, hexBuf(key.address)))
    : null;
  const tokenKey = color === null
    ? tokenKeyOf(key.kind, { address: key.address, domainSep: key.domainSep })
    : tokenKeyOf(key.kind, { color: color.toString("hex") });
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, token_key, kind, address, domain_sep, color, status, first_seen_height,
       metadata_updated_height, metadata_updated_event_id)
    VALUES
      (${net}, ${hexBuf(tokenKey)}, ${key.kind}, ${hexBuf(key.address)}, ${hexBuf(key.domainSep)},
       ${color}, 'declared', ${event.blockHeight}, ${event.blockHeight}, ${event.eventId})
    ON CONFLICT (net, token_key, kind) DO UPDATE SET
      address                   = COALESCE(${sql(schema)}.tokens.address, EXCLUDED.address),
      domain_sep                = COALESCE(${sql(schema)}.tokens.domain_sep, EXCLUDED.domain_sep),
      status                    = CASE WHEN ${sql(schema)}.tokens.status = 'seen'
                                       THEN 'observed' ELSE ${sql(schema)}.tokens.status END,
      first_seen_height         = LEAST(${sql(schema)}.tokens.first_seen_height, EXCLUDED.first_seen_height),
      metadata_updated_height   = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_height, EXCLUDED.metadata_updated_height), EXCLUDED.metadata_updated_height),
      metadata_updated_event_id = GREATEST(COALESCE(${sql(schema)}.tokens.metadata_updated_event_id, EXCLUDED.metadata_updated_event_id), EXCLUDED.metadata_updated_event_id)
  `;

  await recomputeToken(sql, schema, net, { tokenKey, kind: key.kind });
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
 * there is nothing to decide. Neither is the colour a matter of opinion: for a native kind it IS
 * the row's physical key, and a ledger kind has none (MIP §3, §4).
 *
 * ── The status rule, extended by project 00023 (US5) ───────────────────────────────────────────
 * |  mint | metadata | contract known | status      |
 * |-------|----------|----------------|-------------|
 * |  yes  |   no     |      yes       | `observed`  |
 * |  yes  |   yes    |      yes       | `described` |
 * |  no   |   yes    |      yes       | `declared`  |
 * |  no   |   no     |      **no**    | `seen`      |
 *
 * The last row is the new one, and it is the ONLY way a row can have no contract: a mint and a
 * metadata event both carry one, so "no evidence but the colour itself" is exactly what `seen`
 * means. "No mint, no metadata, contract known" is unreachable — nothing else writes a contract —
 * and falls back to `observed` rather than inventing a fifth state.
 *
 * Never touches a `builtin` row — NIGHT and DUST have no contract and no evidence, and their
 * `token_key`s are the ledger's own facts, which no derivation can collide with.
 */
export async function recomputeToken(
  sql: ISql, schema: string, net: string, identity: TokenIdentity,
): Promise<void> {
  const tokenKey = hexBuf(identity.tokenKey);

  const rows = await sql<{
    mint_count: string; status: string; address: Buffer | null; domain_sep: Buffer | null;
  }[]>`
    SELECT mint_count::text, status, address, domain_sep FROM ${sql(schema)}.tokens
    WHERE net = ${net} AND token_key = ${tokenKey} AND kind = ${identity.kind}
  `;
  const row = rows[0];
  if (row === undefined || row.status === "builtin") return;
  const hasMint = BigInt(row.mint_count) > 0n;

  // A row with no contract behind it can have no metadata event either: an event is emitted BY a
  // contract, about its own `(domainSep, kind)`. So the two queries below are skipped entirely for
  // a `seen` row rather than run with NULL parameters that could never match.
  const key: TokenKey | undefined = row.address === null || row.domain_sep === null
    ? undefined
    : { address: row.address.toString("hex"), domainSep: row.domain_sep.toString("hex"), kind: identity.kind };

  // The evidence: every APPLIED declaration for THIS kind byte, newest last in MIP §6.2's order
  // (block, transaction position, first part — P1). An event for another kind is another token's
  // business entirely (MIP §6.3) — that is the whole of the D4 change.
  const events = key === undefined ? [] : await sql<{ event_id: string; block_height: string }[]>`
    SELECT event_id::text, block_height::text
    FROM ${sql(schema)}.token_metadata_events
    WHERE net = ${net} AND address = ${hexBuf(key.address)} AND domain_sep = ${hexBuf(key.domainSep)}
      AND applied AND kind_byte = ${identity.kind}
    ORDER BY block_height, tx_position, event_id
  `;
  const hasMetadata = events.length > 0;
  const latest = events[events.length - 1];

  const status = hasMint
    ? (hasMetadata ? "described" : "observed")
    : (hasMetadata ? "declared" : (key === undefined ? "seen" : "observed"));

  // For a native kind the key IS the colour (`tokens_color_is_key`); a ledger kind has none.
  const color = isNativeKind(identity.kind) ? tokenKey : null;

  const projected = key === undefined
    ? { name: null, symbol: null, decimals: null, tokenUri: null, metadata: null }
    : await projectedFields(sql, schema, net, key);

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
    WHERE net = ${net} AND token_key = ${tokenKey} AND kind = ${identity.kind}
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
  /** Which event name set this key — it decides how a `val-type` 2 byte string reads and whether
   *  `metadata/<n>` means anything at all. */
  name_variant: NameVariant;
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
 * ── Null clears a column (MIP-0018 §2.1 type 5, §6.2) ─────────────────────────────────────────
 * A kv row whose `val_type` is 5 is the tombstone written by a Null event (see
 * {@link applyMetadataEvent}). It is skipped here exactly as a `projection_error` row is, so the
 * column it fed goes back to NULL on the very next recompute — which is what "clears the key"
 * means for a consumer that projects. The trait row itself stays visible, with the clearing event
 * beside it.
 *
 * ── Multipart `metadata/<n>` is a DRAFT-NAME convention only (owner Q27) ───────────────────────
 * MIP-0018 §5.4 is explicit: "This MIP defines no multipart representation or reassembly rule." So
 * under the final name `metadata` is one complete JSON value or nothing, and `metadata/3` is an
 * ordinary trait. The assembly below therefore considers **only rows whose `name_variant` is the
 * draft**, so the already-deployed reference contracts keep displaying their split documents while
 * no MIP-0018 event can ever be assembled into one. The draft's rule was: parts `0..max` ALL
 * present, all type 3, at most 16 parts / 3 024 bytes, their concatenation parsing as a JSON
 * object; and when both forms exist the most recently COMPLETED one wins, decided here by the
 * highest event id behind each candidate.
 */
export async function projectedFields(
  sql: ISql, schema: string, net: string, key: TokenKey,
): Promise<ProjectedFields> {
  const rows = await sql<KvRow[]>`
    SELECT key_hex, key_text, name_variant, val_type, val_len, value, projection_error,
           updated_event_id::text
    FROM ${sql(schema)}.token_metadata_kv
    WHERE net = ${net} AND address = ${hexBuf(key.address)} AND domain_sep = ${hexBuf(key.domainSep)}
      AND kind = ${key.kind}
  `;
  // Only projectable rows with a spellable key can reach a column; everything else is a trait —
  // and a Null tombstone (val_type 5) is deliberately in "everything else", which is how a cleared
  // key empties its column.
  const byKey = new Map<string, KvRow>();
  for (const row of rows) {
    if (row.key_text === null || row.projection_error !== null) continue;
    if (row.val_type === VAL_TYPE_NULL) continue;
    byKey.set(row.key_text, row);
  }

  const text = (k: string): string | null => {
    const row = byKey.get(k);
    if (row === undefined) return null;
    return decodeUtf8(new Uint8Array(row.value.subarray(0, row.val_len))) ?? null;
  };

  const decimalsRow = byKey.get("decimals");

  // --- metadata: the single declaration or the draft's split document (chooseMetadata) ---------
  const { metadata } = chooseMetadata(rows);

  return {
    name: text("name"),
    symbol: text("symbol"),
    // `decimals` is `val-type` 2, and the bytes read differently under the two names: MIP-0018's
    // Compact `Uint<8·N>` is little-endian at any width from 1 to 31 bytes, the draft's was
    // big-endian at one byte. `integerOfValue` is the one place that knows; `projection_error` has
    // already refused any row whose number is out of the column's 0–36 range, so `Number` is safe.
    decimals: decimalsRow === undefined
      ? null
      : Number(integerOfValue(
        new Uint8Array(decimalsRow.value.subarray(0, decimalsRow.val_len)), decimalsRow.name_variant,
      )),
    tokenUri: text("tokenUri"),
    metadata,
  };
}

/** The fields of a `token_metadata_kv` row {@link chooseMetadata} reads. */
export interface MetadataKvRow {
  key_text: string | null;
  name_variant: NameVariant;
  val_type: number;
  val_len: number;
  value: Buffer;
  projection_error: string | null;
  updated_event_id: string;
}

/** Which declaration(s) the projected `metadata` column comes from — and the column itself. */
export interface MetadataChoice {
  metadata: Record<string, unknown> | null;
  /** `whole`: the key `metadata`; `assembly`: the draft name's `metadata/0..n`; `null`: nothing
   *  projects. */
  source: "whole" | "assembly" | null;
  /** The kv keys behind the winning candidate, in part order (`["metadata"]` for a whole one). */
  keys: string[];
}

/**
 * The `metadata` projection as ONE pure function of a token's kv rows, so the fold that writes the
 * column and the API that says where it came from cannot disagree (01-D audit F5: the API used to
 * pick the newest `metadata/<n>` part as evidence even when that assembly was incomplete and the
 * column still held the whole document).
 *
 * The two candidates are the whole `metadata` declaration and, under the superseded draft name only,
 * the assembly of `metadata/0..max`: every part present, projectable, type 3, at most 16 parts /
 * 3 024 bytes (Appendix A). Of the candidates whose document parses as a JSON object — and is not
 * nested deeper than {@link MAX_METADATA_DEPTH} (audit F2) — the most recently completed (highest
 * event id behind it) wins.
 */
export function chooseMetadata(rows: readonly MetadataKvRow[]): MetadataChoice {
  // Only projectable rows with a spellable key can reach a column; a Null tombstone does not.
  const byKey = new Map<string, MetadataKvRow>();
  for (const row of rows) {
    if (row.key_text === null || row.projection_error !== null) continue;
    if (row.val_type === VAL_TYPE_NULL) continue;
    byKey.set(row.key_text, row);
  }
  const text = (k: string): string | null => {
    const row = byKey.get(k);
    if (row === undefined) return null;
    return decodeUtf8(new Uint8Array(row.value.subarray(0, row.val_len))) ?? null;
  };

  // `max` is taken over EVERY part that exists, projectable or not: a part carried with the wrong
  // `val-type` is still a part the contract emitted, and the MIP's rule is that the assembly waits
  // for it rather than quietly publishing the document without it (spec §2 edge cases, MIP §5.3).
  let maxPart = -1;
  for (const row of rows) {
    if (row.key_text === null) continue;
    // Draft-name rows only: under MIP-0018 this key is a trait and assembling it would invent a
    // document the standard does not define (§5.4).
    if (row.name_variant !== "legacy-mip-xxxx") continue;
    const index = metadataPartIndex(row.key_text);
    if (index !== undefined && index < MAX_METADATA_PARTS) maxPart = Math.max(maxPart, index);
  }

  interface Candidate { document: string; eventId: bigint; source: "whole" | "assembly"; keys: string[] }
  let assembled: Candidate | null = null;
  if (maxPart >= 0) {
    const parts: string[] = [];
    const keys: string[] = [];
    let eventId = 0n;
    let complete = true;
    for (let i = 0; i <= maxPart; i++) {
      const row = byKey.get(`metadata/${i}`);
      const piece = text(`metadata/${i}`);
      // A part emitted under the FINAL name is not a part (§5.4): it neither completes an assembly
      // nor blocks one — the draft-name document simply waits for a draft-name part, as it would
      // for a missing one.
      if (row !== undefined && row.name_variant !== "legacy-mip-xxxx") { complete = false; break; }
      if (row === undefined || piece === null) { complete = false; break; }
      parts.push(piece);
      keys.push(`metadata/${i}`);
      const id = BigInt(row.updated_event_id);
      if (id > eventId) eventId = id;
    }
    const document = parts.join("");
    // Appendix A caps the assembly at 16 parts / 3 024 bytes; the per-part rules already bound it,
    // and this is the belt that says so out loud.
    if (complete && Buffer.byteLength(document, "utf8") <= MAX_METADATA_BYTES) {
      assembled = { document, eventId, source: "assembly", keys };
    }
  }

  const wholeRow = byKey.get("metadata");
  const whole: Candidate | null = wholeRow === undefined ? null
    : { document: text("metadata") ?? "", eventId: BigInt(wholeRow.updated_event_id), source: "whole", keys: ["metadata"] };

  // "A single-part `metadata` and a multi-part `metadata/<n>` for the same token SHOULD NOT both be
  // emitted; if they are, the most recently completed one wins" (Appendix A).
  const candidates = [assembled, whole].filter((c): c is Candidate => c !== null);
  candidates.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  let choice: MetadataChoice = { metadata: null, source: null, keys: [] };
  for (const candidate of candidates) {
    // Belt and braces for 01-D audit F2: a document too deep to be written back never projects
    // (the whole-`metadata` row already carries `metadata_too_deep`; this covers an assembly too).
    if (jsonNestingDepth(candidate.document) > MAX_METADATA_DEPTH) continue;
    try {
      const value: unknown = JSON.parse(candidate.document);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        choice = { metadata: value as Record<string, unknown>, source: candidate.source, keys: candidate.keys };
      }
    } catch { /* an incomplete or malformed document simply does not project */ }
  }
  return choice;
}

/** Exported for the API and the tests: the keys that become columns rather than traits. */
export { isWellKnownKey };
