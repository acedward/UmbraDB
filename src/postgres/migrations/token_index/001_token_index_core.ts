import type { ISql } from "postgres";

/**
 * Project 00020 — the `token_index` schema: every Midnight token the chain reveals, its colour,
 * its observed mints and whatever its contract declared about itself on chain.
 *
 * Spec: `/home/eddie/todo/Umbra/spec/00020-token-indexer.md` §6.1 (this file is that section,
 * expressed as DDL), §6.2 (the `status` rules the CHECK below encodes), §3 "Row sources" and
 * FR-017 (the only two kinds of evidence that create a row: an observed mint, or an emitted
 * `TokenMetadata` event — plus the two built-in seeds this migration inserts).
 *
 * ── Why this is its own lineage, in its own schema ─────────────────────────────────────────────
 * Exactly the same reason and mechanism as the `chain_archive` and `evm_rpc` lineages next door:
 * `000_schema.ts` is REUSED unchanged (its `up(sql, schema)` is fully schema-parameterised, so it
 * bootstraps an independent `token_index._migrations`), and a caller selects this lineage with
 * `runMigrations(sql, { schema: "token_index", migrations: tokenIndexMigrations })`. No runner
 * machinery was added; `RunMigrationsOptions.migrations` already exists for this.
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; `bytea(32)` is a syntax error, not a constraint.
 * Byte lengths are expressed as `CHECK (octet_length(...) = 32)`, following `010_logs.ts`.
 *
 * ── The two seed rows (owner decision Q7) ──────────────────────────────────────────────────────
 * NIGHT and DUST are never minted by a contract, so the scanner can never see them; the owner's
 * decision is that they are hardcoded ("night / dust HAS to be hardcoded as it never will be
 * displayed otherwise"). They are the ONLY rows in this schema not derived from chain evidence,
 * and they are marked `status = 'builtin'` so nothing downstream mistakes them for observations.
 *
 * NIGHT is the unshielded token type of 32 zero bytes (`coin-structure/src/coin.rs:556`;
 * the pinned ledger package's `nativeToken().raw` returns exactly 64 hex zeros — asserted in
 * `token-indexer/test/migrate.test.ts`, which may import the ledger because it lives outside
 * `src/`; this file must not even NAME that package, since
 * `test/postgres/no-sdk-import-guard.test.ts` is a whole-file text scan), 6 decimals
 * (1 NIGHT = 10^6 STAR).
 *
 * DUST has **no colour at all**: the ledger types it as a UNIT variant (`TokenType::Dust` in
 * `coin-structure/src/coin.rs:285-288`; `export type DustTokenType = { tag: 'dust' }` in
 * `ledger-v9.d.ts:54`), so the spec's `feeToken().raw` does not exist — verified at runtime, it
 * is `undefined`. Its row therefore carries `color = NULL` and a documented sentinel key
 * (`address` = 32 zero bytes, `domain_sep` = `pad(32, "dust")`) purely so the primary key can
 * distinguish it from NIGHT's all-zero/all-zero key. Recorded as question Q30.
 *
 * No literal byte values are computed here from the Midnight packages: nothing under `src/` may
 * reference them (`test/postgres/no-sdk-import-guard.test.ts`), so the seeds are written as
 * literals and pinned against the real packages by a test that lives outside `src/`.
 */
export const name = "001_token_index_core";

/** `pad(32, s)` — the Compact standard library's padding: UTF-8 bytes, NUL-filled to 32. */
function pad32Hex(s: string): string {
  const b = Buffer.alloc(32);
  b.write(s, 0, "utf8");
  return b.toString("hex");
}

const ZERO32 = "0".repeat(64);

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- contracts -----------------------------------------------------------------------------
  // Every contract the scanner has seen, whether from its `ContractDeploy` (then `deploy_height`
  // and `deploy_tx_hash` are known) or from a later `ContractCall` on a contract deployed before
  // the archive's first block (then they stay NULL — the archive starts at the chain head on this
  // project, spec FR-015, so that is the common case, not an edge case).
  await sql`
    CREATE TABLE ${sql(schema)}.contracts (
      net               text   NOT NULL,
      address           bytea  NOT NULL CHECK (octet_length(address) = 32),
      deploy_tx_hash    bytea  CHECK (deploy_tx_hash IS NULL OR octet_length(deploy_tx_hash) = 32),
      deploy_height     bigint CHECK (deploy_height IS NULL OR deploy_height >= 0),
      first_seen_height bigint NOT NULL CHECK (first_seen_height >= 0),
      last_call_height  bigint CHECK (last_call_height IS NULL OR last_call_height >= 0),
      PRIMARY KEY (net, address)
    )
  `;

  // ---- pending_event_lookups -----------------------------------------------------------------
  // `(contract, transaction)` pairs whose transcripts contained `log` ops but for which the
  // indexer had not yet served every event. The scan cursor moves on regardless (spec §6.5), so
  // one slow transaction never stalls the scanner; a drain loop retries these with backoff.
  await sql`
    CREATE TABLE ${sql(schema)}.pending_event_lookups (
      net             text        NOT NULL,
      tx_hash         bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
      address         bytea       NOT NULL CHECK (octet_length(address) = 32),
      block_height    bigint      NOT NULL CHECK (block_height >= 0),
      expected_events int         NOT NULL CHECK (expected_events >= 0),
      got_events      int         NOT NULL DEFAULT 0 CHECK (got_events >= 0),
      attempts        int         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error      text,
      PRIMARY KEY (net, tx_hash, address)
    )
  `;
  await sql`
    CREATE INDEX pending_event_lookups_due
      ON ${sql(schema)}.pending_event_lookups (net, next_attempt_at)
  `;

  // ---- tokens --------------------------------------------------------------------------------
  // One row per `(net, address, domain_sep, kind)`. The same 32-byte colour can appear twice —
  // once shielded, once unshielded — because the ledger distinguishes those by TAG, not by value
  // (spec §0); that is why `kind` is part of the key and `color` is not unique.
  await sql`
    CREATE TABLE ${sql(schema)}.tokens (
      net                       text   NOT NULL,
      address                   bytea  NOT NULL CHECK (octet_length(address) = 32),
      domain_sep                bytea  NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind                      text   NOT NULL CHECK (kind IN ('shielded','unshielded')),
      -- NULL only for a ledger token whose declaration has not yet been folded; a row is never
      -- persisted with an unknown storage by any code path in token-indexer/.
      storage                   text   CHECK (storage IS NULL OR storage IN ('native','ledger')),
      -- NULL for ledger tokens (no colour is derivable for them) and for the built-in DUST row
      -- (the ledger's DUST token type carries no bytes at all — Q30).
      color                     bytea  CHECK (color IS NULL OR octet_length(color) = 32),
      name                      text,
      symbol                    text,
      decimals                  smallint CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 36)),
      token_uri                 text,
      metadata                  jsonb,
      status                    text   NOT NULL
        CHECK (status IN ('observed','declared','described','inconsistent','builtin')),
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

  // ---- token_mints ---------------------------------------------------------------------------
  // One row per entry of one transcript's mint map. The key is what makes re-scanning idempotent:
  // a mint is uniquely identified by its transaction, the intent segment it sat in, the index of
  // the call within that intent, the kind of mint map it came from and its domain separator.
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
      kind         text          NOT NULL CHECK (kind IN ('shielded','unshielded')),
      amount       numeric(20,0) NOT NULL CHECK (amount >= 0),
      PRIMARY KEY (net, tx_hash, segment, call_index, kind, domain_sep)
    )
  `;
  await sql`
    CREATE INDEX token_mints_by_token
      ON ${sql(schema)}.token_mints (net, address, domain_sep, kind, block_height)
  `;

  // ---- token_metadata_events -----------------------------------------------------------------
  // Every `TokenMetadata` Misc event the lookup fetched, applied or rejected, keyed by the
  // indexer's own event id — which is what makes a re-lookup of the same transaction idempotent.
  // Rejected events are KEPT (with `reject_reason`) because a contract's malformed claim is
  // evidence about that contract, and the page shows it.
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
      key_text      text,
      len           smallint NOT NULL CHECK (len >= 0 AND len <= 190),
      value         bytea    NOT NULL,
      applied       boolean  NOT NULL,
      reject_reason text,
      PRIMARY KEY (net, event_id)
    )
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_token
      ON ${sql(schema)}.token_metadata_events (net, address, domain_sep, block_height, event_id)
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_contract
      ON ${sql(schema)}.token_metadata_events (net, address, event_id)
  `;

  // ---- token_metadata_kv ---------------------------------------------------------------------
  // The CURRENT value of one key for one token (EIP-7496's `getTraitValue`), last write wins in
  // chain order. History lives in `token_metadata_events`; this is the projection.
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_kv (
      net              text     NOT NULL,
      address          bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             text     NOT NULL CHECK (kind IN ('shielded','unshielded')),
      key_text         text     NOT NULL,
      value            bytea    NOT NULL,
      len              smallint NOT NULL CHECK (len >= 0 AND len <= 190),
      updated_event_id bigint   NOT NULL,
      updated_height   bigint   NOT NULL CHECK (updated_height >= 0),
      PRIMARY KEY (net, address, domain_sep, kind, key_text)
    )
  `;

  // ---- cursors -------------------------------------------------------------------------------
  // `kind = 'decode'` carries `{ height, position }` — the scanner's position in the archive,
  // advanced in the SAME database transaction as the rows it produced (spec FR-014).
  await sql`
    CREATE TABLE ${sql(schema)}.cursors (
      net        text        NOT NULL,
      kind       text        NOT NULL,
      value      jsonb       NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, kind)
    )
  `;
}

/**
 * The two built-in rows (owner decision Q7). Not part of `up()` because they are **per-net**
 * data, not schema: one migration run serves every `net` the same database might hold, and the
 * net a process works on only becomes known when it is configured. `token-indexer/migrate.ts`
 * calls this right after `runMigrations`, and `rebuild` calls it again after truncating.
 * Idempotent: re-running inserts nothing and overwrites nothing.
 */
export async function seedBuiltinTokens(sql: ISql, schema: string, net: string): Promise<void> {
  // NIGHT — the unshielded native token whose type is 32 zero bytes. Colour and key coincide,
  // which is exactly what the chain says: there is no contract and no domain separator.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, storage, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(ZERO32, "hex")}, 'unshielded', 'native',
       ${Buffer.from(ZERO32, "hex")}, 'NIGHT', 'NIGHT', 6, 'builtin', 0)
    ON CONFLICT (net, address, domain_sep, kind) DO NOTHING
  `;
  // DUST — the fee token. `color` stays NULL: the ledger's DUST token type is a unit variant with
  // no bytes (Q30). The sentinel `domain_sep` only separates this row from NIGHT's key.
  await sql`
    INSERT INTO ${sql(schema)}.tokens
      (net, address, domain_sep, kind, storage, color, name, symbol, decimals, status, first_seen_height)
    VALUES
      (${net}, ${Buffer.from(ZERO32, "hex")}, ${Buffer.from(pad32Hex("dust"), "hex")}, 'unshielded', 'native',
       NULL, 'DUST', 'DUST', 15, 'builtin', 0)
    ON CONFLICT (net, address, domain_sep, kind) DO NOTHING
  `;
}

/** The sentinel keys the two built-in rows use, exported so tests and the API can name them
 *  without re-deriving the bytes. Hex, lowercase, unprefixed — the repo's convention. */
export const BUILTIN_KEYS = {
  night: { address: ZERO32, domainSep: ZERO32, kind: "unshielded" as const },
  dust: { address: ZERO32, domainSep: pad32Hex("dust"), kind: "unshielded" as const },
};
