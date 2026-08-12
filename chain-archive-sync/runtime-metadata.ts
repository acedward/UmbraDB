/**
 * Block-scoped runtime metadata: resolving the runtime's own description of itself for the exact
 * block being decoded, and reading the facts ingest needs out of it.
 *
 * WHY THIS EXISTS. Three things this archive must do cannot be done from constants:
 *
 *   1. classify an extrinsic by its dispatched call, when a runtime may renumber its pallets;
 *   2. read the call out of a SIGNED framing, whose address / signature / transaction-extension
 *      layouts are chain configuration rather than protocol constants;
 *   3. decode `SystemTransactionApplied` events, which is the only place a runtime-GENERATED
 *      system transaction exists.
 *
 * Until this module, all three were handled by refusing (see the sprint plan §5.1–§5.3). Refusing
 * is correct but it is not ingest.
 *
 * BLOCK-SCOPED, NOT TIP-SCOPED. Metadata is fetched at the block's own hash, never at the chain
 * tip. A block spanning a runtime upgrade decodes against the wrong layout otherwise, and the
 * failure is silent: pallet indices simply mean something else, so genuine transactions are
 * classified as foreign calls and vanish. `state_getMetadata` accepts a block hash, which is what
 * makes this possible at all.
 *
 * CACHED BY RUNTIME IDENTITY, NOT BY BLOCK. Metadata is ~100 KB and identical for every block of
 * a given runtime, so fetching per block would be pure waste. The cache key is the runtime's
 * `(spec_name, spec_version)` from `state_getRuntimeVersion` at that same block hash -- the
 * runtime's own identity, which is exactly what changes at an upgrade. Keying on anything coarser
 * (a protocol version range, a node version) would reintroduce the tip-scoped bug for the blocks
 * either side of an upgrade.
 */
import { Metadata, TypeRegistry } from "@polkadot/types";
import type { NodeRpcClient } from "./node-rpc-client.js";
import type { RuntimeCallIndices } from "./extrinsic-decoder.js";
import { captureForProtocolVersion } from "./metadata-captures/index.js";

/** A runtime's own identity, as the runtime reports it. The cache key. */
export interface RuntimeIdentity {
  specName: string;
  specVersion: number;
}

/**
 * Where this archive keeps its own metadata captures.
 *
 * Narrower than the store interface on purpose: metadata resolution needs exactly "load these
 * bytes" and "keep these bytes", and depending on the whole archive store would make this module
 * untestable without a database.
 */
export interface MetadataPersistence {
  load(identity: RuntimeIdentity): Promise<Uint8Array | undefined>;
  save(identity: RuntimeIdentity, bytes: Uint8Array): Promise<void>;
}

/** Everything ingest reads out of one runtime's metadata, resolved once per runtime. */
export interface ResolvedRuntimeMetadata {
  identity: RuntimeIdentity;
  registry: TypeRegistry;
  metadata: Metadata;
  /** Pallet and call indices read from the runtime itself, replacing pinned constants. */
  callIndices: RuntimeCallIndices;
  /** `(palletIndex, variantIndex)` of `MidnightSystem::SystemTransactionApplied`, or `undefined`
   *  if this runtime has no such event. */
  systemTransactionAppliedEvent: { palletIndex: number; variantIndex: number } | undefined;
}

/** Pallet names as the Midnight runtime declares them. Matched by NAME, never by index -- the
 *  whole point of reading metadata is that indices are not stable across runtimes. */
const PALLET_MIDNIGHT = "Midnight";
const PALLET_MIDNIGHT_SYSTEM = "MidnightSystem";
const CALL_SEND_TRANSACTION = "send_mn_transaction";
const CALL_SEND_SYSTEM_TRANSACTION = "send_mn_system_transaction";
const EVENT_SYSTEM_TRANSACTION_APPLIED = "SystemTransactionApplied";

function findPallet(metadata: Metadata, name: string) {
  const pallet = metadata.asLatest.pallets.find((p) => p.name.toString() === name);
  if (pallet === undefined) {
    throw new Error(
      `runtime metadata declares no "${name}" pallet. This runtime cannot be a Midnight runtime ` +
        "this archive understands; refusing rather than guessing an index.",
    );
  }
  return pallet;
}

/** Index of a named call within a pallet, read from the pallet's call enum. */
function callIndex(registry: TypeRegistry, metadata: Metadata, palletName: string, callName: string): number {
  const pallet = findPallet(metadata, palletName);
  if (pallet.calls.isNone) {
    throw new Error(`runtime metadata: pallet "${palletName}" declares no calls at all`);
  }
  const variants = registry.lookup.getSiType(pallet.calls.unwrap().type).def.asVariant.variants;
  const variant = variants.find((v) => v.name.toString() === callName);
  if (variant === undefined) {
    throw new Error(
      `runtime metadata: pallet "${palletName}" declares no call "${callName}" (has: ` +
        `${variants.map((v) => v.name.toString()).join(", ")}). Refusing rather than assuming an index.`,
    );
  }
  return variant.index.toNumber();
}

/**
 * Parse SCALE-encoded metadata bytes into a usable registry plus the indices ingest needs.
 *
 * Separated from fetching so it can be exercised against a committed fixture with no node -- the
 * decode path is the part that can be wrong, and it should not require a running chain to test.
 */
export function resolveMetadata(bytes: Uint8Array, identity: RuntimeIdentity): ResolvedRuntimeMetadata {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, bytes);
  registry.setMetadata(metadata);

  const midnight = findPallet(metadata, PALLET_MIDNIGHT);
  const midnightSystem = findPallet(metadata, PALLET_MIDNIGHT_SYSTEM);

  // Exactly the four facts `RuntimeCallIndices` declares, and no more. The runtime also describes
  // Timestamp and every other pallet, but the classifier does not need them: anything that is not
  // one of these two (pallet, call) pairs is `not_midnight` by construction, so carrying extra
  // indices would be data nothing reads -- and data nothing reads is data nothing notices going
  // wrong.
  const callIndices: RuntimeCallIndices = {
    midnightPallet: midnight.index.toNumber(),
    midnightSystemPallet: midnightSystem.index.toNumber(),
    sendTransactionCall: callIndex(registry, metadata, PALLET_MIDNIGHT, CALL_SEND_TRANSACTION),
    sendSystemTransactionCall: callIndex(
      registry, metadata, PALLET_MIDNIGHT_SYSTEM, CALL_SEND_SYSTEM_TRANSACTION,
    ),
  };

  // Absence is not an error: a runtime that emits no such event simply has no event-borne system
  // transactions, and ingest's guard handles that case by finding nothing to account for.
  let systemTransactionAppliedEvent: { palletIndex: number; variantIndex: number } | undefined;
  if (midnightSystem.events.isSome) {
    const variants = registry.lookup.getSiType(midnightSystem.events.unwrap().type).def.asVariant.variants;
    const variant = variants.find((v) => v.name.toString() === EVENT_SYSTEM_TRANSACTION_APPLIED);
    if (variant !== undefined) {
      systemTransactionAppliedEvent = {
        palletIndex: midnightSystem.index.toNumber(),
        variantIndex: variant.index.toNumber(),
      };
    }
  }

  return { identity, registry, metadata, callIndices, systemTransactionAppliedEvent };
}

/** One extrinsic's dispatched call, read through the runtime's own metadata. */
export interface MetadataDecodedExtrinsic {
  /** Whether the extrinsic carried a signature. Recorded, not acted on: `send_mn_transaction`
   *  ignores its origin, so a signed Midnight transaction is exactly as valid as a bare one. */
  isSigned: boolean;
  palletIndex: number;
  callIndex: number;
  /** The call's first argument as BARE bytes, when it has one -- the serialized transaction for
   *  Midnight calls. `undefined` for calls taking no arguments. */
  payload: Uint8Array | undefined;
}

/**
 * Decode one extrinsic's call using metadata, for EVERY framing.
 *
 * This is what §5.2 was waiting for. The hand-rolled envelope decoder can only read a bare
 * extrinsic: in a signed or "general" framing the call sits behind an address, a signature and the
 * transaction extensions, whose layouts are chain configuration rather than protocol constants.
 * Because `send_mn_transaction` ignores its origin, a SIGNED Midnight transaction is valid and the
 * reference indexer archives it -- so being unable to read one meant either dropping a real
 * transaction or refusing the block.
 *
 * Metadata removes the distinction entirely: the same call is read out of either framing, which is
 * precisely how the reference adapter treats them (`decode_call_data_as::<Call>()`, applied
 * without regard to framing).
 *
 * Throws on anything it cannot decode. A caller must not be able to mistake "this extrinsic is not
 * a Midnight call" for "this extrinsic could not be read", because the first is a routine skip and
 * the second means the archive would be missing something.
 */
export function decodeExtrinsicWithMetadata(
  resolved: ResolvedRuntimeMetadata,
  extrinsicHex: string,
): MetadataDecodedExtrinsic {
  const { registry } = resolved;
  let xt: any;
  // Normalize the `0x` prefix. `chain_getBlock` always includes it, but without it the codec takes
  // the value for a plain string rather than hex and fails with a message about expecting "an
  // input object, map or array" -- which points nowhere near the actual problem.
  const hex = extrinsicHex.startsWith("0x") ? extrinsicHex : `0x${extrinsicHex}`;
  try {
    xt = registry.createType("Extrinsic" as never, hex);
  } catch (cause) {
    throw new Error(
      `could not decode extrinsic against this block's runtime metadata: ${(cause as Error).message}. ` +
        "Refusing rather than skipping it -- an unreadable extrinsic may be a Midnight transaction, " +
        "and skipping would omit it from the archive without a word.",
      { cause },
    );
  }
  const idx = xt.method?.callIndex;
  if (idx === undefined || idx.length < 2) {
    throw new Error("decoded extrinsic carries no call index; refusing rather than guessing");
  }
  const arg0 = xt.method.args?.[0];
  return {
    isSigned: Boolean(xt.isSigned),
    palletIndex: idx[0],
    callIndex: idx[1],
    // `toU8a(true)` -- bare, without the SCALE length prefix a `Bytes` argument would re-add. The
    // archived payload must be the transaction itself, not the transaction inside an envelope.
    payload: arg0?.toU8a ? new Uint8Array(arg0.toU8a(true)) : undefined,
  };
}

/** One runtime-generated system transaction, recovered from a `SystemTransactionApplied` event. */
export interface EventSystemTransaction {
  /** The authoritative ledger hash, hex, no `0x`, lowercase -- as the RUNTIME reported it. */
  txHash: string;
  /** The serialized system transaction, exactly as archived. */
  payload: Uint8Array;
}

/** The `System::Events` storage item's own type, read from metadata rather than assumed.
 *  Its shape (`Vec<FrameSystemEventRecord>`) is a runtime detail, so it is looked up, not named. */
function eventsTypeId(resolved: ResolvedRuntimeMetadata): number {
  const system = findPallet(resolved.metadata, "System");
  if (system.storage.isNone) throw new Error("runtime metadata: System pallet declares no storage");
  const events = system.storage.unwrap().items.find((i) => i.name.toString() === "Events");
  if (events === undefined) throw new Error("runtime metadata: System pallet declares no Events storage item");
  return events.type.asPlain.toNumber();
}

/**
 * Decode the block's `System::Events` blob and return every system transaction the RUNTIME
 * generated.
 *
 * This is the capability whose absence forced ingest to refuse (sprint plan §5.1). Runtime-
 * generated system transactions are not in `chain_getBlock.extrinsics` at all -- the
 * `SystemTransactionApplied` event is the only place they exist.
 *
 * Note what the event carries: BOTH the payload and the authoritative hash. So these transactions
 * need no ledger hashing -- unlike extrinsic-borne ones, which must be hashed with the ledger
 * because the extrinsic carries only bytes. The hash here is the runtime's own answer, which is
 * also what the reference indexer keys on
 * (`midnight-node/pallets/midnight-system/src/lib.rs`, and `subxt_node.rs` consuming it).
 *
 * Throws rather than returning partial results if the blob cannot be decoded: an events blob that
 * does not match its own runtime's metadata means the metadata is wrong for this block, and
 * continuing would silently under-report what the block contained.
 */
export function decodeEventSystemTransactions(
  resolved: ResolvedRuntimeMetadata,
  eventsBlob: Uint8Array,
): EventSystemTransaction[] {
  const target = resolved.systemTransactionAppliedEvent;
  // A runtime with no such event cannot have event-borne system transactions. Not an error.
  if (target === undefined) return [];

  const { registry } = resolved;
  const records = registry.createType(
    registry.createLookupType(eventsTypeId(resolved)) as never,
    eventsBlob,
  ) as unknown as { toArray?: () => unknown[] } & Iterable<unknown>;

  const out: EventSystemTransaction[] = [];
  for (const record of records as Iterable<any>) {
    const event = record?.event;
    if (event === undefined) continue;
    // Match by INDEX, from metadata -- never by decoded name string. Names are stable in practice
    // but the index pair is what the encoding actually carries, and metadata is what maps one to
    // the other for this specific runtime.
    //
    // `event.index` is a codec (a 2-byte U8aFixed), NOT an array: indexing it positionally yields
    // undefined, so a naive `index[0] === palletIndex` check silently matches nothing and every
    // event-borne system transaction is reported as absent. Read the encoded bytes instead.
    const idx = event.index?.toU8a?.();
    if (idx === undefined || idx.length < 2) continue;
    if (idx[0] !== target.palletIndex || idx[1] !== target.variantIndex) continue;

    // This runtime declares the event's two fields as ONE named composite, so the decoded `data`
    // is a single-element array holding a struct -- not two positional items. Both shapes are
    // accepted because that is a runtime's choice, not a protocol rule, and a future runtime
    // could declare them positionally.
    const data = event.data;
    const composite = data?.length === 1 ? data[0] : undefined;
    // Read named fields through the Struct accessor, NEVER as plain properties.
    //
    // `codec.hash` is a BUILT-IN on every polkadot codec -- the blake2 hash of the encoded value --
    // so `composite.hash` silently returns that instead of the event's `hash_` field. It is a
    // 32-byte hex either way, so nothing looks wrong: every event-borne system transaction would
    // have been archived under a fabricated key, and `ON CONFLICT DO NOTHING` would have made it
    // permanent. Caught only by comparing against a known input.
    const field = (name: string): any =>
      typeof composite?.get === "function" ? composite.get(name) : undefined;
    const hashRaw = field("hash_") ?? field("hash") ?? data?.[0];
    const payloadRaw = field("serializedSystemTransaction") ?? data?.[1];
    if (hashRaw === undefined || payloadRaw === undefined) {
      throw new Error(
        "runtime metadata: SystemTransactionApplied decoded without the expected hash and " +
          "serialized-transaction fields. The event's shape changed; refusing rather than " +
          "archiving a system transaction under a key that may not be its identity.",
      );
    }
    out.push({
      txHash: Buffer.from(hashRaw.toU8a ? hashRaw.toU8a() : hashRaw).toString("hex").toLowerCase(),
      // `toU8a(true)` -- bare encoding. The payload is `Bytes`, whose default encoding re-prepends
      // the SCALE length prefix; archiving that would store bytes that are not the transaction.
      payload: new Uint8Array(payloadRaw.toU8a ? payloadRaw.toU8a(true) : payloadRaw),
    });
  }
  return out;
}

/**
 * Resolves metadata for one block, caching per runtime identity.
 *
 * Deliberately a class with an explicit cache rather than a module-level map: two services
 * ingesting different chains in one process must not share a cache keyed only by spec name and
 * version, since two chains can legitimately report the same pair while having different runtimes.
 */
export class BlockScopedMetadata {
  private readonly cache = new Map<string, ResolvedRuntimeMetadata>();

  constructor(
    private readonly node: NodeRpcClient,
    /** Where this archive keeps (and looks for) its own captures. Optional so the class stays
     *  usable in tests and tools that have no store; without it, only the node and the committed
     *  registry are available. */
    private readonly persistence?: MetadataPersistence,
  ) {}

  /**
   * Resolve metadata for the runtime that produced `blockHash`, in this order:
   *
   *   1. **this archive's own capture** -- exact, self-contained, no node involved;
   *   2. **the node**, at the block's hash -- and persist the answer, so step 2 retires itself
   *      for that runtime and later re-syncs or replays need no node at all;
   *   3. **the committed registry**, keyed by the header's MNSV version -- the pruned-node
   *      bootstrap, where `state_getRuntimeVersion` itself is unanswerable;
   *   4. **refuse**, naming which sources were tried.
   *
   * Never guesses a layout. Metadata from the wrong runtime decodes a block against layouts that
   * are not its own, and that failure is silent: pallet indices simply mean something else, so
   * genuine transactions are classified as foreign calls and vanish.
   *
   * `protocolVersion` (the header's MNSV value) is what makes step 3 possible; it is optional
   * because steps 1-2 do not need it.
   */
  async forBlock(blockHash: string, protocolVersion?: number): Promise<ResolvedRuntimeMetadata> {
    const at = blockHash.startsWith("0x") ? blockHash : `0x${blockHash}`;

    // The runtime's identity needs the same historical state the metadata does, so on a pruned
    // node this is where resolution fails -- which is exactly when the registry is the only path
    // left. But ONLY that kind of failure may fall through.
    //
    // Audit A3: this catch previously swallowed every error, so a transient connection reset or a
    // timeout silently degraded resolution to the coarse committed registry -- keyed by protocol
    // range rather than by the runtime's own identity -- and ingest carried on as though nothing
    // had happened. A network blip must not quietly change which metadata decodes a block; the
    // difference is invisible in the archive afterwards. Only a node that ANSWERED and said the
    // state is gone earns the fallback. Anything else propagates.
    let identity: RuntimeIdentity | undefined;
    try {
      const version = await this.node.runtimeVersionAt(at);
      identity = { specName: version.specName, specVersion: version.specVersion };
    } catch (error) {
      if (!isHistoricalStateUnavailable(error)) throw error;
      identity = undefined;
    }

    if (identity !== undefined) {
      const key = `${identity.specName}@${identity.specVersion}`;
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;

      // (1) this archive's own capture
      const stored = await this.persistence?.load(identity);
      if (stored !== undefined) {
        const resolved = resolveMetadata(stored, identity);
        this.cache.set(key, resolved);
        return resolved;
      }

      // (2) the node -- and keep what it gives us.
      //
      // Audit A3 asked whether persisting here is safe, since it commits BEFORE the block that
      // triggered it is known to be archivable: a block that later refuses leaves the capture
      // behind. It is safe, and deliberately so. A capture is a fact about a RUNTIME, not about a
      // block -- the node served this metadata for this runtime identity, and that stays true
      // whether or not the block goes on to refuse for unrelated reasons. Keeping it is also what
      // makes a retry cheaper rather than poisoned: the retry reads the same bytes from the
      // archive instead of re-fetching. What must never leak past a refusal is block-derived data,
      // and none of this is that.
      //
      // The one visible consequence: `first_seen_height` can name a block that was never archived.
      // It is diagnostic ("which block introduced this runtime"), not structural, and the honest
      // answer to that question is the height where the runtime was first OBSERVED.
      const raw = await this.node.metadataAt(at).catch(() => undefined);
      if (raw !== undefined) {
        const bytes = hexToBytes(raw);
        const resolved = resolveMetadata(bytes, identity);
        this.cache.set(key, resolved);
        await this.persistence?.save(identity, bytes);
        return resolved;
      }
    }

    // (3) the committed registry -- last resort, coarse key, from the block HEADER
    if (protocolVersion !== undefined) {
      const found = captureForProtocolVersion(protocolVersion);
      if (found !== undefined) {
        // Identity is unknown on this path by construction, so the capture's own node version
        // stands in as the cache key. It must not be written back to the archive: a capture is
        // evidence about a node RELEASE, not an observation of this chain's runtime identity.
        const fallbackIdentity: RuntimeIdentity = {
          specName: `capture:${found.capture.nodeVersion}`,
          specVersion: protocolVersion,
        };
        const resolved = resolveMetadata(found.bytes, fallbackIdentity);
        this.cache.set(`${fallbackIdentity.specName}@${protocolVersion}`, resolved);
        return resolved;
      }
    }

    throw new Error(
      `no runtime metadata available for block ${at}` +
        (protocolVersion === undefined ? "" : ` (protocol ${protocolVersion})`) +
        ". Tried: this archive's own runtime_metadata captures, the node's state_getMetadata at " +
        "that block, and the committed capture registry. Historical metadata derives from " +
        "historical state, so a pruned node cannot serve it; either ingest this range through an " +
        "archive node once, or add a capture for this runtime to chain-archive-sync/" +
        "metadata-captures/. Refusing rather than decoding against another runtime's layout.",
    );
  }

  /** Runtimes resolved so far, for tests and diagnostics. */
  get cachedRuntimes(): string[] {
    return [...this.cache.keys()];
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, "hex"));
}

/**
 * Whether a failure means "the node answered, and the historical state is gone" -- the only
 * condition that may fall back to the coarse committed registry.
 *
 * Deliberately a MESSAGE match, and deliberately narrow. Substrate reports pruned state as an
 * application-level JSON-RPC error rather than a distinct type, so the text is the only signal
 * available; matching too broadly would restore the bug this replaces, where any failure quietly
 * changed which metadata decoded a block. A connection reset, a timeout, a 500 -- none of these
 * say anything about state retention, and all of them now propagate.
 */
function isHistoricalStateUnavailable(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return (
    /state already discarded/i.test(message) ||
    /unknown block/i.test(message) ||
    /state not available/i.test(message) ||
    /has been pruned/i.test(message)
  );
}
