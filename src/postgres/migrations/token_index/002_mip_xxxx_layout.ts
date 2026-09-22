import type { ISql } from "postgres";

/**
 * Project 00021 — the `token_index` schema aligned with MIP PR #315
 * (`mip-xxxx:token-metadata[v1]`). Spec: `/home/eddie/todo/Umbra/spec/00021-mip-315-alignment.md`
 * FR-103/FR-104/FR-107, and through it MIP §2, §3, §4, §5 and §7.2.
 *
 * ── Why this drops and recreates instead of ALTERing ───────────────────────────────────────────
 * Every table this migration touches is a pure DERIVATION of `chain_archive` plus the two seeded
 * rows: the scanner rebuilds all of it from the archive in minutes (spec Q3). The change is to the
 * PRIMARY KEY of `tokens` and of `token_metadata_kv` — the identity of a token becomes the full
 * `kind` byte (MIP §4), and the identity of a key becomes its trimmed BYTES (MIP §5.1) — which an
 * in-place `ALTER` could only express as a drop-and-add of the constraint plus a rewrite of every
 * row's key column anyway. Recreating states the new shape in one readable place; migrating the
 * old rows would state it twice and produce nothing that a rebuild does not.
 *
 * `contracts`, `cursors` and `pending_event_lookups` keep their shape and are simply EMPTIED: they
 * are derivations too, and leaving the decode cursor behind while the rows it produced are gone
 * would silently freeze the index at the old tip. After this migration the schema is empty except
 * for the seeds, and the next `serve`/`rebuild` refills it from block zero of the archive.
 *
 * ── What changed against 001 (spec D2–D8) ──────────────────────────────────────────────────────
 *  - `tokens.kind` is the MIP's byte, `smallint CHECK (kind BETWEEN 0 AND 3)`, and it is part of
 *    the primary key. `privacy` and `storage` are GENERATED columns derived from it, so the two
 *    can never disagree with the identity and no code path can write a third opinion.
 *  - `tokens.status` loses `inconsistent` (MIP §7.2 has three consumer states; `builtin` is this
 *    repository's fourth for the two seeded rows). A declaration and a mint now populate different
 *    rows, so there is nothing left to contradict — see `token-indexer/ingest/fold.ts`.
 *  - `tokens.color` is `NULL` for the ledger kinds by CHECK, not by convention: MIP §3 says a
 *    consumer MUST NOT derive or display a colour for kind 2 or 3.
 *  - `token_metadata_kv` is keyed by `key_hex`, the trimmed key bytes as hex, because MIP §5.1
 *    makes bytes the identity and explicitly forbids rejecting a key for not being UTF-8.
 *    `key_text` is the nullable convenience spelling.
 *  - `token_metadata_kv` and `token_metadata_events` carry `val_type` and `val_len` (MIP §2), and
 *    the kv row carries `projection_error` (MIP §5.3): the trait is stored either way and the
 *    projection into a `tokens` column is what fails.
 *  - `token_mints.kind` is the same byte, restricted to the two NATIVE kinds — a mint effect can
 *    only ever be kind 0 or 1 (MIP §6.3).
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; byte lengths are `CHECK (octet_length(...) = 32)`,
 * following `010_logs.ts` and 001 next door.
 */
export const name = "002_mip_xxxx_layout";

/** `pad(32, s)` — the Compact standard library's padding: UTF-8 bytes, NUL-filled to 32. */
function pad32Hex(s: string): string {
  const b = Buffer.alloc(32);
  b.write(s, 0, "utf8");
  return b.toString("hex");
}

const ZERO32 = "0".repeat(64);

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- out with the 00020 shapes -------------------------------------------------------------
  // Order is irrelevant (no foreign keys anywhere in this schema) but reads top-down.
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_kv`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_events`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_mints`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.tokens`;

  // Everything left in this schema is derived from the archive as well, so it goes too: keeping a
  // decode cursor that points past rows that no longer exist is the one way to make this migration
  // silently lose tokens.
  await sql`DELETE FROM ${sql(schema)}.cursors`;
  await sql`DELETE FROM ${sql(schema)}.pending_event_lookups`;
  await sql`DELETE FROM ${sql(schema)}.contracts`;

  // ---- tokens --------------------------------------------------------------------------------
  // One row per `(net, contractAddress, domainSep, kind)` — MIP §4's identity triple, plus the net.
  // Each of the four kinds is a distinct token even under one domain separator: the same colour can
  // appear twice (kinds 0 and 1 share it, the ledger keeps them apart by TAG), and a MIP-0004 asset
  // can be a balance book (kind 2) and UTXOs (kind 0/1) at once. A consumer MAY link the rows that
  // share `(address, domain_sep)`; the API does, through `GET /v1/contracts/:a/tokens/:domainSep`.
  await sql`
    CREATE TABLE ${sql(schema)}.tokens (
      net                       text     NOT NULL,
      address                   bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep                bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind                      smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      -- Derived, never written: bit 0 is the privacy tag and bit 1 is where the value lives
      -- (MIP §3). GENERATED means the identity byte and these two labels cannot drift apart.
      privacy                   text     NOT NULL GENERATED ALWAYS AS
                                  (CASE WHEN (kind % 2) = 1 THEN 'shielded' ELSE 'unshielded' END) STORED,
      storage                   text     NOT NULL GENERATED ALWAYS AS
                                  (CASE WHEN kind >= 2 THEN 'ledger' ELSE 'native' END) STORED,
      -- NULL for the ledger kinds (MIP §3: a consumer MUST NOT derive or display a colour for them)
      -- and for the built-in DUST row (the ledger's DUST token type carries no bytes at all — Q30).
      color                     bytea    CHECK (color IS NULL OR octet_length(color) = 32),
      CONSTRAINT tokens_ledger_has_no_color CHECK (kind < 2 OR color IS NULL),
      name                      text,
      symbol                    text,
      decimals                  smallint CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 36)),
      token_uri                 text,
      metadata                  jsonb,
      -- MIP §7.2's three consumer states, plus 'builtin' for the two seeded rows. 'inconsistent'
      -- is gone: with the full kind byte in the identity a declaration and a mint describe
      -- different rows and there is nothing to contradict (MIP §6.3, spec D4).
      status                    text     NOT NULL
        CHECK (status IN ('observed','declared','described','builtin')),
      mint_count                bigint        NOT NULL DEFAULT 0 CHECK (mint_count >= 0),
      -- Sums u64 amounts; numeric(39,0) cannot overflow even if every mint that could ever exist
      -- were summed into one row.
      total_minted              numeric(39,0) NOT NULL DEFAULT 0 CHECK (total_minted >= 0),
      first_mint_height         bigint CHECK (first_mint_height IS NULL OR first_mint_height >= 0),
      last_mint_height          bigint CHECK (last_mint_height IS NULL OR last_mint_height >= 0),
      first_seen_height         bigint NOT NULL CHECK (first_seen_height >= 0),
      metadata_updated_height   bigint CHECK (metadata_updated_height IS NULL OR metadata_updated_height >= 0),
      metadata_updated_event_id bigint,
      PRIMARY KEY (net, address, domain_sep, kind)
    )
  `;
  await sql`CREATE INDEX tokens_by_color ON ${sql(schema)}.tokens (net, color)`;
  await sql`CREATE INDEX tokens_by_symbol ON ${sql(schema)}.tokens (net, lower(symbol))`;
  await sql`CREATE INDEX tokens_by_name ON ${sql(schema)}.tokens (net, lower(name))`;
  // The MIP's "MAY link rows sharing (contractAddress, domainSep)" (§4) is a lookup this index
  // serves directly; the primary key's leading columns would serve it too, but naming it here is
  // what says the linking route is a supported read and not an accident of the key order.
  await sql`CREATE INDEX tokens_by_contract_domain ON ${sql(schema)}.tokens (net, address, domain_sep)`;

  // ---- token_mints ---------------------------------------------------------------------------
  // One row per entry of one transcript's mint map. `kind` is the MIP byte, and only the two NATIVE
  // values can ever appear: a mint effect is by definition a protocol-level mint (MIP §6.3).
  await sql`
    CREATE TABLE ${sql(schema)}.token_mints (
      net          text          NOT NULL,
      tx_hash      bytea         NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height bigint        NOT NULL CHECK (block_height >= 0),
      tx_position  int           NOT NULL CHECK (tx_position >= 0),
      segment      int           NOT NULL CHECK (segment >= 0),
      call_index   int           NOT NULL CHECK (call_index >= 0),
      entry_point  text,
      address      bytea         NOT NULL CHECK (octet_length(address) = 32),
      domain_sep   bytea         NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind         smallint      NOT NULL CHECK (kind IN (0, 1)),
      amount       numeric(20,0) NOT NULL CHECK (amount >= 0),
      PRIMARY KEY (net, tx_hash, segment, call_index, kind, domain_sep)
    )
  `;
  await sql`
    CREATE INDEX token_mints_by_token
      ON ${sql(schema)}.token_mints (net, address, domain_sep, kind, block_height)
  `;

  // ---- token_metadata_events -----------------------------------------------------------------
  // Every event of THIS MIP's name the lookup fetched, applied or rejected, keyed by the indexer's
  // own event id — which is what makes a re-lookup of the same transaction idempotent. An event of
  // any other name never reaches this table at all (MIP §1: it MUST be ignored), so the pre-MIP
  // `TokenMetadata` events of 00020 leave no trace here.
  //
  // `kind_byte`, `val_type` and `val_len` are stored RAW, with the full 0..255 range allowed: a
  // rejected event's whole point is that one of them is out of range, and clamping it would erase
  // the evidence the `reject_reason` refers to.
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_events (
      net           text     NOT NULL,
      event_id      bigint   NOT NULL,
      address       bytea    NOT NULL CHECK (octet_length(address) = 32),
      tx_hash       bytea    NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height  bigint   NOT NULL CHECK (block_height >= 0),
      payload       bytea    NOT NULL CHECK (octet_length(payload) = 256),
      domain_sep    bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind_byte     smallint NOT NULL CHECK (kind_byte >= 0 AND kind_byte <= 255),
      key           bytea    NOT NULL CHECK (octet_length(key) = 32),
      -- The trimmed key bytes as lowercase hex: the identity a kv row is keyed by (MIP §5.1).
      -- Empty is possible here and only here — an all-NUL key is what key_empty rejects.
      key_hex       text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])*$'),
      key_text      text,
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

  // ---- token_metadata_kv ---------------------------------------------------------------------
  // The CURRENT value of one key for one token (EIP-7496's `getTraitValue`, MIP §5.2), last write
  // wins in chain order. History lives in `token_metadata_events`; this is the projection.
  //
  // Keyed by `key_hex`, never by `key_text`: MIP §5.1 compares trimmed BYTES and forbids rejecting
  // a key for not being valid UTF-8, so a key that has no text still has a row, and two keys that
  // differ only outside UTF-8 stay two keys.
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_kv (
      net              text     NOT NULL,
      address          bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      key_hex          text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])+$'),
      -- NULL when the key's bytes are not a NUL-free valid UTF-8 string; the page shows the hex.
      key_text         text,
      val_type         smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 4),
      val_len          smallint NOT NULL CHECK (val_len >= 0 AND val_len <= 189),
      value            bytea    NOT NULL CHECK (octet_length(value) <= 189),
      -- Non-NULL when this is an Appendix A key whose value broke Appendix A's rule for it: the
      -- trait is kept and the projection into a tokens column is what was refused (MIP §5.3).
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

/**
 * The two built-in rows (owner decision Q7 of 00020), on the 002 shape.
 *
 * Not part of `up()` because they are **per-net** data, not schema: one migration run serves every
 * `net` the same database might hold, and the net a process works on only becomes known when it is
 * configured. `token-indexer/bootstrap.ts` calls this right after `runMigrations`, and `rebuild`
 * calls it again after deleting. Idempotent: re-running inserts nothing and overwrites nothing.
 *
 * Both rows are kind 0 — unshielded native — which is what NIGHT is and the closest honest label
 * for DUST, whose own type is a unit variant with no colour at all (Q30). MIP "Out of scope" says
 * neither is described by this mechanism; they are here because the owner's decision is that a
 * wallet's two universal balances must be displayable (00020 Q7).
 */
export async function seedBuiltinTokens(sql: ISql, schema: string, net: string): Promise<void> {
  // NIGHT — the unshielded native token whose type is 32 zero bytes. Colour and key coincide,
  // which is exactly what the chain says: there is no contract and no domain separator.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(ZERO32, "hex")}, 0,
       ${Buffer.from(ZERO32, "hex")}, 'NIGHT', 'NIGHT', 6, 'builtin', 0)
    ON CONFLICT (net, address, domain_sep, kind) DO NOTHING
  `;
  // DUST — the fee token. `color` stays NULL: the ledger's DUST token type is a unit variant with
  // no bytes (Q30). The sentinel `domain_sep` only separates this row from NIGHT's key.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(pad32Hex("dust"), "hex")}, 0,
       NULL, 'DUST', 'DUST', 15, 'builtin', 0)
    ON CONFLICT (net, address, domain_sep, kind) DO NOTHING
  `;
}

/** The sentinel keys the two built-in rows use, exported so tests and the API can name them
 *  without re-deriving the bytes. Hex, lowercase, unprefixed — the repo's convention. */
export const BUILTIN_KEYS = {
  night: { address: ZERO32, domainSep: ZERO32, kind: 0 as const },
  dust: { address: ZERO32, domainSep: pad32Hex("dust"), kind: 0 as const },
};
