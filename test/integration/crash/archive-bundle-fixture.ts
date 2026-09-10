import type {
  BlockBundle, BridgeObservationRecord, TransactionRecord,
} from "../../../src/interfaces/chain-archive-store.js";

/**
 * One block height's bundle, built identically in the parent test process and in the crash
 * worker child process.
 *
 * Shared rather than duplicated on purpose: a killed attempt and its no-kill control must write
 * BYTE-IDENTICAL content, or the control proves nothing about the killed run -- the absence
 * could always be blamed on different input. Everything here is a pure function of the
 * arguments, so both processes produce the same bundle without exchanging it.
 */

export const WATERMARK_KEY_PREFIX = "sync_cursor:";
export const LEDGER_BUILD = "ledger-v8@8.1.0-syshash.4";
export const LEDGER_NETWORK_ID = "undeployed";

/** The all-zero parent every archive's genesis block carries (Substrate's own convention, and
 *  what `sync-service.ts` writes at height 0). Used as the chain anchor in these fixtures so a
 *  height-0 bundle is shaped exactly like a real one. */
export const GENESIS_PARENT_HASH = "0".repeat(64);

export function hex32(seed: number, tag = 0): string {
  return (tag.toString(16).padStart(4, "0") + seed.toString(16).padStart(8, "0")).padStart(64, "0");
}

export interface HeightBundleSpec {
  net: string;
  height: number;
  parentHash: string;
  txCount: number;
  observationCount: number;
  withCheckpoint: boolean;
}

export function blockHashFor(net: string, height: number): string {
  // Deterministic in (net, height) so parent links are reproducible without carrying state.
  let acc = 0;
  for (const ch of net) acc = (acc * 31 + ch.charCodeAt(0)) % 0xffff;
  return hex32(height, acc | 0x1000);
}

export function buildHeightBundle(spec: HeightBundleSpec): BlockBundle {
  const { net, height, parentHash, txCount, observationCount, withCheckpoint } = spec;
  const blockHash = blockHashFor(net, height);
  const transactions: TransactionRecord[] = Array.from({ length: txCount }, (_, position) => ({
    net,
    txHash: hex32(height * 1_000 + position, 0xcc),
    blockHeight: height,
    blockHash,
    position,
    kind: "regular" as const,
    protocolVersion: 1_000_000,
    rawBytes: new TextEncoder().encode(`tx/${net}/${height}/${position}`),
  }));
  const bridgeObservations: BridgeObservationRecord[] = Array.from(
    { length: observationCount },
    (_, observationIndex) => ({
      net,
      blockHeight: height,
      blockHash,
      observationIndex,
      kind: "system_parameters_d" as const,
      rawBytes: new TextEncoder().encode(
        JSON.stringify({ numPermissionedCandidates: height, numRegisteredCandidates: observationIndex }),
      ),
    }),
  );
  return {
    block: {
      net, blockHash, height, parentHash,
      stateRoot: hex32(height, 0x11),
      extrinsicsRoot: hex32(height, 0x22),
      headerBytes: new TextEncoder().encode(`header/${net}/${height}`),
      bodyBytes: new TextEncoder().encode(`body/${net}/${height}`),
      isCanonical: true, status: "canonical", finalized: true,
      timestampMs: 1_754_395_200_000 + height * 6_000,
    },
    transactions,
    bridgeObservations,
    replayCheckpoint: withCheckpoint
      ? {
        net, blockHeight: height, blockHash,
        stateBytes: new TextEncoder().encode(`ledger-state/${net}/${height}`),
        ledgerVersion: LEDGER_BUILD,
        blockTimestampMs: 1_754_395_200_000 + height * 6_000,
        ledgerNetworkId: LEDGER_NETWORK_ID,
      }
      : undefined,
    watermark: { key: `${WATERMARK_KEY_PREFIX}${net}`, value: { height } },
    notifyChannel: "chain_archive_progress",
  };
}
