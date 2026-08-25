/**
 * A `newHeads` block source backed by the INDEXER HEAD, injected into `serve-all.ts`'s
 * `createSubscribeServer` call by `images/umbra-evm/patches/apply.mjs`.
 *
 * WHY THIS EXISTS (demo-infra 00001, Phase 3)
 * -------------------------------------------
 * `createSubscribeServer` takes an optional `blockSource`. When none is given it falls back to
 * `createLogsTableBlockSource`, which polls DISTINCT (block_number, block_hash) out of
 * `evm_rpc.logs` — i.e. it can only ever announce a block that produced a WATCHED CONTRACT LOG.
 * `serve-all.ts` upstream passes no source, and subscribe.ts's own header says why:
 *
 *     "Part C owns no chain head (Part B does) … at the Part F merge a real head source is
 *      injected here and nothing else changes."
 *
 * That injection is the one piece the Part F merge did not carry out. On the demo stack the
 * consequence is total: it is a READ-ONLY façade over a devnet with no deployed contracts and an
 * empty `watch.json`, so `evm_rpc.logs` stays empty forever and `eth_subscribe("newHeads")`
 * returns a subscription id that never delivers a single header. The spec's User Story 3
 * acceptance scenario 3 ("subscribes to newHeads → receives new block headers") cannot pass
 * without a real source.
 *
 * This source is the injection subscribe.ts describes: it polls the same `IndexerReader` that
 * answers `eth_blockNumber`, so the head a `newHeads` subscriber sees and the head
 * `eth_blockNumber` reports are by construction the same one. Header fields are rendered exactly
 * as `synthesizeBlock` renders them (`quantity`, `sourceFixedDataHex`, `evmTimestampSeconds`), so
 * a client cannot observe the same block differently through the two surfaces.
 */
import type { IndexerReader } from "../indexer-gql.js";
import { evmTimestampSeconds } from "../methods/blocks.js";
import { quantity, sourceFixedDataHex, ZERO_HASH } from "../methods/common.js";
import type { BlockHeader, BlockSource } from "./subscribe.js";

export interface IndexerHeadBlockSourceOptions {
  /** Poll interval. Midnight's dev block time is ~6s, so 1s is comfortably faster than the tip. */
  pollMs?: number;
  onError?: (error: Error) => void;
}

export function createIndexerHeadBlockSource(
  indexer: IndexerReader,
  options: IndexerHeadBlockSourceOptions = {},
): BlockSource {
  const pollMs = options.pollMs ?? 1_000;
  return {
    start(emit: (header: BlockHeader) => void) {
      // -1 rather than 0: block 0 (genesis) is a legitimate head on a chain that has not produced
      // anything yet, and must still be announced once.
      let lastAnnounced = -1;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const poll = async (): Promise<void> => {
        const head = await indexer.getLatestBlock();
        if (head === undefined || stopped) return;
        if (head.height <= lastAnnounced) return;
        lastAnnounced = head.height;
        emit({
          number: quantity(head.height),
          hash: sourceFixedDataHex(head.hash, 32, "block hash"),
          parentHash:
            head.height === 0 || head.parent === null
              ? ZERO_HASH
              : sourceFixedDataHex(head.parent.hash, 32, "parent hash"),
          timestamp: quantity(evmTimestampSeconds(head.timestamp)),
        });
      };

      const loop = (): void => {
        if (stopped) return;
        void poll()
          // A transient indexer failure must not kill the poller: the whole point of the read
          // façade is that it degrades rather than dies when the indexer blips.
          .catch((error: unknown) => {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          })
          .finally(() => {
            if (stopped) return;
            timer = setTimeout(loop, pollMs);
            timer.unref?.();
          });
      };
      loop();

      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}
