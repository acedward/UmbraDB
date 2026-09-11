import { z } from "zod";
import {
  ArchiveDiscontinuityError,
  type ArchiveBlockPage,
  type ArchiveIdentity,
  type ArchivedBlock,
  type ArchivedTransaction,
  type ArchiveTip,
} from "./archive-read-contract.js";
import { Hex32Schema, type TransactionKind, type TransactionResult } from "./chain-archive-store.js";

/**
 * The JSON encoding of {@link ArchiveReadContract} — one module, used by BOTH ends of the wire
 * (organizer sub-plan 00009-08; `spec/00009` FR-025).
 *
 * **Why this file exists at all.** `archive-read-contract.ts` says, in its own header, that the
 * contract "can move across a process boundary". 00009-08 is that move: an A-side process serves
 * the contract over HTTP (`archive-read-api/`) and project B consumes it through
 * `shielded-monitor/archive-http-client.ts`. Two hand-written codecs — one per side — is the
 * classic way for a boundary like this to rot: the server starts sending `timestamp_ms`, the
 * client keeps reading `timestampMs`, every field decodes to `undefined`, and the scanner records
 * a run of blocks with no timestamps and no error. So the encoding is written ONCE, here, with
 * the decoder as the schema's own output, and both sides import it.
 *
 * **Why it lives in `src/interfaces/` rather than next to the server.** It is part of the
 * CONTRACT, not of either implementation. Project B may not import A's storage modules at all
 * (owner Rule B, enforced by `test/shielded-monitor/import-boundary.test.ts`), so anything B
 * needs in order to speak to A has to sit where the interface sits. Nothing here imports
 * `postgres`, a schema name, or a storage module; the only dependency beyond the interface types
 * is `zod`, which this repository already ships.
 *
 * **Bytes.** `rawBytes` is base64 on the wire. Not hex: the archive's raw ledger bytes are the
 * bulk of every page (hundreds of bytes to tens of kilobytes per transaction), and hex doubles
 * that where base64 costs a third. Not an array of numbers, which costs four times. The decoder
 * rejects anything that is not canonical base64 rather than silently producing short bytes.
 *
 * **What is NOT on the wire.** No blob hash, no `is_canonical`, no row id, no schema name — the
 * same exclusion list the interface's own header gives, now enforced by a schema instead of by
 * discipline. A field that does not exist here cannot leak A's storage shape into B.
 */

/** The wire's protocol marker. Bumped only for a change a 00009-08 client could not read; it is
 *  returned by `/v1/archive/identity` so a client can refuse a server it does not understand
 *  rather than mis-parsing it. */
export const ARCHIVE_READ_WIRE_VERSION = 1;

/** The routes, as one table, so the server's router and the client's URL builder cannot drift. */
export const ARCHIVE_READ_ROUTES = {
  health: "/v1/health",
  identity: "/v1/archive/identity",
  blocks: "/v1/archive/blocks",
  tip: "/v1/archive/tip",
  events: "/v1/archive/events",
} as const;

/** Error codes the archive read API returns. A client switches on these, never on messages. */
export type ArchiveReadApiErrorCode =
  | "VALIDATION_FAILED"
  | "ARCHIVE_DISCONTINUITY"
  | "BLOB_INTEGRITY"
  | "BLOB_MISSING"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

export const ArchiveReadApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(4096),
    requestId: z.string().max(64).optional(),
  }),
});

export type ArchiveReadApiError = z.infer<typeof ArchiveReadApiErrorSchema>;

// ── base64 ───────────────────────────────────────────────────────────────────────────────────

/**
 * Strict base64: the alphabet, correct padding, and a length that is a multiple of four.
 *
 * `Buffer.from(s, "base64")` is deliberately permissive — it ignores characters outside the
 * alphabet and truncates at the first problem, so `"!!!!"` decodes to zero bytes and a
 * transaction whose payload was corrupted in transit would arrive as an EMPTY `rawBytes` that the
 * scanner would hand to the ledger as "undecodable" (a fail-closed stop, on a fault that is
 * really a transport bug). Refusing the string here names the real fault instead.
 */
const Base64Schema = z
  .string()
  .max(64 * 1024 * 1024)
  .refine(
    (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s),
    "expected canonical base64 (RFC 4648, padded)",
  );

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  const buf = Buffer.from(value, "base64");
  // `new Uint8Array(buf)` COPIES. Returning a view over Node's pooled Buffer would hand callers a
  // window into a shared 8 KiB slab, which the scanner then keeps for the life of an association.
  return new Uint8Array(buf);
}

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────

/** Heights are JSON numbers: the contract types them as `number` (safe-integer block heights),
 *  and inventing a decimal-string encoding here would make the two ends disagree about the type
 *  the interface actually declares. */
const HeightSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WireTransactionSchema = z.object({
  txHash: Hex32Schema,
  position: z.number().int().min(0).max(1_000_000),
  kind: z.enum(["regular", "system"]),
  protocolVersion: z.number().int().min(0).max(1_000_000),
  result: z.enum(["success", "partial_success", "failure"]).optional(),
  rawBytes: Base64Schema,
});

export const WireBlockSchema = z.object({
  net: z.string().min(1).max(64),
  height: HeightSchema,
  hash: Hex32Schema,
  parentHash: Hex32Schema,
  timestampMs: z.number().int().min(0).optional(),
  transactions: z.array(WireTransactionSchema).max(100_000),
});

export const WireTipSchema = z.object({ height: HeightSchema, hash: Hex32Schema });

export const WireBlockPageSchema = z.object({
  blocks: z.array(WireBlockSchema).max(10_000),
  sourceTip: WireTipSchema.optional(),
});

export const WireIdentitySchema = z.object({
  net: z.string().min(1).max(64),
  genesisHash: Hex32Schema,
  archiveInstanceId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Present from 00009-08 on; absent from a hypothetical older server, which is why the client
   *  treats it as optional and only REFUSES a version it knows it cannot read. */
  wireVersion: z.number().int().min(1).optional(),
});

/** The SSE `progress` event's data payload: the height the archive just committed. */
export const WireProgressEventSchema = z.object({
  net: z.string().min(1).max(64),
  height: HeightSchema,
});

export type WireBlockPage = z.infer<typeof WireBlockPageSchema>;
export type WireIdentity = z.infer<typeof WireIdentitySchema>;

// ── Encode (server side) ─────────────────────────────────────────────────────────────────────

export function encodeTransaction(tx: ArchivedTransaction): z.infer<typeof WireTransactionSchema> {
  return {
    txHash: tx.txHash,
    position: tx.position,
    kind: tx.kind,
    protocolVersion: tx.protocolVersion,
    ...(tx.result === undefined ? {} : { result: tx.result }),
    rawBytes: bytesToBase64(tx.rawBytes),
  };
}

export function encodeBlock(block: ArchivedBlock): z.infer<typeof WireBlockSchema> {
  return {
    net: block.net,
    height: block.height,
    hash: block.hash,
    parentHash: block.parentHash,
    ...(block.timestampMs === undefined ? {} : { timestampMs: block.timestampMs }),
    transactions: block.transactions.map(encodeTransaction),
  };
}

export function encodeBlockPage(page: ArchiveBlockPage): WireBlockPage {
  return {
    blocks: page.blocks.map(encodeBlock),
    ...(page.sourceTip === undefined ? {} : { sourceTip: { ...page.sourceTip } }),
  };
}

export function encodeIdentity(identity: ArchiveIdentity): WireIdentity {
  return { ...identity, wireVersion: ARCHIVE_READ_WIRE_VERSION };
}

// ── Decode (client side) ─────────────────────────────────────────────────────────────────────

/** A wire payload that does not match the schema. Fail-closed: a page that cannot be fully
 *  validated is refused, never partially used. */
export class ArchiveWireError extends Error {
  readonly code = "ARCHIVE_WIRE_INVALID" as const;
  constructor(what: string, readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `the archive read API returned a ${what} this client cannot read: ` +
        issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("; "),
    );
    this.name = "ArchiveWireError";
  }
}

function decode<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ArchiveWireError(
      what,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function decodeBlockPage(value: unknown): ArchiveBlockPage {
  const wire = decode(WireBlockPageSchema, value, "block page");
  const blocks: ArchivedBlock[] = wire.blocks.map((block) => ({
    net: block.net,
    height: block.height,
    hash: block.hash,
    parentHash: block.parentHash,
    ...(block.timestampMs === undefined ? {} : { timestampMs: block.timestampMs }),
    transactions: block.transactions.map((tx) => ({
      txHash: tx.txHash,
      position: tx.position,
      kind: tx.kind as TransactionKind,
      protocolVersion: tx.protocolVersion,
      ...(tx.result === undefined ? {} : { result: tx.result as TransactionResult }),
      rawBytes: base64ToBytes(tx.rawBytes),
    })),
  }));

  // The SAME parent-linkage check `PgArchiveReadContract` performs, re-run on the client.
  //
  // Not redundant: the client is the side whose coverage advances, and it must not be able to
  // record a scanned range on the word of a server (or a proxy, or a cache) that handed it a
  // sequence with a hole in it. The in-process implementation refuses that page; so does this.
  for (let i = 1; i < blocks.length; i++) {
    const previous = blocks[i - 1]!;
    const current = blocks[i]!;
    if (current.height !== previous.height + 1 || current.parentHash !== previous.hash) {
      throw new ArchiveDiscontinuityError(current.net, current.height, previous.hash, current.parentHash);
    }
  }

  const tip: ArchiveTip | undefined = wire.sourceTip;
  return { blocks, ...(tip === undefined ? {} : { sourceTip: tip }) };
}

export function decodeIdentity(value: unknown): ArchiveIdentity {
  const wire = decode(WireIdentitySchema, value, "archive identity");
  if (wire.wireVersion !== undefined && wire.wireVersion > ARCHIVE_READ_WIRE_VERSION) {
    throw new ArchiveWireError("archive identity", [
      {
        path: "wireVersion",
        message:
          `the server speaks wire version ${wire.wireVersion}; this client understands ` +
          `${ARCHIVE_READ_WIRE_VERSION}. Refusing to read pages from a protocol it may be ` +
          "misinterpreting rather than guessing at the fields it recognises.",
      },
    ]);
  }
  return {
    net: wire.net,
    genesisHash: wire.genesisHash,
    archiveInstanceId: wire.archiveInstanceId,
  };
}

export function decodeProgressEvent(value: unknown): { net: string; height: number } {
  return decode(WireProgressEventSchema, value, "progress event");
}
