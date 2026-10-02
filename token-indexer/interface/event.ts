import { pad32 } from "../color.js";

/**
 * Project 00024-02 task C2 — the public-interface event ([B], the Public Interfaces for Compact
 * Contracts draft, `acedward/public-interfaces-for-compact-contracts` PR #6 @ `1cf9477`).
 *
 * ── The event ──────────────────────────────────────────────────────────────────────────────────
 * `publishBundle(payload: Bytes<256>)` emits one `Misc` event whose 32-byte name is
 * `pad(32, "mip-xxxx:public-interface[v1]")` ([B] `compact/OffChainInterface.compact`). Any other
 * name is not [B]'s and is ignored. Under UC-2 (`spec/00024-upstream-spec-changes.md`) the name
 * follows the Multi-Part Event rule ([Y]): every event of this name one contract emits in one intent
 * of one transaction is ONE part of ONE package, and the package — not the single event — is the
 * publication (`ingest/packages.ts` forms it; spec FR-001).
 *
 * ── The payload (the merged package, `256 · k` bytes) ──────────────────────────────────────────
 * ```
 *  offset     size       field
 *       0       32       the bundle commitment ([B] "ecmh-jubjub-grouphash", interface/commitment.ts)
 *      32  256·k − 32    utf8(URL of the bundle's index.json), zero padded
 * ```
 * [B] (`src/hash.mjs` `parsePayload`): "parsers strip trailing NULs". The format does not change
 * with `k`: a one-part payload is the original draft's layout byte for byte, and a URL longer than
 * 224 bytes takes `k = ceil((32 + len) / 256)` parts (UC-2). Nothing here limits `k`: the reader's
 * 1 024-part safety ceiling is the only bound (spec FR-004).
 *
 * ── What this module decides beyond [B] (and why) ──────────────────────────────────────────────
 * [B]'s reference decodes the URL with Node's lossy `toString('utf8')`. An indexer stores the URL as
 * text and serves it, so it must not invent characters: bytes that are not valid UTF-8, or that hold
 * a control character (U+0000–U+001F, U+007F — including an interior NUL, which Postgres `text`
 * cannot even store), are kept as bytes only and the publication records WHY there is no URL
 * (`url_not_utf8`, `url_control_character`; an all-zero URL field is `url_empty`). Such a
 * publication is still a publication — it is current if it is the newest, and it is reported
 * `unfetchable` (spec US1 scenario 5, FR-010: a newer unavailable publication is reported as such,
 * never replaced by an older one).
 */

/** The event name `publishBundle` emits, before zero padding to 32 bytes. */
export const PUBLIC_INTERFACE_EVENT_NAME = "mip-xxxx:public-interface[v1]";

/** The name as the chain holds it — `pad(32, name)` — in lowercase hex. Pinned by
 *  `[[interface-event-golden]]` against the bytes of a real Stagenet event. */
export const PUBLIC_INTERFACE_NAME_HEX = Buffer.from(pad32(PUBLIC_INTERFACE_EVENT_NAME)).toString("hex");

/** Bytes of one part (one event's payload). */
export const PART_BYTES = 256;
/** Bytes of the commitment at the start of the payload. */
export const COMMITMENT_BYTES = 32;
/** URL bytes a one-part payload holds. */
export const ONE_PART_URL_BYTES = PART_BYTES - COMMITMENT_BYTES;

export type UrlError = "url_empty" | "url_not_utf8" | "url_control_character";

/** One publication's pointer, decoded from its merged payload. */
export interface DecodedPublication {
  /** The 32-byte bundle commitment. */
  commitment: Uint8Array;
  /** payload[32..], trailing zero bytes removed — exactly what [B]'s parser keeps, as bytes. */
  urlBytes: Uint8Array;
  /** `urlBytes` as text, when they are valid UTF-8 with no control character; else `undefined`. */
  url: string | undefined;
  /** Why `url` is undefined. */
  urlError: UrlError | undefined;
  /** Parts in the package (`payload.length / 256`). */
  parts: number;
}

/** Thrown for a payload that is not a whole number of parts — impossible from the reader, which
 *  always hands over `256 · k` bytes; stated so a caller bug is loud, never a silent truncation. */
export class PublicationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationPayloadError";
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/u;

/** [B]'s pointer from a package's merged payload (`256 · k` bytes, `k ≥ 1`). Never throws for the
 *  URL's content; throws {@link PublicationPayloadError} only for a payload of the wrong size. */
export function decodePublication(payload: Uint8Array): DecodedPublication {
  if (payload.byteLength === 0 || payload.byteLength % PART_BYTES !== 0) {
    throw new PublicationPayloadError(
      `a public-interface payload is 256·k bytes (k ≥ 1), got ${payload.byteLength}`,
    );
  }
  const commitment = payload.slice(0, COMMITMENT_BYTES);
  let end = payload.byteLength;
  while (end > COMMITMENT_BYTES && payload[end - 1] === 0) end--;
  const urlBytes = payload.slice(COMMITMENT_BYTES, end);
  const parts = payload.byteLength / PART_BYTES;
  if (urlBytes.byteLength === 0) return { commitment, urlBytes, url: undefined, urlError: "url_empty", parts };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(urlBytes);
  } catch {
    return { commitment, urlBytes, url: undefined, urlError: "url_not_utf8", parts };
  }
  if (CONTROL.test(text)) return { commitment, urlBytes, url: undefined, urlError: "url_control_character", parts };
  return { commitment, urlBytes, url: text, urlError: undefined, parts };
}

/** Whether a 32-byte event name (lowercase or uppercase hex) is [B]'s. */
export function isPublicInterfaceName(nameHex: string): boolean {
  return nameHex.toLowerCase() === PUBLIC_INTERFACE_NAME_HEX;
}
