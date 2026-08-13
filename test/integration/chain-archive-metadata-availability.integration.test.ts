import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { FIXTURE_METADATA_HEX, FIXTURE_RUNTIME_VERSION } from "./fake-node-metadata.js";

/**
 * Stage 2b: the archive keeps its own metadata, so it can decode its history without the node
 * still serving it.
 *
 * The problem this closes (plan B7): decoding a block needs the metadata of the runtime that
 * produced it, and that metadata derives from historical STATE. A pruned node cannot serve it, so
 * ingesting an old range through one refused. For a chain whose history is pruned everywhere, a
 * prior capture is the only possible source -- the bytes exist nowhere else.
 *
 * Three properties, each its own test rather than one flow, so a failure says which guarantee
 * broke:
 *
 *   1. ingest persists the runtime's metadata the first time it sees that runtime;
 *   2. a later sync uses the stored copy and asks the node for nothing;
 *   3. a PRUNED node -- one that serves blocks but refuses all historical state -- still ingests,
 *      falling back to the committed capture registry keyed on the header's MNSV version.
 */
const NET = "meta_avail";

function compactU32Hex(value: number): string {
  if (value < 64) return (value << 2).toString(16).padStart(2, "0");
  const v = (value << 2) | 0b01;
  return (v & 0xff).toString(16).padStart(2, "0") + ((v >> 8) & 0xff).toString(16).padStart(2, "0");
}

function bareSystemExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "06" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

const REAL_SYSTEM_TX_HEX = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n")[0]!.trim().split(/\s+/)[3]!;

const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const BLOCK_HASH = `0x${"f0".repeat(32)}`;

/** A node that answers block queries but refuses everything derived from historical state --
 *  exactly how a pruned node behaves for an old range. `served` records what it was asked. */
function fakeNode(opts: { pruned: boolean; served: string[] }): typeof fetch {
  const header = {
    parentHash: `0x${"00".repeat(32)}`,
    number: "0x0",
    stateRoot: `0x${"b0".repeat(32)}`,
    extrinsicsRoot: `0x${"c0".repeat(32)}`,
    digest: { logs: [MNSV_DIGEST_V1] },
  };
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    opts.served.push(body.method);
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    const fail = () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0", id: body.id,
          error: { code: -32000, message: "State already discarded for this block" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    switch (body.method) {
      case "chain_getBlockHash":
      case "chain_getFinalizedHead":
        return reply(BLOCK_HASH);
      case "chain_getHeader":
        return reply(header);
      case "chain_getBlock":
        return reply({ block: { header, extrinsics: [bareSystemExtrinsicHex(REAL_SYSTEM_TX_HEX)] } });
      // Everything below is derived from historical state.
      case "state_getRuntimeVersion":
        return opts.pruned ? fail() : reply(FIXTURE_RUNTIME_VERSION);
      case "state_getMetadata":
        return opts.pruned ? fail() : reply(FIXTURE_METADATA_HEX);
      case "state_getStorageAt":
        return opts.pruned ? fail() : reply(null);
      case "state_call":
        return opts.pruned ? fail() : reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

describe("metadata availability", () => {
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
    const schema = `meta_avail_${counter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    return schema;
  }

  const service = (schema: string, served: string[], pruned = false) =>
    new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNode({ pruned, served }) },
    });

  it("persists the runtime's metadata on first sight", async () => {
    const schema = await newSchema();
    const served: string[] = [];
    await service(schema, served).syncOnce({ maxBlocks: 1 });

    const rows = await sql<{ spec_name: string; spec_version: string; first_seen_height: string; n: number }[]>`
      SELECT rm.spec_name, rm.spec_version::text, rm.first_seen_height::text,
             octet_length(b.data) AS n
      FROM ${sql(schema)}.runtime_metadata rm
      JOIN ${sql(schema)}.chain_blobs b ON b.hash = rm.metadata_blob_hash
      WHERE rm.net = ${NET}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spec_name).toBe(FIXTURE_RUNTIME_VERSION.specName);
    expect(rows[0]!.spec_version).toBe(String(FIXTURE_RUNTIME_VERSION.specVersion));
    // The height that introduced the runtime, not whatever a later re-sync reached.
    expect(rows[0]!.first_seen_height).toBe("0");
    // The real metadata, byte-for-byte -- not a truncated or re-encoded copy.
    expect(rows[0]!.n).toBe((FIXTURE_METADATA_HEX.length - 2) / 2);
  }, 180_000);

  it("reuses the stored capture instead of re-fetching from the node", async () => {
    const schema = await newSchema();
    await service(schema, []).syncOnce({ maxBlocks: 1 });

    // A second service over the same archive: the metadata is already there, so the node should
    // never be asked for it again. This is what makes the archive self-describing.
    const served: string[] = [];
    await service(schema, served).syncOnce({ maxBlocks: 1 });
    expect(served).not.toContain("state_getMetadata");
    // Still exactly one row -- the second pass must not duplicate or overwrite the capture.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.runtime_metadata WHERE net = ${NET}
    `;
    expect(count!.n).toBe(1);
  }, 180_000);

  it("on a PRUNED node, metadata is no longer what fails -- but ingest still cannot complete", async () => {
    // The honest scope of §13, established by running it rather than by assuming.
    //
    // The capture registry does remove metadata as a blocker: this node refuses
    // state_getRuntimeVersion AND state_getMetadata, and resolution still succeeds via the
    // header's MNSV version, which is why the registry's coarse key is deliberate. But ingest of
    // a pruned range still fails, and it must -- `System::Events` (where runtime-generated system
    // transactions live) and the D-parameter `state_call` are themselves historical state. No
    // capture can substitute for them: they are per-block facts, not per-runtime ones.
    //
    // So Stage 2b's real value is NOT "pruned nodes can ingest history". It is that the archive
    // becomes self-describing -- re-decoding bytes it already holds, and Stage 4 replay, need no
    // node at all. Fresh ingest of pruned history remains impossible from any source.
    const schema = await newSchema();
    const served: string[] = [];
    await expect(service(schema, served, true).syncOnce({ maxBlocks: 1 })).rejects.toThrow(
      // The failure names the state that is genuinely gone, not metadata.
      /state_getStorageAt|State already discarded/,
    );
    // It asked for the runtime's identity, that failed, and it then went straight to the registry
    // WITHOUT requesting metadata. That is right rather than lazy: without an identity there is no
    // key to cache or persist a fetched copy under, and on a pruned node both calls read the same
    // discarded state anyway, so the second request could only fail too.
    expect(served).toContain("state_getRuntimeVersion");
    expect(served).not.toContain("state_getMetadata");
    // Nothing durable from a failed block.
    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    expect(blocks!.n).toBe(0);
  }, 180_000);

  it("propagates a TRANSPORT failure instead of silently using the registry (audit A3)", async () => {
    // The bug this pins: the runtimeVersionAt catch swallowed every error, so a connection reset
    // or timeout degraded resolution to the coarse committed registry -- keyed by protocol range,
    // not by the runtime's own identity -- and ingest carried on as if nothing had happened. A
    // network blip must not quietly change which metadata decodes a block, because nothing in the
    // resulting archive shows that it did. Only a node that ANSWERED "state is gone" earns the
    // fallback.
    const schema = await newSchema();
    // Healthy for everything except the one call the fallback hinges on, which fails the way a
    // network does -- not the way a pruned node does. If this were treated as "state is gone",
    // the block would decode against registry metadata and nothing afterwards would show it.
    const served: string[] = [];
    const base = fakeNode({ pruned: false, served });
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "state_getRuntimeVersion") throw new Error("fetch failed: ECONNRESET");
      return base(input, init);
    }) as typeof fetch;
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema, node: { url: "http://fake-node", fetchImpl: flaky },
    });
    // The RPC client wraps transport failures with the method name, so match on that rather than
    // the inner text -- what matters is that it SURFACES at all instead of being swallowed.
    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow(/state_getRuntimeVersion/);
    // And nothing durable from the refused block.
    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    expect(blocks!.n).toBe(0);
  }, 180_000);

  it("propagates a TRANSPORT failure at the SECOND call site too (T7)", async () => {
    // The test above faults `state_getRuntimeVersion`, the FIRST of the two calls that can fall
    // back. Because it fails before the second is ever reached, restoring the bug at
    // `state_getMetadata` -- twelve lines away in the same method -- left that test green. That is
    // exactly how the missed call site survived the round that claimed to fix it.
    //
    // So this one lets `state_getRuntimeVersion` SUCCEED and faults `state_getMetadata`, which is
    // the only arrangement that reaches the second catch at all.
    const schema = await newSchema();
    const served: string[] = [];
    const base = fakeNode({ pruned: false, served });
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "state_getMetadata") throw new Error("fetch failed: ECONNRESET");
      return base(input, init);
    }) as typeof fetch;
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema, node: { url: "http://fake-node", fetchImpl: flaky },
    });
    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow(/state_getMetadata/);
    // Proof the first call really did succeed -- otherwise this test would be a duplicate of the
    // one above, passing for the wrong reason.
    expect(served).toContain("state_getRuntimeVersion");

    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    expect(blocks!.n, "a transport failure must archive nothing").toBe(0);
  }, 180_000);

  /**
   * The pruning classifier, tested where it actually decides.
   *
   * An earlier version of this asserted through `syncOnce` that no block was archived. That was
   * VACUOUS: ingest on a pruned node also fails for an unrelated reason (`System::Events` needs
   * the same historical state), so the block count was zero either way. Verified by mutation --
   * restoring `/unknown block/i` left the whole file green. These call the resolver directly, so
   * the only thing deciding the outcome is the classification under test.
   */
  describe("historical-state classification (T7)", () => {
    const AMBIGUOUS = "Client error: UnknownBlock: Unknown block: State unavailable";
    const UNAMBIGUOUS = "State already discarded for this block";

    const resolverFor = async (message: string) => {
      const { BlockScopedMetadata } = await import("../../chain-archive-sync/runtime-metadata.js");
      const node = {
        runtimeVersionAt: async () => { throw new Error(message); },
        metadataAt: async () => { throw new Error(message); },
      };
      return new BlockScopedMetadata(node as never);
    };

    it("REFUSES on an ambiguous 'Unknown block' instead of falling back", async () => {
      // A node says "Unknown block" both for state it has pruned AND for a hash it has never seen
      // -- a block from another chain, a fork it did not follow, a typo. Accepting it as pruning
      // meant an unrecognised hash silently selected the committed capture for the header's
      // protocol version and decoded the block against it: the precise failure this resolution
      // chain exists to prevent, reached by claiming to have detected pruning.
      //
      // Protocol version 1_000_000 is deliberately one the registry DOES cover, so the fallback
      // would succeed if it were taken. A version with no capture would refuse anyway and prove
      // nothing.
      //
      // The node's own error PROPAGATES -- resolution does not reach its final "tried everything"
      // refusal, because an unclassified failure is not a reason to keep looking. That is the
      // distinguishing outcome: were "unknown block" still accepted as pruning, this call would
      // RESOLVE successfully from the registry rather than throw at all.
      const resolver = await resolverFor(AMBIGUOUS);
      await expect(resolver.forBlock(BLOCK_HASH, 1_000_000)).rejects.toThrow(/Unknown block/);
    }, 60_000);

    it("still falls back for an UNAMBIGUOUS pruning signal", async () => {
      // The counterweight, on the same protocol version. Without it, the assertion above would
      // also pass on a resolver that never falls back at all -- which would make the committed
      // capture registry, and the pruned-node bootstrap it exists for, dead code.
      const resolver = await resolverFor(UNAMBIGUOUS);
      const resolved = await resolver.forBlock(BLOCK_HASH, 1_000_000);
      expect(resolved.callIndices.midnightPallet).toBe(5);
    }, 60_000);
  });

  it("REJECTS a JSON-RPC response carrying neither result nor error (T7)", async () => {
    // `return body.result as T` handed the caller `undefined` with no error, so a malformed or
    // truncated response looked like a successful empty answer and surfaced far away, if at all.
    const { NodeRpcClient } = await import("../../chain-archive-sync/node-rpc-client.js");
    const malformed = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: malformed });
    await expect(client.getFinalizedHead()).rejects.toThrow(/neither "result" nor "error"/);

    // `result: null` is a LEGITIMATE answer -- `chain_getBlockHash` for a height the node does not
    // have returns exactly that -- so it must still come back as null rather than throwing.
    const nullResult = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const nullClient = new NodeRpcClient({ url: "http://fake-node", fetchImpl: nullResult });
    await expect(nullClient.getBlockHash(999_999)).resolves.toBeNull();
  }, 60_000);

  it("decodes from the stored capture with the node's metadata gone -- the replay guarantee", async () => {
    // What the table is actually for. Ingest once against a healthy node, then come back when the
    // node has pruned its state: metadata resolution must succeed from the archive's own copy,
    // with no metadata request issued at all. This is the property Stage 4 replay depends on,
    // since it re-reads metadata for every historical runtime long after capture windows close.
    const schema = await newSchema();
    await service(schema, []).syncOnce({ maxBlocks: 1 });

    const { BlockScopedMetadata } = await import("../../chain-archive-sync/runtime-metadata.js");
    const { PgChainArchiveStore } = await import("../../src/postgres/chain-archive-store.js");
    const store = new PgChainArchiveStore(sql, schema);
    const served: string[] = [];
    const prunedNode = {
      runtimeVersionAt: async () => FIXTURE_RUNTIME_VERSION,
      metadataAt: async () => {
        served.push("state_getMetadata");
        throw new Error("State already discarded for this block");
      },
    };
    const resolver = new BlockScopedMetadata(prunedNode as never, {
      load: (id) => store.getRuntimeMetadata(NET, id.specName, id.specVersion),
      save: async () => {},
    });

    const resolved = await resolver.forBlock(BLOCK_HASH, 1_000_000);
    expect(resolved.callIndices.midnightPallet).toBe(5);
    expect(resolved.callIndices.midnightSystemPallet).toBe(6);
    // The node was never asked: the archive answered from its own capture.
    expect(served).toEqual([]);
  }, 180_000);
});
