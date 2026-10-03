/**
 * The applied-parts decoder: from one archived raw transaction, everything the MIP-0018 indexer reads — the `log`
 * operations of contract calls, the `shieldedMints` / `unshieldedMints` effects, contract deploys, maintenance
 * updates, and the token colors visible in public data — each placed in its part of the transaction, in the ledger's
 * execution order; and the filter that keeps only the parts that took effect. ONE module, used by the mint table and
 * seen tokens (sub-plan A3) and by the metadata events (sub-plan B2): one deserialization per transaction.
 *
 * Port (UmbraDB's own code, not vendored — project 00026 Q17) of `decodeTransaction`, `readLogItem`, `partApplied`
 * and `applied` from the MIP-0018 reference implementation, `packages/midnight/src/raw.ts` of
 * https://github.com/midnight-experiments/mip-0018 @ daec1f19747b09f4e245885ab0dd9ecc789a82ce (Apache-2.0,
 * © the mip-0018 reference authors; see `token-indexer/vendor/mip0018/LICENSE` and `NOTICE`). Changes from the
 * reference: UmbraDB's archive outcome shape (`success` / `partial_success` / `failure` + `{id, success}` segments);
 * an unknown contract action is an error instead of being skipped (PR #19 lesson: a scanner must not silently pass
 * over what it cannot classify); deploys and maintenance updates are placed in their segment's fallible part (see
 * `partApplied`); the token colors of public data (unshielded offers, Zswap offer deltas, unshielded transcript
 * effects) are collected for the seen-token list (owner Q3); amounts and colors are sorted so that the ledger's
 * random `Map` order never leaks into stored rows.
 *
 * Authority: MIP-0018 PR #340 head `274a84f`:
 * - "Applying records": within a transaction, events are in the ledger's execution order — the guaranteed part of
 *   every intent (in ascending segment id), then each successful fallible segment (in ascending segment id); within
 *   a part, actions and their operations in order.
 * - "Lookup": a mint is a `shieldedMints` or `unshieldedMints` effect of a contract call.
 * - "Consuming": missing trailing bytes are zero; raw ledger log data is `name ‖ payload` (288 bytes) with trailing
 *   zero bytes of the WHOLE item dropped, so it is zero-extended to 288 before it is split (never name and payload
 *   separately).
 *
 * What applied (spec FR-002, owner Q9): a FAILURE applies nothing; otherwise the guaranteed part applies, and a
 * fallible part only when its segment succeeded (`SUCCESS`: every segment; `PARTIAL_SUCCESS`: a segment listed with
 * `success: true` — one missing from the list counts as failed).
 */
import { ContractCall, ContractDeploy, MaintenanceUpdate, Transaction } from "@midnightntwrk/ledger-v9";
import { NAME_SIZE, PAYLOAD_SIZE, splitMiscData, toHex } from "../vendor/mip0018/codec/src/index.ts";

/** MIP-0002 `LogEventType` code of `Misc`. */
export const MISC_EVENT_TYPE_CODE = 10;
/** Size of the zero-extended `Misc` data item: `name` (32) ‖ `payload` (256). */
export const MISC_DATA_SIZE = NAME_SIZE + PAYLOAD_SIZE;

/** MIP-0002 `LogEventType` names by code (the codec's `Misc` spelling for code 10). */
export const LOG_EVENT_TYPES = [
  "ShieldedSpend",
  "ShieldedReceive",
  "ShieldedMint",
  "ShieldedBurn",
  "UnshieldedSpend",
  "UnshieldedReceive",
  "UnshieldedMint",
  "UnshieldedBurn",
  "Paused",
  "Unpaused",
  "Misc",
] as const;

/** The color of NIGHT (and of the shielded native token): 32 zero bytes. A built-in row, never a seen token. */
export const NIGHT_COLOR = "00".repeat(32);

export type Phase = "guaranteed" | "fallible";

/** Where a part sits: its phase and its intent's segment id (the ledger's `physicalSegment`). */
export interface Part {
  phase: Phase;
  segment: number;
}

export interface CallPlacement extends Part {
  /** Index of the action in its intent. */
  actionIndex: number;
  /** 32-byte contract address, lowercase hex. */
  contractAddress: string;
  entryPoint: string;
}

export interface DecodedLog extends CallPlacement {
  /** Index of the `log` op in its transcript program. */
  opIndex: number;
  version: number | null;
  eventTypeCode: number | null;
  /** MIP-0002 `LogEventType` name (`Misc` for code 10), or `null` when unknown. */
  eventType: string | null;
  /** `Misc` only: the data item zero-extended to 288 bytes, split — lowercase hex of 32 and 256 bytes. */
  name?: string;
  payload?: string;
  /** Why a log could not be read as a `Misc` `name ‖ payload` (when it has another shape). */
  undecodable?: string;
}

export interface DecodedMint extends CallPlacement {
  /** 1 = shielded (`shieldedMints`), 2 = unshielded (`unshieldedMints`) — the MIP's kinds. */
  kind: 1 | 2;
  /** 32 bytes, lowercase hex. */
  domainSep: string;
  amount: bigint;
}

export interface DecodedDeploy extends Part {
  actionIndex: number;
  address: string;
}

export interface DecodedMaintenance extends Part {
  actionIndex: number;
  address: string;
  counter: bigint;
  /** Each update as `<kind>(<operation>, <version>)`, e.g. `VerifierKeyInsert(publishMetadata, v3)`. */
  updates: string[];
}

export interface DecodedCall extends Omit<CallPlacement, "phase"> {
  /** The transcripts this call carries, in ledger order. */
  phases: Phase[];
}

/** Where a token color appears in public data. */
export type SightingEvidence = "unshielded-utxo" | "shielded-offer" | "contract-unshielded";

export interface ColorSighting extends Part {
  /** 32 bytes, lowercase hex; never NIGHT's zero color. */
  color: string;
  evidence: SightingEvidence;
}

export interface DecodedTransaction {
  /** Recomputed by the ledger from the bytes, lowercase hex. */
  hash: string;
  /** Intent segment ids, ascending. */
  segments: number[];
  calls: DecodedCall[];
  deploys: DecodedDeploy[];
  maintenance: DecodedMaintenance[];
  /** Every `log` op of every call, in ledger execution order. */
  logs: DecodedLog[];
  /** Every mint effect, in ledger execution order (ascending `domainSep` within one transcript and kind). */
  mints: DecodedMint[];
  /** Every token color of public data, in ledger execution order (deduplicated within one offer or transcript). */
  sightings: ColorSighting[];
}

/** The archive's per-transaction outcome (`chain_archive.transactions.result` / `.segments`). */
export interface TransactionOutcome {
  result: "success" | "partial_success" | "failure";
  segments?: ReadonlyArray<{ id: number; success: boolean }> | null;
}

export class RawDecodeError extends Error {
  override name = "RawDecodeError";
}

type Encoded = { tag: string; content?: unknown };
type Aligned = { value: Uint8Array[] };
type TokenTypeLike = { tag: string; raw?: string };
type Transcript = {
  program: unknown[];
  effects: {
    shieldedMints: Map<string, bigint>;
    unshieldedMints: Map<string, bigint>;
    unshieldedInputs?: Map<TokenTypeLike, bigint>;
    unshieldedOutputs?: Map<TokenTypeLike, bigint>;
    claimedUnshieldedSpends?: Map<[TokenTypeLike, unknown], bigint>;
  };
};
type UnshieldedOfferLike = { inputs: Array<{ type: string }>; outputs: Array<{ type: string }> } | undefined | null;
type ZswapOfferLike = { deltas: Map<string, bigint> } | undefined | null;
type IntentLike = {
  actions: unknown[];
  guaranteedUnshieldedOffer?: UnshieldedOfferLike;
  fallibleUnshieldedOffer?: UnshieldedOfferLike;
};
/** The parts of a ledger-v9 `Transaction` this decoder reads (also what a synthetic test transaction provides). */
export interface TransactionLike {
  transactionHash(): string;
  intents?: Map<number, IntentLike>;
  guaranteedOffer?: ZswapOfferLike;
  fallibleOffer?: Map<number, ZswapOfferLike>;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Lowercase hex without a `0x` prefix. */
export function normHex(h: string): string {
  return (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h).toLowerCase();
}

const entryPointText = (e: Uint8Array | string): string => (typeof e === "string" ? e : Buffer.from(e).toString("utf8"));

function leUint(bytes: Uint8Array): number {
  let n = 0;
  for (let i = bytes.length - 1; i >= 0; i--) n = n * 256 + (bytes[i] as number);
  return n;
}

function singleAtom(v: Encoded | undefined): Uint8Array | undefined {
  if (v?.tag !== "cell") return undefined;
  const atoms = (v.content as Aligned).value;
  return atoms.length === 1 ? atoms[0] : atoms.length === 0 ? new Uint8Array(0) : undefined;
}

/** Reads the `VersionedLogItem` `[version, eventType, data]` pushed right before a `log` op. */
export function readLogItem(pushed: unknown): Pick<DecodedLog, "version" | "eventTypeCode" | "eventType" | "name" | "payload" | "undecodable"> {
  const v = pushed as Encoded | undefined;
  if (v?.tag !== "array" || !Array.isArray(v.content) || v.content.length !== 3) {
    return { version: null, eventTypeCode: null, eventType: null, undecodable: "not a [version, eventType, data] array" };
  }
  const [ver, et, data] = v.content as Encoded[];
  const verBytes = singleAtom(ver);
  const etBytes = singleAtom(et);
  const version = verBytes === undefined ? null : leUint(verBytes);
  const eventTypeCode = etBytes === undefined ? null : leUint(etBytes);
  const eventType = eventTypeCode === null ? null : (LOG_EVENT_TYPES[eventTypeCode] ?? null);
  const out: ReturnType<typeof readLogItem> = { version, eventTypeCode, eventType };
  if (eventTypeCode !== MISC_EVENT_TYPE_CODE) return out;
  const atom = singleAtom(data);
  if (atom === undefined) return { ...out, undecodable: "Misc data is not a single cell atom" };
  const split = splitMiscData(atom); // zero-extends the whole item to 288 bytes, then splits 32 | 256
  if (split === undefined) return { ...out, undecodable: `Misc data is ${atom.length} bytes (> ${MISC_DATA_SIZE})` };
  return { ...out, name: toHex(split.name), payload: toHex(split.payload) };
}

function transcriptParts(t: Transcript, place: CallPlacement): { logs: DecodedLog[]; mints: DecodedMint[]; sightings: ColorSighting[] } {
  const logs: DecodedLog[] = [];
  t.program.forEach((op, i) => {
    if (op !== "log") return;
    const prev = t.program[i - 1] as { push?: { value: unknown } } | undefined;
    const item = prev?.push !== undefined
      ? readLogItem(prev.push.value)
      : { version: null, eventTypeCode: null, eventType: null, undecodable: "the logged value was not pushed right before the log op" };
    logs.push({ ...place, opIndex: i, ...item });
  });
  const mints: DecodedMint[] = [];
  for (const [kind, map] of [[1, t.effects.shieldedMints], [2, t.effects.unshieldedMints]] as const) {
    for (const [ds, amount] of [...map].map(([d, a]) => [normHex(String(d)), a] as const).sort(([a], [b]) => byString(a, b))) {
      mints.push({ ...place, kind, domainSep: ds, amount: BigInt(amount) });
    }
  }
  const colors: string[] = [];
  const addType = (t2: TokenTypeLike): void => {
    if ((t2.tag === "unshielded" || t2.tag === "shielded") && typeof t2.raw === "string") colors.push(normHex(t2.raw));
  };
  for (const [tt] of t.effects.unshieldedInputs ?? new Map()) addType(tt);
  for (const [tt] of t.effects.unshieldedOutputs ?? new Map()) addType(tt);
  for (const [[tt]] of t.effects.claimedUnshieldedSpends ?? new Map()) addType(tt);
  return { logs, mints, sightings: sightingsOf(place, "contract-unshielded", colors) };
}

function sightingsOf(part: Part, evidence: SightingEvidence, colors: Iterable<string>): ColorSighting[] {
  const unique = [...new Set([...colors].map(normHex))].filter((c) => c !== NIGHT_COLOR).sort(byString);
  return unique.map((color) => ({ phase: part.phase, segment: part.segment, color, evidence }));
}

function unshieldedOfferColors(o: UnshieldedOfferLike): string[] {
  if (o === undefined || o === null) return [];
  return [...o.inputs.map((i) => String(i.type)), ...o.outputs.map((x) => String(x.type))];
}

function zswapOfferColors(o: ZswapOfferLike): string[] {
  if (o === undefined || o === null) return [];
  return [...o.deltas.keys()].map((k) => String(k));
}

/** `VerifierKeyInsert(publishMetadata, v3)`, `VerifierKeyRemove(mint, v3)`, `ReplaceAuthority`, … */
export function describeUpdate(u: unknown): string {
  const x = u as { constructor?: { name?: string }; operation?: string | Uint8Array; version?: { version?: string }; vk?: { version?: string } };
  const kind = x.constructor?.name ?? "Unknown";
  if (x.operation === undefined) return kind;
  const op = typeof x.operation === "string" ? x.operation : Buffer.from(x.operation).toString("utf8");
  const version = x.version?.version ?? x.vk?.version;
  return `${kind}(${op}${version === undefined ? "" : `, ${version}`})`;
}

/** Deserializes a finalized transaction (the archive's `tx_raw`, the indexer's `Transaction.raw`). */
export function deserializeTransaction(raw: Uint8Array): TransactionLike {
  try {
    return Transaction.deserialize("signature", "proof", "binding", raw) as unknown as TransactionLike;
  } catch (e) {
    throw new RawDecodeError(`not a finalized ledger-v9 transaction: ${(e as Error).message}`);
  }
}

/**
 * Decodes a transaction (its serialized bytes, or an already-deserialized object) into its parts, in the ledger's
 * execution order: first the guaranteed phase — the transaction's guaranteed Zswap offer, then intents in ascending
 * segment id, actions in intent order, operations in program order — then each fallible segment in ascending segment
 * id (its Zswap offer, then its intent's fallible unshielded offer, deploys, maintenance updates and fallible
 * transcripts in action order).
 * @throws {RawDecodeError} for bytes that are not a finalized ledger-v9 transaction, or an unknown contract action.
 */
export function decodeTransaction(input: Uint8Array | TransactionLike): DecodedTransaction {
  const tx = input instanceof Uint8Array ? deserializeTransaction(input) : input;
  const intents = [...(tx.intents ?? new Map<number, IntentLike>())].sort(([a], [b]) => a - b);
  const fallibleOffers = new Map(tx.fallibleOffer ?? new Map<number, ZswapOfferLike>());
  const out: DecodedTransaction = {
    hash: normHex(String(tx.transactionHash())),
    segments: intents.map(([s]) => s),
    calls: [],
    deploys: [],
    maintenance: [],
    logs: [],
    mints: [],
    sightings: [],
  };
  out.sightings.push(...sightingsOf({ phase: "guaranteed", segment: 0 }, "shielded-offer", zswapOfferColors(tx.guaranteedOffer)));

  type Fallible = Pick<DecodedTransaction, "logs" | "mints" | "sightings" | "deploys" | "maintenance">;
  const fallible: Array<[number, Fallible]> = [];
  for (const [segment, intent] of intents) {
    const g: Part = { phase: "guaranteed", segment };
    const f: Part = { phase: "fallible", segment };
    const seg: Fallible = { logs: [], mints: [], sightings: [], deploys: [], maintenance: [] };
    out.sightings.push(...sightingsOf(g, "unshielded-utxo", unshieldedOfferColors(intent.guaranteedUnshieldedOffer)));
    seg.sightings.push(...sightingsOf(f, "shielded-offer", zswapOfferColors(fallibleOffers.get(segment))));
    fallibleOffers.delete(segment);
    seg.sightings.push(...sightingsOf(f, "unshielded-utxo", unshieldedOfferColors(intent.fallibleUnshieldedOffer)));
    intent.actions.forEach((action, actionIndex) => {
      if (action instanceof ContractCall) {
        const contractAddress = normHex(String(action.address));
        const entryPoint = entryPointText(action.entryPoint as Uint8Array | string);
        const phases: Phase[] = [];
        for (const [phase, transcript, target] of [
          ["guaranteed", action.guaranteedTranscript, out],
          ["fallible", action.fallibleTranscript, seg],
        ] as const) {
          if (transcript === undefined || transcript === null) continue;
          phases.push(phase);
          const p = transcriptParts(transcript as unknown as Transcript, { phase, segment, actionIndex, contractAddress, entryPoint });
          target.logs.push(...p.logs);
          target.mints.push(...p.mints);
          target.sightings.push(...p.sightings);
        }
        out.calls.push({ segment, actionIndex, contractAddress, entryPoint, phases });
      } else if (action instanceof ContractDeploy) {
        seg.deploys.push({ ...f, actionIndex, address: normHex(String(action.address)) });
      } else if (action instanceof MaintenanceUpdate) {
        seg.maintenance.push({
          ...f,
          actionIndex,
          address: normHex(String(action.address)),
          counter: BigInt(action.counter),
          updates: action.updates.map(describeUpdate),
        });
      } else {
        const name = (action as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof action;
        throw new RawDecodeError(`segment ${segment}, action ${actionIndex}: unknown contract action ${name}`);
      }
    });
    fallible.push([segment, seg]);
  }
  // A fallible Zswap offer whose segment has no intent still belongs to that segment's fallible part.
  for (const [segment, offer] of fallibleOffers) {
    fallible.push([segment, { logs: [], mints: [], deploys: [], maintenance: [], sightings: sightingsOf({ phase: "fallible", segment }, "shielded-offer", zswapOfferColors(offer)) }]);
  }
  fallible.sort(([a], [b]) => a - b);
  for (const [, f] of fallible) {
    out.logs.push(...f.logs);
    out.mints.push(...f.mints);
    out.sightings.push(...f.sightings);
    out.deploys.push(...f.deploys);
    out.maintenance.push(...f.maintenance);
  }
  return out;
}

/**
 * Whether a part took effect, given the transaction's outcome: nothing applies after a FAILURE; the guaranteed part
 * applies otherwise; a fallible part applies on SUCCESS, and on PARTIAL_SUCCESS only when its segment is listed with
 * `success: true`. Deploys and maintenance updates are placed in their segment's fallible part (the ledger applies
 * contract actions other than the guaranteed transcripts of calls in the fallible phase); no Stagenet fixture of a
 * failed deploy exists, so this placement is covered by unit tests only.
 */
export function partApplied(part: Part, outcome: TransactionOutcome): boolean {
  if (outcome.result === "failure") return false;
  if (part.phase === "guaranteed" || outcome.result === "success") return true;
  return (outcome.segments ?? []).some((s) => s.id === part.segment && s.success);
}

export interface AppliedParts {
  /** Applied logs, in ledger order; `eventIndex` = position among the applied logs of the transaction. */
  logs: Array<DecodedLog & { eventIndex: number }>;
  mints: DecodedMint[];
  sightings: ColorSighting[];
  deploys: DecodedDeploy[];
  maintenance: DecodedMaintenance[];
}

/** The logs, mints, sightings, deploys and maintenance updates that took effect, in ledger order. */
export function appliedParts(d: DecodedTransaction, outcome: TransactionOutcome): AppliedParts {
  const keep = <T extends Part>(xs: T[]): T[] => xs.filter((x) => partApplied(x, outcome));
  return {
    logs: keep(d.logs).map((l, eventIndex) => ({ ...l, eventIndex })),
    mints: keep(d.mints),
    sightings: keep(d.sightings),
    deploys: keep(d.deploys),
    maintenance: keep(d.maintenance),
  };
}
