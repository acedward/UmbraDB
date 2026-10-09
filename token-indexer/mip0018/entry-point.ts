/**
 * Contract entry points as BYTES.
 *
 * The ledger stores an entry point as arbitrary bytes (`EntryPointBuf(Vec<u8>)`; ledger `v2.0.0-rc.4`
 * `onchain-state/src/state.rs` `maybe_str`: "This is to permit arbitrary bytes"), so a call — or a maintenance update's
 * `operation` — may name an entry point holding NUL, control, bidi or non-UTF-8 bytes. ledger-v9 hands it to
 * JavaScript as `Uint8Array | string` (`onchain-runtime-wasm/src/state.rs` `maybe_string`: valid UTF-8 → string,
 * anything else → `Uint8Array`), which is lossless; this module turns either form back into the exact bytes, which
 * UmbraDB stores as `bytea` (`mip0018_contract_actions.entry_point`, `.maintenance_operations`,
 * `mip0018_activity.entry_point`) — never as `text`, which Postgres refuses for NUL (one such call would otherwise
 * stop the scan for good).
 *
 * Display: an entry point gets a text form only when it is "printable" by the ledger's own rule for presenting an
 * entry point as a string (`maybe_str`: every byte an ASCII letter or digit or one of `'+-_":/\?#$^*&.`), and it is
 * not empty. Everything else (NUL, controls, spaces, bidi or other non-ASCII characters, non-UTF-8 bytes) is served
 * as hex only. The rule is UmbraDB's display choice.
 */
import { latin1Text, toHex, utf8Bytes } from "./bytes.ts";

/** The bytes the ledger stored for an entry point, from ledger-v9's JS form (`Uint8Array | string`). */
export function entryPointBytes(e: Uint8Array | string): Uint8Array {
  if (typeof e === "string") return utf8Bytes(e); // the ledger produced the string from valid UTF-8: exact
  if (e instanceof Uint8Array) return new Uint8Array(e);
  throw new TypeError(`an entry point is a string or a Uint8Array, got ${typeof e}`);
}

const PERMITTED_PUNCTUATION = new Set([..."'+-_\":/\\?#$^*&."].map((c) => c.charCodeAt(0)));

/** Whether a byte is one the ledger presents inside an entry-point string (`maybe_str`'s `permitted`). */
function permitted(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || PERMITTED_PUNCTUATION.has(b);
}

/** The entry point's text when it is printable (non-empty, every byte permitted), otherwise `null` (hex only). */
export function entryPointText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  for (const b of bytes) if (!permitted(b)) return null;
  return latin1Text(bytes); // ASCII only here, so latin1 = UTF-8 = the bytes
}

/**
 * At most this many bytes of an entry point are served: an entry point is arbitrary bytes of any
 * length and every activity row of a call repeats it, so a long one would inflate every page of the tokens it touches.
 * Compact entry points are short identifiers; a longer one is served as its first bytes with its `length`.
 */
export const ENTRY_POINT_MAX_BYTES = 128;

/**
 * How the API serves an entry point: the exact bytes as hex; `text` only when it is printable. An entry point longer
 * than {@link ENTRY_POINT_MAX_BYTES} is served as its first bytes (`hex`), its `length` and `truncated: true`, never
 * as text.
 */
export interface EntryPointJson {
  hex: string;
  text?: string;
  length?: number;
  truncated?: true;
}

/** `bytes` = the entry point, or its first bytes when `length` (its full length) is larger. */
export function entryPointJson(bytes: Uint8Array, length = bytes.length): EntryPointJson {
  if (length > bytes.length || bytes.length > ENTRY_POINT_MAX_BYTES)
    return { hex: toHex(bytes.subarray(0, ENTRY_POINT_MAX_BYTES)), length, truncated: true };
  const text = entryPointText(bytes);
  const out: EntryPointJson = { hex: toHex(bytes) };
  if (text !== null) out.text = text;
  return out;
}

/**
 * The readable form of an entry point inside a rendered maintenance update (`VerifierKeyInsert(<op>, v3)`): the text
 * when printable, else `<bytes HEX>` (`<`, `>` and the space are never in a printable entry point, so the two forms
 * cannot be confused). ASCII only; the exact bytes are stored next to it.
 */
export function entryPointLabel(bytes: Uint8Array): string {
  return entryPointText(bytes) ?? `<bytes ${toHex(bytes)}>`;
}
