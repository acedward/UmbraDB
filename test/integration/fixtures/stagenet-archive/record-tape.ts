/**
 * Records a Stagenet "archive tape" (project 00026, Q11: recorded fixtures for CI, captured from
 * live development runs): for each requested height, exactly what `ChainArchiveSyncService` asks
 * the two public endpoints -- the node's `chain_getBlockHash` / `chain_getBlock` results and the
 * indexer's `block(offset:{height})` answer to `BLOCK_BY_HEIGHT_QUERY` (with `__typename` and the
 * per-transaction `transactionResult`). `fake-chain-server.ts` serves a tape back over real HTTP,
 * so CI replays the sync with no network.
 *
 * Polite by construction: one request at a time per endpoint, at least 250 ms apart (the clients'
 * public-host pacing), with the sync's own bounded back-off on 429/403/5xx. Refuses to record from
 * a node whose genesis is not Stagenet's.
 *
 * Usage (inside the node:24 container, from the repo root):
 *   node --import tsx test/integration/fixtures/stagenet-archive/record-tape.ts \
 *     --heights 714637-714663 --out test/integration/fixtures/stagenet-archive/<name>.json
 *   (`--heights` takes a comma-separated list of heights and inclusive ranges, e.g. `714501,714557-714559`)
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BLOCK_BY_HEIGHT_QUERY, IndexerClient } from "../../../../chain-archive-sync/indexer-client.js";
import { NodeRpcClient } from "../../../../chain-archive-sync/node-rpc-client.js";
import { withRetry } from "../../../../chain-archive-sync/retry.js";

export const STAGENET_GENESIS = "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491";
export const STAGENET_NODE_URL = "https://rpc.stagenet.shielded.tools";
export const STAGENET_INDEXER_URL = "https://indexer.stagenet.shielded.tools/api/v4/graphql";

export function parseHeights(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) throw new Error(`bad height spec ${JSON.stringify(part)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo || hi - lo > 2_000) throw new Error(`bad or too large range ${part}`);
    for (let h = lo; h <= hi; h++) out.add(h);
  }
  return [...out].sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      heights: { type: "string" },
      out: { type: "string" },
      node: { type: "string", default: STAGENET_NODE_URL },
      indexer: { type: "string", default: STAGENET_INDEXER_URL },
      comment: { type: "string", default: "" },
    },
    strict: true,
  });
  if (values.heights === undefined || values.out === undefined) {
    throw new Error("usage: record-tape.ts --heights <list> --out <file> [--node <url>] [--indexer <url>] [--comment <text>]");
  }
  const heights = parseHeights(values.heights);
  const node = new NodeRpcClient({ url: values.node, timeoutMs: 30_000, minIntervalMs: 250 });
  const indexer = new IndexerClient({ url: values.indexer, timeoutMs: 30_000, minIntervalMs: 250 });
  const retry = <T>(op: string, call: () => Promise<T>): Promise<T> =>
    withRetry(op, call, { onRetry: (i) => console.error(`retry ${op}: ${i.message} (wait ${i.delayMs} ms)`) });

  const genesis = await retry("genesis", () => node.getBlockHash(0));
  if (genesis.toLowerCase() !== STAGENET_GENESIS) {
    throw new Error(`refusing to record: genesis ${genesis} is not Stagenet's ${STAGENET_GENESIS}`);
  }
  const finalizedHash = await retry("finalized", () => node.getFinalizedHead());
  const finalizedHeight = await retry("finalized-height", () => node.getHeightOf(finalizedHash));
  if (heights.some((h) => h > finalizedHeight)) throw new Error(`a height is above the finalized head ${finalizedHeight}`);

  const blocks: unknown[] = [];
  for (const height of heights) {
    const blockHash = await retry("chain_getBlockHash", () => node.getBlockHash(height));
    const nodeBlock = await retry("chain_getBlock", () => node.getBlock(blockHash));
    const indexerBlock = await retry("indexer.block", () => indexer.getBlockByHeight(height));
    if (indexerBlock === undefined) throw new Error(`indexer has no block ${height}`);
    blocks.push({ height, blockHash, nodeBlock, indexerBlock });
    console.error(`recorded ${height} (${indexerBlock.transactions.length} tx)`);
  }

  const tape = {
    $comment:
      "Stagenet archive tape for UmbraDB project 00026 (recorded fixture, Q11). Public, finalized chain data read " +
      "with test/integration/fixtures/stagenet-archive/record-tape.ts; served back by fake-chain-server.ts. " +
      values.comment,
    network: "stagenet",
    genesisHash: STAGENET_GENESIS,
    nodeUrl: values.node,
    indexerUrl: values.indexer,
    recordedOn: new Date().toISOString().slice(0, 10),
    finalizedHeightAtRecording: finalizedHeight,
    indexerQuerySha256: createHash("sha256").update(BLOCK_BY_HEIGHT_QUERY).digest("hex"),
    heights,
    blocks,
  };
  writeFileSync(values.out, JSON.stringify(tape, null, 1) + "\n");
  console.error(`wrote ${values.out}: ${heights.length} blocks`);
}

if (process.argv[1]?.endsWith("record-tape.ts")) {
  await main();
}
