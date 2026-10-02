/* eslint-disable @typescript-eslint/no-explicit-any */
import { encodeTokenMetadata, encodeTokenMetadataUc1, type NameVariant } from "../../ingest/payload.js";
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

/**
 * One transcript of a fake call. Project 00023 widened it past the two mint maps: the whole point
 * of the flow maps here is that their keys are `{tag: 'unshielded', raw}` OBJECTS on chain (unlike
 * the mint maps, whose keys are hex strings — spec §0), and that a key of any OTHER shape must
 * make the decoder throw rather than silently drop a token movement (FR-015). No real Stagenet
 * transaction can produce a malformed key, so this seam is the only way to prove it.
 */
export interface FakeTranscriptSpec {
  logOps?: number;
  /** Non-`log` ops, added so `ops` and `logOps` can differ as they do on chain. */
  ops?: number;
  /** `effects.shieldedMints`, keyed by domain separator hex (as the ledger does). */
  shielded?: Record<string, bigint>;
  /** `effects.unshieldedMints`. */
  unshielded?: Record<string, bigint>;
  /** `effects.unshieldedInputs`, keyed by COLOUR hex; wrapped as `{tag:'unshielded', raw}`. */
  inFlows?: Record<string, bigint>;
  /** `effects.unshieldedOutputs`, same keying. */
  outFlows?: Record<string, bigint>;
  /** Emit the flow keys as bare hex STRINGS instead — the "future build" shape the spec's edge
   *  case says must also be accepted. */
  stringFlowKeys?: boolean;
  /** Add one `effects.unshieldedInputs` entry under a key of this exact shape. Anything that is
   *  neither a string, a `Uint8Array` nor an object carrying `raw` must make the decoder throw. */
  brokenFlowKey?: unknown;
  /** Add one `effects.unshieldedInputs` entry under `{tag:'dust'}` — the one unrecognised-looking
   *  key that is legitimately SKIPPED rather than thrown on, because DUST is not tracked (Q13). */
  dustFlowKey?: boolean;
  gas?: { readTime?: bigint; computeTime?: bigint; bytesWritten?: bigint; bytesDeleted?: bigint };
  claimedNullifiers?: string[];
  claimedShieldedReceives?: string[];
  claimedShieldedSpends?: string[];
}

export interface FakeCallSpec {
  address: string;
  entryPoint?: string;
  segment?: number;
  communicationCommitment?: string;
  guaranteed?: FakeTranscriptSpec;
  fallible?: FakeTranscriptSpec;
}

export interface FakeDeploySpec {
  address: string;
  segment?: number;
}

/** An intent's unshielded offer — the public half of an unshielded token transfer. */
export interface FakeUnshieldedOfferSpec {
  segment?: number;
  section?: "guaranteed" | "fallible";
  inputs?: { value: bigint; type: string; ownerKey: string; intentHash: string; outputNo: number }[];
  outputs?: { value: bigint; type: string; owner: string }[];
  signatures?: number;
}

/** `Intent.dustActions` — decoded for the transaction view and never for a row (Q13). */
export interface FakeDustSpec {
  segment?: number;
  ctime?: Date;
  spends?: { vFee: bigint; oldNullifier?: string; newCommitment?: string }[];
  registrations?: { nightKey: string; dustAddress?: string; allowFeePayment?: bigint }[];
}

/** A zswap offer. `deltas` empty = BALANCED = the colour is not public (spec §0). */
export interface FakeZswapSpec {
  section?: "guaranteed" | "fallible";
  segment?: number;
  deltas?: Record<string, bigint>;
  inputs?: { nullifier: string; contractAddress?: string }[];
  outputs?: { commitment: string; contractAddress?: string }[];
  transients?: { commitment: string; nullifier: string; contractAddress?: string }[];
}

/** `Transaction.rewards` — a `ClaimRewards` transaction. The archive holds none on Stagenet, so
 *  this is the only way the `reward` role is exercised at all. */
export interface FakeRewardsSpec {
  value: bigint;
  ownerKey: string;
  nonce: string;
  kind?: string;
}

class FakeContractCall {
  constructor(
    readonly address: string,
    readonly entryPoint: string | undefined,
    readonly guaranteedTranscript: unknown,
    readonly fallibleTranscript: unknown,
    readonly communicationCommitment: string | undefined,
  ) {}
}
class FakeContractDeploy {
  readonly initialState = {};
  constructor(readonly address: string) {}
}
class FakeMaintenanceUpdate {
  constructor(readonly address: string) {}
}

/** The chain's own key shape for the two FLOW maps: an object, not a string (spec §0). */
const flowKey = (color: string, asString: boolean): unknown =>
  asString ? color : { tag: "unshielded", raw: color };

function transcript(spec: FakeTranscriptSpec | undefined): unknown {
  if (spec === undefined) return undefined;
  const program: string[] = [
    ...Array.from({ length: spec.logOps ?? 0 }, () => "log"),
    ...Array.from({ length: spec.ops ?? 0 }, () => "noop"),
  ];
  const inFlows = new Map<unknown, bigint>();
  for (const [color, amount] of Object.entries(spec.inFlows ?? {})) {
    inFlows.set(flowKey(color, spec.stringFlowKeys === true), amount);
  }
  if (spec.dustFlowKey === true) inFlows.set({ tag: "dust" }, 7n);
  if (spec.brokenFlowKey !== undefined) inFlows.set(spec.brokenFlowKey, 13n);
  const outFlows = new Map<unknown, bigint>();
  for (const [color, amount] of Object.entries(spec.outFlows ?? {})) {
    outFlows.set(flowKey(color, spec.stringFlowKeys === true), amount);
  }
  return {
    program,
    gas: {
      readTime: spec.gas?.readTime ?? 0n,
      computeTime: spec.gas?.computeTime ?? 0n,
      bytesWritten: spec.gas?.bytesWritten ?? 0n,
      bytesDeleted: spec.gas?.bytesDeleted ?? 0n,
    },
    effects: {
      shieldedMints: new Map(Object.entries(spec.shielded ?? {})),
      unshieldedMints: new Map(Object.entries(spec.unshielded ?? {})),
      unshieldedInputs: inFlows,
      unshieldedOutputs: outFlows,
      claimedNullifiers: spec.claimedNullifiers ?? [],
      claimedShieldedReceives: spec.claimedShieldedReceives ?? [],
      claimedShieldedSpends: spec.claimedShieldedSpends ?? [],
      claimedContractCalls: [],
      claimedUnshieldedSpends: new Map(),
    },
  };
}

/** The tag a fake serialized ledger `Event` starts with — anything else makes the fake
 *  `Event.deserialize` throw, which is how a test serves an UNDECODABLE `raw`. */
const FAKE_EVENT_TAG = "fake-midnight:event[v1]:";

/**
 * A fake serialized ledger `Event` for one contract `Misc` event (project 00024-01): the hex the
 * fake event indexer serves as `raw`, and the fake {@link fakeLedger}'s `Event.deserialize` turns
 * back into the real `Event` SHAPE — `source.{transactionHash, logicalSegment, physicalSegment}` and
 * a `contractLog` whose logged item is one `bytes(288)` atom (name then payload, trailing zeros
 * trimmed, exactly as the ledger stores it). `logicalSegment` is 0, as the real ledger sets it for
 * both phases.
 */
export function fakeRawEvent(fields: {
  txHash: string; segment: number; address: string; nameHex: string; payloadHex: string;
  entryPoint?: string; eventType?: string;
}): string {
  return Buffer.from(FAKE_EVENT_TAG + JSON.stringify(fields), "utf8").toString("hex");
}

function fakeEventDeserialize(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.startsWith(FAKE_EVENT_TAG)) throw new Error("fake ledger: not a serialized Event");
  const f = JSON.parse(text.slice(FAKE_EVENT_TAG.length)) as {
    txHash: string; segment: number; address: string; nameHex: string; payloadHex: string;
    entryPoint?: string; eventType?: string;
  };
  const value = Buffer.alloc(288);
  Buffer.from(f.nameHex, "hex").copy(value, 0);
  Buffer.from(f.payloadHex, "hex").copy(value, 32);
  let end = value.length;
  while (end > 0 && value[end - 1] === 0) end--;
  return {
    source: { transactionHash: f.txHash, logicalSegment: 0, physicalSegment: f.segment },
    content: {
      tag: "contractLog",
      address: f.address,
      entryPoint: f.entryPoint ?? "emit",
      loggedItem: {
        version: 1,
        eventType: f.eventType ?? "misc",
        data: {
          tag: "cell",
          content: {
            alignment: [{ tag: "atom", value: { tag: "bytes", length: 288 } }],
            value: [new Uint8Array(value.subarray(0, end))],
          },
        },
      },
    },
  };
}

/** Raw bytes carrying the STANDARD transaction self-tag, so `isSystemTransaction` says no and the
 *  decoder proceeds to `Transaction.deserialize` — which the fake module below answers. */
export function fakeRawTransaction(marker: string): Buffer {
  return Buffer.from(`midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):${marker}`, "utf8");
}

export interface FakeLedgerSpecs {
  calls?: FakeCallSpec[];
  deploys?: FakeDeploySpec[];
  maintenance?: FakeDeploySpec[];
  /** 00023: intents' unshielded offers, DUST actions, zswap offers and rewards. */
  unshielded?: FakeUnshieldedOfferSpec[];
  dust?: FakeDustSpec[];
  zswap?: FakeZswapSpec[];
  rewards?: FakeRewardsSpec;
  identifiers?: string[];
  txHash?: string;
  /** `addressFromKey` on the real ledger maps a `SignatureVerifyingKey` to a `UserAddress`. The
   *  fake maps the key's hex VALUE through this table, defaulting to the value itself — so a test
   *  that does not care about the distinction can use one hex string for both. */
  addresses?: Record<string, string>;
}

/**
 * A module object shaped like the parts of ledger-v9 the decoders touch. `deserialize` ignores the
 * bytes and returns the structure this factory was built with — the transaction bytes exist only to
 * satisfy the archive's own schema.
 */
export function fakeLedger(specs: FakeLedgerSpecs): any {
  interface FakeIntent {
    actions: unknown[];
    guaranteedUnshieldedOffer: unknown;
    fallibleUnshieldedOffer: unknown;
    dustActions: unknown;
    ttl: Date | undefined;
    intentHash: (segment: number) => string;
  }
  const bySegment = new Map<number, FakeIntent>();
  const intentAt = (segment: number): FakeIntent => {
    let intent = bySegment.get(segment);
    if (intent === undefined) {
      intent = {
        actions: [], guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined,
        dustActions: undefined, ttl: new Date("2026-09-21T00:00:00.000Z"),
        intentHash: (seg: number) => seg.toString(16).padStart(64, "e"),
      };
      bySegment.set(segment, intent);
    }
    return intent;
  };
  const push = (segment: number, action: unknown): void => { intentAt(segment).actions.push(action); };

  for (const d of specs.deploys ?? []) push(d.segment ?? 0, new FakeContractDeploy(d.address));
  for (const m of specs.maintenance ?? []) push(m.segment ?? 0, new FakeMaintenanceUpdate(m.address));
  for (const c of specs.calls ?? []) {
    push(c.segment ?? 0, new FakeContractCall(
      c.address, c.entryPoint ?? "call", transcript(c.guaranteed), transcript(c.fallible),
      c.communicationCommitment,
    ));
  }
  for (const u of specs.unshielded ?? []) {
    const offer = {
      inputs: (u.inputs ?? []).map((i) => ({
        value: i.value, type: i.type, owner: { tag: "schnorr", value: i.ownerKey },
        intentHash: i.intentHash, outputNo: i.outputNo,
      })),
      outputs: (u.outputs ?? []).map((o) => ({ value: o.value, type: o.type, owner: o.owner })),
      signatures: Array.from({ length: u.signatures ?? 0 }, (_v, i) => i),
    };
    const intent = intentAt(u.segment ?? 0);
    if ((u.section ?? "fallible") === "guaranteed") intent.guaranteedUnshieldedOffer = offer;
    else intent.fallibleUnshieldedOffer = offer;
  }
  for (const d of specs.dust ?? []) {
    intentAt(d.segment ?? 0).dustActions = {
      ctime: d.ctime ?? new Date("2026-09-21T00:00:00.000Z"),
      spends: (d.spends ?? []).map((s) => ({
        vFee: s.vFee, oldNullifier: s.oldNullifier ?? "aa".repeat(32),
        newCommitment: s.newCommitment ?? "bb".repeat(32),
      })),
      registrations: (d.registrations ?? []).map((r) => ({
        nightKey: { tag: "schnorr", value: r.nightKey },
        dustAddress: r.dustAddress, allowFeePayment: r.allowFeePayment ?? 0n,
      })),
    };
  }

  const zswapOffer = (z: FakeZswapSpec): unknown => ({
    deltas: new Map(Object.entries(z.deltas ?? {})),
    inputs: (z.inputs ?? []).map((i) => ({ nullifier: i.nullifier, contractAddress: i.contractAddress })),
    outputs: (z.outputs ?? []).map((o) => ({ commitment: o.commitment, contractAddress: o.contractAddress })),
    transients: (z.transients ?? []).map((t) => ({
      commitment: t.commitment, nullifier: t.nullifier, contractAddress: t.contractAddress,
    })),
  });
  const guaranteedZswap = (specs.zswap ?? []).find((z) => (z.section ?? "guaranteed") === "guaranteed");
  const fallibleZswap = (specs.zswap ?? []).filter((z) => z.section === "fallible");

  return {
    ContractCall: FakeContractCall,
    ContractDeploy: FakeContractDeploy,
    MaintenanceUpdate: FakeMaintenanceUpdate,
    Event: { deserialize: fakeEventDeserialize },
    addressFromKey: (key: { value?: string } | string) => {
      const value = typeof key === "string" ? key : String(key.value);
      return specs.addresses?.[value] ?? value;
    },
    Transaction: {
      deserialize: () => ({
        intents: [...bySegment.entries()].map(([segment, intent]) => [segment, intent] as const),
        guaranteedOffer: guaranteedZswap === undefined ? undefined : zswapOffer(guaranteedZswap),
        fallibleOffer: fallibleZswap.length === 0
          ? undefined
          : fallibleZswap.map((z) => [z.segment ?? 0, zswapOffer(z)] as const),
        rewards: specs.rewards === undefined ? undefined : {
          value: specs.rewards.value,
          owner: { tag: "schnorr", value: specs.rewards.ownerKey },
          nonce: specs.rewards.nonce,
          kind: specs.rewards.kind ?? "Reward",
        },
        bindingRandomness: 1n,
        identifiers: () => specs.identifiers ?? [],
        transactionHash: () => specs.txHash ?? "ff".repeat(32),
      }),
    },
  };
}

/**
 * A token-metadata payload as hex — built with the encoders the parser module itself exports, so
 * the fixtures and the production parser can never drift apart.
 *
 * `nameVariant` picks the layout: the superseded draft's single 256-byte event (the default, what
 * the pre-00024 hand-built cases were written against) or MIP-0018's UC-1 package (`256 · k`
 * bytes, 2-byte `val-len`, project 00024-01). `valType` defaults to 1 (UTF-8 string); every test
 * that exercises a type rule passes it explicitly.
 */
export function metadataPayloadHex(fields: {
  domainSep: string | Uint8Array;
  kindByte: number;
  key: string | Uint8Array;
  value: string | Uint8Array;
  valType?: number;
  valLen?: number;
  nameVariant?: NameVariant;
  parts?: number;
}): string {
  const domainSep = typeof fields.domainSep === "string"
    ? (fields.domainSep.length === 64 ? new Uint8Array(Buffer.from(fields.domainSep, "hex")) : pad32(fields.domainSep))
    : fields.domainSep;
  const common = {
    domainSep, kindByte: fields.kindByte, key: fields.key, valType: fields.valType ?? 1,
    value: fields.value, valLen: fields.valLen,
  };
  return Buffer.from(fields.nameVariant === "mip-0018"
    ? encodeTokenMetadataUc1({ ...common, parts: fields.parts })
    : encodeTokenMetadata(common)).toString("hex");
}

/**
 * A fake ledger whose `Transaction.deserialize` answers PER TRANSACTION (project 00024-01): the
 * archive's raw bytes are `fakeRawTransaction(marker)`, and the marker picks which spec the
 * transaction is. Lets one scan cover several synthetic transactions (e.g. [Y]'s "repeated
 * publication" vector, one package in each of two transactions).
 */
export function fakeLedgerPerTransaction(byMarker: Record<string, FakeLedgerSpecs>): any {
  const ledgers = new Map(Object.entries(byMarker).map(([marker, specs]) => [marker, fakeLedger(specs)]));
  const any = fakeLedger({});
  return {
    ...any,
    Transaction: {
      deserialize: (_s: string, _p: string, _b: string, bytes: Uint8Array) => {
        const text = Buffer.from(bytes).toString("utf8");
        const marker = text.slice(text.lastIndexOf(":") + 1);
        const ledger = ledgers.get(marker);
        if (ledger === undefined) throw new Error(`fake ledger: no transaction spec for marker ${marker}`);
        return ledger.Transaction.deserialize();
      },
    },
  };
}
