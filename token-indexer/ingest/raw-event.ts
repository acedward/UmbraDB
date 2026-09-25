/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Project 00024-01 task B2 — one indexer contract event's `raw` field, decoded with ledger-v9.
 *
 * The indexer's typed `MiscContractEvent` carries no intent (spec F2b). Its `raw` field — present on
 * every `ContractEvent` type — is the serialized ledger `Event`, whose `EventSource` names the
 * transaction and the **physical segment**: the intent of the call that emitted it. That is the
 * grouping key [Y] §4 needs, taken per event exactly as the ledger recorded it (spec Q4, FR-003),
 * and it is what [Y]'s reference client reads (`src/indexer/index.ts` `partEventsFromIndexer`,
 * `src/reader/transaction.ts` `partEventsFromLedgerEvents` / `decodeMiscValue`; provenance in
 * `./SOURCE.md`).
 *
 * `EventSource.logicalSegment` is deliberately NOT read: the ledger sets it to the guaranteed
 * segment (0) for contract events of BOTH phases (`midnight-ledger` `ledger/src/semantics.rs`,
 * measured on Stagenet too — evidence note §01-B research), so a part's phase comes from the
 * archived transcripts instead (`events.ts`).
 *
 * The ledger module is INJECTED, like everywhere else in this ingest path, so the walk is testable
 * against the fake ledger and this file typechecks without the WASM package.
 */

/** A `Misc` value is a 32-byte name then a 256-byte payload, logged as one 288-byte cell. */
export const MISC_VALUE_LENGTH = 288;
export const NAME_LENGTH = 32;

/** One decoded contract `Misc` event, as the multi-part reader needs it. */
export interface DecodedRawEvent {
  /** Lowercase hex. */
  transactionHash: string;
  /** `EventSource.physicalSegment`. */
  physicalSegment: number;
  /** Emitting contract, lowercase hex. */
  address: string;
  /** The 32 name bytes, lowercase hex. */
  nameHex: string;
  /** The 256-byte payload, width restored. */
  payload: Uint8Array;
}

/** `raw` did not decode into a contract `Misc` event consistent with the indexer's typed fields.
 *  The lookup records the pair as pending and retries it; nothing of it is stored (audit F1). */
export class RawEventError extends Error {
  constructor(readonly eventId: number, message: string) {
    super(`indexer event ${eventId}: ${message}`);
    this.name = "RawEventError";
  }
}

function lowerHex(value: unknown): string {
  if (typeof value === "string") return (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value).toLowerCase();
}

/**
 * The single `bytes` atom of a `cell` — [Y] `cellAtom`. A logged `Misc` value is one `bytes(288)`
 * atom with its trailing zeros trimmed by the ledger.
 */
function cellAtom(eventId: number, value: any, width: number): Uint8Array {
  if (value?.tag !== "cell") throw new RawEventError(eventId, `logged data is a '${String(value?.tag)}', not a cell`);
  const alignment = value.content?.alignment;
  const atoms = value.content?.value;
  const [segment] = alignment ?? [];
  if (
    !Array.isArray(alignment) || alignment.length !== 1 || segment?.tag !== "atom"
    || segment.value?.tag !== "bytes" || segment.value.length !== width
  ) {
    throw new RawEventError(eventId, "logged data is not a single bytes(288) atom");
  }
  if (!Array.isArray(atoms) || atoms.length !== 1 || !(atoms[0] instanceof Uint8Array)) {
    throw new RawEventError(eventId, `cell holds ${Array.isArray(atoms) ? atoms.length : "no"} atoms`);
  }
  const atom = atoms[0] as Uint8Array;
  if (atom.byteLength > width) throw new RawEventError(eventId, "cell atom exceeds its width");
  return atom;
}

/**
 * Decodes one event's `raw` hex with `ledger.Event.deserialize` and checks it against what the
 * indexer's typed fields and the lookup already say — [Y]'s `partEventsFromIndexer` checks: the
 * raw event is a `contractLog` of type `misc` from `expected.address` in `expected.txHash`, and its
 * name and width-restored payload equal the typed `name`/`payload`.
 *
 * @throws {RawEventError} on anything else — an absent or undecodable `raw`, another event kind, a
 *   different transaction or contract, or typed fields that disagree with `raw`.
 */
export function decodeRawMiscEvent(
  ledger: any,
  event: { eventId: number; rawHex: string | undefined; nameHex: string; payloadHex: string },
  expected: { txHash: string; address: string },
): DecodedRawEvent {
  const id = event.eventId;
  if (event.rawHex === undefined || event.rawHex.length === 0) {
    throw new RawEventError(id, "the indexer served no `raw` bytes; its intent is unknown");
  }
  if (ledger?.Event?.deserialize === undefined) {
    throw new RawEventError(id, "no ledger module to decode `raw` with");
  }
  let decoded: any;
  try {
    decoded = ledger.Event.deserialize(new Uint8Array(Buffer.from(event.rawHex, "hex")));
  } catch (error) {
    throw new RawEventError(
      id, `\`raw\` does not decode (${error instanceof Error ? error.message : String(error)}); its intent is unknown`,
    );
  }
  const content = decoded?.content;
  if (content?.tag !== "contractLog") throw new RawEventError(id, `\`raw\` is a '${String(content?.tag)}' event, not a contract log`);
  if (content.loggedItem?.eventType !== "misc") {
    throw new RawEventError(id, `\`raw\` logs a '${String(content.loggedItem?.eventType)}' event, not misc`);
  }
  const address = lowerHex(content.address);
  if (address !== expected.address) throw new RawEventError(id, `\`raw\` was emitted by ${address}, not ${expected.address}`);
  const transactionHash = lowerHex(decoded.source?.transactionHash);
  if (transactionHash !== expected.txHash) {
    throw new RawEventError(id, `\`raw\` belongs to transaction ${transactionHash}, not ${expected.txHash}`);
  }
  const physicalSegment = Number(decoded.source?.physicalSegment);
  if (!Number.isInteger(physicalSegment) || physicalSegment < 1 || physicalSegment > 65535) {
    throw new RawEventError(id, `\`raw\` has physical segment ${String(decoded.source?.physicalSegment)}`);
  }
  const atom = cellAtom(id, content.loggedItem.data, MISC_VALUE_LENGTH);
  const full = new Uint8Array(MISC_VALUE_LENGTH);
  full.set(atom);
  const nameHex = Buffer.from(full.subarray(0, NAME_LENGTH)).toString("hex");
  const payload = full.slice(NAME_LENGTH);

  // The typed fields must be the same bytes (the indexer re-pads them; widths restored on both).
  const typedName = Buffer.alloc(NAME_LENGTH);
  const typedPayload = Buffer.alloc(MISC_VALUE_LENGTH - NAME_LENGTH);
  const nameBytes = Buffer.from(event.nameHex, "hex");
  const payloadBytes = Buffer.from(event.payloadHex, "hex");
  if (nameBytes.length > NAME_LENGTH || payloadBytes.length > typedPayload.length) {
    throw new RawEventError(id, "typed name or payload is longer than a Misc value allows");
  }
  nameBytes.copy(typedName);
  payloadBytes.copy(typedPayload);
  if (typedName.toString("hex") !== nameHex || !typedPayload.equals(Buffer.from(payload))) {
    throw new RawEventError(id, "the typed name/payload disagree with `raw`");
  }
  return { transactionHash, physicalSegment, address, nameHex, payload };
}
