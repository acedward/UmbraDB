import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { metadataRpcResult } from "./fake-node-metadata.js";

/** Must match `LEDGER_STATE_VERSION` in the sync service -- a checkpoint row written by hand has
 *  to look valid in every respect except the one under test. */
const LEDGER_VERSION = "ledger-v8@8.1.0-syshash.2";

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
/**
 * Genesis's `Timestamp::set` inherent (T1).
 *
 * The target 1.0 node ALWAYS emits this in genesis; the committed devnet genesis decodes to
 * 1754395200000 ms (2025-08-05T12:00:00Z). Leaving it out of this fixture is what hid the genesis
 * timestamp bug through two audit rounds: the code exempted genesis from the timestamp
 * requirement, the fixture omitted the inherent, and the two agreed with each other. The suite was
 * green because it was testing a chain that does not exist.
 *
 * Byte layout is identical to the real height-45 inherent (`0x280501000be07b93d89f01` in
 * `runtime-metadata.test.ts`) -- same compact length, same pallet 1 / call 0, same Compact<u64>
 * big-integer mode -- differing only in the encoded value.
 */
const GENESIS_TIMESTAMP_MS = 1754395200000;
const GENESIS_TIMESTAMP_INHERENT = "0x280501000b004a1a7a9801";

/** All five genesis system transactions plus the timestamp inherent every real genesis carries. */
const GENESIS_SYSTEM_EXTRINSICS = [
  GENESIS_TIMESTAMP_INHERENT,
  ...FIXTURE.map((f) => bareSystemExtrinsicHex(f[3]!)),
];

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

/**
 * A fake node serving a two-block chain, which single-block fixtures cannot express.
 *
 * Needed for T1: a checkpoint's stored parent timestamp is only consulted when a LATER block is
 * replayed by a DIFFERENT process instance. One block, or one process, cannot show it.
 */
const HEIGHT_1_HASH = `0x${"d1".repeat(32)}`;
/** Genesis + 6 seconds, encoded the same way. Verified in `runtime-metadata.test.ts`. */
const HEIGHT_1_TIMESTAMP_MS = 1754395206000;
const HEIGHT_1_TIMESTAMP_INHERENT = "0x280501000b70611a7a9801";

const HEIGHT_2_HASH = `0x${"d2".repeat(32)}`;
const HEIGHT_2_TIMESTAMP_MS = 1754395212000;
const HEIGHT_2_TIMESTAMP_INHERENT = "0x280501000be0781a7a9801";

/** Lets a test fault `chain_getBlock` for one specific hash, to inject a failure during replay
 *  catch-up -- which reads archived blocks back from the node. */
interface NodeFault { failGetBlockFor?: string }

function chainNodeFetch(
  genesisExtrinsics: string[],
  opts: { head?: string; fault?: NodeFault } = {},
): typeof fetch {
  const head = opts.head ?? HEIGHT_1_HASH;
  const fault = opts.fault ?? {};
  const headers: Record<string, Record<string, unknown>> = {
    [BLOCK_HASH]: {
      parentHash: `0x${"00".repeat(32)}`, number: "0x0",
      stateRoot: `0x${"b0".repeat(32)}`, extrinsicsRoot: `0x${"c0".repeat(32)}`,
      digest: { logs: [MNSV_DIGEST_V1] },
    },
    [HEIGHT_1_HASH]: {
      parentHash: BLOCK_HASH, number: "0x1",
      stateRoot: `0x${"b1".repeat(32)}`, extrinsicsRoot: `0x${"c1".repeat(32)}`,
      digest: { logs: [MNSV_DIGEST_V1] },
    },
    [HEIGHT_2_HASH]: {
      parentHash: HEIGHT_1_HASH, number: "0x2",
      stateRoot: `0x${"b2".repeat(32)}`, extrinsicsRoot: `0x${"c2".repeat(32)}`,
      digest: { logs: [MNSV_DIGEST_V1] },
    },
  };
  // Heights 1 and 2 carry only their timestamp inherent: an empty block still exercises the fold,
  // and there is no second real regular transaction that applies cleanly to the advanced state.
  const extrinsics: Record<string, string[]> = {
    [BLOCK_HASH]: genesisExtrinsics,
    [HEIGHT_1_HASH]: [HEIGHT_1_TIMESTAMP_INHERENT],
    [HEIGHT_2_HASH]: [HEIGHT_2_TIMESTAMP_INHERENT],
  };
  const byNumber = [BLOCK_HASH, HEIGHT_1_HASH, HEIGHT_2_HASH];
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    const meta = metadataRpcResult(body.method);
    if (meta !== undefined) return reply(meta);
    switch (body.method) {
      case "chain_getBlockHash": {
        const n = body.params?.[0];
        if (n === undefined || n === null) return reply(head);
        return reply(byNumber[Number(n)] ?? null);
      }
      case "chain_getFinalizedHead":
        return reply(head);
      case "chain_getHeader":
        return reply(headers[String(body.params?.[0] ?? head)] ?? headers[head]);
      case "chain_getBlock": {
        const h = String(body.params?.[0] ?? head);
        if (fault.failGetBlockFor !== undefined && h === fault.failGetBlockFor) {
          return new Response("injected node failure", { status: 503 });
        }
        return reply({ block: { header: headers[h], extrinsics: extrinsics[h] ?? [] } });
      }
      case "state_getStorageAt":
        return reply(null);
      case "state_call":
        return reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

/** Back-compat alias for the two-block cases written before height 2 existed. */
const twoBlockNodeFetch = (genesisExtrinsics: string[]) => chainNodeFetch(genesisExtrinsics);

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
      ledgerNetworkId: "undeployed", // the LEDGER's network id, not this archive's `net` label
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
    // The timestamp inherent is present because a real genesis has one -- otherwise this block is
    // refused for the missing timestamp instead, and the assertion below would pass while never
    // reaching replay at all.
    await expect(
      service(schema, [GENESIS_TIMESTAMP_INHERENT, bareRegularExtrinsicHex(corrupted)])
        .syncOnce({ maxBlocks: 1 }),
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

  /**
   * T1: block time is decoded, never guessed -- including at genesis, and including across a
   * restart.
   *
   * The bug this covers survived two audit rounds because the synthetic fixtures agreed with it:
   * the code exempted genesis from needing a `Timestamp::set`, and the fixtures omitted one, so
   * the suite was green about a chain that does not exist. The fixtures now carry the inherent the
   * target node actually emits.
   */
  describe("block time (T1)", () => {
    it("REFUSES genesis with no Timestamp::set -- genesis is not exempt", async () => {
      // The whole finding in one assertion. The target 1.0 node always emits this inherent at
      // genesis, so its absence is a decode failure, not a property of genesis. Before the fix
      // this block was accepted and folded at time 0 -- roughly 55 years early -- seeding every
      // later state from a genesis that never existed.
      const schema = await newSchema();
      const withoutTimestamp = FIXTURE.map((f) => bareSystemExtrinsicHex(f[3]!));
      await expect(
        service(schema, withoutTimestamp).syncOnce({ maxBlocks: 1 }),
      ).rejects.toThrow(/height 0: no Timestamp::set inherent/);

      const [blocks] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
      `;
      expect(blocks!.n, "a refused block writes nothing").toBe(0);
    }, 180_000);

    it("stores the checkpointed block's own timestamp", async () => {
      const schema = await newSchema();
      await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });
      const [row] = await sql<{ ts: string }[]>`
        SELECT block_timestamp_ms::text AS ts
        FROM ${sql(schema)}.replay_checkpoints WHERE net = ${NET} AND block_height = 0
      `;
      // The exact decoded value, not merely "not null": a checkpoint carrying a plausible-looking
      // wrong time is the failure mode, and it is the one nothing else would notice.
      expect(row?.ts).toBe(String(GENESIS_TIMESTAMP_MS));
    }, 180_000);

    it("resumes with the checkpointed parent time, in a SEPARATE service instance", async () => {
      // The restart bug proper. `lastBlockTime` lives in memory during a run, so a single process
      // always has it and no single-run test can miss it. What was broken is the value a NEW
      // process starts with: the checkpoint stored no timestamp, so the first block after a
      // restart was folded against a parent dated 1970.
      //
      // This is observable only because the missing case now THROWS rather than defaulting to
      // zero. If the checkpoint did not restore the timestamp, replaying height 1 raises "replay
      // has no timestamp for the parent block" -- so height 1 completing at all is the evidence.
      const schema = await newSchema();
      const node = { url: "http://fake-node", fetchImpl: twoBlockNodeFetch(GENESIS_SYSTEM_EXTRINSICS) };
      const common = {
        sql, net: NET, schema, node,
        replayValidation: true,
        ledgerNetworkId: "undeployed",
        replayCheckpointInterval: 1,
      };

      // Process 1: genesis only, then exit. Its in-memory parent time dies with it.
      await new ChainArchiveSyncService(common).syncOnce({ maxBlocks: 1 });
      const [cp] = await sql<{ h: string; ts: string }[]>`
        SELECT block_height::text AS h, block_timestamp_ms::text AS ts
        FROM ${sql(schema)}.replay_checkpoints WHERE net = ${NET} ORDER BY block_height DESC LIMIT 1
      `;
      expect(cp?.h).toBe("0");

      // Process 2: a genuinely fresh instance, which must recover the parent time from storage.
      await new ChainArchiveSyncService(common).syncOnce({ maxBlocks: 1 });

      const [after] = await sql<{ h: string; ts: string }[]>`
        SELECT block_height::text AS h, block_timestamp_ms::text AS ts
        FROM ${sql(schema)}.replay_checkpoints WHERE net = ${NET} ORDER BY block_height DESC LIMIT 1
      `;
      expect(after?.h, "the resumed run must have replayed and checkpointed height 1").toBe("1");
      expect(after?.ts).toBe(String(HEIGHT_1_TIMESTAMP_MS));
    }, 180_000);
  });

  /**
   * T2: a checkpoint is bound to the LEDGER NETWORK it was folded under.
   *
   * The pre-existing guard compared `ledger_version` only. Every checkpoint ever written carries
   * the same marker for a given build regardless of network, so that check cannot distinguish a
   * checkpoint from another chain -- and the network embedded in the serialized state was trusted
   * implicitly while the configured `ledgerNetworkId` was never consulted at all.
   */
  it("REFUSES a checkpoint written for a different ledger network (T2)", async () => {
    const schema = await newSchema();
    await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });

    // Rewrite the stored checkpoint as if another network had produced it. Everything else --
    // ledger_version included -- stays exactly as a valid checkpoint, which is the point: the
    // build marker cannot tell these apart, so only an explicit network check can.
    await sql`
      UPDATE ${sql(schema)}.replay_checkpoints
      SET ledger_network_id = 'devnet' WHERE net = ${NET} AND block_height = 0
    `;

    const node = { url: "http://fake-node", fetchImpl: twoBlockNodeFetch(GENESIS_SYSTEM_EXTRINSICS) };
    await expect(
      new ChainArchiveSyncService({
        sql, net: NET, schema, node,
        replayValidation: true,
        ledgerNetworkId: "undeployed",
        replayCheckpointInterval: 1,
      }).syncOnce({ maxBlocks: 1 }),
    ).rejects.toThrow(/written for ledger network "devnet".*configured for "undeployed"/s);
  }, 180_000);

  /**
   * T5: checkpoint selection follows the CANONICAL chain.
   *
   * Migration 004 keys checkpoints by `(net, height, block_hash)` specifically so competing forks
   * are distinguishable, but selection filtered on `(net, height)` alone -- so the newest row won
   * even when its block had been orphaned, and replay would fold canonical successors onto a state
   * that forked away from them.
   */
  it("selects the canonical checkpoint, not a higher orphaned one (T5)", async () => {
    const schema = await newSchema();
    await service(schema, GENESIS_SYSTEM_EXTRINSICS).syncOnce({ maxBlocks: 1 });

    // An orphaned block at height 1 carrying its own checkpoint. It is HIGHER than the canonical
    // genesis checkpoint, so a height-only selection prefers it -- which is the bug.
    const orphanHash = Buffer.from("ee".repeat(32), "hex");
    const orphanState = Buffer.from("orphan-ledger-state-bytes");
    const orphanBlobHash = createHash("sha256").update(orphanState).digest();
    await sql`
      INSERT INTO ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root,
         header_blob_hash, body_blob_hash, is_canonical, status, finalized)
      SELECT ${NET}, ${orphanHash}, 1, b.block_hash, ${Buffer.alloc(32, 0xb2)},
             ${Buffer.alloc(32, 0xc2)}, b.header_blob_hash, b.body_blob_hash, false, 'orphaned', false
      FROM ${sql(schema)}.blocks b WHERE b.net = ${NET} AND b.height = 0
    `;
    await sql`
      INSERT INTO ${sql(schema)}.chain_blobs (hash, data) VALUES (${orphanBlobHash}, ${orphanState})
      ON CONFLICT (hash) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(schema)}.chain_blob_roles (blob_hash, role)
      VALUES (${orphanBlobHash}, 'ledger_state') ON CONFLICT (blob_hash, role) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(schema)}.replay_checkpoints
        (net, block_height, block_hash, state_blob_hash, ledger_version, block_timestamp_ms,
         ledger_network_id)
      VALUES (${NET}, 1, ${orphanHash}, ${orphanBlobHash}, ${LEDGER_VERSION},
              ${HEIGHT_1_TIMESTAMP_MS}, 'undeployed')
    `;

    const store = new PgChainArchiveStore(sql, schema);
    const chosen = await store.getLatestReplayCheckpoint(NET, 10);
    // Height 0, not 1: the orphan is newer and would win on height alone.
    expect(chosen?.blockHeight, "must not select the orphaned checkpoint").toBe(0);
    expect(Buffer.from(chosen!.stateBytes).equals(orphanState)).toBe(false);
  }, 180_000);

  /**
   * T3: replay must not be left ahead of what is durable.
   *
   * The auditor reproduced this with an injected first-write failure, so the test does the same
   * rather than mocking the store: a trigger makes the real `putBlockBundle` fail inside Postgres,
   * which is the production write path, not a stand-in for it.
   */
  it("recovers from a durable-write failure instead of wedging on the height (T3)", async () => {
    const schema = await newSchema();
    // Genesis first, so there is a checkpoint to fall back to and the failure lands on height 1 --
    // the case where replay has genuinely advanced past what is stored.
    const node = { url: "http://fake-node", fetchImpl: twoBlockNodeFetch(GENESIS_SYSTEM_EXTRINSICS) };
    const common = {
      sql, net: NET, schema, node,
      replayValidation: true,
      ledgerNetworkId: "undeployed",
      replayCheckpointInterval: 1,
    };
    const svc = new ChainArchiveSyncService(common);
    await svc.syncOnce({ maxBlocks: 1 });

    // Inject the failure at the database, on the real insert path.
    await sql`
      CREATE FUNCTION ${sql(schema)}.fail_block_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'injected durable-write failure' USING ERRCODE = 'serialization_failure';
      END;
      $fn$
    `;
    await sql`
      CREATE TRIGGER fail_block_insert_trigger BEFORE INSERT ON ${sql(schema)}.blocks
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.fail_block_insert()
    `;

    // THE SAME service instance, because the wedge was an in-memory condition: replay advanced to
    // height 1 while nothing about height 1 was written.
    await expect(svc.syncOnce({ maxBlocks: 1 })).rejects.toThrow(/injected durable-write failure/);

    await sql`DROP TRIGGER fail_block_insert_trigger ON ${sql(schema)}.blocks`;

    // Before the fix this threw "replay validation is at height 1 but this block is 1", forever:
    // the engine sat one block ahead of the archive and nothing could move the archive to match.
    await svc.syncOnce({ maxBlocks: 1 });

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET} AND height = 1
    `;
    expect(row!.n, "height 1 must be archived after the retry").toBe(1);
    const [cp] = await sql<{ h: string }[]>`
      SELECT block_height::text AS h FROM ${sql(schema)}.replay_checkpoints
      WHERE net = ${NET} ORDER BY block_height DESC LIMIT 1
    `;
    expect(cp?.h, "replay must have advanced with the archive").toBe("1");
  }, 180_000);

  it("recovers from a failure PARTWAY THROUGH replay catch-up (T5)", async () => {
    // The other half of T5. `replayCatchUpFrom` is cleared before the catch-up loop runs, so a
    // failure inside the loop left the engine resumed-but-not-caught-up with catch-up already
    // marked done. Every later attempt skipped catch-up and refused on the height gap -- the same
    // permanent wedge as T3, reached by a different route.
    //
    // Catch-up only happens when the newest checkpoint is BELOW the resume point, so the interval
    // here is large enough that only genesis is checkpointed, leaving height 1 archived but not
    // checkpointed and height 2 needing catch-up over it.
    const schema = await newSchema();
    const fault: NodeFault = {};
    const common = {
      sql, net: NET, schema,
      replayValidation: true,
      ledgerNetworkId: "undeployed",
      replayCheckpointInterval: 1000, // only height 0 satisfies height % interval === 0
    };

    // Process 1: archive heights 0 and 1. Checkpoint exists at 0 only.
    await new ChainArchiveSyncService({
      ...common,
      node: { url: "http://fake-node", fetchImpl: chainNodeFetch(GENESIS_SYSTEM_EXTRINSICS) },
    }).syncOnce({ maxBlocks: 2 });
    const [before] = await sql<{ h: string }[]>`
      SELECT block_height::text AS h FROM ${sql(schema)}.replay_checkpoints
      WHERE net = ${NET} ORDER BY block_height DESC LIMIT 1
    `;
    expect(before?.h, "only genesis should be checkpointed").toBe("0");

    // Process 2: fresh instance, head at height 2, so ingesting it must first catch up over
    // height 1 -- which is exactly the read this fault breaks.
    const svc = new ChainArchiveSyncService({
      ...common,
      node: {
        url: "http://fake-node",
        fetchImpl: chainNodeFetch(GENESIS_SYSTEM_EXTRINSICS, { head: HEIGHT_2_HASH, fault }),
      },
    });
    fault.failGetBlockFor = HEIGHT_1_HASH;
    await expect(svc.syncOnce({ maxBlocks: 1 })).rejects.toThrow();

    // Fault cleared: the retry must rebuild from the checkpoint and catch up properly. Before the
    // fix it threw "replay validation is at height 0 but this block is 2" on every attempt.
    delete fault.failGetBlockFor;
    await svc.syncOnce({ maxBlocks: 1 });

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET} AND height = 2
    `;
    expect(row!.n, "height 2 must be archived after the retry").toBe(1);
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
    expect(rows[0]!.ledger_version).toContain("8.1.0-syshash.2");
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
      ledgerNetworkId: "undeployed",
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
