import type { PackagePhase } from "./fold.js";
import { MIP_0018_NAME_HEX } from "./payload.js";

/**
 * Project 00024-01 — the reader of the **Multi-Part Event** rule ([Y], `mip-xxxx:multi-part[v1]`),
 * adopted UNCHANGED at `acedward/compact-multi-part-event` PR #1 @ `f2425f2` (spec 00024 §0).
 *
 * Normative text: [Y] `MIP-SPEC-DRAFT.md` §3 (opting in), §4 (reconstructing packages), §5
 * (atomicity) and its Testing vectors. This module restates none of it; it implements §4:
 *
 *  1. only events whose 32-byte name is an OPTED-IN name are read ({@link MULTIPART_OPT_INS});
 *     every other event is left alone (§3: "this proposal has no effect on its events");
 *  2. they are grouped by (chain, contract, name, transaction, physical intent) — on EVERY
 *     contract that emits the name, each instance on its own (spec Q16, FR-001; [Y] finding UC-4.1);
 *  3. each group is ordered by the parts' position in LEDGER EMISSION ORDER — the indexer's event
 *     id — never by delivery order (§4; the "upstream order" vector);
 *  4. every part is restored to its full 256 bytes and the parts are concatenated, every byte kept,
 *     trailing zeros included (§4; the "trailing zero" and "all-zero part" vectors).
 *
 * It never interprets the merged payload: that is the adopting protocol's business (MIP-0018's
 * decoder, `payload.ts`). It adds no rule of its own to packages — no placement rejection, no
 * verification level (spec Q6, Q15, FR-002): a guaranteed, a fallible-only and a mixed-phase
 * package are all packages, and the phase is recorded for display.
 *
 * ── Ported from the reference reader, with the differences stated ─────────────────────────────
 * Port of [Y] `src/reader/packages.ts` (`readPackages`); provenance and hashes in `./SOURCE.md`.
 * What differs, and why:
 *
 *  - **Names are opted in, not (contract, name) pairs.** The reference takes a list of
 *    `(contract, N)` opt-ins; MIP-0018 and the public-interface standard are open standards any
 *    contract may emit, so the opt-in here is the name alone and the contract is a grouping key
 *    (spec Q16; logged as [Y] finding UC-4.1). Same grouping key as the reference.
 *  - **No input bounds** (`maxEvents`, `maxPackages`): [Y] defines none (spec F18) and the reader
 *    accepts every package as the events deliver it (spec Q5, FR-004). The ONE bound is the 1 024-
 *    part safety ceiling per package, [Y]'s publisher ceiling and far above any block; reaching it
 *    means the indexer response is malformed, so it is an error for that lookup — never a
 *    truncation ({@link PackageReadError} `part_ceiling`).
 *  - **A conflicting delivery is an acquisition error, not a rejected package.** The reference marks
 *    a package `rejected` when one identity (group, position) arrives with two contents; [Y] §3
 *    places "conflicting upstream deliveries" outside the rule's input, so here it stops the lookup
 *    ({@link PackageReadError} `conflicting_delivery`) and the pair is retried. An identical
 *    redelivery (a paging overlap) is tolerated, as in the reference.
 *  - **Each part carries its phase** (`guaranteed | fallible`), derived by the caller from the
 *    archived transcripts (`events.ts`), and the package's phase is computed from its APPLIED parts
 *    (spec FR-002). The reference has no phase: it reads applied events only, exactly like this.
 *  - **Input is the part's 256-byte payload** (name already matched) rather than the 288-byte
 *    `Misc` value; restoring the width is the same operation (`restorePart`).
 */

/** The width of one `Misc` payload, and so of one part of a package ([Y] §1). */
export const PART_LENGTH = 256;

/** [Y]'s publisher ceiling, used here as a SAFETY ceiling only (spec FR-004); the schema's
 *  `parts` CHECK states the same number (migration 005). */
export const MAX_PACKAGE_PARTS = 1024;

/**
 * The event names this indexer opts into [Y], as the lowercase hex of their 32 padded bytes.
 *
 * `mip-0018:token-metadata[v1]` — MIP-0018 amended in place (UC-1). The public-interface name
 * `mip-xxxx:public-interface[v1]` joins in project 00024-02. The superseded draft name
 * `mip-xxxx:token-metadata[v1]` is deliberately NOT here (spec FR-006): its events stay single.
 */
export const MULTIPART_OPT_INS: readonly string[] = Object.freeze([MIP_0018_NAME_HEX]);

/** One applied, decoded event of an opted-in name, as the lookup hands it to the reader. */
export interface PartEvent {
  /** The chain the source belongs to (this indexer's `NET`). */
  network: string;
  /** Emitting contract, 64 lowercase hex. */
  contract: string;
  /** The event's 32 name bytes, lowercase hex. */
  nameHex: string;
  /** Hash of the transaction holding the event, lowercase hex. */
  transactionHash: string;
  /** `EventSource.physicalSegment`: the intent of the call that emitted it, 1..65535. */
  segment: number;
  /** Position in ledger emission order — the indexer's event id (it follows that order). */
  position: number;
  /** The payload as delivered: at most 256 bytes; trailing zeros may have been trimmed. */
  payload: Uint8Array;
  /** The execution phase this part was applied in, from the archived transcripts. */
  phase: "guaranteed" | "fallible";
}

/** One package: every applied event of one opted-in name one contract emitted from one intent. */
export interface Package {
  network: string;
  contract: string;
  nameHex: string;
  transactionHash: string;
  segment: number;
  /** The parts' positions (indexer event ids), ascending — ledger emission order. */
  positions: number[];
  /** Width-restored 256-byte payloads, in position order. */
  parts: Uint8Array[];
  /** Concatenation of `parts`: exactly `256 · parts.length` bytes. */
  payload: Uint8Array;
  /** `guaranteed` / `fallible` when every part shares it; `mixed` otherwise (a publisher error
   *  under [Y] §5, recorded and shown, never dropped — spec FR-002). */
  phase: PackagePhase;
}

export interface ReadOutput {
  /** Sorted by network, contract, name, transaction, then segment (as the reference sorts). */
  packages: Package[];
  /** Events of other names or networks, left untouched. */
  ignored: number;
}

export type PackageReadErrorReason = "part_ceiling" | "conflicting_delivery" | "malformed_part";

/** The reader's input was not the valid, complete, consistent event set [Y] §3 presumes. The
 *  lookup records the pair as pending and retries it; nothing of it is stored. */
export class PackageReadError extends Error {
  constructor(readonly reason: PackageReadErrorReason, message: string) {
    super(message);
    this.name = "PackageReadError";
  }
}

export interface ReadOptions {
  /** Opted-in names (32-byte name hex). Default {@link MULTIPART_OPT_INS}; a test configuration
   *  may opt in another name (spec US2: `example:message[v1]` for the recorded Stagenet vectors). */
  optIns?: readonly string[];
  /** Only read events of this network. */
  network?: string;
}

/** Restore one part to its full width: the ledger trims trailing zeros ([Y] `restoreEventValue`). */
export function restorePart(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > PART_LENGTH) {
    throw new PackageReadError(
      "malformed_part", `a part is ${payload.byteLength} bytes; at most ${PART_LENGTH} allowed`,
    );
  }
  const full = new Uint8Array(PART_LENGTH);
  full.set(payload);
  return full;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Code-unit order, locale-independent (the reference's `compareCodeUnits`). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function checkEvent(event: PartEvent, index: number): void {
  const where = `part event ${index} (position ${String(event.position)})`;
  if (event.network.length === 0 || event.transactionHash.length === 0) {
    throw new PackageReadError("malformed_part", `${where}: empty network or transaction hash`);
  }
  if (!Number.isInteger(event.segment) || event.segment < 1 || event.segment > 65535) {
    throw new PackageReadError("malformed_part", `${where}: segment ${String(event.segment)} is not in 1..65535`);
  }
  if (!Number.isSafeInteger(event.position) || event.position < 0) {
    throw new PackageReadError("malformed_part", `${where}: position must be a non-negative safe integer`);
  }
  if (event.phase !== "guaranteed" && event.phase !== "fallible") {
    throw new PackageReadError("malformed_part", `${where}: phase ${String(event.phase)} is not guaranteed|fallible`);
  }
}

interface Group {
  network: string;
  contract: string;
  nameHex: string;
  transactionHash: string;
  segment: number;
  byPosition: Map<number, { part: Uint8Array; phase: "guaranteed" | "fallible" }>;
}

/**
 * [Y] §4 over one delivery of events, in any order, from any number of pages.
 *
 * @throws {PackageReadError} on an event outside [Y]'s input (a malformed part or source field, a
 *   position delivered with two contents) or a package beyond the safety ceiling.
 */
export function readPackages(events: readonly PartEvent[], options: ReadOptions = {}): ReadOutput {
  const optIns = new Set((options.optIns ?? MULTIPART_OPT_INS).map((n) => n.toLowerCase()));
  const groups = new Map<string, Group>();
  let ignored = 0;

  events.forEach((event, index) => {
    const nameHex = event.nameHex.toLowerCase();
    if (!optIns.has(nameHex) || (options.network !== undefined && event.network !== options.network)) {
      ignored += 1;
      return;
    }
    checkEvent(event, index);
    const part = restorePart(event.payload);
    const key = JSON.stringify([event.network, event.contract, nameHex, event.transactionHash, event.segment]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        network: event.network, contract: event.contract, nameHex,
        transactionHash: event.transactionHash, segment: event.segment, byPosition: new Map(),
      };
      groups.set(key, group);
    }
    const seen = group.byPosition.get(event.position);
    if (seen === undefined) {
      group.byPosition.set(event.position, { part, phase: event.phase });
    } else if (!bytesEqual(seen.part, part) || seen.phase !== event.phase) {
      throw new PackageReadError(
        "conflicting_delivery",
        `position ${String(event.position)} of transaction ${event.transactionHash} segment ` +
        `${String(event.segment)} was delivered with two contents`,
      );
    }
    // else: an identical redelivery — tolerated, exactly as the reference does.
  });

  const packages: Package[] = [...groups.values()]
    .sort((a, b) =>
      cmp(a.network, b.network) || cmp(a.contract, b.contract) || cmp(a.nameHex, b.nameHex) ||
      cmp(a.transactionHash, b.transactionHash) || a.segment - b.segment)
    .map((group) => {
      const positions = [...group.byPosition.keys()].sort((a, b) => a - b);
      if (positions.length > MAX_PACKAGE_PARTS) {
        throw new PackageReadError(
          "part_ceiling",
          `transaction ${group.transactionHash} segment ${String(group.segment)} holds ` +
          `${String(positions.length)} parts, above the ${String(MAX_PACKAGE_PARTS)}-part safety ceiling`,
        );
      }
      const entries = positions.map((p) => group.byPosition.get(p)!);
      const parts = entries.map((e) => e.part);
      const payload = new Uint8Array(parts.length * PART_LENGTH);
      parts.forEach((part, i) => payload.set(part, i * PART_LENGTH));
      const phases = new Set(entries.map((e) => e.phase));
      const phase: PackagePhase = phases.size > 1 ? "mixed" : (entries[0]!.phase);
      return {
        network: group.network, contract: group.contract, nameHex: group.nameHex,
        transactionHash: group.transactionHash, segment: group.segment,
        positions, parts, payload, phase,
      };
    });
  return { packages, ignored };
}
