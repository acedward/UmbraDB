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
 * ── The two layouts (project 00024-01, UC-1) ──────────────────────────────────────────────────
 * **MIP-0018 as amended in place by UC-1** (`spec/00024-upstream-spec-changes.md`; spec 00024 Q1,
 * FR-007): `mip-0018:token-metadata[v1]` follows the Multi-Part Event rule ([Y],
 * `compact-multi-part-event` PR #1), so what this module decodes under that name is a PACKAGE — the
 * `256 · k` merged payload of `k ≥ 1` events (`ingest/packages.ts`) — and its length field is two
 * bytes, so ONE field can be any length the package holds:
 *
 * ```
 *  offset  size     field
 *       0    32     domainSep   the token within the contract (the ERC-1155 id analogue)
 *      32     1     kind        0 unshielded native, 1 shielded native, 2 unshielded ledger,
 *                               3 shielded ledger — the FULL byte is part of the token identity
 *      33    32     key         key identifier bytes, NUL-padded; compared after trimming trailing NULs
 *      65     1     val-type    0 opaque, 1 UTF-8 string, 2 unsigned integer, 3 UTF-8 JSON,
 *                               4 UTF-8 URI, 5 Null, 6..255 reserved
 *      66     2     val-len     unsigned 16-bit LITTLE-endian, 0..65535, with 68 + val-len ≤ 256·k
 *      68  256·k−68 value       the value bytes; bytes at or after `val-len` carry no meaning
 * ```
 *
 * A one-part package holds 188 value bytes. One package is ONE declaration (UC-1: "The MULTI-PART
 * is ONLY for extending the length of the field"); bytes after the value are ignored, as MIP-0018
 * already says (spec Q11).
 *
 * **The superseded draft name** keeps the one-event 256-byte layout of the MIP text before UC-1 —
 * `val-len` ONE byte at 66 (`0 ≤ val-len ≤ 189`), value from 67, 189 bytes — and is not opted into
 * [Y] (spec FR-006):
 *
 * ```
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
 * | `val-type` 5 | **Null** — `val-len` MUST be 0, every value byte ignored; CLEARS the key | reserved → rejects |
 * | reserved | 6–255 | 5–255 |
 * | `/metadata/…` keys | MUST be valid RFC 6901 JSON Pointers or the event REJECTS | no rule (plain bytes) |
 * | layout (UC-1) | `256·k`-byte package, 2-byte LE `val-len` at 66, value from 68, any length | one 256-byte event, 1-byte `val-len`, ≤ 189 |
 * | long values | a [Y] multi-part package; `metadata` is ONE complete JSON value of any length | `metadata/<n>`, parts `0..15`, assembled |
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
 * {@link decodeTokenMetadata} does the structural split and never judges — it takes the variant
 * only to pick the layout (UC-1 moved `val-len` and the value). {@link validateTokenMetadata}
 * judges, and only against the TRANSPORT rules of MIP §2.1/§2.2/§3/§5.1 (and UC-1's length rule).
 * That is what lets a REJECTED declaration still be stored with all of its fields plus a stable
 * `reject_reason` — a contract's malformed claim is evidence about that contract, and the page
 * shows it. Only a payload of the wrong SHAPE cannot be decoded at all: longer than 256 bytes under
 * the draft name, not a positive multiple of 256 under the standard's.
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
 * construction, a real event whose value does not fill its field arrives SHORT — it is not
 * malformed, it is the same bytes with zeros removed. The indexer's GraphQL `payload` field re-pads
 * to exactly 256, so this does not arise through that source, but the node-direct `EventSource` the
 * owner has planned sees the untrimmed form. Under the draft name {@link decodeTokenMetadata}
 * therefore **zero-extends** a short payload to 256 and records how short it was. Under the
 * standard's name the multi-part reader restores every PART to 256 bytes before concatenating
 * (`ingest/packages.ts`, [Y] §4), so the package it hands over is already `256 · k` bytes.
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

/** One event's payload — and so one PART of a MIP-0018 package ([Y] §1). */
export const PAYLOAD_SIZE = 256;
/** Payload offsets, from MIP §2's table — spelled out so the decoder reads as the table does. The
 *  first four are shared by both layouts. */
export const OFFSET_DOMAIN_SEP = 0;
export const OFFSET_KIND = 32;
export const OFFSET_KEY = 33;
export const OFFSET_VAL_TYPE = 65;
export const OFFSET_VAL_LEN = 66;
/** The draft's value offset (one-byte `val-len`). */
export const OFFSET_VALUE = 67;
/** The draft's value field: 189 bytes. */
export const VALUE_SIZE = 189;
/** `val-len > 189` rejects under the draft (MIP §2.2 before UC-1). */
export const MAX_VAL_LEN = VALUE_SIZE;

/** UC-1: `val-len` is two bytes at offset 66, so the value starts at 68 … */
export const OFFSET_VALUE_UC1 = 68;
/** … and one part holds 188 value bytes; more needs a multi-part package. */
export const ONE_PART_VALUE_SIZE_UC1 = PAYLOAD_SIZE - OFFSET_VALUE_UC1;
/** UC-1: `val-len` is an unsigned 16-bit integer. */
export const MAX_VAL_LEN_UC1 = 65_535;

/** MIP-0018 §2.1's Null type. `val-len` MUST be 0 and every value byte is ignored; it sets the
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
  /** The payload as decoded: `256 · parts` bytes under the standard's name (a [Y] package); exactly
   *  256 under the draft name, zero-extended if the source delivered it with its trailing NULs
   *  trimmed. This is what gets stored. */
  payload: Uint8Array;
  /** How many 256-byte parts the payload is: `payload.length / 256`. Always 1 under the draft. */
  parts: number;
  /** The length the source actually delivered, when it was shorter than 256 — evidence that the
   *  trailing-NUL trimming happened, and `undefined` for a full-width payload (and always for a
   *  package, whose parts the reader restored). */
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
  /** The DECLARED length — two bytes little-endian under UC-1, one byte under the draft. It may
   *  exceed the value field on a malformed payload; validation reports that. */
  valLen: number;
  /** The whole value field, padding included — from offset 68 to the end of the package under
   *  UC-1, the 189 bytes from offset 67 under the draft — stored verbatim on the event row. */
  value: Uint8Array;
  /** `value.subarray(0, val-len)` — the only bytes any consumer may read (MIP §2.2); clamped to the
   *  field when a malformed `val-len` runs past it. */
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
  /** The draft name only: `val-len > 189` (MIP §2.2 before UC-1). */
  | "val_len_too_long"
  /** The standard's name (UC-1): `68 + val-len` runs past the package's `256 · k` bytes — the
   *  declared value is longer than what the package carries. A one-part package holds 188 bytes,
   *  so `val-len` 189 in one part lands here too. */
  | "val_len_beyond_package"
  /** Every per-type value rule of §2.1, Null's `val-len` MUST be zero included — MIP §2.2 files
   *  them all under one line ("`value` failing its `val-type` backing-type or semantic rule MUST
   *  reject the event"), and the reference contracts' corpus names this case the same way, so the
   *  two implementations report one string for one rule. */
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
  | "metadata_too_deep"
  | "metadata_part_index"
  | "token_uri_not_absolute_http"
  | "text_not_storable";

export class PayloadSizeError extends Error {
  readonly reason = "payload_size" as const;
  constructor(readonly size: number, variant: NameVariant = "legacy-mip-xxxx") {
    super(variant === "mip-0018"
      ? `a mip-0018 package must be a positive multiple of ${PAYLOAD_SIZE} bytes, got ${size}`
      : `token-metadata payload must be at most ${PAYLOAD_SIZE} bytes, got ${size}`);
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
 * Structural decode. It never judges; the variant only picks the LAYOUT, because UC-1 moved
 * `val-len` and the value (see the header).
 *
 *  - `mip-0018`: a [Y] package, `256 · k` bytes (`k ≥ 1`); `val-len` is two bytes little-endian at
 *    66 and the value field runs from 68 to the end of the package. Anything that is not a positive
 *    multiple of 256 throws {@link PayloadSizeError}: the reader never produces one, so it is a bug
 *    upstream, and storing it would store a package the chain never carried.
 *  - `legacy-mip-xxxx`: one 256-byte event; a SHORTER payload is zero-extended (the VM trims
 *    trailing NULs, and every short payload is a full one with zeros removed), a LONGER one throws.
 *
 * `valueBytes` is clamped to the field so a malformed `val-len` is reported by validation, never by
 * a range error.
 */
export function decodeTokenMetadata(raw: Uint8Array, variant: NameVariant): DecodedTokenMetadata {
  let payload = raw;
  let paddedFrom: number | undefined;
  if (variant === "mip-0018") {
    if (raw.length === 0 || raw.length % PAYLOAD_SIZE !== 0) throw new PayloadSizeError(raw.length, variant);
  } else {
    if (raw.length > PAYLOAD_SIZE) throw new PayloadSizeError(raw.length, variant);
    if (raw.length < PAYLOAD_SIZE) {
      paddedFrom = raw.length;
      payload = new Uint8Array(PAYLOAD_SIZE);
      payload.set(raw, 0);
    }
  }
  const domainSep = payload.subarray(OFFSET_DOMAIN_SEP, OFFSET_KIND);
  const kindByte = payload[OFFSET_KIND]!;
  const key = payload.subarray(OFFSET_KEY, OFFSET_VAL_TYPE);
  const keyBytes = trimTrailingNuls(key);
  const valType = payload[OFFSET_VAL_TYPE]!;
  const uc1 = variant === "mip-0018";
  // UC-1: `Uint<16>` in Compact's serialization — little-endian, byte 66 is the low byte.
  const valLen = uc1
    ? payload[OFFSET_VAL_LEN]! | (payload[OFFSET_VAL_LEN + 1]! << 8)
    : payload[OFFSET_VAL_LEN]!;
  const value = payload.subarray(uc1 ? OFFSET_VALUE_UC1 : OFFSET_VALUE, payload.length);
  return {
    payload,
    parts: payload.length / PAYLOAD_SIZE,
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
    valueBytes: value.subarray(0, Math.min(valLen, value.length)),
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
      // "`val-len` MUST be zero; consumers MUST ignore all … `value` bytes." Reported as
      // `val_type_rule` rather than a reason of its own: MIP §2.2 puts every per-type value rule on
      // one line, and the reference contracts' negative corpus names this case `val_type_rule` too
      // (`fixtures/contracts/negative-payloads.json`), so a diagnostic string means the same thing
      // in both implementations.
      return valLen === 0 ? undefined : "val_type_rule";
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
 * Every rejection rule of MIP §2.2, §2.1, §3 and §5.1 (with UC-1's length rule under the standard's
 * name), applied in PAYLOAD-OFFSET order so a payload that breaks two rules always reports the same
 * one: `kind` (32) → `key` (33) → `val-type` (65) → `val-len` (66) → `value` (67 / 68). Returns
 * `undefined` when the declaration is applicable.
 *
 * The pointer rule sits with the key it is about, at offset 33. The length rule differs by name:
 * `val_len_beyond_package` under UC-1 (`68 + val-len > 256 · k`), `val_len_too_long` under the
 * draft (`val-len > 189`).
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
  if (variant === "mip-0018") {
    if (OFFSET_VALUE_UC1 + decoded.valLen > decoded.payload.length) return "val_len_beyond_package";
  } else if (decoded.valLen > MAX_VAL_LEN) {
    return "val_len_too_long";
  }
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

  // UC-1 (project 00024-01, spec FR-009): under the standard's name a value may be any length, so
  // this consumer's projections set no 189-byte ceiling of their own; the draft keeps its limits.
  const oneEventCeiling = variant === "mip-0018" ? Number.POSITIVE_INFINITY : VALUE_SIZE;
  switch (keyText) {
    case "name":
      if (valType !== 1) return "val_type_mismatch";
      if (valLen < 1 || valLen > oneEventCeiling) return "name_len";
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
      // 01-D audit F2: a valid document can nest deeper than the column can be written
      // (`JSON.stringify` overflows the stack long before a 65 535-byte value runs out); such a
      // value stays a trait and is flagged, so the fold never throws and the scan never stalls.
      if (jsonNestingDepth(decodeUtf8(valueBytes)!) > MAX_METADATA_DEPTH) return "metadata_too_deep";
      if (variant === "mip-0018") {
        return isJsonObject(decodeUtf8(valueBytes)!) ? undefined : "metadata_not_json_object";
      }
      if (valLen < 2) return "metadata_len";
      return isJsonObject(decodeUtf8(valueBytes)!) ? undefined : "metadata_not_json_object";
    }
    case "tokenUri": {
      if (valType !== 4) return "val_type_mismatch";
      if (valLen < 1 || valLen > oneEventCeiling) return "token_uri_not_absolute_http";
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
/**
 * The deepest nesting a projected `metadata` document may have (01-D audit F2). A MIP-0018 value may
 * be 65 535 bytes, enough for ~32 000 levels of `[`; `JSON.parse` accepts that, but serializing the
 * parsed object back into the `jsonb` column (`JSON.stringify`, and Postgres's own parser) recurses
 * once per level and overflows. 128 is far beyond any real metadata document and far below both
 * limits. A deeper value is still stored and served as a trait; only the column projection is refused.
 */
export const MAX_METADATA_DEPTH = 128;

/** The maximum `{`/`[` nesting depth of a JSON text, counted in one pass without recursion; string
 *  contents (with their escapes) do not count. */
export function jsonNestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) { depth++; if (depth > max) max = depth; }
    else if (c === 0x7d || c === 0x5d) depth--;
  }
  return max;
}

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
 * Decode + validate in one call — what the fold uses. The variant is **required**: it decides the
 * layout, four transport rules and how a type-2 byte string reads, and a default would silently
 * validate a payload under rules its emitter never used.
 *
 * Throws {@link PayloadSizeError} for a payload of the wrong shape (nothing can be stored for it);
 * every other transport failure comes back as `applied: false` with a reason, and the caller stores
 * the row anyway.
 */
export function parseTokenMetadata(payload: Uint8Array, variant: NameVariant): ParsedTokenMetadata {
  const decoded = decodeTokenMetadata(payload, variant);
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
 * Builds a 256-byte payload in the **draft's** layout (one-byte `val-len`, value from 67) — the
 * encoder side of the legacy decode. Used by the tests and by the fixture tooling; having the
 * encoder here rather than in a test file is what makes "encode(decode(x)) == x" a property the
 * module itself guarantees. The standard's name uses {@link encodeTokenMetadataUc1}.
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
 * Builds a MIP-0018 package payload on the **UC-1** layout: `domainSep` · `kind` · `key` ·
 * `val-type` · `val-len` (`Uint<16>`, little-endian) · value, zero-padded to `256 · parts` bytes —
 * by default the fewest parts that hold the value (188 value bytes in one part). This is the byte
 * string the multi-part reader hands the decoder, and the one a publisher splits into parts.
 *
 * `valLen` and `parts` are explicit so a test can build what no honest emitter would (a declared
 * length past the package, a value in a larger package than it needs).
 */
export function encodeTokenMetadataUc1(fields: {
  domainSep: Uint8Array;
  kindByte: number;
  key: Uint8Array | string;
  valType: number;
  valLen?: number;
  value: Uint8Array | string;
  parts?: number;
  /** Bytes written after the value (a publisher that broke [Y] §5 by putting two declarations in
   *  one intent leaves the second one here — spec Q11). */
  trailing?: Uint8Array;
}): Uint8Array {
  if (fields.domainSep.length !== 32) throw new Error("domainSep must be 32 bytes");
  const key = typeof fields.key === "string" ? pad32(fields.key) : fields.key;
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const value = typeof fields.value === "string" ? new TextEncoder().encode(fields.value) : fields.value;
  const trailing = fields.trailing ?? new Uint8Array(0);
  const valLen = fields.valLen ?? value.length;
  if (!Number.isInteger(valLen) || valLen < 0 || valLen > MAX_VAL_LEN_UC1) {
    throw new Error(`val-len ${valLen} does not fit Uint<16>`);
  }
  const needed = OFFSET_VALUE_UC1 + value.length + trailing.length;
  const parts = fields.parts ?? Math.max(1, Math.ceil(needed / PAYLOAD_SIZE));
  if (!Number.isInteger(parts) || parts < 1 || parts * PAYLOAD_SIZE < needed) {
    throw new Error(`${needed} bytes do not fit ${parts} part(s)`);
  }
  const out = new Uint8Array(parts * PAYLOAD_SIZE);
  out.set(fields.domainSep, OFFSET_DOMAIN_SEP);
  out[OFFSET_KIND] = fields.kindByte;
  out.set(key, OFFSET_KEY);
  out[OFFSET_VAL_TYPE] = fields.valType;
  out[OFFSET_VAL_LEN] = valLen & 0xff;
  out[OFFSET_VAL_LEN + 1] = valLen >> 8;
  out.set(value, OFFSET_VALUE_UC1);
  out.set(trailing, OFFSET_VALUE_UC1 + value.length);
  return out;
}

/** A package payload split into its 256-byte parts — what a publisher emits, one event each. */
export function splitIntoParts(payload: Uint8Array): Uint8Array[] {
  if (payload.length === 0 || payload.length % PAYLOAD_SIZE !== 0) {
    throw new Error(`a package is a positive multiple of ${PAYLOAD_SIZE} bytes, got ${payload.length}`);
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += PAYLOAD_SIZE) parts.push(payload.slice(i, i + PAYLOAD_SIZE));
  return parts;
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
