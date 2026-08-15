/**
 * Minimal Substrate JSON-RPC client for a Midnight node -- plain `fetch`, no SDK dependency
 * (`@midnightntwrk/*` is not imported anywhere in this file or this directory). Grounded against
 * the real local devnet node (`http://localhost:9944`, `midnightntwrk/midnight-node`) during this
 * implementation session -- `rpc_methods` confirmed `chain_getHeader`/`chain_getBlockHash`/
 * `chain_getBlock`/`chain_getFinalizedHead` are all live; `chain_getHeader`'s shape matches the
 * standard Substrate `generic::Header<BlockNumber,BlakeTwo256>` the design doc's §3.1 predicted
 * (`parentHash`, `number`, `stateRoot`, `extrinsicsRoot`, `digest.logs[]`); `chain_getBlock`
 * additionally returns `block.extrinsics: string[]` (0x-hex-encoded raw SCALE bytes per
 * extrinsic) and `block.header`.
 *
 * **Lives entirely outside `src/`** (AC-7) -- this is real, non-test production code that talks
 * directly to a node's RPC endpoint; `test/postgres/no-chain-sync-import-guard.test.ts` is the
 * automated guard confirming nothing under `src/` ever imports this module or references its
 * endpoint-talking behavior.
 */

export interface SubstrateHeader {
  parentHash: string;
  number: string; // 0x-hex compact block number
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] };
}

export interface SubstrateBlock {
  block: {
    header: SubstrateHeader;
    extrinsics: string[];
  };
  justifications: unknown;
}

export class NodeRpcError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NodeRpcError";
  }
}

/** Fix 3 (sprint-fix round, MEDIUM): a typed error for the specific "HTTP 200 but the body isn't
 *  valid JSON" case (e.g. a proxy/load-balancer's HTML error page returned with a 2xx status) --
 *  raised instead of letting `res.json()`'s bare, context-free `SyntaxError` propagate, which
 *  gave no indication of which request/URL/method failed. */
export class NodeRpcParseError extends Error {
  constructor(message: string, readonly url: string, readonly method: string, readonly cause?: unknown) {
    super(message);
    this.name = "NodeRpcParseError";
  }
}

/** Fix 3: raised by `getHeightOf` when the node's `header.number` field is missing or does not
 *  decode to a safe integer -- previously `parseInt(header.number, 16)` silently produced `NaN`
 *  in that case, which then made `syncOnce`'s loop-bounds check (`startHeight > NaN` is always
 *  `false`) silently no-op the entire sync attempt while still reporting success. */
export class NodeRpcInvalidHeightError extends Error {
  constructor(message: string, readonly blockHash: string | undefined, readonly rawNumber: unknown) {
    super(message);
    this.name = "NodeRpcInvalidHeightError";
  }
}

export interface NodeRpcClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds -- a hung/black-holed node otherwise stalls the entire
   *  sync service indefinitely with no way to recover (Fix 3). Default: 20_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

let nextId = 1;

/** Real, minimal Substrate JSON-RPC client -- one HTTP POST per call, no batching/subscriptions
 *  (a polling ingestion loop, §"reasonable ongoing-sync design," does not need either). */
export class NodeRpcClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: NodeRpcClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NodeRpcError(`${method}: request to ${this.url} failed`, err);
    }
    if (!res.ok) {
      throw new NodeRpcError(`${method}: HTTP ${res.status} from ${this.url}`);
    }
    let body: { result?: T; error?: { code: number; message: string } };
    try {
      body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    } catch (err) {
      throw new NodeRpcParseError(
        `${method}: response body from ${this.url} was not valid JSON`, this.url, method, err,
      );
    }
    if (body.error !== undefined) {
      throw new NodeRpcError(`${method}: RPC error ${body.error.code}: ${body.error.message}`);
    }
    // A JSON-RPC response carries `result` OR `error`. One with neither is malformed, and this
    // used to return `undefined` cast to `T` -- so a caller expecting a header, a block or a hex
    // payload received `undefined` with no error, and the failure surfaced far away as a property
    // read on undefined, or not at all (audit T7).
    //
    // `in` rather than a truthiness or `!== undefined` check, deliberately: `result: null` is a
    // LEGITIMATE answer for several of these calls -- `chain_getBlockHash` for a height the node
    // does not have, `state_getStorageAt` for an empty key -- and callers handle it. What is not
    // legitimate is the key being absent altogether.
    if (!("result" in body)) {
      throw new NodeRpcError(
        `${method}: malformed JSON-RPC response from ${this.url} -- it carried neither "result" ` +
          "nor \"error\". Treating this as a successful empty answer would hand the caller " +
          "undefined in place of data it requires.",
      );
    }
    return body.result as T;
  }

  /** `null` params ⇒ current best (not-necessarily-finalized) head's hash. */
  async getBlockHash(height?: number): Promise<string> {
    return this.call<string>("chain_getBlockHash", height === undefined ? [] : [height]);
  }

  async getHeader(blockHash?: string): Promise<SubstrateHeader> {
    return this.call<SubstrateHeader>("chain_getHeader", blockHash === undefined ? [] : [blockHash]);
  }

  async getBlock(blockHash?: string): Promise<SubstrateBlock> {
    return this.call<SubstrateBlock>("chain_getBlock", blockHash === undefined ? [] : [blockHash]);
  }

  async getFinalizedHead(): Promise<string> {
    return this.call<string>("chain_getFinalizedHead", []);
  }

  /**
   * Midnight's committed post-block ledger root at one historical block.
   *
   * This is the custom pallet RPC (`midnight_ledgerStateRoot`), not the Substrate header's
   * `stateRoot`. Node 1.0 returns the untagged serialized typed arena key as a JSON byte array.
   * Refuse malformed values here so replay cannot compare coerced/truncated data and call that a
   * state-root check.
   */
  async ledgerStateRoot(at: string): Promise<Uint8Array> {
    const value = await this.call<unknown>("midnight_ledgerStateRoot", [at]);
    if (
      !Array.isArray(value) || value.length === 0 ||
      value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new NodeRpcError(
        `midnight_ledgerStateRoot at ${at} returned ${JSON.stringify(value)} instead of a ` +
          "non-empty serialized typed arena key. Replay cannot verify the chain commitment without the " +
          "exact root, so this block is refused.",
      );
    }
    return Uint8Array.from(value as number[]);
  }

  /**
   * Ledger state embedded in the chain specification and installed directly at genesis.
   *
   * Midnight's custom genesis block builder puts `genesis_extrinsics` in block 0 without
   * executing them. The actual ledger state is the serialized snapshot in
   * `system_properties.genesis_state`, which is also what the node toolkit's historical fetcher
   * returns for block 0. Reconstructing it from the block body therefore double-applies data that
   * the runtime never executed.
   */
  async genesisLedgerState(): Promise<Uint8Array> {
    const properties = await this.call<unknown>("system_properties", []);
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new NodeRpcError(
        "system_properties returned no object; replay cannot initialize the authoritative " +
          "Midnight genesis ledger state",
      );
    }
    const raw = (properties as Record<string, unknown>).genesis_state;
    if (typeof raw !== "string") {
      throw new NodeRpcError(
        "system_properties.genesis_state is missing or is not a string; replay cannot " +
          "reconstruct the ledger state installed by the genesis builder",
      );
    }
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new NodeRpcError(
        "system_properties.genesis_state is not non-empty, even-length hexadecimal; replay " +
          "refuses to guess the genesis ledger state",
      );
    }
    return new Uint8Array(Buffer.from(hex, "hex"));
  }

  /** Runtime ledger network id at a historical block, decoded from SCALE `String`. */
  async ledgerNetworkId(at: string): Promise<string> {
    const encoded = await this.stateCall("MidnightRuntimeApi_get_network_id", "0x", at);
    if (typeof encoded !== "string" || !/^0x[0-9a-fA-F]+$/.test(encoded)) {
      throw new NodeRpcError(
        `MidnightRuntimeApi_get_network_id at ${at} returned malformed SCALE bytes`,
      );
    }
    const bytes = Buffer.from(encoded.slice(2), "hex");
    if (bytes.length === 0) {
      throw new NodeRpcError(`MidnightRuntimeApi_get_network_id at ${at} returned an empty value`);
    }
    const mode = bytes[0]! & 0b11;
    let prefixBytes: number;
    let length: number;
    if (mode === 0) {
      prefixBytes = 1;
      length = bytes[0]! >>> 2;
    } else if (mode === 1 && bytes.length >= 2) {
      prefixBytes = 2;
      length = (bytes.readUInt16LE(0) >>> 2);
    } else {
      throw new NodeRpcError(
        `MidnightRuntimeApi_get_network_id at ${at} used an invalid SCALE string length prefix`,
      );
    }
    if (length === 0 || length > 64 || bytes.length !== prefixBytes + length) {
      throw new NodeRpcError(
        `MidnightRuntimeApi_get_network_id at ${at} returned an invalid ${length}-byte SCALE string`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(prefixBytes));
    } catch (cause) {
      throw new NodeRpcError(
        `MidnightRuntimeApi_get_network_id at ${at} was not valid UTF-8`, cause,
      );
    }
  }

  /**
   * Raw value of a storage key at a block, or `undefined` when the key is unset.
   *
   * Used to read `System::Events`, which is where the runtime records what it DID -- including
   * system transactions it generated rather than received as extrinsics. Those never appear in
   * `chain_getBlock.extrinsics` at all.
   */
  async storageAt(keyHex: string, at: string): Promise<string | undefined> {
    const value = await this.call<string | null>("state_getStorageAt", [keyHex, at]);
    return value ?? undefined;
  }

  /**
   * Substrate `state_call`: invoke a runtime API at a block. `method` is the
   * `TraitName_method_name` string (e.g. `SystemParametersApi_get_d_parameter`), `dataHex` the
   * 0x-hex SCALE-encoded arguments (`0x` for no-arg calls); returns 0x-hex SCALE-encoded result
   * bytes. Node-only replacement for data the indexer used to compute from its own runtime-API
   * calls (`midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`).
   */
  async stateCall(method: string, dataHex: string, at?: string): Promise<string> {
    const params: unknown[] = at === undefined ? [method, dataHex] : [method, dataHex, at];
    return this.call<string>("state_call", params);
  }

  /**
   * SCALE-encoded runtime metadata AT a block.
   *
   * The `at` parameter is what makes block-scoped decoding possible: metadata must describe the
   * runtime that produced the block being decoded, not the chain tip. Resolving at the tip means a
   * block from before a runtime upgrade is decoded against the wrong pallet indices, and the
   * failure is SILENT -- genuine transactions are simply classified as something else.
   *
   * Pruning is reported as a JSON-RPC error and classified by the caller. A successful response
   * with `result: null` is not pruning evidence and is refused here; returning `undefined` would
   * let it silently enter the committed-registry fallback.
   */
  async metadataAt(at: string): Promise<string> {
    const value = await this.call<unknown>("state_getMetadata", [at]);
    if (typeof value !== "string") {
      throw new Error(
        `state_getMetadata at ${at} returned ${value === null ? "null" : typeof value} instead ` +
          "of SCALE metadata. A missing historical response is not proof of pruning, so registry " +
          "fallback is refused.",
      );
    }
    return value;
  }

  /**
   * The runtime's own identity at a block: `specName` and `specVersion`.
   *
   * This is the cache key for metadata. `specVersion` is exactly what a runtime upgrade bumps, so
   * keying on it means the metadata cache invalidates precisely at upgrade boundaries -- whereas
   * keying on anything coarser (protocol-version range, node version) would serve one runtime's
   * layout for another runtime's blocks.
   */
  async runtimeVersionAt(at: string): Promise<{ specName: string; specVersion: number }> {
    const v = await this.call<{ specName: string; specVersion: number }>(
      "state_getRuntimeVersion", [at],
    );
    if (typeof v?.specName !== "string" || typeof v?.specVersion !== "number") {
      throw new Error(
        `state_getRuntimeVersion at ${at} returned no usable specName/specVersion. Without the ` +
          "runtime's identity, metadata cannot be cached safely across a runtime upgrade.",
      );
    }
    return { specName: v.specName, specVersion: v.specVersion };
  }

  /** Convenience: resolves a hash to its height via `getHeader` -- the RPC surface has no
   *  direct "height of this hash" call, so this is the standard two-hop lookup.
   *
   *  Fix 3 (sprint-fix round, MEDIUM): explicitly validates the decoded height is a safe integer
   *  before returning it -- a malformed/missing `header.number` previously produced a silent
   *  `NaN` here, which made `syncOnce`'s own `startHeight > targetTipHeight` bounds check
   *  (`startHeight > NaN` is always `false`) silently skip the entire sync attempt while
   *  `syncOnce` still returned a normal-looking success result. */
  async getHeightOf(blockHash: string): Promise<number> {
    const header = await this.getHeader(blockHash);
    const height = parseInt(header.number, 16);
    if (!Number.isSafeInteger(height)) {
      throw new NodeRpcInvalidHeightError(
        `chain_getHeader returned a malformed/missing "number" field for blockHash=${blockHash}: ` +
        `${JSON.stringify(header.number)} did not decode to a safe integer`,
        blockHash, header.number,
      );
    }
    return height;
  }
}
