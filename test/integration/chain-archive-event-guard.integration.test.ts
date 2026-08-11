import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { metadataRpcResult } from "./fake-node-metadata.js";

/**
 * Runtime-generated system transactions are ARCHIVED, in the reference's order.
 *
 * This suite used to assert the opposite: that ingest detected an event-borne system transaction
 * it could not decode and refused the block. That was the honest interim -- refusing beats
 * silently omitting, since `ON CONFLICT DO NOTHING` makes an incomplete archive unrepairable --
 * but it was never the goal. With the block's own runtime metadata, the transaction is decoded and
 * stored, so the refusal it was written to prove no longer happens.
 *
 * Two properties matter here, and neither is about counting:
 *
 *   1. the transaction is archived under the hash the RUNTIME reported, with its exact payload;
 *   2. it is positioned BEFORE the extrinsic-derived transactions. Substrate applies inherents
 *      first, and the reference prepends them (`runtimes/v1_0_0.rs:160-163`). Position is part of
 *      this archive's contract, so getting the order wrong makes two archives holding the same
 *      transactions non-interchangeable.
 *
 * A fake node is used deliberately: no reachable devnet emits runtime-generated system
 * transactions (v1.0.0 block rewards are zero and its reward pallet is disabled), so waiting for a
 * live specimen would leave this permanently unverified. The bytes are real -- the payloads come
 * from the indexer ground-truth fixture and the metadata is a real node capture.
 */
const NET = "event_ingest";

function compactU32Hex(value: number): string {
  if (value < 64) return (value << 2).toString(16).padStart(2, "0");
  if (value < 2 ** 14) {
    const v = (value << 2) | 0b01;
    return (v & 0xff).toString(16).padStart(2, "0") + ((v >> 8) & 0xff).toString(16).padStart(2, "0");
  }
  const v = (value << 2) | 0b10;
  return [0, 8, 16, 24].map((s) => ((v >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
}

/** Bare `pallet_midnight_system::send_mn_system_transaction` (pallet 6, call 0). */
function bareSystemExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "06" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

/** Two DIFFERENT real serialized system transactions, from the indexer ground-truth fixture. */
const FIXTURE = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((l) => l.trim().split(/\s+/));
const EXTRINSIC_TX_HEX = FIXTURE[0]![3]!;
const EVENT_TX_HEX = FIXTURE[1]![3]!;
const EVENT_TX_HASH = FIXTURE[1]![2]!.toLowerCase();
const EXTRINSIC_TX_HASH = FIXTURE[0]![2]!.toLowerCase();

const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const BLOCK_HASH = `0x${"e0".repeat(32)}`;

/** A `System::Events` blob carrying one `SystemTransactionApplied`, hand-encoded as a node emits
 *  it: `EventRecord { phase, event(pallet, variant, fields), topics }`. */
function eventsBlobHex(hashHex: string, payloadHex: string): string {
  const inner =
    "00" + "03000000" +                                   // phase = ApplyExtrinsic(3)
    "0600" +                                              // MidnightSystem::SystemTransactionApplied
    hashHex +                                             // hash_: [u8;32]
    compactU32Hex(payloadHex.length / 2) + payloadHex +   // serializedSystemTransaction
    "00";                                                 // topics: []
  return "0x" + compactU32Hex(1) + inner;
}

function fakeNodeFetch(opts: { events?: string; extrinsics: string[] }): typeof fetch {
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
        status: 200,
        headers: { "Content-Type": "application/json" },
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
        return reply({ block: { header, extrinsics: opts.extrinsics } });
      case "state_getStorageAt":
        return reply(opts.events ?? null);
      case "state_call":
        return reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

describe("event-borne system transactions are archived, event-first", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function ingest(opts: { events?: string; extrinsics: string[] }) {
    const schema = `event_ingest_${schemaCounter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(opts) },
    });
    await service.syncOnce({ maxBlocks: 1 });
    const rows = await sql<{ position: number; tx_hash: string; kind: string; raw: string }[]>`
      SELECT t.position, encode(t.tx_hash, 'hex') AS tx_hash, t.kind, encode(b.data, 'hex') AS raw
      FROM ${sql(schema)}.transactions t
      JOIN ${sql(schema)}.chain_blobs b ON b.hash = t.raw_blob_hash
      WHERE t.net = ${NET} ORDER BY t.position
    `;
    return rows;
  }

  it("archives an event-only system transaction under the runtime's own hash", async () => {
    const rows = await ingest({
      events: eventsBlobHex(EVENT_TX_HASH, EVENT_TX_HEX),
      extrinsics: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("system");
    // The hash the runtime reported, not one recomputed here -- this is the key the reference uses.
    expect(rows[0]!.tx_hash).toBe(EVENT_TX_HASH);
    expect(rows[0]!.raw).toBe(EVENT_TX_HEX);
  }, 180_000);

  it("places event-borne transactions BEFORE extrinsic-derived ones", async () => {
    // The ordering rule, which is the behaviour-changing part of this stage. Substrate applies
    // inherents before regular transactions, and the reference prepends them; a block carrying
    // both must therefore number the event-borne one 0 and the extrinsic-borne one 1.
    const rows = await ingest({
      events: eventsBlobHex(EVENT_TX_HASH, EVENT_TX_HEX),
      extrinsics: [bareSystemExtrinsicHex(EXTRINSIC_TX_HEX)],
    });
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[0]!.tx_hash).toBe(EVENT_TX_HASH);
    expect(rows[1]!.tx_hash).toBe(EXTRINSIC_TX_HASH);
  }, 180_000);

  it("stores BOTH copies when one transaction is present in each source", async () => {
    // The dual-source case the position re-key exists for: the same system transaction reaches the
    // node as an extrinsic AND as an event. The reference stores two rows and does not
    // deduplicate, so parity means two rows here -- the event-borne copy first.
    const rows = await ingest({
      events: eventsBlobHex(EXTRINSIC_TX_HASH, EXTRINSIC_TX_HEX),
      extrinsics: [bareSystemExtrinsicHex(EXTRINSIC_TX_HEX)],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tx_hash)).toEqual([EXTRINSIC_TX_HASH, EXTRINSIC_TX_HASH]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  }, 180_000);

  it("archives an ordinary block with no events unchanged", async () => {
    const rows = await ingest({ extrinsics: [bareSystemExtrinsicHex(EXTRINSIC_TX_HEX)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(0);
    expect(rows[0]!.tx_hash).toBe(EXTRINSIC_TX_HASH);
  }, 180_000);
});
