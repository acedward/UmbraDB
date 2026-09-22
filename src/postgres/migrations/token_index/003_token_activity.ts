import type { ISql } from "postgres";

/**
 * Project 00023 — the `token_index` schema gains a token's LIFE: every public occurrence of a
 * colour in an archived transaction, every zswap offer, every contract call.
 *
 * Spec: `/home/eddie/todo/Umbra/spec/00023-token-transactions.md` §6.1 (this file is that section,
 * expressed as DDL), §3 FR-001/FR-018/FR-019/FR-020, US5 (the `seen` status) and §0 (what the
 * ledger actually makes public).
 *
 * ── Why this may drop and recreate (owner decision Q3, "VERY IMPORTANT") ───────────────────────
 * The owner's standing rule for this project is that **the index is reindexed from scratch, so
 * breaking changes to `token_index` are allowed**: there is no compatibility path with a 00021
 * database and none is wanted. Everything in this schema is a pure DERIVATION of `chain_archive`
 * plus the two seeded rows, and the scanner rebuilds all of it in minutes.
 *
 * **A deployer therefore runs exactly two commands, in this order:**
 *
 * ```
 * npm run token-indexer -- migrate     # applies this migration; the index is now EMPTY
 * npm run token-indexer -- rebuild     # re-seeds the built-ins and re-scans from block zero
 * ```
 *
 * Skipping `rebuild` leaves an empty index that the scanner would refill anyway from the cursor
 * this migration deletes — the `rebuild` is what states that intent out loud and re-seeds NIGHT and
 * DUST against the CURRENT table shape.
 *
 * ── What changed against 002 ───────────────────────────────────────────────────────────────────
 *  - **`tokens` is keyed by its colour, not by its contract** (FR-019, US5). A colour seen in any
 *    public field — an unshielded UTXO, a contract effect map, a zswap offer delta — whose mint
 *    predates the archive has no `(contractAddress, domainSep)` that anyone could recover: a colour
 *    is a commitment, not an encoding. Such a colour now gets a row with the new status `seen` and
 *    NULL address/domain separator, which a later mint or metadata event fills IN PLACE. The
 *    physical key is `token_key`:
 *      * kinds 0 and 1 (native): `token_key = color` — a colour IS the identity of a native token,
 *        and it is a function of `(domainSep, address)`, so nothing is lost by keying on it;
 *      * kinds 2 and 3 (ledger): no colour exists (MIP §3), so `token_key` is
 *        `sha256('umbra:ledger' || address || domain_sep || kind)` — a private, stable stand-in that
 *        never leaves this schema (the API keeps serving those rows by `(address, domainSep, kind)`).
 *    `token-indexer/ingest/fold.ts`'s `tokenKeyOf()` is the ONLY place that computes it.
 *  - **`address` / `domain_sep` are NULLABLE**, together (`tokens_contract_pair`), and NULL only
 *    while the row is `seen` (`tokens_seen_has_no_contract`). Every address-based lookup the API
 *    makes is still served — and still unique — by the partial unique index below.
 *  - **`status` gains `seen`** as the fourth row source, after an observed mint, an applied metadata
 *    event and the two built-in seeds.
 *  - **`token_activity`, `shielded_offers` and `contract_calls`** are new (FR-001, FR-018, FR-020).
 *  - `token_mints`, `token_metadata_events` and `token_metadata_kv` are recreated **verbatim** from
 *    002: they are keyed by `(address, domain_sep, kind)`, which only ever exists for a row that has
 *    a contract behind it, so the colour identity changes nothing about them. They are dropped and
 *    recreated rather than left alone because their rows are derivations of an index that no longer
 *    exists, and leaving them would make `rebuild` the only way to a consistent state without
 *    saying so.
 *
 * ── No wall-clock time anywhere (owner decision Q1, FR-012) ────────────────────────────────────
 * Not one column here carries a timestamp. A row is located by `block_height` and `tx_position`.
 * The archive on this lineage has no block time at all, and the owner's answer to "where would it
 * come from" was "we are only listing block heights".
 *
 * ── DUST is never tracked (owner decision Q13, FR-001) ─────────────────────────────────────────
 * 681 of the archive's 683 transactions pay a DUST fee, so a DUST activity list would be a list of
 * the whole chain. `token_activity.color` is `NOT NULL` and DUST has no colour at all, which is the
 * schema-level form of that decision: no code path can write a DUST row even by accident. A
 * transaction's DUST spends and registrations remain visible in that transaction's own view, which
 * is decoded on request and never stored.
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; byte lengths are `CHECK (octet_length(...) = 32)`,
 * following `010_logs.ts` and 001/002 next door.
 */
export const name = "003_token_activity";

/** `pad(32, s)` — the Compact standard library's padding: UTF-8 bytes, NUL-filled to 32. */
function pad32Hex(s: string): string {
  const b = Buffer.alloc(32);
  b.write(s, 0, "utf8");
  return b.toString("hex");
}

const ZERO32 = "0".repeat(64);

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- out with the 002 shapes ---------------------------------------------------------------
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_kv`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_events`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_mints`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.tokens`;
  // These three survive as shapes but not as rows: keeping a decode cursor that points past rows
  // that no longer exist is the one way to make this migration silently lose tokens.
  await sql`DELETE FROM ${sql(schema)}.cursors`;
  await sql`DELETE FROM ${sql(schema)}.pending_event_lookups`;
  await sql`DELETE FROM ${sql(schema)}.contracts`;

  // ---- tokens --------------------------------------------------------------------------------
  // One row per `(net, token_key, kind)`. For a NATIVE kind the key IS the colour, so the row that
  // a UTXO of colour C belongs to is found without knowing which contract minted C — which is the
  // whole of FR-019. For a LEDGER kind there is no colour, so the key is a digest of the identity
  // the MIP does define; `tokens_color_is_key` below states the relationship in the schema itself.
  await sql`
    CREATE TABLE ${sql(schema)}.tokens (
      net                       text     NOT NULL,
      -- The physical identity. 32 bytes either way: a colour, or the ledger-kind digest.
      token_key                 bytea    NOT NULL CHECK (octet_length(token_key) = 32),
      kind                      smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      -- NULL together, and only while the row's only evidence is an activity row (status 'seen').
      address                   bytea    CHECK (address IS NULL OR octet_length(address) = 32),
      domain_sep                bytea    CHECK (domain_sep IS NULL OR octet_length(domain_sep) = 32),
      -- Derived, never written: bit 0 is the privacy tag and bit 1 is where the value lives
      -- (MIP §3). GENERATED means the identity byte and these two labels cannot drift apart.
      privacy                   text     NOT NULL GENERATED ALWAYS AS
                                  (CASE WHEN (kind % 2) = 1 THEN 'shielded' ELSE 'unshielded' END) STORED,
      storage                   text     NOT NULL GENERATED ALWAYS AS
                                  (CASE WHEN kind >= 2 THEN 'ledger' ELSE 'native' END) STORED,
      color                     bytea    CHECK (color IS NULL OR octet_length(color) = 32),
      name                      text,
      symbol                    text,
      decimals                  smallint CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 36)),
      token_uri                 text,
      metadata                  jsonb,
      -- MIP §7.2's three consumer states, 'builtin' for the two seeded rows, and 'seen' for a
      -- colour that public data proves exists while nothing has yet said whose it is (US5).
      status                    text     NOT NULL
        CHECK (status IN ('seen','observed','declared','described','builtin')),
      mint_count                bigint        NOT NULL DEFAULT 0 CHECK (mint_count >= 0),
      total_minted              numeric(39,0) NOT NULL DEFAULT 0 CHECK (total_minted >= 0),
      first_mint_height         bigint CHECK (first_mint_height IS NULL OR first_mint_height >= 0),
      last_mint_height          bigint CHECK (last_mint_height IS NULL OR last_mint_height >= 0),
      first_seen_height         bigint NOT NULL CHECK (first_seen_height >= 0),
      metadata_updated_height   bigint CHECK (metadata_updated_height IS NULL OR metadata_updated_height >= 0),
      metadata_updated_event_id bigint,
      -- A contract and a domain separator are one fact, not two: neither is knowable alone.
      CONSTRAINT tokens_contract_pair       CHECK ((address IS NULL) = (domain_sep IS NULL)),
      -- The ONLY status that may have no contract behind it. A row stops being 'seen' exactly when
      -- a mint or a metadata event says which contract issued the colour (US5 scenario 2).
      CONSTRAINT tokens_seen_has_no_contract CHECK (status <> 'seen' OR address IS NULL),
      -- MIP §3: "A consumer MUST NOT derive or display a colour for a ledger kind."
      CONSTRAINT tokens_ledger_has_no_color  CHECK (kind < 2 OR color IS NULL),
      -- …and conversely, every native row that came from the chain HAS one: a mint derives it, a
      -- declaration derives it, and an activity row is a colour by definition. The built-ins are the
      -- documented exception — DUST's token type is a unit variant carrying no bytes at all (Q30).
      CONSTRAINT tokens_native_has_color     CHECK (status = 'builtin' OR kind >= 2 OR color IS NOT NULL),
      -- The invariant that makes token_key readable: where a colour exists, the key IS it.
      CONSTRAINT tokens_color_is_key         CHECK (color IS NULL OR color = token_key),
      PRIMARY KEY (net, token_key, kind)
    )
  `;
  await sql`CREATE INDEX tokens_by_color ON ${sql(schema)}.tokens (net, color)`;
  await sql`CREATE INDEX tokens_by_symbol ON ${sql(schema)}.tokens (net, lower(symbol))`;
  await sql`CREATE INDEX tokens_by_name ON ${sql(schema)}.tokens (net, lower(name))`;
  await sql`CREATE INDEX tokens_by_contract_domain ON ${sql(schema)}.tokens (net, address, domain_sep)`;
  // The MIP's identity, kept UNIQUE even though it is no longer the primary key: `token_key` is a
  // function of `(address, domain_sep, kind)` for every row the fold writes, so two rows could only
  // share the triple by a bug — and this index turns that bug into an error instead of a duplicate.
  //
  // The two exclusions are exactly the two rows whose key is NOT that function:
  //   * `address IS NULL` — a `seen` row has no triple to be unique on;
  //   * `status <> 'builtin'` — NIGHT and DUST carry SENTINEL contract keys (the all-zero address),
  //     chosen in 00020 so the primary key could tell them apart, while their `token_key` is the
  //     ledger's own fact (NIGHT's zero colour, DUST's sentinel separator). A metadata event from a
  //     contract at the all-zero address — impossible on chain, exercised by the fold's own test —
  //     is a different token from NIGHT and must be allowed to be one.
  await sql`
    CREATE UNIQUE INDEX tokens_by_identity ON ${sql(schema)}.tokens (net, address, domain_sep, kind)
    WHERE address IS NOT NULL AND status <> 'builtin'
  `;

  // ---- token_mints (verbatim from 002) -------------------------------------------------------
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

  // ---- token_metadata_events (verbatim from 002) ---------------------------------------------
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

  // ---- token_metadata_kv (verbatim from 002) -------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_kv (
      net              text     NOT NULL,
      address          bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      key_hex          text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])+$'),
      key_text         text,
      val_type         smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 4),
      val_len          smallint NOT NULL CHECK (val_len >= 0 AND val_len <= 189),
      value            bytea    NOT NULL CHECK (octet_length(value) <= 189),
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

  // ---- token_activity (NEW — FR-001) ---------------------------------------------------------
  // One row per PUBLIC occurrence of a colour in one archived transaction. The natural key is the
  // occurrence itself — which transaction, which intent segment, which section of it, what kind of
  // occurrence, and the index of the item within that list — so re-scanning a block with
  // `ON CONFLICT DO NOTHING` changes nothing (FR-004).
  //
  // Only COUNTED rows are ever stored (owner decision Q10, "skip failed"): a movement that did not
  // happen must not appear in a token's list. The transaction view decodes the uncounted sections
  // on request and marks them, so nothing is hidden — it is simply not attributed.
  //
  // `amount` is UNSIGNED and `direction` carries the sign, so a reader never has to know which
  // roles are negative:
  //   utxo_out / contract_in / mint → 'in'      (the token arrived somewhere public)
  //   utxo_in  / contract_out       → 'out'
  //   shielded_delta                → 'pool_in' (delta < 0: value entered the shielded pool)
  //                                   'pool_out'(delta > 0: value left it)
  //   reward                        → 'in'
  await sql`
    CREATE TABLE ${sql(schema)}.token_activity (
      net          text          NOT NULL,
      tx_hash      bytea         NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height bigint        NOT NULL CHECK (block_height >= 0),
      tx_position  int           NOT NULL CHECK (tx_position >= 0),
      -- The intent segment. The transaction-level GUARANTEED zswap offer and a ClaimRewards
      -- transaction sit outside every intent and use 0 (spec §6.1).
      segment      int           NOT NULL CHECK (segment >= 0),
      section      text          NOT NULL CHECK (section IN ('guaranteed','fallible')),
      role         text          NOT NULL CHECK (role IN
                     ('utxo_out','utxo_in','contract_in','contract_out','mint','shielded_delta','reward')),
      item_index   int           NOT NULL CHECK (item_index >= 0),
      -- Every tracked row has a colour: DUST is not tracked (Q13) and it is the only token type on
      -- this ledger that carries no bytes.
      color        bytea         NOT NULL CHECK (octet_length(color) = 32),
      -- The evidence's privacy decides the kind: an unshielded UTXO or a contract effect is kind 0,
      -- a zswap delta is kind 1, a mint takes the kind of the map it came from (FR-003).
      kind         smallint      NOT NULL CHECK (kind IN (0, 1)),
      amount       numeric(39,0) NOT NULL CHECK (amount >= 0),
      direction    text          NOT NULL CHECK (direction IN ('in','out','mint','pool_in','pool_out')),
      -- utxo_out: the 32-byte UserAddress the output pays. utxo_in: the address behind the spend's
      -- signature verifying key (addressFromKey). Rendered to the wire as Bech32m (Q9).
      owner        bytea         CHECK (owner IS NULL OR octet_length(owner) = 32),
      -- utxo_in only: <tag>:<hex> of the SignatureVerifyingKey, which is what the ledger carries.
      owner_key    text,
      -- utxo_out: the intent hash this output belongs to. utxo_in: the intent hash of the UTXO being
      -- spent, with output_no — together the identity of the coin that was consumed.
      intent_hash  bytea         CHECK (intent_hash IS NULL OR octet_length(intent_hash) = 32),
      output_no    int           CHECK (output_no IS NULL OR output_no >= 0),
      -- contract_in / contract_out / mint: the contract and the entry point that moved it.
      address      bytea         CHECK (address IS NULL OR octet_length(address) = 32),
      entry_point  text,
      call_index   int           CHECK (call_index IS NULL OR call_index >= 0),
      -- mint rows only: the domain separator the mint map was keyed by.
      domain_sep   bytea         CHECK (domain_sep IS NULL OR octet_length(domain_sep) = 32),
      PRIMARY KEY (net, tx_hash, segment, section, role, item_index)
    )
  `;
  // The token page: one colour, one kind, newest first.
  await sql`
    CREATE INDEX token_activity_by_token
      ON ${sql(schema)}.token_activity (net, color, kind, block_height DESC, tx_hash)
  `;
  // The transaction view: every row of one transaction.
  await sql`CREATE INDEX token_activity_by_tx ON ${sql(schema)}.token_activity (net, tx_hash)`;
  // The contract view's "what flowed through this contract".
  await sql`
    CREATE INDEX token_activity_by_contract
      ON ${sql(schema)}.token_activity (net, address, block_height DESC) WHERE address IS NOT NULL
  `;

  // ---- shielded_offers (NEW — FR-018) --------------------------------------------------------
  // One row per zswap offer on the chain, whether or not any token row exists for it. This is what
  // turns "Midnight is really private" into a number that comes FROM the chain: an offer whose
  // `deltas` map is empty is BALANCED, and a balanced offer publishes nothing about which colour
  // moved (spec §0: `normalize_deltas` drops every zero and the verifier rejects a stored zero).
  // `undisclosed` is GENERATED so no code path can disagree with the count it is derived from.
  await sql`
    CREATE TABLE ${sql(schema)}.shielded_offers (
      net          text    NOT NULL,
      tx_hash      bytea   NOT NULL CHECK (octet_length(tx_hash) = 32),
      section      text    NOT NULL CHECK (section IN ('guaranteed','fallible')),
      segment      int     NOT NULL CHECK (segment >= 0),
      block_height bigint  NOT NULL CHECK (block_height >= 0),
      tx_position  int     NOT NULL CHECK (tx_position >= 0),
      inputs       int     NOT NULL CHECK (inputs >= 0),
      outputs      int     NOT NULL CHECK (outputs >= 0),
      transients   int     NOT NULL CHECK (transients >= 0),
      deltas       int     NOT NULL CHECK (deltas >= 0),
      undisclosed  boolean NOT NULL GENERATED ALWAYS AS (deltas = 0) STORED,
      -- Unlike token_activity, an offer is recorded even when its section did not count: the
      -- privacy figure is about what the CHAIN carries, not about what took effect.
      counted      boolean NOT NULL,
      PRIMARY KEY (net, tx_hash, section, segment)
    )
  `;
  await sql`
    CREATE INDEX shielded_offers_by_disclosure
      ON ${sql(schema)}.shielded_offers (net, undisclosed, block_height DESC, tx_hash)
  `;

  // ---- contract_calls (NEW — FR-020, US7) ----------------------------------------------------
  // Every contract call with everything public about it, per transcript section. This is the only
  // activity a LEDGER token (kind 2/3) has: its balances live in its contract's state, which needs
  // that contract's own layout to read. The page lists these under the owner's note — "only public
  // data is listed; we do not have access to the code this executes" (Q4).
  //
  // `guaranteed` / `fallible` are jsonb because their contents ARE a document: op and `log` counts,
  // the gas vector and every effect map, all of which the transaction view prints verbatim. Making
  // them columns would fix a shape that the ledger is free to extend.
  await sql`
    CREATE TABLE ${sql(schema)}.contract_calls (
      net          text   NOT NULL,
      tx_hash      bytea  NOT NULL CHECK (octet_length(tx_hash) = 32),
      segment      int    NOT NULL CHECK (segment >= 0),
      call_index   int    NOT NULL CHECK (call_index >= 0),
      address      bytea  NOT NULL CHECK (octet_length(address) = 32),
      entry_point  text,
      block_height bigint NOT NULL CHECK (block_height >= 0),
      tx_position  int    NOT NULL CHECK (tx_position >= 0),
      guaranteed   jsonb,
      fallible     jsonb,
      PRIMARY KEY (net, tx_hash, segment, call_index)
    )
  `;
  await sql`
    CREATE INDEX contract_calls_by_contract
      ON ${sql(schema)}.contract_calls (net, address, block_height DESC, tx_hash)
  `;
}

/**
 * The two built-in rows (owner decision Q7 of 00020), on the 003 shape.
 *
 * Not part of `up()` because they are **per-net** data, not schema: one migration run serves every
 * `net` the same database might hold, and the net a process works on only becomes known when it is
 * configured. `token-indexer/bootstrap.ts` calls this right after `runMigrations`, and `rebuild`
 * calls it again after deleting. Idempotent: re-running inserts nothing and overwrites nothing.
 *
 * Both rows are kind 0 — unshielded native — which is what NIGHT is and the closest honest label
 * for DUST, whose own type is a unit variant with no colour at all (Q30).
 *
 * **Their `token_key`s are the ledger's own facts, not derivations.** NIGHT's colour is 32 zero
 * bytes (`nativeToken().raw`), so its key is that. DUST has no colour, so its key is the same
 * sentinel domain separator 00020 chose for it, `pad(32, "dust")` — a value no derived colour can
 * collide with, since a colour is a commitment over 64 bytes of input. Both keep the 00020 sentinel
 * `(address, domain_sep)` so every route that addresses a token by its contract still reaches them.
 */
export async function seedBuiltinTokens(sql: ISql, schema: string, net: string): Promise<void> {
  // NIGHT — the unshielded native token whose type is 32 zero bytes. Colour, key and sentinel
  // address all coincide, which is exactly what the chain says: there is no contract here.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, token_key, kind, address, domain_sep, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(ZERO32, "hex")}, 0,
       ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(ZERO32, "hex")},
       ${Buffer.from(ZERO32, "hex")}, 'NIGHT', 'NIGHT', 6, 'builtin', 0)
    ON CONFLICT (net, token_key, kind) DO NOTHING
  `;
  // DUST — the fee token. `color` stays NULL: the ledger's DUST token type is a unit variant with
  // no bytes (Q30), and `tokens_native_has_color` exempts the built-ins for exactly this reason.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, token_key, kind, address, domain_sep, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(pad32Hex("dust"), "hex")}, 0,
       ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(pad32Hex("dust"), "hex")},
       NULL, 'DUST', 'DUST', 15, 'builtin', 0)
    ON CONFLICT (net, token_key, kind) DO NOTHING
  `;
}

/** The sentinel keys the two built-in rows use, exported so tests and the API can name them
 *  without re-deriving the bytes. Hex, lowercase, unprefixed — the repo's convention.
 *  `tokenKey` is the physical identity of the row; `address`/`domainSep` are the 00020 sentinels
 *  the contract-addressed routes still answer to. */
export const BUILTIN_KEYS = {
  night: { tokenKey: ZERO32, address: ZERO32, domainSep: ZERO32, kind: 0 as const },
  dust: { tokenKey: pad32Hex("dust"), address: ZERO32, domainSep: pad32Hex("dust"), kind: 0 as const },
};
