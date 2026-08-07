import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { NodeRpcInvalidHeightError } from "../../chain-archive-sync/node-rpc-client.js";
import { ledgerV8EntryPath } from "../../chain-archive-sync/tx-replay-decoder.js";
import type { BlockBundle, Hex32 } from "../../src/interfaces/chain-archive-store.js";

/**
 * Real Postgres (testcontainers), a fully-controllable fake node RPC / indexer GraphQL (no
 * dependency on a live devnet, unlike `chain-archive-sync.integration.test.ts`) -- exercises the
 * sprint-fix round's Fix 1 and Fix 2 end to end through `ChainArchiveSyncService.syncOnce`, the
 * real production entry point, not just the underlying store methods in isolation. Also covers
 * the `syncOnce`-level consequence of Fix 3's `getHeightOf` validation.
 */

const NET = "retry_test_net";

function hx(n: number, tag: number): Hex32 {
  return (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");
}

interface FakeChainBlock {
  height: number;
  hash: Hex32;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  /** hex, no 0x prefix -- a VALIDLY SCALE-FRAMED bare extrinsic wrapping `txRawHex[i]` as its
   *  single `Vec<u8>` argument. Sprint 9's node-derived ingest path decodes every extrinsic's
   *  envelope for real (`extrinsic-decoder.ts`) and oracle-cross-checks the extracted payload
   *  against the indexer's reported raw, so a fake chain must reproduce the real byte
   *  relationship, not merely substring containment. */
  extrinsics: string[];
  txHashes: Hex32[];
  txRawHex: string[];
  dParameter: { numPermissionedCandidates: number; numRegisteredCandidates: number };
}

/** SCALE compact-u32 encode (the two modes these small fixtures can need). */
function compactU32Hex(value: number): string {
  if (value < 64) return ((value << 2) >>> 0).toString(16).padStart(2, "0");
  if (value < 16_384) {
    const v = ((value << 2) | 0b01) >>> 0;
    return Buffer.from([v & 0xff, (v >> 8) & 0xff]).toString("hex");
  }
  throw new Error("fixture compactU32Hex: value out of supported fixture range");
}

/** Wraps `payloadHex` exactly the way the real node frames a bare
 *  `pallet_midnight::send_mn_transaction` extrinsic (verified live in
 *  `test/chain-archive-sync/extrinsic-decoder.test.ts`): compact total length | version 0x05
 *  (bare v5) | pallet 5 | call 0 | compact arg length | payload. */
function bareMidnightExtrinsicHex(payloadHex: string): string {
  const payloadLen = payloadHex.length / 2;
  const inner = "05" + "05" + "00" + compactU32Hex(payloadLen) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

/** The real MNSV consensus digest item (Consensus | "MNSV" | compact 4 | u32 LE), carrying
 *  1_000_000 -- node 1.0.x. This is the ACTUAL genesis digest captured from a live devnet, and it
 *  must stay a supported version: ingest now rejects protocol versions outside the ranges whose
 *  ledger codec the archive implements, so a made-up version (this fixture previously used 1)
 *  is correctly refused rather than silently decoded with the v8 codec. */
const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const FIXTURE_PROTOCOL_VERSION = 1_000_000;

function fakeChain(blocks: { height: number; dParamSeed: number }[]): FakeChainBlock[] {
  return blocks.map(({ height, dParamSeed }) => {
    // The payload must carry the real `midnight:transaction` self-tag: both the envelope
    // decoder's midnight-or-null classification and `sync-service.ts`'s own kind field key off
    // it (design.md §6.1 -- classification is byte-derived, so a fake payload without the tag is
    // not a regular transaction anywhere in the pipeline).
    const txRaw = Buffer.from(`midnight:transaction-fake-tx-raw-${height}`, "utf8").toString("hex");
    return {
      height,
      hash: hx(height, 0xa),
      parentHash: height === 0 ? hx(0, 0x00) : hx(height - 1, 0xa),
      stateRoot: hx(height, 0xb),
      extrinsicsRoot: hx(height, 0xc),
      extrinsics: [bareMidnightExtrinsicHex(txRaw)],
      txHashes: [hx(height, 0xd)],
      txRawHex: [txRaw],
      dParameter: { numPermissionedCandidates: dParamSeed, numRegisteredCandidates: dParamSeed + 1 },
    };
  });
}

function fakeNodeFetch(blocks: FakeChainBlock[], finalizedHeight: number, badHeaderNumberForHash?: Hex32): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { id: number; method: string; params: unknown[] };
    const { id, method, params } = body;
    let result: unknown;
    switch (method) {
      case "chain_getFinalizedHead":
        result = "0x" + blocks[finalizedHeight]!.hash;
        break;
      case "chain_getHeader": {
        const hash = (params[0] as string).replace(/^0x/, "");
        if (badHeaderNumberForHash !== undefined && hash === badHeaderNumberForHash) {
          result = { parentHash: "0x" + hx(0, 0), number: "not-a-valid-hex-number", stateRoot: "0x" + hx(0, 1), extrinsicsRoot: "0x" + hx(0, 2), digest: { logs: [] } };
        } else {
          const blk = blocks.find((b) => b.hash === hash)!;
          result = {
            parentHash: "0x" + blk.parentHash, number: "0x" + blk.height.toString(16),
            stateRoot: "0x" + blk.stateRoot, extrinsicsRoot: "0x" + blk.extrinsicsRoot, digest: { logs: [MNSV_DIGEST_V1] },
          };
        }
        break;
      }
      case "chain_getBlockHash": {
        const height = params[0] as number;
        result = "0x" + blocks[height]!.hash;
        break;
      }
      case "chain_getBlock": {
        const hash = (params[0] as string).replace(/^0x/, "");
        const blk = blocks.find((b) => b.hash === hash)!;
        result = {
          block: {
            header: {
              parentHash: "0x" + blk.parentHash, number: "0x" + blk.height.toString(16),
              stateRoot: "0x" + blk.stateRoot, extrinsicsRoot: "0x" + blk.extrinsicsRoot, digest: { logs: [MNSV_DIGEST_V1] },
            },
            extrinsics: blk.extrinsics.map((e) => "0x" + e),
          },
          justifications: null,
        };
        break;
      }
      case "state_call": {
        // SystemParametersApi_get_d_parameter -> SCALE `DParameter { u16, u16 }`, little-endian,
        // matching what the live node returned (0x0a000000 == {10, 0}) and what the fake
        // indexer reports for the same block, so node-only and oracle modes agree.
        const at = (params[2] as string | undefined)?.replace(/^0x/, "");
        const blk = at === undefined ? blocks[finalizedHeight]! : blocks.find((b) => b.hash === at)!;
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(blk.dParameter.numPermissionedCandidates, 0);
        buf.writeUInt16LE(blk.dParameter.numRegisteredCandidates, 2);
        result = "0x" + buf.toString("hex");
        break;
      }

      default:
        throw new Error(`fakeNodeFetch: unhandled method ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  };
}

function fakeIndexerFetch(blocks: FakeChainBlock[]): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { variables?: { height?: number } };
    const height = body.variables?.height;
    if (typeof height === "number") {
      const blk = blocks.find((b) => b.height === height);
      const data = {
        block: blk === undefined ? null : {
          hash: "0x" + blk.hash,
          height: blk.height,
          transactions: blk.txHashes.map((hash, i) => ({ hash: "0x" + hash, protocolVersion: FIXTURE_PROTOCOL_VERSION, raw: blk.txRawHex[i] })),
          systemParameters: { dParameter: blk.dParameter },
        },
      };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    const maxHeight = Math.max(...blocks.map((b) => b.height));
    return new Response(JSON.stringify({ data: { block: { height: maxHeight } } }), { status: 200 });
  };
}

describe("ChainArchiveSyncService retry safety (sprint-fix round Fixes 1-3)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 60_000); // teardown under heavy host load can exceed the 10s default (matches setup.ts)

  afterEach(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function newService(blocks: FakeChainBlock[], finalizedHeight: number, opts?: { badHeaderNumberForHash?: Hex32 }) {
    const schema = `retry_test_${schemaCounter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(blocks, finalizedHeight, opts?.badHeaderNumberForHash) },
      indexer: { url: "http://fake-indexer", fetchImpl: fakeIndexerFetch(blocks) },
    });
    return { service, schema };
  }

  // Node-only mode needs the ledger WASM to classify payloads, and that dependency is resolved
  // from a sibling checkout rather than package.json (audit finding F6). Reported as SKIPPED
  // where it is absent -- never as a vacuous pass. This test is the reason F6 matters: the DoS
  // regression cannot be enforced in CI until the dependency is packaged.
  it.skipIf(ledgerV8EntryPath() === undefined)(
    "audit F2: a forged midnight-tagged System::remark is neither archived nor able to wedge ingest", async () => {
    // The denial of service this closes: the envelope decoder classifies by the payload's
    // `midnight:` self-tag, which anyone can forge. A bare System::remark(Vec<u8>) whose bytes
    // merely START with that tag was accepted, then failed to deserialize as a transaction, and
    // that failure aborted the block. Because the watermark only advances on success, ingest
    // retried the same height forever -- a permanent stall for the price of one remark.
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }]);
    // The block carries one GENUINE transaction and one forgery.
    //
    // The genuine one must be a real serialized Midnight transaction, because node-only mode
    // classifies with the ledger itself -- the fake chain's synthetic payloads deliberately are
    // not, so they would be skipped too and the test would prove nothing. This is the real
    // genesis regular-transaction extrinsic captured from a 1.0.0 devnet.
    const REAL_TX_EXTRINSIC =
      "81030505006d036d69646e696768743a7472616e73616374696f6e5b76395d287369676e61747572655b76315d2c70726f6f662c706564657273656e2d7363686e6f72725b76315d293a040051020128756e6465706c6f7965640b00203d88792d86f71b8a7a21bfe16a2bb2eab74475073fa5b773854f151ed548dba77a2c58157815f0843fc0701ec174828174fbc4e03d122b40fe97741dd131c92658f533496e48e284ce47644a1d68449ce51b8e20a4c624566827c2f437120e31ec4e628b94c4bcb7dec5a1dbd186677de26fdcacb19130f4126359efe37f471bb9c2496900";
    // A System::remark (pallet 0, call 1) carrying a forged `midnight:` tag over bytes that are
    // NOT a serializable transaction -- the attack.
    const forged = Buffer.from(
      "midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):NOT-A-TRANSACTION",
      "latin1",
    ).toString("hex");
    const inner = "05" + "00" + "01" + compactU32Hex(forged.length / 2) + forged;
    blocks[0]!.extrinsics = [REAL_TX_EXTRINSIC, compactU32Hex(inner.length / 2) + inner];

    const schema = `retry_test_${schemaCounter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    // NODE-ONLY: no indexer option at all, which is the mode the forged payload attacks.
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(blocks, 0) },
    });

    // Must complete, not throw, and must not archive the forged payload as a transaction.
    const result = await service.syncOnce({ maxBlocks: 10 });
    expect(result.ingestedBlocks).toBe(1);
    expect(await service.getSyncedHeight()).toBe(0);
    // The forgery is now rejected at CLASSIFICATION -- it is not carried by the Midnight call, so
    // it never reaches the decoder at all and is not counted as an undecodable payload. The skip
    // counter defends the remaining case: a payload inside a GENUINE Midnight call that fails to
    // deserialize. Both layers are needed; this asserts the outer one caught it first.
    expect(result.skippedUndecodablePayloads).toBe(0);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}
    `;
    expect(rows[0]!.n).toBe(1); // only the genuine transaction
  }, 60_000);

  it("audit F3: a block whose parent is not the archived block below it is rejected, not spliced", async () => {
    // Archive heights 0 and 1 normally, then hand the service a height-2 block whose parentHash
    // points at a DIFFERENT hash -- exactly what a reorg below the finalized head, or an operator
    // repointing NODE_URL at another chain, would produce. Before the continuity check this was
    // archived silently and the cursor advanced over it.
    const blocks = fakeChain([
      { height: 0, dParamSeed: 1 },
      { height: 1, dParamSeed: 1 },
      { height: 2, dParamSeed: 1 },
    ]);
    const { service } = await newService(blocks, 1);
    await service.syncOnce({ maxBlocks: 10 });
    expect(await service.getSyncedHeight()).toBe(1);

    // Rewrite height 2's parent to a foreign hash and extend the finalized head to it.
    blocks[2]!.parentHash = hx(999, 0xf);
    const { service: spliced } = await newService(blocks, 2);
    // Reuse the SAME schema is not possible via the helper, so drive continuity from the store:
    // re-sync from scratch reaches height 2 and must reject it on its parent.
    await expect(spliced.syncOnce({ maxBlocks: 10 })).rejects.toThrow(/chain continuity BROKEN at height 2/);
  }, 60_000);

  it("audit F3: an archive built from one genesis refuses a node serving a different genesis", async () => {
    const chainA = fakeChain([{ height: 0, dParamSeed: 1 }]);
    const { service: a, schema } = await newService(chainA, 0);
    await a.syncOnce({ maxBlocks: 10 });
    expect(await a.getSyncedHeight()).toBe(0);

    // A different chain: same net label, same schema, different genesis hash.
    const chainB = fakeChain([{ height: 0, dParamSeed: 1 }]);
    chainB[0]!.hash = hx(4242, 0xb);
    const foreign = new ChainArchiveSyncService({
      sql: sql!, net: NET, schema,
      node: { url: "http://fake-node-b", fetchImpl: fakeNodeFetch(chainB, 0) },
      indexer: { url: "http://fake-indexer-b", fetchImpl: fakeIndexerFetch(chainB) },
    });
    await expect(foreign.syncOnce({ maxBlocks: 10 })).rejects.toThrow(/chain identity mismatch/);
  }, 60_000);

  it("Fix 1: retrying after a partial legacy-style write (block row already present, transactions/bridge_observations missing) succeeds instead of duplicate-key-erroring", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 0);

    // Reproduces exactly what the OLD (pre-fix) ingestOneBlock could leave behind: the block row
    // committed via a bare putBlock call, but transactions/bridge_observations never wrote.
    const blk = blocks[0]!;
    await service.store.putBlock({
      net: NET, blockHash: blk.hash, height: 0, parentHash: blk.parentHash,
      stateRoot: blk.stateRoot, extrinsicsRoot: blk.extrinsicsRoot,
      headerBytes: new TextEncoder().encode("placeholder-header"),
      bodyBytes: new TextEncoder().encode("placeholder-body"),
      isCanonical: true, status: "canonical", finalized: true,
    });

    // Under the OLD code, this threw a duplicate-key error on the blocks PK and wedged
    // permanently. Under the fix, it completes the missing transaction/bridge-observation rows.
    const result = await service.syncOnce({ maxBlocks: 1 });
    expect(result.ingestedBlocks).toBe(1);
    expect(await service.getSyncedHeight()).toBe(0);

    const archivedTx = await service.store.getTransactionsByHash(NET, blk.txHashes[0]!);
    expect(archivedTx).toHaveLength(1);
  }, 60_000);

  it("Fix 1: retrying an already-fully-committed height at the sync-service layer (simulating a crash between ingestion succeeding and the watermark write) is a safe no-op, not a duplicate-key error", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }, { height: 1, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 1);

    const first = await service.syncOnce({ maxBlocks: 2 });
    expect(first.ingestedBlocks).toBe(2);

    // Directly re-invoke the private per-block ingestion method for an already-fully-ingested
    // height, bypassing the watermark-driven skip -- this is precisely the retry shape a crash
    // between `ingestOneBlock` returning and `syncOnce`'s own `setWatermark` call would produce.
    const serviceInternal = service as unknown as { ingestOneBlock(height: number): Promise<void> };
    await expect(serviceInternal.ingestOneBlock(0)).resolves.toBeUndefined();

    const blocksAtZero = await service.store.getBlocksAtHeight(NET, 0);
    expect(blocksAtZero).toHaveLength(1); // no duplicate row created by the retry
  }, 60_000);

  it("Fix 2: the D-parameter dedup cursor is only advanced after a durable write succeeds -- a failed write does not silently drop the observation on retry", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }, { height: 1, dParamSeed: 99 }]); // height 1's dParameter genuinely differs
    const { service, schema } = await newService(blocks, 1);

    await service.syncOnce({ maxBlocks: 1 }); // ingests height 0 only, cursor now reflects height 0's dParameter
    const cursorAfterHeight0 = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterHeight0).toBeDefined();

    // Simulate a transient failure on height 1's durable write specifically -- the exact scenario
    // Fix 2 addresses: the write for the block carrying the NEW dParameter value fails.
    const originalPutBlockBundle = service.store.putBlockBundle.bind(service.store);
    let shouldFail = true;
    service.store.putBlockBundle = async (bundle: BlockBundle) => {
      if (shouldFail && bundle.block.height === 1) {
        throw new Error("simulated transient write failure for height 1");
      }
      return originalPutBlockBundle(bundle);
    };

    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow("simulated transient write failure");

    // The cursor must be UNCHANGED after the failed attempt -- under the pre-fix bug, it would
    // already have been advanced to height 1's value BEFORE the write was attempted, causing the
    // observation to be silently dropped on retry.
    const cursorAfterFailedAttempt = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterFailedAttempt).toBe(cursorAfterHeight0);

    // Now retry for real (write succeeds this time) -- the observation must actually land.
    shouldFail = false;
    const retryResult = await service.syncOnce({ maxBlocks: 1 });
    expect(retryResult.ingestedBlocks).toBe(1);

    const cursorAfterSuccess = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterSuccess).not.toBe(cursorAfterHeight0); // cursor now reflects height 1's dParameter

    // Proves the observation was NOT silently dropped by the earlier failed attempt -- it landed
    // for real once the retry succeeded.
    const obsRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.bridge_observations WHERE net = ${NET} AND block_height = 1
    `;
    expect(obsRows[0]!.n).toBe(1);
  }, 60_000);

  /**
   * Sol-audit fix round, Finding 5: a direct, non-devnet-gated proof that a REAL D-parameter
   * CHANGE is detected and recorded -- the devnet-gated bridge_observations test only asserts
   * "at least one row landed," which never proves change-detection; this one drives a chain
   * whose D-parameter genuinely changes at a known height and asserts the recorded observations
   * are exactly the change points, with the changed values' real content.
   */
  it("Finding 5: a real D-parameter change is detected and recorded as a bridge observation at exactly the changing height, with the changed content", async () => {
    // Heights 0-1 share one D-parameter; height 2 changes it; height 3 keeps the changed value.
    const blocks = fakeChain([
      { height: 0, dParamSeed: 7 }, { height: 1, dParamSeed: 7 },
      { height: 2, dParamSeed: 42 }, { height: 3, dParamSeed: 42 },
    ]);
    const { service, schema } = await newService(blocks, 3);

    const result = await service.syncOnce({ maxBlocks: 4 });
    expect(result.ingestedBlocks).toBe(4);

    const obs = await sql<{ block_height: bigint; raw_blob_hash: Buffer }[]>`
      SELECT block_height, raw_blob_hash FROM ${sql(schema)}.bridge_observations
      WHERE net = ${NET} AND kind = 'system_parameters_d' ORDER BY block_height
    `;
    // Exactly the change points: first-ever value at height 0, the change at height 2 --
    // heights 1 and 3 (unchanged values) must NOT have produced near-duplicate rows.
    expect(obs.map((o) => Number(o.block_height))).toEqual([0, 2]);

    // The height-2 observation's archived content is the REAL changed value, not just any row.
    const changed = await service.store.getBlob(obs[1]!.raw_blob_hash.toString("hex"));
    expect(JSON.parse(Buffer.from(changed).toString("utf8"))).toEqual({
      numPermissionedCandidates: 42, numRegisteredCandidates: 43,
    });
  }, 60_000);

  it("Fix 3 (syncOnce-level consequence): a malformed node-reported block number surfaces a typed error from syncOnce instead of silently no-oping with a reported success", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 0, { badHeaderNumberForHash: blocks[0]!.hash });

    // Under the pre-fix bug, `getHeightOf` silently produced NaN, `startHeight > NaN` was always
    // `false`, and `syncOnce` returned a normal-looking `{ ingestedBlocks: 0, ... }` "success"
    // instead of surfacing the real problem.
    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toBeInstanceOf(NodeRpcInvalidHeightError);
  }, 60_000);
});
