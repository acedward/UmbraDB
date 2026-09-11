import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";
import { encodeViewingKey, parseViewingKey, type ShieldedViewingKey } from "../../shielded-monitor/viewing-key.js";
import { PgShieldedMonitorStore, type AssociationInput } from "../../shielded-monitor/store.js";

/**
 * Shared fixtures for the project-B integration tests.
 *
 * Not a test file: no `describe`, no `it`. It exists so the store, isolation, restore and
 * harness suites build their monitors the same way, and so the one place a **fixture seed**
 * appears is marked as such.
 */

/**
 * FIXTURE SEEDS — test constants only.
 *
 * These are not keys, they are inputs to `ZswapSecretKeys.fromSeed` inside the test process, and
 * nothing derived from them is ever used on any network. They exist so a test can mint a
 * distinct, *real* viewing key on demand without a fixture file that looks like a key someone
 * could mistake for one.
 */
export function fixtureSeed(n: number): Uint8Array {
  const seed = new Uint8Array(32);
  seed.fill(n & 0xff);
  seed[0] = n & 0xff;
  seed[1] = (n >> 8) & 0xff;
  return seed;
}

/** Mints a distinct, ledger-valid viewing key for `net` from {@link fixtureSeed}. */
export async function fixtureViewingKey(n: number, net = "undeployed"): Promise<ShieldedViewingKey> {
  const { loadLedgerV8 } = await import("../../chain-archive-sync/tx-replay-decoder.js");
  const ledger = (await loadLedgerV8()) as {
    ZswapSecretKeys: {
      fromSeed(seed: Uint8Array): {
        encryptionSecretKey: { yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array };
      };
    };
  };
  const serialized = ledger.ZswapSecretKeys.fromSeed(fixtureSeed(n)).encryptionSecretKey
    .yesIKnowTheSecurityImplicationsOfThis_serialize();
  return parseViewingKey(encodeViewingKey(serialized, net), net);
}

/** The Bech32m encoding of {@link fixtureViewingKey}'s key, for tests that need the wire form
 *  (the harness reads a key from a file). */
export async function fixtureViewingKeyEncoded(n: number, net = "undeployed"): Promise<string> {
  const key = await fixtureViewingKey(n, net);
  return encodeViewingKey(key.yesIKnowTheSecurityImplicationsOfThis_serialized(), net);
}

export const TEST_LEDGER_BUILD = "ledger-v8@8.1.0-syshash.4";
export const TEST_MATCHING_RULE = "shielded-monitor/v1";

/** A store over a freshly bootstrapped schema in `container`'s database. */
export async function freshStore(
  container: StartedPostgreSqlContainer,
  schema: string,
): Promise<{ sql: UmbraDBSql; store: PgShieldedMonitorStore }> {
  const sql = createClient({ connectionString: container.getConnectionUri(), schema, maxConnections: 6 });
  await bootstrapShieldedMonitorSchema(sql, schema);
  return { sql, store: new PgShieldedMonitorStore(sql, schema) };
}

/** Registers a fixture monitor and returns it. */
export async function registerFixture(
  store: PgShieldedMonitorStore,
  seed: number,
  opts: { net?: string; startHeight?: bigint; actor?: string } = {},
): Promise<{ id: string; epoch: bigint }> {
  const net = opts.net ?? "undeployed";
  const key = await fixtureViewingKey(seed, net);
  const monitor = await store.register({
    key,
    net,
    requestedStartHeight: opts.startHeight ?? 0n,
    matchingRuleVersion: TEST_MATCHING_RULE,
    ledgerBuild: TEST_LEDGER_BUILD,
    actor: opts.actor ?? "test",
  });
  return { id: monitor.id, epoch: monitor.epoch };
}

/** A deterministic association payload for `height`/`position`. */
export function association(
  height: bigint, position: number, overrides: Partial<AssociationInput> = {},
): AssociationInput {
  const blockHash = Buffer.alloc(32);
  blockHash.writeBigUInt64BE(height, 0);
  const txHash = Buffer.alloc(32);
  txHash.writeBigUInt64BE(height, 0);
  txHash.writeUInt32BE(position, 8);
  return {
    net: "undeployed",
    blockHeight: height,
    blockHash: Uint8Array.from(blockHash),
    position,
    txHash: Uint8Array.from(txHash),
    protocolVersion: 1n,
    matchedSegments: [0],
    matchingRuleVersion: TEST_MATCHING_RULE,
    ledgerBuild: TEST_LEDGER_BUILD,
    ...overrides,
  };
}

/** A schema name unique to one test file, so suites sharing a container never collide. */
export function uniqueSchema(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * A full-content snapshot of project B's tables, used to assert "nothing changed" after a
 * rejected write. Ordered deterministically and rendered as text so a diff is readable when it
 * fails.
 */
export async function schemaSnapshot(sql: UmbraDBSql, schema: string): Promise<string> {
  const parts: string[] = [];
  for (const table of ["monitors", "associations", "lifecycle_events", "audit_events"] as const) {
    const rows = await sql<{ line: string }[]>`
      SELECT t::text AS line FROM ${sql(schema)}.${sql(table)} t ORDER BY t::text
    `;
    parts.push(`-- ${table}\n${rows.map((r) => r.line).join("\n")}`);
  }
  return parts.join("\n");
}
