/**
 * Synthetic archive blocks for the MIP-0018 scan tests (project 00026 A3/B2): what real Stagenet bytes cannot cover
 * (a mint in a failed fallible segment, a color seen before its mint, several intents and segments, broken archive
 * rows). Blocks are written through the real archive store (`putBlockBundle`, with the sync cursor watermark); each
 * transaction's "raw bytes" are a JSON description that `decodeSynthetic` turns into the decoder's `TransactionLike`
 * — real `ContractCall` / `ContractDeploy` / `MaintenanceUpdate` prototypes, so the applied-parts decoder runs
 * unchanged. Recorded Stagenet transactions go through the real ledger-v9 decoder instead.
 */
import { createHash } from "node:crypto";
import { ContractCall, ContractDeploy, MaintenanceUpdate } from "@midnightntwrk/ledger-v9";
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../../src/postgres/client.js";
import { decodeTransaction, type DecodedTransaction, type TransactionLike } from "../../mip0018/applied-parts.ts";

export interface SynthLog {
  /** MIP-0002 event type code (default 10, `Misc`). */
  eventType?: number;
  /** Hex of the logged data item (`name ‖ payload`, trailing zeros may be dropped as the ledger does). */
  data: string;
}

export interface SynthTranscript {
  logs?: SynthLog[];
  /** [domainSep hex, amount] */
  shieldedMints?: Array<[string, string]>;
  unshieldedMints?: Array<[string, string]>;
  /** Colors of the contract's unshielded outputs effect. */
  unshieldedOutputs?: string[];
}

export interface SynthAction {
  call?: { address: string; entryPoint: string; guaranteed?: SynthTranscript; fallible?: SynthTranscript };
  deploy?: { address: string };
  maintenance?: { address: string; updates: string[] };
}

export interface SynthIntent {
  segment: number;
  actions?: SynthAction[];
  guaranteedUtxos?: string[];
  fallibleUtxos?: string[];
}

export interface SynthTx {
  /** 32-byte hex; the archived hash (`archivedHash` may differ to simulate a mismatch). */
  hash: string;
  intents?: SynthIntent[];
  guaranteedDeltas?: string[];
  fallibleDeltas?: Record<string, string[]>;
}

export interface SynthArchivedTx {
  tx: SynthTx;
  result?: "success" | "partial_success" | "failure";
  segments?: Array<{ id: number; success: boolean }> | null;
  archivedHash?: string;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function logItem(log: SynthLog) {
  const cell = (b: Uint8Array) => ({ tag: "cell", content: { value: [b], alignment: [] } });
  return { tag: "array", content: [cell(Uint8Array.from([1])), cell(Uint8Array.from([log.eventType ?? 10])), cell(Uint8Array.from(Buffer.from(log.data, "hex")))] };
}

function transcript(t: SynthTranscript | undefined) {
  if (t === undefined) return undefined;
  const program: unknown[] = [];
  for (const l of t.logs ?? []) program.push({ push: { value: logItem(l) } }, "log");
  return {
    program,
    effects: {
      shieldedMints: new Map((t.shieldedMints ?? []).map(([d, a]) => [d, BigInt(a)])),
      unshieldedMints: new Map((t.unshieldedMints ?? []).map(([d, a]) => [d, BigInt(a)])),
      unshieldedInputs: new Map(),
      unshieldedOutputs: new Map((t.unshieldedOutputs ?? []).map((c) => [{ tag: "unshielded", raw: c }, 1n])),
      claimedUnshieldedSpends: new Map(),
    },
  };
}

function action(a: SynthAction): unknown {
  if (a.call !== undefined) {
    const c = Object.create(ContractCall.prototype) as object;
    Object.defineProperties(c, {
      address: { value: a.call.address },
      entryPoint: { value: a.call.entryPoint },
      guaranteedTranscript: { value: transcript(a.call.guaranteed) },
      fallibleTranscript: { value: transcript(a.call.fallible) },
    });
    return c;
  }
  if (a.deploy !== undefined) {
    const d = Object.create(ContractDeploy.prototype) as object;
    Object.defineProperty(d, "address", { value: a.deploy.address });
    return d;
  }
  if (a.maintenance === undefined) return { unknown: true }; // an action the decoder does not know
  const m = Object.create(MaintenanceUpdate.prototype) as object;
  const updates = a.maintenance.updates.map((u) => Object.assign(Object.create({ constructor: { name: u } }) as object, { operation: "op", vk: { version: "v4" } }));
  Object.defineProperties(m, { address: { value: a.maintenance.address }, counter: { value: 1n }, updates: { value: updates } });
  return m;
}

/** The decoder input a synthetic description stands for. */
export function syntheticTransaction(t: SynthTx): TransactionLike {
  const deltas = (colors: string[] | undefined) => (colors === undefined ? undefined : { deltas: new Map(colors.map((c) => [c, -1n])) });
  const offer = (colors: string[] | undefined) => (colors === undefined ? undefined : { inputs: [], outputs: colors.map((type) => ({ type })) });
  return {
    transactionHash: () => t.hash,
    guaranteedOffer: deltas(t.guaranteedDeltas),
    fallibleOffer: new Map(Object.entries(t.fallibleDeltas ?? {}).map(([s, c]) => [Number(s), deltas(c)])),
    intents: new Map((t.intents ?? []).map((i) => [i.segment, {
      actions: (i.actions ?? []).map(action),
      guaranteedUnshieldedOffer: offer(i.guaranteedUtxos),
      fallibleUnshieldedOffer: offer(i.fallibleUtxos),
    }])),
  };
}

/** The scanner's `decode` for synthetic archives: JSON bytes → the real applied-parts decoder. */
export function decodeSynthetic(raw: Uint8Array): DecodedTransaction {
  return decodeTransaction(syntheticTransaction(JSON.parse(Buffer.from(raw).toString("utf8")) as SynthTx));
}

export const blockHashOf = (network: string, height: number): string => sha(`synthetic:${network}:${height}`);

/**
 * Writes consecutive synthetic blocks `[from, from + blocks.length)` into an archive schema (already migrated) and
 * moves its sync cursor (`{height, startHeight}`) with each block, as `chain-archive-sync` does.
 */
export async function putSyntheticBlocks(
  sql: UmbraDBSql, archiveSchema: string, network: string, from: number, blocks: SynthArchivedTx[][],
  opts: { parentOf?: (height: number) => string } = {},
): Promise<void> {
  const store = new PgChainArchiveStore(sql, archiveSchema);
  for (const [i, txs] of blocks.entries()) {
    const height = from + i;
    const blockHash = blockHashOf(network, height);
    await store.putBlockBundle({
      block: {
        net: network, blockHash, height,
        parentHash: opts.parentOf?.(height) ?? blockHashOf(network, height - 1),
        stateRoot: sha(`state:${height}`), extrinsicsRoot: sha(`extrinsics:${height}`),
        headerBytes: Buffer.from(`synthetic header ${network} ${height}`), isCanonical: true, status: "canonical", finalized: true,
      },
      transactions: txs.map((t, position) => ({
        net: network, txHash: t.archivedHash ?? t.tx.hash, blockHeight: height, blockHash, position, kind: "regular" as const,
        protocolVersion: 1, ...(t.result === undefined ? {} : { result: t.result }), segments: t.segments ?? null,
        rawBytes: Buffer.from(JSON.stringify(t.tx)),
      })),
      bridgeObservations: [],
      watermark: { key: `sync_cursor:${network}`, value: { height, startHeight: from } },
    });
  }
}
