import type { ISql } from "postgres";

/**
 * Project 00023 Phase F — the `token_index` schema on **MIP-0018 (final)**, with the superseded
 * `mip-xxxx` draft name kept beside it.
 *
 * Normative text: `mips/mip-0018-on-chain-token-metadata.md` of
 * https://github.com/midnightntwrk/midnight-improvement-proposals/pull/325 @ `37a3471`.
 * `002_mip_xxxx_layout.ts` built this shape against the PR #315 draft of the same document; four of
 * its transport rules changed on the way to the final text, and `token-indexer/ingest/payload.ts`
 * now implements both sets. This migration is the part of that change the schema has to carry.
 *
 * ── What changes ───────────────────────────────────────────────────────────────────────────────
 *  1. **`name_variant` on `token_metadata_events` and on `token_metadata_kv`** — `'mip-0018'` or
 *     `'legacy-mip-xxxx'`. The event NAME is the version (MIP §8), so it is the one fact that says
 *     which rules an event was judged under; storing it is what lets the page mark a draft-name
 *     row "pre-MIP name", what lets a trait say which name set it, and what lets the whole legacy
 *     code path be deleted in one commit the day the reference contracts are redeployed.
 *  2. **`token_metadata_kv.val_type` may now be 5** (was `<= 4`): MIP-0018 §2.1 adds Null.
 *  3. **Two CHECKs that state the Null rules in the schema itself** —
 *     `kv_null_is_empty` (`val-len` MUST be zero and no value bytes may be kept) and
 *     `kv_null_is_mip_0018` (Null does not exist under the draft name, where 5 is reserved and the
 *     event is rejected outright, so no kv row can ever be written for it).
 *
 * `token_metadata_events.val_type` keeps its full `0..255` range: a REJECTED event is stored with
 * the raw byte it carried, because that byte is what its `reject_reason` is about. Only the kv
 * table — which holds applied values only — is constrained.
 *
 * ── Why this drops and recreates, and why the index has to be rebuilt ──────────────────────────
 * Standing owner decision Q3 for this project: **the index is reindexed from scratch, so breaking
 * changes to `token_index` are allowed** — everything in this schema is a pure derivation of
 * `chain_archive` plus the two seeded rows. Adding two columns could have been an `ALTER`, but the
 * value of `name_variant` on an existing row cannot be derived from anything stored: the events
 * table keeps the payload, not the event's name. Backfilling it with `'legacy-mip-xxxx'` would be a
 * guess that happens to be right for today's database and silently wrong for any other, so the two
 * metadata tables are recreated empty and the evidence is re-read from the chain.
 *
 * Every row that is DERIVED from that evidence goes with it. `tokens` is the one that matters:
 * its `status`, `name`, `symbol`, `decimals`, `token_uri` and `metadata` are recomputed from
 * `token_metadata_kv`, so leaving those rows behind would leave a token claiming to be
 * `described` with no event in the database supporting it. `token_mints`, `token_activity`,
 * `shielded_offers` and `contract_calls` are deleted too because `tokens` rows are what they hang
 * off, and `cursors` is emptied so the scanner really does re-read the range rather than resuming
 * past it. The rows are deleted for **every net**: a migration is not net-scoped, and a shape
 * change cannot be true for one net and false for another in the same schema.
 *
 * **A deployer therefore runs exactly two commands, in this order** (as after 003):
 *
 * ```
 * npm run token-indexer -- migrate     # applies this migration; the index is now EMPTY
 * npm run token-indexer -- rebuild     # re-seeds the built-ins and re-scans from block zero
 * ```
 *
 * `migrate` alone is already safe — `token-indexer/bootstrap.ts` re-seeds NIGHT and DUST
 * immediately after the lineage runs, and the scanner refills the rest from the cursor this
 * migration deletes. `rebuild` is what states that intent out loud.
 *
 * ── Deliberately NOT a data migration of the Stagenet rows ─────────────────────────────────────
 * The reference contracts on Stagenet are NOT being redeployed (owner decision Q28), so every
 * metadata event already on chain carries the draft name and will be re-read as
 * `'legacy-mip-xxxx'` — the same 17 token rows, folded under the same draft rules, with the
 * variant now recorded. Nothing about that set changes except that the page can now say which
 * name it came from.
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; byte lengths are `CHECK (octet_length(...) = 32)`,
 * following 001/002/003 next door.
 */
export const name = "004_mip_0018";

/** The two values `name_variant` may take, spelled here and in `token-indexer/ingest/payload.ts`'s
 *  `NameVariant` and nowhere else. */
export const NAME_VARIANTS = ["mip-0018", "legacy-mip-xxxx"] as const;

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- out with the 002/003 metadata shapes --------------------------------------------------
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_kv`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_events`;

  // Every row derived from the evidence those two tables held. The TABLES stay — only 003's shapes
  // are still correct for them — but their rows are now unsupported by anything stored.
  await sql`DELETE FROM ${sql(schema)}.token_activity`;
  await sql`DELETE FROM ${sql(schema)}.shielded_offers`;
  await sql`DELETE FROM ${sql(schema)}.contract_calls`;
  await sql`DELETE FROM ${sql(schema)}.token_mints`;
  await sql`DELETE FROM ${sql(schema)}.tokens`;
  await sql`DELETE FROM ${sql(schema)}.contracts`;
  await sql`DELETE FROM ${sql(schema)}.pending_event_lookups`;
  await sql`DELETE FROM ${sql(schema)}.cursors`;

  // ---- token_metadata_events (003's shape plus `name_variant`) -------------------------------
  // One row per recognised event, APPLIED OR NOT: a contract's malformed claim is evidence about
  // that contract (MIP §7.1 asks a consumer to keep rejection reasons available for diagnostics),
  // and the page shows it. An event under neither name is not here at all — MIP §1 says a v1
  // consumer ignores it, which is not the same as rejecting it.
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_events (
      net           text     NOT NULL,
      event_id      bigint   NOT NULL,
      address       bytea    NOT NULL CHECK (octet_length(address) = 32),
      tx_hash       bytea    NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height  bigint   NOT NULL CHECK (block_height >= 0),
      -- WHICH NAME the event carried, and therefore which validator judged it (MIP §8: the event
      -- name is the version). 'legacy-mip-xxxx' exists for the already-deployed reference
      -- contracts only — see token-indexer/ingest/payload.ts and owner decision Q27.
      name_variant  text     NOT NULL CHECK (name_variant IN ('mip-0018','legacy-mip-xxxx')),
      payload       bytea    NOT NULL CHECK (octet_length(payload) = 256),
      domain_sep    bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      -- The RAW byte, 0..255: a rejected event keeps the kind it claimed, which is what its
      -- reject_reason is about.
      kind_byte     smallint NOT NULL CHECK (kind_byte >= 0 AND kind_byte <= 255),
      key           bytea    NOT NULL CHECK (octet_length(key) = 32),
      key_hex       text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])*$'),
      key_text      text,
      -- Also the raw byte: 6..255 are reserved under MIP-0018 (5..255 under the draft) and reject,
      -- and the stored row is how a reader sees which reserved value was used.
      val_type      smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 255),
      val_len       smallint NOT NULL CHECK (val_len >= 0 AND val_len <= 255),
      value         bytea    NOT NULL,
      applied       boolean  NOT NULL,
      reject_reason text,
      PRIMARY KEY (net, event_id)
    )
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_token
      ON ${sql(schema)}.token_metadata_events (net, address, domain_sep, kind_byte, block_height, event_id)
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_contract
      ON ${sql(schema)}.token_metadata_events (net, address, event_id)
  `;

  // ---- token_metadata_kv (003's shape plus `name_variant`, plus Null) ------------------------
  // The CURRENT value of every key of every token: last write wins per
  // `(net, address, domain_sep, kind, key_hex)` (MIP §6.2), keyed by the key's trimmed BYTES
  // because §5.1 makes bytes the identity and forbids rejecting a key for not being UTF-8.
  //
  // A row with `val_type = 5` is a Null TOMBSTONE: the key's current value is Null (MIP §2.1,
  // §6.2), the column it projected into is empty again, and the row stays so that the
  // last-write-wins comparison still has something to compare a late-arriving older event
  // against. History lives in `token_metadata_events`, which a Null never touches.
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_kv (
      net              text     NOT NULL,
      address          bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      key_hex          text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])+$'),
      key_text         text,
      name_variant     text     NOT NULL CHECK (name_variant IN ('mip-0018','legacy-mip-xxxx')),
      -- 0 opaque, 1 string, 2 integer, 3 JSON, 4 URI, 5 Null (MIP-0018 §2.1). Only APPLIED values
      -- reach this table, so unlike the events table the range is the closed enum.
      val_type         smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 5),
      val_len          smallint NOT NULL CHECK (val_len >= 0 AND val_len <= 189),
      value            bytea    NOT NULL CHECK (octet_length(value) <= 189),
      -- MIP-0018 §2.1 type 5: "val-len MUST be zero; consumers MUST ignore all 189 value bytes".
      -- A tombstone that kept bytes would be a value pretending to be absent.
      CONSTRAINT kv_null_is_empty CHECK (val_type <> 5 OR (val_len = 0 AND octet_length(value) = 0)),
      -- Null is a MIP-0018 type. Under the draft name 5 is reserved, so such an event is rejected
      -- and never produces a kv row at all — stated here so the two validators cannot drift.
      CONSTRAINT kv_null_is_mip_0018 CHECK (val_type <> 5 OR name_variant = 'mip-0018'),
      projection_error text,
      updated_event_id bigint   NOT NULL,
      updated_height   bigint   NOT NULL CHECK (updated_height >= 0),
      PRIMARY KEY (net, address, domain_sep, kind, key_hex)
    )
  `;
  await sql`
    CREATE INDEX token_metadata_kv_by_key_text
      ON ${sql(schema)}.token_metadata_kv (net, key_text)
  `;
}
