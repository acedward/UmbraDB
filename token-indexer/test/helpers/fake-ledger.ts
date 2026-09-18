/* eslint-disable @typescript-eslint/no-explicit-any */
import { encodeTokenMetadata } from "../../ingest/payload.js";
import { pad32 } from "../../color.js";

/**
 * A synthetic stand-in for the ledger-v9 module, for the cases real Stagenet bytes cannot cover.
 *
 * Why it is needed and what it is NOT used for: no contract on Stagenet emits a `TokenMetadata`
 * event yet (the reference contracts of sub-plan 02 are what will), and no recorded transaction has
 * a `log` op or a fallible mint — so the event-driven half of the scanner has nothing real to run
 * on until those contracts are deployed. Forging proven transaction bytes is impossible, so the
 * seam the production code already has (the ledger module is INJECTED into
 * `decodeTransactionActions`, exactly as `chain-archive-sync/tx-replay-decoder.ts` injects it) is
 * used instead.
 *
 * The mint-and-colour half of the scanner is NOT tested this way — `scan.test.ts` runs the real
 * WASM decoder over the real recorded transactions.
 */

export interface FakeCallSpec {
  address: string;
  entryPoint?: string;
  segment?: number;
  guaranteed?: { logOps?: number; shielded?: Record<string, bigint>; unshielded?: Record<string, bigint> };
  fallible?: { logOps?: number; shielded?: Record<string, bigint>; unshielded?: Record<string, bigint> };
}

export interface FakeDeploySpec {
  address: string;
  segment?: number;
}

class FakeContractCall {
  constructor(
    readonly address: string,
    readonly entryPoint: string | undefined,
    readonly guaranteedTranscript: unknown,
    readonly fallibleTranscript: unknown,
  ) {}
}
class FakeContractDeploy {
  readonly initialState = {};
  constructor(readonly address: string) {}
}
class FakeMaintenanceUpdate {
  constructor(readonly address: string) {}
}

function transcript(spec: FakeCallSpec["guaranteed"]): unknown {
  if (spec === undefined) return undefined;
  return {
    program: Array.from({ length: spec.logOps ?? 0 }, () => "log"),
    effects: {
      shieldedMints: new Map(Object.entries(spec.shielded ?? {})),
      unshieldedMints: new Map(Object.entries(spec.unshielded ?? {})),
    },
  };
}

/** Raw bytes carrying the STANDARD transaction self-tag, so `isSystemTransaction` says no and the
 *  decoder proceeds to `Transaction.deserialize` — which the fake module below answers. */
export function fakeRawTransaction(marker: string): Buffer {
  return Buffer.from(`midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):${marker}`, "utf8");
}

/**
 * A module object shaped like the parts of ledger-v9 the decoder touches. `deserialize` ignores the
 * bytes and returns the actions this factory was built with — the transaction bytes exist only to
 * satisfy the archive's own schema.
 */
export function fakeLedger(specs: { calls?: FakeCallSpec[]; deploys?: FakeDeploySpec[]; maintenance?: FakeDeploySpec[] }): any {
  const bySegment = new Map<number, unknown[]>();
  const push = (segment: number, action: unknown): void => {
    const list = bySegment.get(segment) ?? [];
    list.push(action);
    bySegment.set(segment, list);
  };
  for (const d of specs.deploys ?? []) push(d.segment ?? 0, new FakeContractDeploy(d.address));
  for (const m of specs.maintenance ?? []) push(m.segment ?? 0, new FakeMaintenanceUpdate(m.address));
  for (const c of specs.calls ?? []) {
    push(c.segment ?? 0, new FakeContractCall(
      c.address, c.entryPoint ?? "call", transcript(c.guaranteed), transcript(c.fallible),
    ));
  }
  return {
    ContractCall: FakeContractCall,
    ContractDeploy: FakeContractDeploy,
    MaintenanceUpdate: FakeMaintenanceUpdate,
    Transaction: {
      deserialize: () => ({
        intents: [...bySegment.entries()].map(([segment, actions]) => [segment, { actions }] as const),
      }),
    },
  };
}

/**
 * A 256-byte `mip-xxxx:token-metadata[v1]` payload as hex — built with the encoder the parser module
 * itself exports, so the fixtures and the production parser can never drift apart.
 *
 * `valType` defaults to 1 (UTF-8 string), which is what most of the hand-built cases want; every
 * test that exercises a type rule passes it explicitly.
 */
export function metadataPayloadHex(fields: {
  domainSep: string | Uint8Array;
  kindByte: number;
  key: string | Uint8Array;
  value: string | Uint8Array;
  valType?: number;
  valLen?: number;
}): string {
  const domainSep = typeof fields.domainSep === "string"
    ? (fields.domainSep.length === 64 ? new Uint8Array(Buffer.from(fields.domainSep, "hex")) : pad32(fields.domainSep))
    : fields.domainSep;
  return Buffer.from(encodeTokenMetadata({
    domainSep, kindByte: fields.kindByte, key: fields.key, valType: fields.valType ?? 1,
    value: fields.value, valLen: fields.valLen,
  })).toString("hex");
}
