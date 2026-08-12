import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { metadataRpcResult } from "./fake-node-metadata.js";

/**
 * Audit A2: ledger replay GATES ingest.
 *
 * The engine existed before this and nothing consulted it, so an archive could contain blocks the
 * reference indexer would have aborted on -- which is a parity failure, not a missing nicety.
 * Replay now runs before `putBlockBundle`, so a block the reference refuses is refused here too,
 * with nothing written.
 *
 * Restart is the other half. Ledger state is a fold from genesis, so resuming has to start
 * somewhere real: the newest `replay_checkpoints` row at or below the last archived height, or a
 * blank genesis state when there is none. Both directions are covered, plus the two ways resuming
 * can silently compute against the wrong state -- a foreign ledger build, and a height gap.
 */
const NET = "replay_gate";

function compactU32Hex(value: number): string {
  if (value < 64) return (value << 2).toString(16).padStart(2, "0");
  const v = (value << 2) | 0b01;
  return (v & 0xff).toString(16).padStart(2, "0") + ((v >> 8) & 0xff).toString(16).padStart(2, "0");
}
function bareSystemExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "06" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

const FIXTURE = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((l) => l.trim().split(/\s+/));
/** All five genesis system transactions -- the real block, which must replay cleanly. */
const GENESIS_SYSTEM_EXTRINSICS = FIXTURE.map((f) => bareSystemExtrinsicHex(f[3]!));

/** The real genesis regular transaction, payload only. Corrupting one byte of its proof leaves it
 *  deserializable but not well-formed -- the case only replay catches. */
const REGULAR_TX_HEX =
  "6d69646e696768743a7472616e73616374696f6e5b76395d287369676e61747572655b76315d2c70726f6f662c706564657273656e2d7363686e6f72725b76315d293a040051020128756e6465706c6f7965640b00203d88792d86f71b8a7a21bfe16a2bb2eab74475073fa5b773854f151ed548dba77a2c58157815f0843fc0701ec174828174fbc4e03d122b40fe97741dd131c92658f533496e48e284ce47644a1d68449ce51b8e20a4c624566827c2f437120e31ec4e628b94c4bcb7dec5a1dbd186677de26fdcacb19130f4126359efe37f471bb9c2496900";

/** Bare `pallet_midnight::send_mn_transaction` (pallet 5, call 0). */
function bareRegularExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "05" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const BLOCK_HASH = `0x${"d0".repeat(32)}`;

function fakeNodeFetch(extrinsics: string[]): typeof fetch {
  const header = {
    parentHash: `0x${"00".repeat(32)}`,
    number: "0x0",
    stateRoot: `0x${"b0".repeat(32)}`,
    extrinsicsRoot: `0x${"c0".repeat(32)}`,
    digest: { logs: [MNSV_DIGEST_V1] },
  };
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    const meta = metadataRpcResult(body.method);
    if (meta !== undefined) return reply(meta);
    switch (body.method) {
      case "chain_getBlockHash":
      case "chain_getFinalizedHead":
        return reply(BLOCK_HASH);
      case "chain_getHeader":
        return reply(header);
      case "chain_getBlock":
        return reply({ block: { header, extrinsics } });
      case "state_getStorageAt":
        return reply(null);
      case "state_call":
        return reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

describe("replay validation gates ingest", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function newSchema() {
    const schema = `replay_gate_${counter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    return schema;
  }

  const service = (schema: string, extrinsics: string[], opts: Record<string, unknown> = {}) =>
    new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(extrinsics) },
      replayValidation: true,
      replayCheckpointInterval: 1, // checkpoint every block, so one block exercises the path
      ...opts,
    });

  it("archives the real genesis block, which replays cleanly", async () => {
    const schema = await newSchema();
    await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}
    `;
    expect(rows!.n).toBe(5);
  }, 180_000);

  it("REFUSES a block replay rejects, and writes nothing", async () => {
    // The payload must DESERIALIZE and still be invalid -- that is the gap replay closes.
    // Undeserializable bytes never reach replay at all: the decode path that computes each
    // transaction's hash rejects them first, which the first run of this suite demonstrated. So
    // the case that only replay can catch is a structurally valid transaction that fails
    // validation, here the real genesis regular transaction with one byte flipped inside its proof.
    const schema = await newSchema();
    const corrupted = REGULAR_TX_HEX.replace("126359", "126959");
    await expect(
      service(schema, [bareRegularExtrinsicHex(corrupted)]).syncOnce({ maxBlocks: 1 }),
    ).rejects.toThrow(/ledger replay refuses this block/);

    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    const [txs] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}
    `;
    expect(blocks!.n, "no block row").toBe(0);
    expect(txs!.n, "no transaction row").toBe(0);
  }, 180_000);

  it("writes a checkpoint whose state is real and re-readable", async () => {
    const schema = await newSchema();
    await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });
    const rows = await sql<{ h: string; ledger_version: string; n: number }[]>`
      SELECT c.block_height::text AS h, c.ledger_version, octet_length(b.data) AS n
      FROM ${sql(schema)}.replay_checkpoints c
      JOIN ${sql(schema)}.chain_blobs b ON b.hash = c.state_blob_hash
      WHERE c.net = ${NET}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.h).toBe("0");
    expect(rows[0]!.ledger_version).toContain("8.1.0-syshash.1");
    // Real state, not an empty placeholder: a blank state is ~816 bytes, and genesis's five system
    // transactions take it to tens of kilobytes.
    expect(rows[0]!.n).toBeGreaterThan(1000);
  }, 180_000);

  it("REFUSES to resume a checkpoint written by a different ledger build", async () => {
    // Serialized state is a ledger-INTERNAL encoding. Resuming it under a build that reads it
    // differently produces wrong replay outcomes rather than an error, so the mismatch has to be
    // caught at the boundary where it is still visible.
    const schema = await newSchema();
    await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });
    await sql`
      UPDATE ${sql(schema)}.replay_checkpoints SET ledger_version = 'ledger-v8@9.9.9-other'
      WHERE net = ${NET}
    `;
    // A fresh service starting at height 1 must consult that checkpoint and refuse it.
    const resumed = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(GENESIS_SYSTEM_EXTRINSICS) },
      replayValidation: true,
    });
    await expect(
      (resumed as unknown as {
        replayBlockIfEnabled: (h: number, bh: string, hd: unknown, t: unknown[]) => Promise<void>;
      }).replayBlockIfEnabled(1, `${"d1".repeat(32)}`, { parentHash: BLOCK_HASH }, []),
    ).rejects.toThrow(/written by ledger build .* but this process uses/);
  }, 180_000);

  it("REFUSES to replay a block out of order", async () => {
    // Replay is a fold over consecutive blocks: applying N+2 to a state that stopped at N computes
    // against a state that never existed, and nothing downstream would show it.
    const schema = await newSchema();
    const svc = service(schema, GENESIS_SYSTEM_EXTRINSICS);
    await svc.syncOnce({ maxBlocks: 1 }); // replay is now at height 0
    await expect(
      (svc as unknown as {
        replayBlockIfEnabled: (h: number, bh: string, hd: unknown, t: unknown[]) => Promise<void>;
      }).replayBlockIfEnabled(5, `${"d5".repeat(32)}`, { parentHash: BLOCK_HASH }, []),
    ).rejects.toThrow(/expected 1|Refusing/);
  }, 180_000);

  it("leaves ingest untouched when replay validation is off", async () => {
    // Off by default: it is strictly slower and requires an unbroken run from genesis, so it must
    // be a deliberate choice. The garbage payload that replay refuses is archived without it.
    const schema = await newSchema();
    const corrupted = REGULAR_TX_HEX.replace("126359", "126959");
    const svc = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: {
        url: "http://fake-node", fetchImpl: fakeNodeFetch([bareRegularExtrinsicHex(corrupted)]),
      },
    });
    // The transaction replay rejects is archived without it -- which is precisely why A2 called
    // the un-wired engine a parity failure rather than a missing nicety.
    await svc.syncOnce({ maxBlocks: 1 });
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}
    `;
    expect(rows!.n).toBe(1);
  }, 180_000);
});
