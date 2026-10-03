/**
 * The applied-parts decoder: from one archived raw transaction, everything the MIP-0018 indexer reads — the `log`
 * operations of contract calls, the `shieldedMints` / `unshieldedMints` effects, contract deploys, maintenance
 * updates, and the token colors visible in public data — each placed in its part of the transaction, in the ledger's
 * execution order; and the filter that keeps only the parts that took effect. ONE module, used by the mint table and
 * seen tokens and by the metadata events: one deserialization per transaction.
 *
 * Port (UmbraDB's own code, not vendored) of `decodeTransaction`, `readLogItem`, `partApplied` and `applied` from the
 * MIP-0018 reference implementation, `packages/midnight/src/raw.ts` of https://github.com/midnight-experiments/mip-0018
 * @ daec1f19747b09f4e245885ab0dd9ecc789a82ce (Apache-2.0, © the mip-0018 reference authors; see
 * `token-indexer/vendor/mip0018/LICENSE` and `NOTICE`). Differences from the reference: UmbraDB's archive outcome shape
 * (`success` / `partial_success` / `failure` + `{id, success}` segments); an unknown contract action is an error
 * instead of being skipped (a scanner must not silently pass over what it cannot classify); deploys and maintenance
 * updates are placed in their segment's fallible part (see `partApplied`); the token colors of public data (unshielded
 * offers, Zswap offer deltas, unshielded transcript effects) are collected for the seen-token list; amounts and colors
 * are sorted so that the ledger's random `Map` order never leaks into stored rows.
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
 * What applied: a FAILURE applies nothing; otherwise the guaranteed part applies, and a
 * fallible part only when its segment succeeded (`SUCCESS`: every segment; `PARTIAL_SUCCESS`: a segment listed with
 * `success: true` — one missing from the list counts as failed).
 *
 * Logged values (ledger v2.0.0-rc.4 `onchain-vm/src/vm.rs` `Log`, `try_decode_event`, `decode_event`):
 * the ledger's `log` op logs the value on top of the VM stack. A value that is a well-formed `[u32, LogEventType, data]`
 * triple is an event of that type; ANY other value is a `Misc` event, version 0, whose data is the whole value. The
 * decoder reproduces that rule exactly when the raw transaction shows the logged value, i.e. when the only way the VM
 * reaches the `log` op is straight from a `push` op right before it (`logSites`: the program's forward-only
 * `branch`/`jmp` control flow is followed; a `branch` whose condition is a value pushed right before it is decided).
 * A `log` op the VM never executes in a successful run logs nothing (as on the ledger). A `log` op whose operand comes
 * from anything else (`dup`, `swap`, `idx`, `concat`, …, i.e. from the contract's state), or that runs only on some
 * paths (a `branch` on a value of the contract's state), cannot be read from the raw transaction: it is reported as
 * `unresolved` with its reason — never skipped and never applied (scan: an `unresolved` event row).
 */
import { ContractCall, ContractDeploy, MaintenanceUpdate, Transaction } from "@midnightntwrk/ledger-v9";
import { NAME_SIZE, PAYLOAD_SIZE, splitMiscData, toHex } from "../vendor/mip0018/codec/src/index.ts";
import { entryPointBytes, entryPointLabel } from "./entry-point.ts";

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
  /** The entry point's exact bytes, lowercase hex (arbitrary bytes on the ledger: NUL, non-UTF-8 — `entry-point.ts`). */
  entryPoint: string;
}

/** Why a `log` op's event cannot be known from the raw transaction (an `unresolved` event row; never applied). */
export type UnresolvedReason = "log-operand-not-pushed" | "log-conditionally-executed";

export interface DecodedLog extends CallPlacement {
  /** Index of the `log` op in its transcript program. */
  opIndex: number;
  /** Set when the logged value cannot be read from the raw transaction; then version and type are `null`. */
  unresolved?: UnresolvedReason;
  version: number | null;
  eventTypeCode: number | null;
  /** MIP-0002 `LogEventType` name (`Misc` for code 10), or `null` when unresolved. */
  eventType: string | null;
  /** `versioned`: a well-formed `[u32, LogEventType, data]` triple; `bare`: any other value (ledger: `Misc`, version 0). */
  form?: "versioned" | "bare";
  /** `Misc` only: the data item zero-extended to 288 bytes, split — lowercase hex of 32 and 256 bytes. */
  name?: string;
  payload?: string;
  /** Why a `Misc` event's data could not be read as one `name ‖ payload` item (stored as `ignore`). */
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
  /**
   * Each update as `<kind>(<operation>, <version>)`, e.g. `VerifierKeyInsert(publishMetadata, v3)` — ASCII only: an
   * operation that is not printable is drawn as `<bytes HEX>` (`entry-point.ts` `entryPointLabel`).
   */
  updates: string[];
  /** Per update, its operation's exact bytes (lowercase hex), or `null` for an update without one (`ReplaceAuthority`). */
  operations: Array<string | null>;
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

/** A cell's atoms (`EncodedStateValue` `{tag: "cell", content: AlignedValue}`), or `undefined` for anything else. */
function cellAtoms(v: Encoded | undefined): Uint8Array[] | undefined {
  if (v?.tag !== "cell") return undefined;
  const atoms = (v.content as Partial<Aligned> | undefined)?.value;
  return Array.isArray(atoms) && atoms.every((a) => a instanceof Uint8Array) ? atoms : undefined;
}

/**
 * The ledger's `u32::try_from(&ValueSlice)` / `u8::try_from(&ValueSlice)` (`base-crypto/src/fab/conversions.rs`): a cell
 * of exactly one atom of at most 16 bytes, little-endian, at most `max`; otherwise `undefined`.
 */
function uintOfCell(v: Encoded | undefined, max: bigint): number | undefined {
  const atoms = cellAtoms(v);
  if (atoms === undefined || atoms.length !== 1) return undefined;
  const a = atoms[0]!;
  if (a.length > 16) return undefined;
  let n = 0n;
  for (let i = a.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(a[i]!);
  return n <= max ? Number(n) : undefined;
}

/** The ledger's `try_decode_event`: an array of exactly three, `[u32 version, LogEventType (0–10), data]`. */
function tryVersioned(v: Encoded | undefined): { version: number; code: number; data: Encoded | undefined } | undefined {
  if (v?.tag !== "array" || !Array.isArray(v.content) || v.content.length !== 3) return undefined;
  const [ver, et, data] = v.content as Array<Encoded | undefined>;
  const version = uintOfCell(ver, 0xffff_ffffn);
  const code = uintOfCell(et, 0xffn);
  if (version === undefined || code === undefined || code >= LOG_EVENT_TYPES.length) return undefined;
  return { version, code, data };
}

export type LogItem = Required<Pick<DecodedLog, "form">> & { version: number; eventTypeCode: number; eventType: string } & Pick<DecodedLog, "name" | "payload" | "undecodable">;

/**
 * The event a logged value is, by the ledger's `decode_event` (`onchain-vm/src/vm.rs`): a well-formed
 * `[version, eventType, data]` triple is an event of that type; any other value is a `Misc` event, version 0, whose
 * data is the whole value. `Misc` data that is a cell of one atom of at most 288 bytes is zero-extended to 288 bytes
 * and split `name ‖ payload` (MIP "Consuming"); any other data cannot be read as one item (`undecodable`).
 */
export function readLogItem(pushed: unknown): LogItem {
  const value = pushed as Encoded | undefined;
  const v = tryVersioned(value);
  const form = v === undefined ? "bare" : "versioned";
  const version = v?.version ?? 0;
  const eventTypeCode = v?.code ?? MISC_EVENT_TYPE_CODE;
  const out: LogItem = { form, version, eventTypeCode, eventType: LOG_EVENT_TYPES[eventTypeCode]! };
  if (eventTypeCode !== MISC_EVENT_TYPE_CODE) return out;
  const atoms = cellAtoms(v === undefined ? value : v.data);
  if (atoms === undefined || atoms.length !== 1)
    return { ...out, undecodable: v === undefined ? "the logged value is neither a [version, type, data] triple nor a cell of one atom" : "Misc data is not a cell of one atom" };
  const atom = atoms[0]!;
  const split = splitMiscData(atom); // zero-extends the whole item to 288 bytes, then splits 32 | 256
  if (split === undefined) return { ...out, undecodable: `Misc data is ${atom.length} bytes (> ${MISC_DATA_SIZE})` };
  return { ...out, name: toHex(split.name), payload: toHex(split.payload) };
}

/** What the raw transaction says about one `log` op of a transcript program. */
export type LogSite =
  | { opIndex: number; status: "resolved"; pushed: unknown }
  | { opIndex: number; status: "never" }
  | { opIndex: number; status: "unresolved"; reason: UnresolvedReason };

const opKind = (op: unknown): string | undefined =>
  typeof op === "string" ? op : op !== null && typeof op === "object" ? Object.keys(op)[0] : undefined;

function skipOf(op: unknown, kind: "branch" | "jmp", at: number): number {
  const skip = (op as Record<string, { skip?: unknown } | undefined>)[kind]?.skip;
  if (typeof skip !== "number" || !Number.isSafeInteger(skip) || skip < 0) throw new RawDecodeError(`op ${at}: ${kind} without a valid skip`);
  return skip;
}

/**
 * The `log` ops of a transcript program and whether the raw transaction shows what each one logs. The VM runs the
 * program forward; after op `p` it continues at `p + 1`, or at `p + 1 + skip` after a `jmp` and after a `branch` whose
 * popped condition is not the empty cell (ledger `vm.rs`, end of the op loop). A successful run ends exactly at the
 * program's end. So, over the paths from the first op to the end:
 * - a `log` op on no such path never logs (`never`: the ledger emits nothing for it);
 * - a `log` op not on every such path runs only for some contract states (`unresolved`, `log-conditionally-executed`);
 * - a `log` op on every path whose only way in is the fall-through from a `push` op logs that pushed value
 *   (`resolved`); any other `log` op logs a value made from the contract's state (`unresolved`, `log-operand-not-pushed`).
 * A `branch` whose only way in is the fall-through from a `push` op is decided by that pushed value. Pure; never
 * throws on hostile control flow (a jump past the end is a failing path, which a successful run does not take).
 */
export function logSites(program: readonly unknown[]): LogSite[] {
  const n = program.length;
  const kinds = program.map(opKind);
  const reach = new Array<boolean>(n + 1).fill(false);
  const preds: number[][] = Array.from({ length: n + 1 }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  if (n > 0) reach[0] = true;
  const onlyFromPush = (p: number): boolean => p >= 1 && kinds[p - 1] === "push" && preds[p]!.length === 1 && preds[p]![0] === p - 1;
  for (let p = 0; p < n; p++) {
    if (!reach[p]) continue;
    const kind = kinds[p];
    let targets: number[];
    if (kind === "jmp") {
      targets = [p + 1 + skipOf(program[p], "jmp", p)];
    } else if (kind === "branch") {
      const skip = skipOf(program[p], "branch", p);
      if (onlyFromPush(p)) {
        const cond = (program[p - 1] as { push: { value: unknown } }).push.value as Encoded;
        const atoms = cellAtoms(cond);
        // `branch` pops a cell (anything else fails the run); the empty single-atom cell means "do not skip".
        targets = atoms === undefined ? [] : atoms.length === 1 && atoms[0]!.length === 0 ? [p + 1] : [p + 1 + skip];
      } else {
        targets = [p + 1, p + 1 + skip];
      }
    } else {
      targets = [p + 1];
    }
    for (const t of new Set(targets)) {
      if (t > n) continue; // runs past the end: the ledger fails the run
      succs[p]!.push(t);
      preds[t]!.push(p);
      reach[t] = true;
    }
  }
  // Ops on a path that ends at the program's end (a successful run).
  const live = new Array<boolean>(n + 1).fill(false);
  live[n] = reach[n]!;
  for (let p = n - 1; p >= 0; p--) live[p] = reach[p]! && succs[p]!.some((t) => live[t]);
  // Immediate dominators over the live ops (forward edges only: index order is a topological order).
  const idom = new Array<number>(n + 1).fill(-1);
  const always = new Array<boolean>(n + 1).fill(false);
  if (live[n]) {
    idom[0] = 0;
    const intersect = (a: number, b: number): number => {
      while (a !== b) {
        while (a > b) a = idom[a]!;
        while (b > a) b = idom[b]!;
      }
      return a;
    };
    for (let v = 1; v <= n; v++) {
      if (!live[v]) continue;
      const ps = preds[v]!.filter((u) => live[u]);
      idom[v] = ps.reduce((d, u) => intersect(d, u));
    }
    for (let w = n; ; w = idom[w]!) {
      always[w] = true;
      if (w === 0) break;
    }
  }
  const sites: LogSite[] = [];
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== "log") continue;
    if (!live[i]) sites.push({ opIndex: i, status: "never" });
    else if (!always[i]) sites.push({ opIndex: i, status: "unresolved", reason: "log-conditionally-executed" });
    else if (kinds[i - 1] === "push" && preds[i]!.filter((u) => live[u]).every((u) => u === i - 1))
      sites.push({ opIndex: i, status: "resolved", pushed: (program[i - 1] as { push: { value: unknown } }).push.value });
    else sites.push({ opIndex: i, status: "unresolved", reason: "log-operand-not-pushed" });
  }
  return sites;
}

function transcriptParts(t: Transcript, place: CallPlacement): { logs: DecodedLog[]; mints: DecodedMint[]; sightings: ColorSighting[] } {
  const logs: DecodedLog[] = [];
  for (const site of logSites(t.program)) {
    if (site.status === "never") continue; // the VM never runs it in a successful run: the ledger logs nothing
    if (site.status === "unresolved") logs.push({ ...place, opIndex: site.opIndex, unresolved: site.reason, version: null, eventTypeCode: null, eventType: null });
    else logs.push({ ...place, opIndex: site.opIndex, ...readLogItem(site.pushed) });
  }
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

type UpdateLike = { constructor?: { name?: string }; operation?: string | Uint8Array; version?: { version?: string }; vk?: { version?: string } };

/** A maintenance update's operation (an entry point: arbitrary bytes), lowercase hex; `null` when it has none. */
export function updateOperation(u: unknown): string | null {
  const x = u as UpdateLike;
  return x.operation === undefined ? null : entryPointBytes(x.operation).toString("hex");
}

/**
 * `VerifierKeyInsert(publishMetadata, v3)`, `VerifierKeyRemove(mint, v3)`, `ReplaceAuthority`, … — ASCII only: the
 * kind is the ledger-v9 class name and the version its `v3`/`v4` tag; an operation that is not printable is drawn as
 * `<bytes HEX>` (its exact bytes are kept by `updateOperation`).
 */
export function describeUpdate(u: unknown): string {
  const x = u as UpdateLike;
  const kind = x.constructor?.name ?? "Unknown";
  if (x.operation === undefined) return kind;
  const op = entryPointLabel(entryPointBytes(x.operation));
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
        const entryPoint = entryPointBytes(action.entryPoint as Uint8Array | string).toString("hex");
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
          operations: action.updates.map(updateOperation),
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
