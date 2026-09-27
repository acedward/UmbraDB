import type { ISql } from "postgres";

/**
 * Project 00024-02 — the `token_index` schema for **public interfaces** ([B], `mip-xxxx:public-
 * interface[v1]`, the Public Interfaces for Compact Contracts draft at PR #6 `1cf9477`), read as
 * [Y] Multi-Part Event packages (UC-2).
 *
 * Spec: `/home/eddie/todo/Umbra/spec/00024-indexer-public-interface-multipart.md` (US1,
 * FR-010–FR-013b, §5), plan `plans/00024-02-public-interface.md` task C1.
 *
 * ── Three tables ───────────────────────────────────────────────────────────────────────────────
 *  1. **`public_interface_events`** — one row per PUBLICATION: one [Y] package of the [B] name (its
 *     parts, segment and phase exactly as 005 stores a MIP-0018 package), the decoded pointer (the
 *     32-byte commitment and the URL bytes after it, trailing zeros removed), and THAT publication's
 *     own last verification result. FR-010: the newest publication is current whatever its result,
 *     and "older publications are listed as historical, each with its own last result" — so the
 *     result lives with the publication, not with the contract.
 *  2. **`public_interfaces`** — one row per contract that has published: which publication is
 *     current, and its position in the canonical order (derivation P2: block height, transaction
 *     position, the FIRST part's execution position — P1's order), so a newer publication replaces
 *     it and an older one arriving later never does.
 *  3. **`public_interface_checks`** — the append-only history of every verification result (FR-011b:
 *     a result that changes is recorded with the time the earlier result held).
 *
 * ── Untrusted bytes never stall the scanner ────────────────────────────────────────────────────
 * The payload is whatever a contract emitted. Every constraint below holds for ANY package the
 * reader can form (1..1 024 parts): the commitment is always 32 bytes, the URL bytes are a bytea of
 * any length, and `url` (text) is filled only when the bytes are valid UTF-8 without a control
 * character — Postgres `text` cannot hold U+0000, and a refused INSERT would roll back the whole
 * scan batch on every retry (the 01-D audit's stall class). No B-tree index covers the URL or any
 * other value of unbounded length.
 *
 * ── Why a fresh table set (spec Q3, FR-014) ────────────────────────────────────────────────────
 * Everything is in development; every local run starts from an empty database. Nothing existing is
 * dropped: 006 only adds.
 */
export const name = "006_public_interfaces";

/** The statuses a publication's last result can have (spec §4 Key Entities; `historical` is not a
 *  status but a role: every publication that is not its contract's current one). `unreachable`
 *  (owner decision Q25, task 02-C9): the host did not deliver — no level claimed, retried with
 *  exponential backoff; `unfetchable` is a policy refusal only (scheme, private destination). Edited
 *  in place: everything is in development and every run starts from an empty database (spec Q3). */
export const INTERFACE_STATUSES = ["pending", "verified", "failed", "unchecked", "unfetchable", "unreachable", "stale"] as const;

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- public_interface_events: one row per publication (a [Y] package of the [B] name) ------
  await sql`
    CREATE TABLE ${sql(schema)}.public_interface_events (
      net                 text        NOT NULL,
      -- The FIRST part's indexer event id: the publication's identity, and inside its transaction
      -- its position (derivation P2, P1's order).
      event_id            bigint      NOT NULL,
      part_event_ids      bigint[]    NOT NULL,
      parts               smallint    NOT NULL CHECK (parts >= 1 AND parts <= 1024),
      segment             int         NOT NULL CHECK (segment >= 1 AND segment <= 65535),
      phase               text        NOT NULL CHECK (phase IN ('guaranteed','fallible','mixed')),
      address             bytea       NOT NULL CHECK (octet_length(address) = 32),
      tx_hash             bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height        bigint      NOT NULL CHECK (block_height >= 0),
      tx_position         int         NOT NULL CHECK (tx_position >= 0),
      -- The merged payload: 256 bytes per part, every byte kept ([Y] §4).
      payload             bytea       NOT NULL,
      -- payload[0..32): the bundle commitment ([B] "ecmh-jubjub-grouphash").
      commitment          bytea       NOT NULL CHECK (octet_length(commitment) = 32),
      -- payload[32..): the index.json URL, trailing zero bytes removed ([B]: "parsers strip
      -- trailing NULs"). Any length; may be empty.
      url_bytes           bytea       NOT NULL,
      -- url_bytes as text, when they are valid UTF-8 with no control character; else NULL and
      -- url_error says why (url_empty | url_not_utf8 | url_control_character).
      url                 text,
      url_error           text,

      -- ── this publication's last verification result ──────────────────────────────────────
      status              text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','verified','failed','unchecked','unfetchable','unreachable','stale')),
      -- The highest level passed: 0 none, 1 L1, 2 L1+L2, 3 L1+L2+L3 ([B]: levels are cumulative).
      level               smallint    NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 3),
      l1                  text        CHECK (l1 IS NULL OR l1 IN ('passed','failed','not_run')),
      l2                  text        CHECK (l2 IS NULL OR l2 IN ('passed','failed','not_run')),
      l3                  text        CHECK (l3 IS NULL OR l3 IN ('passed','failed','not_run')),
      l3_reason           text,
      -- Why the status is failed / unchecked / unfetchable / unreachable (the failed check, the
      -- limit, the refused destination, what the host did not deliver); NULL when verified or pending.
      reason              text,
      failed_level        smallint    CHECK (failed_level IS NULL OR failed_level IN (1, 2)),
      -- The [B] PR #6 verification record of the last check, and the published circuits.
      report              jsonb,
      circuits            jsonb,
      -- The contract state Level 2 compared against: where the provider says it comes from.
      state_block_height  bigint      CHECK (state_block_height IS NULL OR state_block_height >= 0),
      state_tx_hash       bytea       CHECK (state_tx_hash IS NULL OR octet_length(state_tx_hash) = 32),
      checked_at          timestamptz,
      checks              int         NOT NULL DEFAULT 0 CHECK (checks >= 0),
      -- The last check that returned verified, and — once a later check did not — the time the
      -- earlier verified result held until (FR-011b: "verified until <time>").
      last_verified_at    timestamptz,
      verified_until      timestamptz,
      -- Consecutive checks that reached no conclusion — unreachable, unchecked, unfetchable (the
      -- exponential retry backoff, owner Q25).
      attempts            int         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      -- When the drain should check it next; NULL = nothing scheduled.
      next_check_at       timestamptz,
      -- Bumped by anything that makes an in-flight check's result obsolete (a maintenance update,
      -- a newer publication); a result is written only if the generation it read is still current.
      generation          int         NOT NULL DEFAULT 0 CHECK (generation >= 0),

      PRIMARY KEY (net, event_id),
      CONSTRAINT pie_payload_is_parts CHECK (octet_length(payload) = 256 * parts),
      CONSTRAINT pie_part_ids_match CHECK (cardinality(part_event_ids) = parts AND part_event_ids[1] = event_id),
      CONSTRAINT pie_url_or_error CHECK ((url IS NULL) = (url_error IS NOT NULL)),
      CONSTRAINT pie_url_error_known CHECK (
        url_error IS NULL OR url_error IN ('url_empty','url_not_utf8','url_control_character')
      ),
      -- Verified means L1 and L2 passed (level 2), L3 passed too (level 3) or tried and not.
      CONSTRAINT pie_verified_level CHECK (status <> 'verified' OR (level >= 2 AND l1 = 'passed' AND l2 = 'passed')),
      -- A failed result names the level that failed; a stale publication keeps its last result
      -- (level, l1/l2/l3, reason, failed_level) as the last known one until it is re-checked.
      CONSTRAINT pie_failed_has_level CHECK (status <> 'failed' OR failed_level IS NOT NULL),
      CONSTRAINT pie_failed_level_only_when_failed CHECK (failed_level IS NULL OR status IN ('failed','stale')),
      CONSTRAINT pie_reason_when_not_ok CHECK (
        status NOT IN ('failed','unchecked','unfetchable','unreachable') OR reason IS NOT NULL
      ),
      CONSTRAINT pie_until_after_verified CHECK (verified_until IS NULL OR last_verified_at IS NOT NULL)
    )
  `;
  await sql`
    CREATE INDEX public_interface_events_by_contract
      ON ${sql(schema)}.public_interface_events (net, address, block_height, tx_position, event_id)
  `;
  await sql`
    CREATE INDEX public_interface_events_due
      ON ${sql(schema)}.public_interface_events (net, next_check_at)
      WHERE next_check_at IS NOT NULL
  `;
  await sql`
    CREATE INDEX public_interface_events_by_tx
      ON ${sql(schema)}.public_interface_events (net, tx_hash, segment)
  `;

  // ---- public_interfaces: the current publication of every contract (derivation P2) ----------
  await sql`
    CREATE TABLE ${sql(schema)}.public_interfaces (
      net           text    NOT NULL,
      address       bytea   NOT NULL CHECK (octet_length(address) = 32),
      -- The newest publication: the last in (block_height, tx_position, event_id) order.
      event_id      bigint  NOT NULL,
      block_height  bigint  NOT NULL CHECK (block_height >= 0),
      tx_position   int     NOT NULL CHECK (tx_position >= 0),
      publications  int     NOT NULL DEFAULT 1 CHECK (publications >= 1),
      PRIMARY KEY (net, address),
      FOREIGN KEY (net, event_id) REFERENCES ${sql(schema)}.public_interface_events (net, event_id)
    )
  `;
  await sql`
    CREATE INDEX public_interfaces_newest
      ON ${sql(schema)}.public_interfaces (net, block_height DESC, tx_position DESC, event_id DESC)
  `;

  // ---- public_interface_checks: every result, in order (FR-011b) -----------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.public_interface_checks (
      net                 text        NOT NULL,
      event_id            bigint      NOT NULL,
      check_no            int         NOT NULL CHECK (check_no >= 1),
      checked_at          timestamptz NOT NULL,
      -- What asked for it: the first check, a retry after a limit, the periodic re-check, a
      -- maintenance update (stale), or verify-interfaces --address.
      trigger             text        NOT NULL CHECK (trigger IN ('initial','retry','recheck','stale','on_demand')),
      status              text        NOT NULL
                          CHECK (status IN ('verified','failed','unchecked','unfetchable','unreachable')),
      level               smallint    NOT NULL CHECK (level >= 0 AND level <= 3),
      l1                  text        NOT NULL CHECK (l1 IN ('passed','failed','not_run')),
      l2                  text        NOT NULL CHECK (l2 IN ('passed','failed','not_run')),
      l3                  text        NOT NULL CHECK (l3 IN ('passed','failed','not_run')),
      l3_reason           text,
      reason              text,
      state_block_height  bigint,
      PRIMARY KEY (net, event_id, check_no),
      FOREIGN KEY (net, event_id) REFERENCES ${sql(schema)}.public_interface_events (net, event_id)
    )
  `;
}
