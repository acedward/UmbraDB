import { pad32 } from "../color.js";

/**
 * The token-metadata payload parser — **MIP-0018 (final)** and, beside it, the superseded
 * `mip-xxxx` draft the reference contracts on Stagenet were deployed under.
 *
 * Normative text: `mips/mip-0018-on-chain-token-metadata.md` of
 * https://github.com/midnightntwrk/midnight-improvement-proposals/pull/325 @ `37a3471`
 * (status Proposed), §§1, 2, 2.1, 2.2, 3, 5, 6.2, 7.1, 8 and Appendix A. Project 00021 implemented
 * the earlier PR #315 draft of the same document; project 00023 Phase F moved this module onto the
 * final text and kept the draft as a second, clearly-labelled code path.
 *
 * One `Misc` contract event (MIP §1) carries exactly 256 bytes (MIP §2):
 *
 * ```
 *  offset  size  field
 *       0    32  domainSep   the token within the contract (the ERC-1155 id analogue)
 *      32     1  kind        0 unshielded native, 1 shielded native, 2 unshielded ledger,
 *                            3 shielded ledger — the FULL byte is part of the token identity
 *      33    32  key         key identifier bytes, NUL-padded; compared after trimming trailing NULs
 *      65     1  val-type    0 opaque, 1 UTF-8 string, 2 unsigned integer, 3 UTF-8 JSON,
 *                            4 UTF-8 URI, 5 Null, 6..255 reserved
 *      66     1  val-len     meaningful bytes of `value`, 0 ≤ val-len ≤ 189
 *      67   189  value       the value bytes; bytes at or after `val-len` carry no meaning
 * ```
 *
 * ── TWO names, TWO validators (owner decision Q27) ─────────────────────────────────────────────
 * The event NAME is the version (MIP §8): "a future, incompatible layout uses a new name and never
 * a reinterpretation of `mip-0018:token-metadata[v1]`". The MIP's number changed between the draft
 * this repository first implemented and the final text, and so did four transport rules — so the
 * two names are two different transports and each gets its own validator:
 *
 * | rule | `mip-0018:token-metadata[v1]` (FINAL) | `mip-xxxx:token-metadata[v1]` (draft, legacy) |
 * |---|---|---|
 * | `val-type` 2 | Compact `Uint<8·N>`, `1 ≤ val-len ≤ 31`, **little-endian** | unsigned **big-endian**, `1 ≤ val-len ≤ 16` |
 * | `val-type` 3 | ONE complete valid JSON value (RFC 8259; scalars allowed) | valid UTF-8, nothing more |
 * | `val-type` 5 | **Null** — `val-len` MUST be 0, all 189 value bytes ignored; CLEARS the key | reserved → rejects |
 * | reserved | 6–255 | 5–255 |
 * | `/metadata/…` keys | MUST be valid RFC 6901 JSON Pointers or the event REJECTS | no rule (plain bytes) |
 * | multipart | **none** — `metadata` is one complete JSON value ≤ 189 B or nothing | `metadata/<n>`, parts `0..15`, assembled |
 *
 * {@link nameVariantOf} maps the event's 32 name bytes to the variant, and every judging function
 * in this module takes that variant. Nothing infers it, and nothing has a default: a payload
 * validated under the wrong rules is a wrong answer that no test downstream could catch.
 *
 * ── THE LEGACY PATH EXISTS FOR DEMONSTRATIVE PURPOSES ONLY ─────────────────────────────────────
 * **Owner decision Q27 (2026-09-22), verbatim: "keep the old rules so we can keep showing them
 * correctly — state in the code this is for demonstrative purposes only".**
 *
 * The reference contracts of `acedward/mip-erc7496-midnight-contracts` are deployed on Stagenet
 * with `pad(32, "mip-xxxx:token-metadata[v1]")` compiled into the circuit as a literal, and they
 * are NOT being redeployed (owner decision Q28). Their events are the live demo's entire token
 * table, so dropping the draft rules would empty the page. That — keeping an already-deployed
 * demonstration readable — is the ONLY reason this code path exists.
 *
 * It is therefore **not** a compatibility guarantee, **not** a migration path, and **not** a
 * pattern to copy: a real consumer of MIP-0018 implements the FINAL column of the table above and
 * nothing else, and MIP §1's "Events of another type or name … MUST be ignored by a v1 consumer"
 * is what the draft name deserves once the demonstration is redeployed. Every stored row carries
 * its {@link NameVariant} so the page can mark the draft-name ones "pre-MIP name", and so this
 * whole path can be deleted in one commit the day the contracts move.
 *
 * ── The 00020 name is IGNORED, not rejected (MIP §1) ───────────────────────────────────────────
 * The pre-MIP events this project shipped in 00020 were named plain `TokenMetadata`. That name is
 * recognised by neither variant: those events are not stored, not rejected and not evidence of
 * anything. {@link nameVariantOf} returns `undefined` and `ingest/events.ts` never hands them here.
 *
 * ── Two stages, on purpose ─────────────────────────────────────────────────────────────────────
 * {@link decodeTokenMetadata} does the structural split and never judges — it is variant-free,
 * because the 256-byte layout is the one thing the two names share. {@link validateTokenMetadata}
 * judges, and only against the TRANSPORT rules of MIP §2.1/§2.2/§3/§5.1. That is what lets a
 * REJECTED event still be stored with all of its fields plus a stable `reject_reason` — a
 * contract's malformed claim is evidence about that contract, and the page shows it. Only a
 * payload LONGER than 256 bytes cannot be decoded at all.
 *
 * ── Appendix A is a PROJECTION rule, never a rejection rule (MIP §5.2/§5.3, §7.1) ──────────────
 * Appendix A is explicitly **informative** in the final text ("The examples below demonstrate
 * transport encodings only… They do not define required fields, key meanings, schema types,
 * validation beyond [2] and [5.1], projections or display behavior"), and §5.2 says "A
 * transport-valid declaration is accepted even if its key is unknown".
 *
 * So the five keys this consumer projects into `tokens` columns — `name`, `symbol`, `decimals`,
 * `tokenUri`, `metadata` — are **our own consumer convention**, not a MIP requirement, and a
 * projection can never reject: a well-known key carrying a shape the column cannot hold is stored
 * verbatim as a trait (MIP §5.2) and flagged with a {@link ProjectionError}. {@link projectionErrorFor}
 * is that check, deliberately separate from {@link validateTokenMetadata} so the two can never be
 * confused.
 *
 * ── Deliberate leniency, recorded ──────────────────────────────────────────────────────────────
 * Bytes of `value` at or after `val-len` are NOT checked for being NUL: MIP §2.2 says consumers
 * MUST ignore them ("including all 189 bytes for Null") and emitters SHOULD zero them — a SHOULD on
 * the emitter is not a rejection rule for the consumer. Everything downstream uses
 * `value.subarray(0, val-len)` only.
 *
 * ── Trailing-NUL trimming, and why a SHORT payload is padded rather than rejected ──────────────
 * The on-chain VM hands a `Log` event's bytes out with **trailing NULs trimmed**, while the event
 * itself declares its serialized length. Since `value` is NUL-padded after `val-len` by
 * construction, a real event whose value does not fill 189 bytes arrives SHORT — it is not
 * malformed, it is the same bytes with zeros removed. The indexer's GraphQL `payload` field re-pads
 * to exactly 256, so this does not arise through that source, but the node-direct `EventSource` the
 * owner has planned sees the untrimmed form. {@link decodeTokenMetadata} therefore **zero-extends**
 * a short payload to 256 and records how short it was; only a payload LONGER than 256 is an error.
 *
 * ── Keys are bytes (MIP §5.1) ──────────────────────────────────────────────────────────────────
 * "Except for `/metadata/` keys as specified below, keys SHOULD be valid UTF-8; consumers MUST NOT
 * reject another key solely for invalid UTF-8 (they MAY display it as hex)." So the key's identity
 * is {@link DecodedTokenMetadata.keyHex} — the trimmed bytes — and `keyText` is a convenience that
 * is `undefined` when those bytes are not a NUL-free valid UTF-8 string. An interior NUL keeps the
 * key (it is part of the bytes) but not its text: Postgres `text` cannot hold a NUL, and a key that
 * cannot be spelled cannot be well-known.
 *
 * The ONE key rule that rejects is the pointer rule of §5.1, and it applies to the final name only:
 * see {@link pointerKeyError}.
 */

/** Which of the two event names an event carried — stored on every row it produces, so the page can
 *  mark the draft-name ones and so the legacy path can be deleted in one commit (owner Q27). */
export type NameVariant = "mip-0018" | "legacy-mip-xxxx";

/** The FINAL event name (MIP-0018 §1), spelled once. */
export const MIP_0018_EVENT_NAME = "mip-0018:token-metadata[v1]";

/**
 * The superseded PR #315 draft name, spelled once.
 *
 * **Demonstrative only (owner Q27).** `xxxx` was the draft's placeholder for the MIP number; the
 * number came out as 0018, so no contract will ever be compiled with this string again. It stays
 * because the Stagenet reference contracts already were, and are not being redeployed (Q28).
 */
export const LEGACY_EVENT_NAME = "mip-xxxx:token-metadata[v1]";

/** `pad(32, MIP_0018_EVENT_NAME)` as lowercase unprefixed hex — what `MiscContractEvent.name`
 *  carries: MIP §1's `0x6d69702d303031383a746f6b656e2d6d657461646174615b76315d` and 5 NULs. */
export const MIP_0018_NAME_HEX = Buffer.from(pad32(MIP_0018_EVENT_NAME)).toString("hex");

/** `pad(32, LEGACY_EVENT_NAME)` as lowercase unprefixed hex. Demonstrative only — see Q27. */
export const LEGACY_NAME_HEX = Buffer.from(pad32(LEGACY_EVENT_NAME)).toString("hex");

/** Both variants, in the order a reader should think of them: the standard first. */
export const NAME_VARIANTS: readonly NameVariant[] = ["mip-0018", "legacy-mip-xxxx"];

/** U+0000 as a string, built rather than written: a literal NUL byte in a source file makes the
 *  file binary to `grep` and invisible to half the tooling. */
const NUL = String.fromCharCode(0);

export const PAYLOAD_SIZE = 256;
/** Payload offsets, from MIP §2's table — spelled out so the decoder reads as the table does. */
export const OFFSET_DOMAIN_SEP = 0;
export const OFFSET_KIND = 32;
export const OFFSET_KEY = 33;
export const OFFSET_VAL_TYPE = 65;
export const OFFSET_VAL_LEN = 66;
export const OFFSET_VALUE = 67;
export const VALUE_SIZE = 189;
/** `val-len > 189` rejects (MIP §2.2). */
export const MAX_VAL_LEN = VALUE_SIZE;

/** MIP-0018 §2.1's Null type. `val-len` MUST be 0 and all 189 value bytes are ignored; it sets the
 *  current value of the exact key to Null (MIP §6.2) without erasing history. Reserved — and so
 *  rejected — under the legacy draft name. */
export const VAL_TYPE_NULL = 5;

/** MIP-0018 §2.1 type 2: byte-aligned `Uint<8>` … `Uint<248>`, so `1 ≤ val-len ≤ 31`. */
export const MAX_INTEGER_BYTES_0018 = 31;
/** The legacy draft's type 2 stopped at 16 bytes. Demonstrative only — see Q27. */
export const MAX_INTEGER_BYTES_LEGACY = 16;
/** Appendix A's emitter default: `Uint<128>`, `val-len = 16`. A default for EMITTERS, explicitly
 *  "not a decoder fallback" — a consumer MUST accept every permitted width. */
export const RECOMMENDED_INTEGER_BYTES = 16;

/** Appendix A of the DRAFT: `metadata/<n>` with `n ≤ 15` — 16 parts of at most 189 bytes each.
 *  **Legacy only.** MIP-0018 §5.4 defines no multipart representation or reassembly rule at all. */
export const MAX_METADATA_PARTS = 16;
/** The draft's cap on an assembled `metadata/<n>` document: 16 × 189 = 3 024 bytes. Legacy only. */
export const MAX_METADATA_BYTES = MAX_METADATA_PARTS * VALUE_SIZE;

/** MIP-0018 §5.1: keys whose trimmed bytes begin with this prefix MUST be valid RFC 6901 JSON
 *  Pointers. The `*` in `/metadata/*` is a literal property token, not a wildcard, and pointer
 *  syntax "does not require JSON assembly, nested updates, prefix replacement or concatenation". */
export const METADATA_POINTER_PREFIX = "/metadata/";
const POINTER_PREFIX_BYTES = new TextEncoder().encode(METADATA_POINTER_PREFIX);

/** The privacy half of the `kind` byte (MIP §3): which tag the value carries. */
export type TokenPrivacy = "shielded" | "unshielded";
/** The storage half of the `kind` byte (MIP §3): protocol UTXOs, or balances in contract state. */
export type TokenStorage = "native" | "ledger";
/** The four values MIP §3 defines; anything else rejects the event. */
export type TokenKindByte = 0 | 1 | 2 | 3;
/** The two kinds a MINT can ever produce — a mint effect is native by definition (MIP §6.3). */
export type NativeKindByte = 0 | 1;
/** MIP-0018 §2.1's closed enum. 6..255 are reserved and reject; 5 is Null and exists under the
 *  final name only. */
export type ValType = 0 | 1 | 2 | 3 | 4 | 5;

export const KIND_UNSHIELDED_NATIVE = 0;
export const KIND_SHIELDED_NATIVE = 1;
export const KIND_UNSHIELDED_LEDGER = 2;
export const KIND_SHIELDED_LEDGER = 3;
export const KIND_BYTES: readonly TokenKindByte[] = [0, 1, 2, 3];

/** The highest `val-type` a variant accepts: 5 (Null) for MIP-0018, 4 for the draft. */
export function maxValType(variant: NameVariant): number {
  return variant === "mip-0018" ? VAL_TYPE_NULL : 4;
}

/** The widest `val-type` 2 a variant accepts: 31 bytes (`Uint<248>`) for MIP-0018, 16 for the draft. */
export function maxIntegerBytes(variant: NameVariant): number {
  return variant === "mip-0018" ? MAX_INTEGER_BYTES_0018 : MAX_INTEGER_BYTES_LEGACY;
}

/** True for the four values of MIP §3 and nothing else. */
export function isKindByte(kind: number): kind is TokenKindByte {
  return Number.isInteger(kind) && kind >= 0 && kind <= 3;
}

/** MIP §3: bit 0 is the privacy tag. */
export function privacyOfKind(kind: number): TokenPrivacy {
  return (kind & 0b1) === 1 ? "shielded" : "unshielded";
}

/** MIP §3: bit 1 is where the value lives. */
export function storageOfKind(kind: number): TokenStorage {
  return (kind & 0b10) === 0b10 ? "ledger" : "native";
}

/** Only kinds 0 and 1 have a colour, a mint effect, or any chance of being observed (MIP §3, §6.3). */
export function isNativeKind(kind: number): boolean {
  return storageOfKind(kind) === "native";
}

/** The kind byte as the page and the CLI print it: `1` → `shielded · native`. */
export function kindLabel(kind: number): string {
  return `${privacyOfKind(kind)} · ${storageOfKind(kind)}`;
}

/** A mint effect map is always native, and names the privacy (MIP §6.3): kind 0 or kind 1. */
export function kindOfMint(privacy: TokenPrivacy): 0 | 1 {
  return privacy === "shielded" ? KIND_SHIELDED_NATIVE : KIND_UNSHIELDED_NATIVE;
}

export interface DecodedTokenMetadata {
  /** The payload as decoded: exactly 256 bytes, zero-extended if the source delivered it with its
   *  trailing NULs trimmed. This is what gets stored. */
  payload: Uint8Array;
  /** The length the source actually delivered, when it was shorter than 256 — evidence that the
   *  trailing-NUL trimming happened, and `undefined` for a full-width payload. */
  paddedFrom: number | undefined;
  /** 32 bytes. */
  domainSep: Uint8Array;
  kindByte: number;
  /** The raw 32 key bytes, padding included — stored verbatim on the event row. */
  key: Uint8Array;
  /** The key with trailing NULs trimmed: its IDENTITY under MIP §5.1. */
  keyBytes: Uint8Array;
  /** `keyBytes` as lowercase hex — the primary-key form, since a key need not be text at all. */
  keyHex: string;
  /** `keyBytes` decoded as UTF-8; `undefined` when they are not a NUL-free valid UTF-8 string. */
  keyText: string | undefined;
  valType: number;
  valLen: number;
  /** The raw 189 value bytes, padding included — stored verbatim on the event row. */
  value: Uint8Array;
  /** `value.subarray(0, val-len)` — the only bytes any consumer may read (MIP §2.2). */
  valueBytes: Uint8Array;
  /** Derived from the kind byte; meaningless if the byte is invalid, which validation catches. */
  privacy: TokenPrivacy;
  storage: TokenStorage;
}

/**
 * Every reason this parser can refuse a payload — MIP §2.2, §3 and §5.1, and nothing else.
 * Stored verbatim in `token_metadata_events.reject_reason`, so each one is a stable, greppable
 * token. Projection failures are NOT here: they are {@link ProjectionError}s and never reject.
 */
export type RejectReason =
  | "payload_size"
  | "kind_unknown"
  | "key_empty"
  /** MIP-0018 §5.1 — a `/metadata/`-prefixed key that is not a valid RFC 6901 JSON Pointer (or is
   *  not valid UTF-8 at all). The final name only; the draft had no such rule. */
  | "key_pointer_invalid"
  | "val_type_reserved"
  | "val_len_too_long"
  /** MIP-0018 §2.1 type 5 — Null with a non-zero `val-len`. */
  | "val_null_len"
  | "val_type_rule";

/**
 * Why a key this consumer projects into a `tokens` column could not be projected. The event is
 * applied and the trait is stored regardless (MIP §5.2: "A transport-valid declaration is accepted
 * even if its key is unknown"); this is the flag beside it.
 *
 * The five projected keys are **this consumer's convention**, not a MIP requirement — Appendix A is
 * informative — so nothing here is ever a conformance verdict about the emitting contract.
 */
export type ProjectionError =
  | "val_type_mismatch"
  | "name_len"
  | "symbol_len"
  | "decimals_len"
  | "decimals_range"
  | "metadata_len"
  | "metadata_not_json_object"
  | "metadata_part_index"
  | "token_uri_not_absolute_http"
  | "text_not_storable";

export class PayloadSizeError extends Error {
  readonly reason = "payload_size" as const;
  constructor(readonly size: number) {
    super(`token-metadata payload must be at most ${PAYLOAD_SIZE} bytes, got ${size}`);
    this.name = "PayloadSizeError";
  }
}

/**
 * Which variant a `MiscContractEvent.name` (unprefixed hex) names, or `undefined` for every other
 * name — including the pre-MIP `TokenMetadata` of project 00020 and any future `[v2]`, both of
 * which MIP §1 says a v1 consumer MUST ignore.
 */
export function nameVariantOf(nameHex: string): NameVariant | undefined {
  const lower = nameHex.toLowerCase();
  if (lower === MIP_0018_NAME_HEX) return "mip-0018";
  if (lower === LEGACY_NAME_HEX) return "legacy-mip-xxxx";
  return undefined;
}

/** True iff a `MiscContractEvent.name` (unprefixed hex) is one of the two names this consumer
 *  recognises (MIP §1). Prefer {@link nameVariantOf} where the RULES matter. */
export function isTokenMetadataName(nameHex: string): boolean {
  return nameVariantOf(nameHex) !== undefined;
}

/** The event name string a variant stands for. */
export function eventNameOf(variant: NameVariant): string {
  return variant === "mip-0018" ? MIP_0018_EVENT_NAME : LEGACY_EVENT_NAME;
}

/** The 32 padded name bytes a variant stands for, as lowercase hex. */
export function nameHexOf(variant: NameVariant): string {
  return variant === "mip-0018" ? MIP_0018_NAME_HEX : LEGACY_NAME_HEX;
}

/**
 * Structural decode — **variant-free**, because the 256-byte layout of MIP §2 is the one thing the
 * two names share. A payload SHORTER than 256 bytes is zero-extended (see the header: the VM trims
 * trailing NULs, and every short payload is a full one with zeros removed). A payload LONGER than
 * 256 throws {@link PayloadSizeError} — the one failure that leaves nothing storable, since
 * `token_metadata_events.payload` is `CHECK (octet_length(payload) = 256)` and truncating would
 * store bytes the chain never carried.
 */
export function decodeTokenMetadata(raw: Uint8Array): DecodedTokenMetadata {
  if (raw.length > PAYLOAD_SIZE) throw new PayloadSizeError(raw.length);
  let payload = raw;
  let paddedFrom: number | undefined;
  if (raw.length < PAYLOAD_SIZE) {
    paddedFrom = raw.length;
    payload = new Uint8Array(PAYLOAD_SIZE);
    payload.set(raw, 0);
  }
  const domainSep = payload.subarray(OFFSET_DOMAIN_SEP, OFFSET_KIND);
  const kindByte = payload[OFFSET_KIND]!;
  const key = payload.subarray(OFFSET_KEY, OFFSET_VAL_TYPE);
  const keyBytes = trimTrailingNuls(key);
  const valType = payload[OFFSET_VAL_TYPE]!;
  const valLen = payload[OFFSET_VAL_LEN]!;
  const value = payload.subarray(OFFSET_VALUE, PAYLOAD_SIZE);
  return {
    payload,
    paddedFrom,
    domainSep,
    kindByte,
    key,
    keyBytes,
    keyHex: Buffer.from(keyBytes).toString("hex"),
    keyText: keyTextOf(keyBytes),
    valType,
    valLen,
    value,
    // `val-len` may exceed VALUE_SIZE on a malformed payload; clamp so the slice is always valid
    // and validation, not a range error, is what reports the problem.
    valueBytes: value.subarray(0, Math.min(valLen, VALUE_SIZE)),
    privacy: privacyOfKind(kindByte),
    storage: storageOfKind(kindByte),
  };
}

/** MIP §5.1: "Trailing NUL bytes are trimmed from `key`, then the remaining bytes are compared
 *  exactly." Only TRAILING ones — an interior NUL is part of the key. */
export function trimTrailingNuls(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

/** The trimmed key as text, or `undefined` when it is not a NUL-free valid UTF-8 string — in which
 *  case the key is still perfectly valid (MIP §5.1) and lives on as its hex. */
export function keyTextOf(keyBytes: Uint8Array): string | undefined {
  if (keyBytes.includes(0)) return undefined;
  return decodeUtf8(keyBytes);
}

/** Strict UTF-8: `TextDecoder` with `fatal: true`, so lone surrogates and invalid sequences are
 *  refused rather than replaced by U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * RFC 6901 syntax, and only syntax.
 *
 * `json-pointer = *( "/" reference-token )`, where a reference token is any run of characters
 * except `/` (the separator) and `~`, plus the two escapes `~0` (a literal `~`) and `~1` (a literal
 * `/`). So for a string that already starts with `/`, the ONLY way to be invalid is a `~` not
 * followed by `0` or `1` — including a trailing `~`. An empty reference token (`"/a//b"`, or the
 * trailing `/` of `"/metadata/"`) is legal, and so is the empty pointer `""`, which denotes the
 * whole document.
 *
 * This says nothing about whether a target document exists or what the pointer would select:
 * MIP §5.1 is explicit that "pointer syntax does not require JSON assembly, nested updates, prefix
 * replacement or concatenation".
 */
export function isValidJsonPointer(text: string): boolean {
  if (text.length === 0) return true; // the whole-document pointer
  if (!text.startsWith("/")) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "~") continue;
    const next = text[i + 1];
    if (next !== "0" && next !== "1") return false;
    i += 1; // the escape is two characters; skip its second
  }
  return true;
}

/** Does `bytes` start with `prefix`? On BYTES, so a key that is not valid UTF-8 can still be
 *  recognised as claiming the pointer prefix. */
function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/**
 * MIP-0018 §5.1's one key rule that REJECTS: "Keys whose trimmed bytes begin with the UTF-8 prefix
 * `/metadata/` MUST be valid UTF-8 JSON Pointer strings under RFC 6901 … any other `~` escape is
 * invalid and MUST cause rejection."
 *
 * Applied to the final name only — the draft had no such rule, and a key that rejects under
 * MIP-0018 must keep being stored as an ordinary trait for a draft-name event (Q27).
 *
 * The prefix is matched on BYTES and the UTF-8 requirement is then checked with
 * {@link decodeUtf8} rather than {@link keyTextOf}: an interior NUL is valid UTF-8 and the MIP does
 * not forbid it here, so such a key is accepted and simply has no `key_text` in the database. Every
 * other key is bytes and is never rejected for its spelling (§5.1).
 */
export function pointerKeyError(keyBytes: Uint8Array): "key_pointer_invalid" | undefined {
  if (!startsWithBytes(keyBytes, POINTER_PREFIX_BYTES)) return undefined;
  const text = decodeUtf8(keyBytes);
  if (text === undefined) return "key_pointer_invalid";
  return isValidJsonPointer(text) ? undefined : "key_pointer_invalid";
}

/** `metadata/<n>` → `n`, or `undefined` for any other key. `<n>` must be plain decimal with no
 *  leading zeros (so `metadata/01` is a distinct key rather than a second `metadata/1`).
 *
 *  **Legacy only.** Under MIP-0018 `metadata/3` is an ordinary trait with no special meaning:
 *  §5.4 defines no multipart representation, and the pointer keys of §5.1 start with a slash. */
export function metadataPartIndex(keyText: string): number | undefined {
  const match = /^metadata\/(0|[1-9][0-9]*)$/.exec(keyText);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * MIP §2.1's per-type rule for `value`, as the reason it fails — a value that breaks it REJECTS the
 * event (§2.2). This is transport validation; the projected keys have nothing to do with it.
 *
 * The three rules that differ between the two names live here: the integer width, JSON
 * completeness, and Null. See the table in this module's header.
 */
export function valueRuleError(
  variant: NameVariant, valType: number, valLen: number, valueBytes: Uint8Array,
): RejectReason | undefined {
  switch (valType) {
    case 0:
      return undefined; // opaque bytes: no rule at all
    case 1:
      return decodeUtf8(valueBytes) === undefined ? "val_type_rule" : undefined;
    case 2:
      // MIP-0018: `1 ≤ val-len ≤ 31`, the width selecting a concrete `Uint<8·N>`; the draft stopped
      // at 16. Every permitted width MUST be accepted — `Uint<128>` is an emitter default, "not a
      // decoder fallback" — so the only rule is the range.
      return valLen >= 1 && valLen <= maxIntegerBytes(variant) ? undefined : "val_type_rule";
    case 3:
      // MIP-0018: "MUST be one complete valid UTF-8 JSON value as defined by RFC 8259; object,
      // array and scalar values are allowed" — a fragment rejects. The draft asked only for valid
      // UTF-8, which is why a `metadata/<n>` fragment was legal on the wire under that name.
      return variant === "mip-0018"
        ? (isCompleteJsonValue(valueBytes) ? undefined : "val_type_rule")
        : (decodeUtf8(valueBytes) === undefined ? "val_type_rule" : undefined);
    case 4: {
      const text = decodeUtf8(valueBytes);
      return text !== undefined && isAbsoluteUri(text) ? undefined : "val_type_rule";
    }
    case VAL_TYPE_NULL:
      // Reachable under MIP-0018 only — `val_type_reserved` catches 5 under the draft name first.
      // "`val-len` MUST be zero; consumers MUST ignore all 189 `value` bytes."
      return valLen === 0 ? undefined : "val_null_len";
    default:
      return "val_type_rule"; // unreachable: a reserved type is rejected before this is asked
  }
}

/** {@link valueRuleError} as a boolean, for readers who only want the verdict. */
export function valueMatchesType(
  variant: NameVariant, valType: number, valLen: number, valueBytes: Uint8Array,
): boolean {
  return valueRuleError(variant, valType, valLen, valueBytes) === undefined;
}

/**
 * Every rejection rule of MIP §2.2, §2.1, §3 and §5.1, applied in PAYLOAD-OFFSET order so a payload
 * that breaks two rules always reports the same one: `kind` (32) → `key` (33) → `val-type` (65) →
 * `val-len` (66) → `value` (67). Returns `undefined` when the event is applicable.
 *
 * The pointer rule sits with the key it is about, at offset 33.
 */
export function validateTokenMetadata(
  decoded: DecodedTokenMetadata, variant: NameVariant,
): RejectReason | undefined {
  if (!isKindByte(decoded.kindByte)) return "kind_unknown";
  if (decoded.keyBytes.length === 0) return "key_empty";
  if (variant === "mip-0018") {
    const pointer = pointerKeyError(decoded.keyBytes);
    if (pointer !== undefined) return pointer;
  }
  if (decoded.valType > maxValType(variant)) return "val_type_reserved";
  if (decoded.valLen > MAX_VAL_LEN) return "val_len_too_long";
  return valueRuleError(variant, decoded.valType, decoded.valLen, decoded.valueBytes);
}

/**
 * This consumer's projection rule for one stored key/value, or `undefined` when there is nothing to
 * complain about — which includes every key we do not project (a trait has no rule to break) and
 * every Null (there is no value to project).
 *
 * The five projected keys are our own convention (MIP Appendix A is informative, §5.2 is explicit),
 * so a verdict here is about OUR columns and never about the emitting contract's conformance. It
 * can never reject: see this module's header.
 *
 * `text_not_storable` is this repository's own addition: a value that is valid UTF-8 but contains a
 * NUL cannot go into a Postgres `text` column, so it is kept as a trait (bytes) and flagged rather
 * than crashing the fold.
 */
export function projectionErrorFor(
  keyText: string | undefined, valType: number, valLen: number, valueBytes: Uint8Array,
  variant: NameVariant,
): ProjectionError | undefined {
  if (keyText === undefined) return undefined; // a key with no text can never be well-known
  // Null CLEARS the key (MIP §6.2). There is no value to project and no rule it could break: the
  // projection is recomputed from the remaining evidence, which for this key is now nothing.
  if (valType === VAL_TYPE_NULL) return undefined;
  const storableText = (): ProjectionError | undefined => {
    const text = decodeUtf8(valueBytes);
    return text === undefined || text.includes(NUL) ? "text_not_storable" : undefined;
  };

  switch (keyText) {
    case "name":
      if (valType !== 1) return "val_type_mismatch";
      if (valLen < 1 || valLen > 189) return "name_len";
      return storableText();
    case "symbol":
      if (valType !== 1) return "val_type_mismatch";
      if (valLen < 1 || valLen > 32) return "symbol_len";
      return storableText();
    case "decimals":
      if (valType !== 2) return "val_type_mismatch";
      // MIP-0018: every permitted width is valid and `Uint<128>` is the emitter default, so the
      // WIDTH is not our business — only the number is. The draft's `decimals` was one byte.
      if (variant === "mip-0018") {
        if (valLen < 1 || valLen > MAX_INTEGER_BYTES_0018) return "decimals_len";
        return BigInt(integerOfValue(valueBytes, variant)) > 36n ? "decimals_range" : undefined;
      }
      if (valLen !== 1) return "decimals_len";
      if (valueBytes[0]! > 36) return "decimals_range";
      return undefined;
    case "metadata": {
      if (valType !== 3) return "val_type_mismatch";
      const bad = storableText();
      if (bad !== undefined) return bad;
      // Under MIP-0018 the transport has already proven this is ONE complete JSON value, so the
      // only thing left to check is our column's own shape: `tokens.metadata` is a jsonb OBJECT.
      // A transport-valid scalar or array is kept as a trait and flagged — never rejected.
      if (variant === "mip-0018") {
        return isJsonObject(decodeUtf8(valueBytes)!) ? undefined : "metadata_not_json_object";
      }
      if (valLen < 2) return "metadata_len";
      return isJsonObject(decodeUtf8(valueBytes)!) ? undefined : "metadata_not_json_object";
    }
    case "tokenUri": {
      if (valType !== 4) return "val_type_mismatch";
      if (valLen < 1 || valLen > 189) return "token_uri_not_absolute_http";
      const bad = storableText();
      if (bad !== undefined) return bad;
      return isAbsoluteHttpUrl(decodeUtf8(valueBytes)!) ? undefined : "token_uri_not_absolute_http";
    }
    default: {
      // MIP-0018 has no multipart convention (§5.4), so `metadata/<n>` is an ordinary trait under
      // the final name — no index rule, no type rule, nothing to project. Under the draft name it
      // is a part of an assembled document and keeps the draft's rules (Q27).
      if (variant === "mip-0018") return undefined;
      if (!keyText.startsWith("metadata/")) return undefined; // an ordinary trait: no rule
      const part = metadataPartIndex(keyText);
      // `metadata/01` or `metadata/99` is a malformed part name, not an anonymous trait: the
      // document it claims to belong to would otherwise never assemble and nobody would be told.
      if (part === undefined || part >= MAX_METADATA_PARTS) return "metadata_part_index";
      // Every part must be type 3: a part of another type is a trait under its own key and the
      // assembly waits.
      if (valType !== 3) return "val_type_mismatch";
      return storableText();
    }
  }
}

/** A JSON **object** — not an array, not a scalar. `tokens.metadata` is a jsonb object, which is
 *  this consumer's convention and not a MIP rule (MIP-0018 §2.1 allows any JSON value). */
export function isJsonObject(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/**
 * MIP-0018 §2.1 type 3: "one complete valid UTF-8 JSON value as defined by RFC 8259; object, array
 * and scalar values are allowed".
 *
 * `JSON.parse` is exactly this test and nothing more: it accepts a top-level scalar (`6`, `"x"`,
 * `true`, `null`), refuses a fragment (`{"half":`), refuses trailing content after the value, and
 * refuses an empty payload — "An empty integer, URI or JSON payload is invalid under the rules
 * above" (§2.2). What it must NOT do is impose a shape: "requirements that a particular key hold an
 * object, array or other shape belong to a metadata-specific MIP".
 */
export function isCompleteJsonValue(valueBytes: Uint8Array): boolean {
  const text = decodeUtf8(valueBytes);
  if (text === undefined) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** MIP §2.1 type 4: "parses as an absolute URI" — any scheme, which is weaker than our `tokenUri`
 *  projection rule on purpose. `new URL` without a base accepts exactly the absolute forms. */
export function isAbsoluteUri(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Our `tokenUri` projection rule: an absolute `http(s)://` URL. */
export function isAbsoluteHttpUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * `val-type` 2's value as a decimal string — **and the one place the two names disagree about what
 * a byte means.**
 *
 *  - `mip-0018`: the Compact serialization of `Uint<8·N>`, which is **LITTLE-endian** — byte `i`
 *    carries weight `256^i`. MIP Appendix A: `6` as `Uint<128>` is
 *    `0x06000000000000000000000000000000`. VERIFIED against the runtime the MIP names
 *    (`@midnight-ntwrk/compact-runtime` 0.19.0): `toBinaryRepr` produces exactly those bytes and
 *    `CompactTypeUnsignedInteger.fromValue` accumulates `res += (1 << 8·i) · val[i]`. The test
 *    `[[token-0018-integer-endianness]]` pins this function against that package, so the agreement
 *    is enforced rather than remembered.
 *  - `legacy-mip-xxxx`: the draft said "unsigned big-endian integer", and the deployed reference
 *    contracts emit `decimals` as a single byte, where the two readings coincide. Demonstrative
 *    only (Q27).
 *
 * `bigint` and never a JSON number: 2^248 does not survive a double, and even `Uint<128>` does not.
 */
export function integerOfValue(valueBytes: Uint8Array, variant: NameVariant): string {
  let out = 0n;
  if (variant === "mip-0018") {
    for (let i = valueBytes.length - 1; i >= 0; i--) out = (out << 8n) | BigInt(valueBytes[i]!);
  } else {
    for (const byte of valueBytes) out = (out << 8n) | BigInt(byte);
  }
  return out.toString(10);
}

/** How a consumer renders an accepted value it does not otherwise understand (MIP §5.2): text for
 *  the textual types, `undefined` for an integer (use {@link integerOfValue}), for opaque bytes and
 *  for Null (which has no value at all). */
export function valueTextOf(valType: number, valueBytes: Uint8Array): string | undefined {
  if (valType !== 1 && valType !== 3 && valType !== 4) return undefined;
  return decodeUtf8(valueBytes);
}

export interface ParsedTokenMetadata extends DecodedTokenMetadata {
  /** Which of the two names the event carried — the variant these verdicts were reached under, and
   *  the value stored on every row this event produces. */
  nameVariant: NameVariant;
  applied: boolean;
  rejectReason: RejectReason | undefined;
  /** This consumer's projection verdict for this key/value, when the event was applied:
   *  `undefined` means the value may be projected into its column. Never a rejection. */
  projectionError: ProjectionError | undefined;
  /** The value as text for `val-type` 1/3/4, when the event was applied and the bytes decode. */
  valueText: string | undefined;
  /** True for an applied `val-type` 5 event: this event CLEARS its key (MIP §2.1, §6.2). */
  clears: boolean;
}

/**
 * Decode + validate in one call — what the event lookup uses. The variant is **required**: it
 * decides four transport rules and how a type-2 byte string reads, and a default would silently
 * validate a payload under rules its emitter never used.
 *
 * Throws {@link PayloadSizeError} for a payload longer than 256 bytes (nothing can be stored for
 * it); every other transport failure comes back as `applied: false` with a reason, and the caller
 * stores the row anyway.
 */
export function parseTokenMetadata(payload: Uint8Array, variant: NameVariant): ParsedTokenMetadata {
  const decoded = decodeTokenMetadata(payload);
  const rejectReason = validateTokenMetadata(decoded, variant);
  const applied = rejectReason === undefined;
  return {
    ...decoded,
    nameVariant: variant,
    applied,
    rejectReason,
    projectionError: applied
      ? projectionErrorFor(decoded.keyText, decoded.valType, decoded.valLen, decoded.valueBytes, variant)
      : undefined,
    valueText: applied ? valueTextOf(decoded.valType, decoded.valueBytes) : undefined,
    clears: applied && decoded.valType === VAL_TYPE_NULL,
  };
}

/** The keys this consumer projects into `tokens` columns. Everything else stays a trait (MIP §5.2),
 *  and `metadata/<n>` is a draft-name-only convention handled by {@link metadataPartIndex}. */
export const WELL_KNOWN_KEYS = ["name", "symbol", "decimals", "metadata", "tokenUri"] as const;
export type WellKnownKey = (typeof WELL_KNOWN_KEYS)[number];

export function isWellKnownKey(keyText: string): keyText is WellKnownKey {
  return (WELL_KNOWN_KEYS as readonly string[]).includes(keyText);
}

/** The `val-type` this consumer projects each of its keys from — what Appendix A shows an emitter
 *  using, and what we check before projecting. Informative on the MIP's side, ours on this side. */
export const WELL_KNOWN_VAL_TYPES: Readonly<Record<WellKnownKey, ValType>> = {
  name: 1, symbol: 1, decimals: 2, metadata: 3, tokenUri: 4,
};

/**
 * Builds a 256-byte payload — the encoder side of the same layout. Used by the tests and by the
 * fixture tooling; having the encoder here rather than in a test file is what makes
 * "encode(decode(x)) == x" a property the module itself guarantees.
 *
 * `valType` and `valLen` are explicit so a test can build a payload no honest emitter would (a
 * reserved type, a length past the field) without the encoder second-guessing it.
 */
export function encodeTokenMetadata(fields: {
  domainSep: Uint8Array;
  kindByte: number;
  key: Uint8Array | string;
  valType: number;
  valLen?: number;
  value: Uint8Array | string;
}): Uint8Array {
  const out = new Uint8Array(PAYLOAD_SIZE);
  if (fields.domainSep.length !== 32) throw new Error("domainSep must be 32 bytes");
  out.set(fields.domainSep, OFFSET_DOMAIN_SEP);
  out[OFFSET_KIND] = fields.kindByte;
  const key = typeof fields.key === "string" ? pad32(fields.key) : fields.key;
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  out.set(key, OFFSET_KEY);
  const value = typeof fields.value === "string" ? new TextEncoder().encode(fields.value) : fields.value;
  if (value.length > VALUE_SIZE) throw new Error(`value must be at most ${VALUE_SIZE} bytes`);
  out[OFFSET_VAL_TYPE] = fields.valType;
  out[OFFSET_VAL_LEN] = fields.valLen ?? value.length;
  out.set(value, OFFSET_VALUE);
  return out;
}

/**
 * `serialize<Uint<8·N>, N>(value)` — MIP-0018's `val-type` 2 encoding: **little-endian**, `N` bytes.
 * Pinned byte-for-byte against `@midnight-ntwrk/compact-runtime` 0.19.0's `toBinaryRepr` by
 * `[[token-0018-integer-endianness]]`, so this is the runtime's encoding and not an interpretation
 * of it.
 */
export function encodeCompactUint(value: bigint | number, byteLength = RECOMMENDED_INTEGER_BYTES): Uint8Array {
  let rest = BigInt(value);
  if (rest < 0n) throw new Error(`${value} is not an unsigned integer`);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error(`${value} does not fit in ${byteLength} bytes`);
  return out;
}

/** The BIG-endian bytes of an unsigned integer — the LEGACY draft's `val-type` 2 encoding, kept for
 *  the deployed reference contracts and their fixtures. Demonstrative only (Q27); new payloads use
 *  {@link encodeCompactUint}. */
export function encodeInteger(value: bigint | number, byteLength = 1): Uint8Array {
  let rest = BigInt(value);
  const out = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error(`${value} does not fit in ${byteLength} bytes`);
  return out;
}
