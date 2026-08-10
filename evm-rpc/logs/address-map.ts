/**
 * The single place Part C reads or writes `evm_rpc.address_map`.
 *
 * Concentrated into one module ON PURPOSE: that table is owned by Part A1/A2, whose own migration
 * and contract doc (`umbradb-sync/wallet-monitor/SCHEMA.md`) are not in this clone. If A1/A2's
 * committed column shape turns out to differ from the minimum shape `010_logs.ts` creates with
 * `IF NOT EXISTS`, the Part F merge has exactly ONE file to reconcile instead of inline SQL spread
 * across the ingester, the backfiller and `eth_getLogs`. Tracked as plan Open question Q1.
 */

import type { ISql } from "postgres";
import { defaultAddressMapper, toHex, type AddressMapper, type MidnightIdentity } from "./event-map.js";

/**
 * The interface a pooled client, a reserved connection and a transaction handle all share —
 * matching `src/postgres/chain-archive-rollover.ts`'s own `AnySql` convention, so a helper here can
 * be called with either the pool or the `tx` inside `sql.begin()`.
 */
export type SqlLike = ISql<{ bigint: bigint }>;

/**
 * Caches identity -> `address_map.id`. Entries are only published here AFTER the transaction that
 * wrote them commits, so a rolled-back batch cannot leave the cache asserting an id that no row
 * has.
 */
export class AddressIdCache {
  private readonly entries = new Map<string, bigint>();

  static key(identity: MidnightIdentity): string {
    return `${identity.kind}:${identity.hex.toLowerCase().replace(/^0x/, "")}`;
  }

  get(identity: MidnightIdentity): bigint | undefined {
    return this.entries.get(AddressIdCache.key(identity));
  }

  set(identity: MidnightIdentity, id: bigint): void {
    this.entries.set(AddressIdCache.key(identity), id);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Registers `identity` at first sighting and returns its `address_map.id`.
 *
 * The upsert is `ON CONFLICT (kind, identity) DO UPDATE` with a no-op SET rather than
 * `DO NOTHING`: `DO NOTHING` returns zero rows on conflict, which would force a second SELECT
 * round trip per already-known identity. The no-op update always yields the row.
 *
 * A `unique_violation` on `evm_address` is NOT caught here. Two distinct identities colliding onto
 * one 20-byte address would silently merge two accounts' balances, so it must surface as an error
 * and abort the batch.
 */
export async function resolveAddressId(
  sql: SqlLike,
  schema: string,
  identity: MidnightIdentity,
  options: { firstSeenBlock?: number; addressMapper?: AddressMapper; cache?: AddressIdCache } = {},
): Promise<bigint> {
  const cached = options.cache?.get(identity);
  if (cached !== undefined) return cached;

  const mapper = options.addressMapper ?? defaultAddressMapper;
  const evmAddress = mapper(identity);
  const identityBytes = Buffer.from(identity.hex.replace(/^0x/, ""), "hex");

  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO ${sql(schema)}.address_map (kind, identity, evm_address, first_seen_block)
    VALUES (
      ${identity.kind},
      ${identityBytes},
      ${Buffer.from(evmAddress)},
      ${options.firstSeenBlock ?? null}
    )
    ON CONFLICT (kind, identity) DO UPDATE
      SET first_seen_block = ${sql(schema)}.address_map.first_seen_block
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`address-map: upsert returned no id for ${AddressIdCache.key(identity)}`);
  }
  return id;
}

/**
 * Resolves the `address_map.id`s for a set of 20-byte EVM addresses, for `eth_getLogs`' `address`
 * filter. Unknown addresses are simply absent from the result — a filter naming an address nothing
 * ever emitted from must yield `[]`, not an error.
 */
export async function lookupAddressIds(
  sql: SqlLike,
  schema: string,
  evmAddresses: readonly Uint8Array[],
): Promise<Map<string, bigint>> {
  if (evmAddresses.length === 0) return new Map();
  const rows = await sql<{ id: bigint; evm_address: Buffer }[]>`
    SELECT id, evm_address FROM ${sql(schema)}.address_map
    WHERE evm_address IN ${sql(evmAddresses.map((a) => Buffer.from(a)))}
  `;
  return new Map(rows.map((row) => [toHex(row.evm_address), row.id]));
}

/** Reverse direction: `address_map.id` -> 20-byte EVM address, for rendering log results. */
export async function lookupAddressesByIds(
  sql: SqlLike,
  schema: string,
  ids: readonly bigint[],
): Promise<Map<string, Uint8Array>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: bigint; evm_address: Buffer }[]>`
    SELECT id, evm_address FROM ${sql(schema)}.address_map WHERE id IN ${sql(ids as bigint[])}
  `;
  return new Map(rows.map((row) => [row.id.toString(), new Uint8Array(row.evm_address)]));
}
