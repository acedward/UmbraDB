/**
 * Synthetic transactions for the token-activity tests: what the recorded Stagenet ranges
 * do not contain — unshielded spends, contract inputs/outputs with recipients, fallible parts, failed segments, NIGHT
 * UTXOs, DUST-tagged effects. A JSON description (the archived "raw bytes") becomes ONE object that serves both the
 * applied-parts decoder (`decodeTransaction`, real `ContractCall` prototype) and the activity reader. Spend owners are
 * real ledger-v9 signature verifying keys (deterministic BIP-340 keys), so `addressFromKey` runs unchanged.
 */
import { createHash } from "node:crypto";
import { addressFromKey, ContractCall, signatureVerifyingKey, signingKeyFromBip340 } from "@midnightntwrk/ledger-v9";
import type { ActivityTransactionLike } from "../../mip0018/activity.ts";
import { decodeTransaction, type DecodedTransaction, type TransactionLike } from "../../mip0018/applied-parts.ts";
import { commonRecords, encodePayload, EVENT_NAME } from "../../vendor/mip0018/codec/src/index.ts";
import { ledgerEntryPoint } from "./synthetic-archive.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The verifying key of synthetic wallet `n` (deterministic). */
export function walletKey(n: number): { tag: string; value: string } {
  return signatureVerifyingKey(signingKeyFromBip340(Buffer.from(sha(`c2-wallet-${n}`), "hex"))) as { tag: string; value: string };
}

/** The 32-byte `UserAddress` (hex) of synthetic wallet `n`. */
export const walletOf = (n: number): string => String(addressFromKey(walletKey(n) as Parameters<typeof addressFromKey>[0]));

/** The intent hash a synthetic intent reports for `segment`. */
export const synthIntentHash = (txHash: string, intentSegment: number, segment: number): string => sha(`intent:${txHash}:${intentSegment}:${segment}`);

/** Misc data items: an accepted MIP-0018 event (name/symbol/decimals of `domainSep`, kind) or a rejected one. */
export function acceptedEvent(domainSep: string, kind: 1 | 2 | 3, name: string): string {
  const payload = encodePayload({ domainSep: Buffer.from(domainSep, "hex"), kind }, commonRecords({ name, symbol: name.slice(0, 4).toUpperCase(), decimals: 6 }));
  return Buffer.concat([EVENT_NAME, payload]).toString("hex");
}
export const rejectedEvent = (): string => Buffer.concat([EVENT_NAME, Buffer.alloc(256)]).toString("hex"); // kind 0 → reject

export interface SynthTranscriptA {
  logs?: string[];
  shieldedMints?: Array<[string, string]>;
  unshieldedMints?: Array<[string, string]>;
  /** [token tag, color, amount]; tag `dust` has no color. */
  unshieldedInputs?: Array<[string, string, string]>;
  unshieldedOutputs?: Array<[string, string, string]>;
  /** [color, recipient tag (`user` | `contract`), recipient hex, amount] */
  claimed?: Array<[string, string, string, string]>;
}

export interface SynthIntentA {
  segment: number;
  /** `entryPointHex` (exact bytes) overrides `entryPoint` (text), as in `synthetic-archive.ts`. */
  calls?: Array<{ address: string; entryPoint: string; entryPointHex?: string; guaranteed?: SynthTranscriptA; fallible?: SynthTranscriptA }>;
  /** Spends: [color, amount, wallet number, spent intent hash, spent output number] */
  guaranteedSpends?: Array<[string, string, number, string, number]>;
  fallibleSpends?: Array<[string, string, number, string, number]>;
  /** Outputs: [color, amount, owner hex] */
  guaranteedOutputs?: Array<[string, string, string]>;
  fallibleOutputs?: Array<[string, string, string]>;
}

export interface SynthTxA {
  hash: string;
  intents?: SynthIntentA[];
  /** Zswap deltas: [color, signed amount] */
  guaranteedDeltas?: Array<[string, string]>;
  fallibleDeltas?: Record<string, Array<[string, string]>>;
}

function logOp(data: string): unknown[] {
  const cell = (b: Uint8Array) => ({ tag: "cell", content: { value: [b], alignment: [] } });
  return [{ push: { value: { tag: "array", content: [cell(Uint8Array.from([1])), cell(Uint8Array.from([10])), cell(Buffer.from(data, "hex"))] } } }, "log"];
}

function transcript(t: SynthTranscriptA | undefined): unknown {
  if (t === undefined) return undefined;
  const tt = (tag: string, raw: string) => (tag === "dust" ? { tag } : { tag, raw });
  return {
    program: (t.logs ?? []).flatMap(logOp),
    effects: {
      shieldedMints: new Map((t.shieldedMints ?? []).map(([d, a]) => [d, BigInt(a)])),
      unshieldedMints: new Map((t.unshieldedMints ?? []).map(([d, a]) => [d, BigInt(a)])),
      unshieldedInputs: new Map((t.unshieldedInputs ?? []).map(([g, c, a]) => [tt(g, c), BigInt(a)])),
      unshieldedOutputs: new Map((t.unshieldedOutputs ?? []).map(([g, c, a]) => [tt(g, c), BigInt(a)])),
      claimedUnshieldedSpends: new Map((t.claimed ?? []).map(([c, tag, addr, a]) => [[{ tag: "unshielded", raw: c }, { tag, address: addr }], BigInt(a)])),
    },
  };
}

function offer(spends: SynthIntentA["guaranteedSpends"], outputs: SynthIntentA["guaranteedOutputs"]): unknown {
  if (spends === undefined && outputs === undefined) return undefined;
  return {
    inputs: (spends ?? []).map(([type, value, w, intentHash, outputNo]) => ({ type, value: BigInt(value), owner: walletKey(w), intentHash, outputNo })),
    outputs: (outputs ?? []).map(([type, value, owner]) => ({ type, value: BigInt(value), owner })),
  };
}

/** The object a synthetic description stands for: a decoder `TransactionLike` and an activity transaction at once. */
export function syntheticActivityTx(t: SynthTxA): TransactionLike & ActivityTransactionLike {
  const deltas = (d: Array<[string, string]> | undefined) => (d === undefined ? undefined : { deltas: new Map(d.map(([c, v]) => [c, BigInt(v)])) });
  return {
    transactionHash: () => t.hash,
    guaranteedOffer: deltas(t.guaranteedDeltas),
    fallibleOffer: new Map(Object.entries(t.fallibleDeltas ?? {}).map(([s, d]) => [Number(s), deltas(d)])),
    intents: new Map((t.intents ?? []).map((i) => [i.segment, {
      actions: (i.calls ?? []).map((c) => {
        const call = Object.create(ContractCall.prototype) as object;
        Object.defineProperties(call, {
          address: { value: c.address },
          entryPoint: { value: ledgerEntryPoint(c.entryPoint, c.entryPointHex) },
          guaranteedTranscript: { value: transcript(c.guaranteed) },
          fallibleTranscript: { value: transcript(c.fallible) },
        });
        return call;
      }),
      guaranteedUnshieldedOffer: offer(i.guaranteedSpends, i.guaranteedOutputs),
      fallibleUnshieldedOffer: offer(i.fallibleSpends, i.fallibleOutputs),
      intentHash: (segment: number) => synthIntentHash(t.hash, i.segment, segment),
    }])),
  } as unknown as TransactionLike & ActivityTransactionLike;
}

const parse = (raw: Uint8Array): SynthTxA => JSON.parse(Buffer.from(raw).toString("utf8")) as SynthTxA;

/** The scanner seams for synthetic archives: `decode` and `activityTransaction`. */
export const syntheticSeams = {
  decode: (raw: Uint8Array): DecodedTransaction => decodeTransaction(syntheticActivityTx(parse(raw))),
  activityTransaction: (raw: Uint8Array): ActivityTransactionLike => syntheticActivityTx(parse(raw)),
};
