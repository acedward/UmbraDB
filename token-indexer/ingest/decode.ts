/* eslint-disable @typescript-eslint/no-explicit-any */
import { isSystemTransaction } from "../../chain-archive-sync/tx-replay-decoder.js";
import { KIND_SHIELDED_NATIVE, KIND_UNSHIELDED_NATIVE, type NativeKindByte } from "./payload.js";

/**
 * Project 00020 — what one archived transaction says about contracts and minting (spec §6.3,
 * FR-001).
 *
 * Everything here is read out of the transaction's own PUBLIC bytes; nothing is executed and
 * nothing is fetched. Three facts come out:
 *
 *  - every `ContractDeploy` (its address), so a contract is known from its first block;
 *  - every `ContractCall` (address, entry point), so a contract deployed before the archive's
 *    first block is still discovered at its next call;
 *  - per call and per transcript, the `effects.shieldedMints` / `effects.unshieldedMints` maps and
 *    the NUMBER of `log` ops in the transcript's program.
 *
 * The mint maps are the ledger's own declaration, checked against execution before the call was
 * applied (`onchain-runtime/src/context.rs`), which is why a mint can be treated as a FACT rather
 * than as a claim. The `log` count is the other half of the design: a contract event's *contents*
 * come from the VM stack and are not in the transaction at all, but the *presence and count* of
 * the `log` opcode is — so the scanner knows exactly which `(transaction, contract)` pairs emitted
 * and how many events, with no watch list and no subscription.
 *
 * The ledger module is INJECTED (never imported here) for the same reason
 * `chain-archive-sync/tx-replay-decoder.ts` injects it: the walk stays unit-testable and this file
 * typechecks in an environment without the WASM package loaded.
 */

export interface TranscriptFacts {
  /** `log` opcodes in this transcript's program — the number of events this call emitted here. */
  logOps: number;
  /** domainSep (lowercase hex) → amount, from `effects.shieldedMints`. */
  shieldedMints: Map<string, bigint>;
  /** domainSep (lowercase hex) → amount, from `effects.unshieldedMints`. */
  unshieldedMints: Map<string, bigint>;
}

export interface DecodedContractAction {
  /** The intent segment this action sat in — the key of `tx.intents`, and what a
   *  `PARTIAL_SUCCESS` transaction's `segments[].id` refers to. */
  segment: number;
  /** Index of the action within `intent.actions` — part of `token_mints`' primary key. */
  callIndex: number;
  kind: "deploy" | "call" | "maintenance";
  /** Contract address, lowercase hex. */
  address: string;
  /** Present for a call; a deploy and a maintenance update have none. */
  entryPoint: string | undefined;
  guaranteed: TranscriptFacts | undefined;
  fallible: TranscriptFacts | undefined;
}

export interface DecodedTransactionActions {
  /** `undefined` for a system transaction (which carries no contract actions at all). */
  actions: DecodedContractAction[] | undefined;
  isSystem: boolean;
}

function hex(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value).toLowerCase();
}

/** An entry point is `Uint8Array | string` in the ledger typings; on chain it is an ASCII circuit
 *  name (`"mint"`, observed live). Bytes are rendered as hex so nothing is ever lossy. */
function entryPointOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) {
    const text = Buffer.from(raw).toString("utf8");
    return /^[\x20-\x7e]+$/.test(text) ? text : Buffer.from(raw).toString("hex");
  }
  return String(raw);
}

function transcriptFacts(transcript: any): TranscriptFacts | undefined {
  if (transcript === undefined || transcript === null) return undefined;
  const program: unknown[] = transcript.program ?? [];
  let logOps = 0;
  for (const op of program) {
    // The `log` opcode is the BARE string `'log'` in `Op<R>` — never an object form, so an
    // equality test is exact rather than a heuristic (`ledger-v9.d.ts:216-263`).
    if (op === "log") logOps++;
  }
  const toMap = (source: unknown): Map<string, bigint> => {
    const out = new Map<string, bigint>();
    if (source === undefined || source === null) return out;
    for (const [domainSep, amount] of source as Iterable<[string, bigint]>) {
      out.set(hex(domainSep), BigInt(amount));
    }
    return out;
  };
  const effects = transcript.effects ?? {};
  return {
    logOps,
    shieldedMints: toMap(effects.shieldedMints),
    unshieldedMints: toMap(effects.unshieldedMints),
  };
}

/**
 * Decodes one archived `tx_raw` payload into its contract actions.
 *
 * @param ledger the loaded ledger module (`loadLedgerV9()`), injected.
 * @param rawBytes exactly the bytes the archive stores (role `tx_raw`).
 * @throws if the bytes are not a Midnight transaction payload, or if an action's runtime shape is
 *   one this walk does not recognise — an unrecognised action is NEVER silently skipped, because
 *   that would lose mints without any signal.
 */
export function decodeTransactionActions(ledger: any, rawBytes: Uint8Array): DecodedTransactionActions {
  if (isSystemTransaction(rawBytes)) return { actions: undefined, isSystem: true };

  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", rawBytes);
  const actions: DecodedContractAction[] = [];
  if (tx.intents === undefined || tx.intents === null) return { actions, isSystem: false };

  for (const [segmentRaw, intent] of tx.intents) {
    const segment = Number(segmentRaw);
    const list: any[] = intent.actions ?? [];
    for (let callIndex = 0; callIndex < list.length; callIndex++) {
      const action = list[callIndex];
      const name = classify(ledger, action);
      actions.push({
        segment,
        callIndex,
        kind: name,
        address: hex(action.address),
        entryPoint: name === "call" ? entryPointOf(action.entryPoint) : undefined,
        guaranteed: name === "call" ? transcriptFacts(action.guaranteedTranscript) : undefined,
        fallible: name === "call" ? transcriptFacts(action.fallibleTranscript) : undefined,
      });
    }
  }
  return { actions, isSystem: false };
}

/**
 * `ContractAction<P> = ContractCall<P> | ContractDeploy | MaintenanceUpdate` — decided by
 * `instanceof` against the SAME module instance that produced the object (one cached dynamic
 * import), with a structural fallback for the case where a future build hands back a plain object.
 * Anything else throws rather than being dropped.
 */
function classify(ledger: any, action: any): "deploy" | "call" | "maintenance" {
  if (ledger.ContractCall !== undefined && action instanceof ledger.ContractCall) return "call";
  if (ledger.ContractDeploy !== undefined && action instanceof ledger.ContractDeploy) return "deploy";
  if (ledger.MaintenanceUpdate !== undefined && action instanceof ledger.MaintenanceUpdate) return "maintenance";

  const ctor = action?.constructor?.name;
  if (ctor === "ContractCall") return "call";
  if (ctor === "ContractDeploy") return "deploy";
  if (ctor === "MaintenanceUpdate") return "maintenance";

  if (action?.entryPoint !== undefined) return "call";
  if (action?.initialState !== undefined) return "deploy";

  throw new Error(
    `decodeTransactionActions: unrecognised contract action (constructor ${JSON.stringify(ctor)}) — ` +
    "refusing to skip it, because a silently dropped action loses mints with no signal",
  );
}

/** One mint the scanner will record: a single entry of one transcript's mint map. */
export interface ObservedMint {
  segment: number;
  callIndex: number;
  address: string;
  domainSep: string;
  /** The MIP §3 kind byte this mint effect maps to: 0 unshielded native from `unshieldedMints`,
   *  1 shielded native from `shieldedMints`. A mint is native by definition (MIP §6.3), so the two
   *  ledger kinds can never come from here. */
  kind: NativeKindByte;
  amount: bigint;
  entryPoint: string | undefined;
  section: "guaranteed" | "fallible";
}

/**
 * Applies spec FR-002's counting rule to one decoded transaction: which of its declared mints
 * actually took effect, and how many events the scanner must therefore look up.
 *
 * - a GUARANTEED transcript's effects count unless the whole transaction failed;
 * - a FALLIBLE transcript's effects count only if that call's intent SEGMENT succeeded.
 *
 * `segments` comes from the archive (`chain_archive.transactions.segments`, spec FR-002). For a
 * `SUCCESS` transaction it is absent and every segment succeeded; for `PARTIAL_SUCCESS` it is
 * required, and its absence is an explicit error naming the transaction rather than a guess
 * (spec §6.3 step 4).
 */
export function countedEffects(
  decoded: DecodedTransactionActions,
  result: "success" | "partial_success" | "failure",
  segments: readonly { id: number; success: boolean }[] | null,
  txHashHex: string,
): { mints: ObservedMint[]; logOpsByAddress: Map<string, number>; callAddresses: Set<string>; deployAddresses: Set<string> } {
  const mints: ObservedMint[] = [];
  const logOpsByAddress = new Map<string, number>();
  const callAddresses = new Set<string>();
  const deployAddresses = new Set<string>();
  if (decoded.actions === undefined) {
    return { mints, logOpsByAddress, callAddresses, deployAddresses };
  }

  const guaranteedCounts = result !== "failure";
  const segmentSucceeded = (segment: number): boolean => {
    if (result === "failure") return false;
    if (result === "success") return true;
    if (segments === null || segments === undefined) {
      throw new Error(
        `transaction ${txHashHex} is partial_success but the archive has no segments for it — ` +
        "run `token-indexer backfill-results` for its block; refusing to guess which segment applied",
      );
    }
    const entry = segments.find((s) => s.id === segment);
    if (entry === undefined) {
      // A segment the indexer did not report inside a PARTIAL_SUCCESS result did not succeed.
      return false;
    }
    return entry.success;
  };

  for (const action of decoded.actions) {
    if (action.kind === "deploy") {
      deployAddresses.add(action.address);
      continue;
    }
    if (action.kind !== "call") continue;
    callAddresses.add(action.address);

    const sections: [("guaranteed" | "fallible"), TranscriptFacts | undefined, boolean][] = [
      ["guaranteed", action.guaranteed, guaranteedCounts],
      ["fallible", action.fallible, segmentSucceeded(action.segment)],
    ];
    for (const [section, facts, counts] of sections) {
      if (facts === undefined || !counts) continue;
      if (facts.logOps > 0) {
        logOpsByAddress.set(action.address, (logOpsByAddress.get(action.address) ?? 0) + facts.logOps);
      }
      for (const [domainSep, amount] of facts.shieldedMints) {
        mints.push({ segment: action.segment, callIndex: action.callIndex, address: action.address,
          domainSep, kind: KIND_SHIELDED_NATIVE, amount, entryPoint: action.entryPoint, section });
      }
      for (const [domainSep, amount] of facts.unshieldedMints) {
        mints.push({ segment: action.segment, callIndex: action.callIndex, address: action.address,
          domainSep, kind: KIND_UNSHIELDED_NATIVE, amount, entryPoint: action.entryPoint, section });
      }
    }
  }
  return { mints, logOpsByAddress, callAddresses, deployAddresses };
}
