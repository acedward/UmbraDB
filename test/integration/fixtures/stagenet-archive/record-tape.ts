/**
 * Records Stagenet "archive tapes" (recorded fixtures for CI, captured from live development runs):
 * for each height, exactly what `ChainArchiveSyncService` asks the two public endpoints -- the
 * node's `chain_getBlockHash` / `chain_getBlock` results and the indexer's `block(offset:{height})`
 * answer to `BLOCK_BY_HEIGHT_QUERY` (with `__typename` and the per-transaction
 * `transactionResult`). `fake-chain-server.ts` serves a tape back over real HTTP, so CI replays the
 * sync with no network.
 *
 * Polite by construction: the clients' public-host pacing (one request start per 250 ms per
 * endpoint), the sync's own bounded back-off on 429/403/5xx, bounded fetch concurrency. Refuses to
 * record from a node whose genesis is not Stagenet's.
 *
 * Modes (inside the node:24 container, from the repo root, `node --import tsx <this file> ...`):
 *
 * 1. `--heights <list> --out <file>`: one paced fetch per listed height, written as a
 *    plain tape. `--heights` takes heights and inclusive ranges, e.g. `714501,714557-714559`.
 * 2. `--capture --range <from>-<to>[:<name>] [--range ...] --pg <postgres url> --raw-out <file>`:
 *    a LIVE `--from/--to` sync of each range with the unchanged `ChainArchiveSyncService` into a
 *    fresh schema, recording every endpoint answer it reads (a recording `fetchImpl`); then the
 *    digest of each archive it wrote (`archive-digest.ts`); then the indexer's `contractEvents`
 *    (all event types, in the indexer's order) for every (transaction, called contract) pair of the
 *    recorded blocks. Writes one uncompressed raw capture (kept out of the repository).
 * 3. `--pack --raw <file> --out-dir <dir> [--cases <dir> --reference-commit <sha>]` (no network):
 *    the committed fixtures -- one compact tape per range, the contract events, the case index
 *    (when the reference cases folder is given, else the existing one is kept) and `manifest.json`
 *    with the SHA-256 and size of every file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as ledger from "@midnightntwrk/ledger-v9";
import { bootstrapChainArchiveSchema } from "../../../../chain-archive-sync/bootstrap.js";
import {
  BLOCK_BY_HEIGHT_QUERY, IndexerClient, IndexerClientError, IndexerClientParseError, type IndexerBlock,
} from "../../../../chain-archive-sync/indexer-client.js";
import { NodeRpcClient, type SubstrateBlock } from "../../../../chain-archive-sync/node-rpc-client.js";
import { parseRetryAfterMs, PUBLIC_MIN_INTERVAL_MS, RequestPacer } from "../../../../chain-archive-sync/polite-http.js";
import { abortableSleep, withRetry } from "../../../../chain-archive-sync/retry.js";
import { ChainArchiveSyncService, SyncRangeError } from "../../../../chain-archive-sync/sync-service.js";
import { createClient } from "../../../../src/postgres/client.js";
import { archiveDigest, type ArchiveDigest, canonicalJson, dumpArchive, sha256Hex } from "./archive-digest.js";
import { buildCaseIndex } from "./case-index.js";
import type { ArchiveTape, TapeBlock } from "./fake-chain-server.js";
import {
  CONTRACT_EVENTS_FORMAT, type ContractEventsFixture, type ContractEventsPair, FIXTURE_MANIFEST_FORMAT,
  type FixtureFile, type FixtureManifest, type RangeFixture, type RecordedContractEvent,
} from "./stagenet-fixtures.js";
import { compressFor, encodeTape, parseHeights, readJsonFile } from "./tape-codec.js";

export { parseHeights };

export const STAGENET_GENESIS = "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491";
export const STAGENET_NODE_URL = "https://rpc.stagenet.shielded.tools";
export const STAGENET_INDEXER_URL = "https://indexer.stagenet.shielded.tools/api/v4/graphql";
const NET = "stagenet";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.error(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
};

// ---------------------------------------------------------------------------------------------
// Mode 1: one paced fetch per height.
// ---------------------------------------------------------------------------------------------

async function recordHeights(values: { heights?: string; out?: string; node: string; indexer: string; comment: string }): Promise<void> {
  if (values.heights === undefined || values.out === undefined) {
    throw new Error("usage: record-tape.ts --heights <list> --out <file> [--node <url>] [--indexer <url>] [--comment <text>]");
  }
  const heights = parseHeights(values.heights);
  const node = new NodeRpcClient({ url: values.node, timeoutMs: 30_000, minIntervalMs: 250 });
  const indexer = new IndexerClient({ url: values.indexer, timeoutMs: 30_000, minIntervalMs: 250 });
  const retry = <T>(op: string, call: () => Promise<T>): Promise<T> =>
    withRetry(op, call, { onRetry: (i) => console.error(`retry ${op}: ${i.message} (wait ${i.delayMs} ms)`) });

  const genesis = await retry("genesis", () => node.getBlockHash(0));
  if (genesis.toLowerCase() !== STAGENET_GENESIS) {
    throw new Error(`refusing to record: genesis ${genesis} is not Stagenet's ${STAGENET_GENESIS}`);
  }
  const finalizedHash = await retry("finalized", () => node.getFinalizedHead());
  const finalizedHeight = await retry("finalized-height", () => node.getHeightOf(finalizedHash));
  if (heights.some((h) => h > finalizedHeight)) throw new Error(`a height is above the finalized head ${finalizedHeight}`);

  const blocks: unknown[] = [];
  for (const height of heights) {
    const blockHash = await retry("chain_getBlockHash", () => node.getBlockHash(height));
    const nodeBlock = await retry("chain_getBlock", () => node.getBlock(blockHash));
    const indexerBlock = await retry("indexer.block", () => indexer.getBlockByHeight(height));
    if (indexerBlock === undefined) throw new Error(`indexer has no block ${height}`);
    blocks.push({ height, blockHash, nodeBlock, indexerBlock });
    console.error(`recorded ${height} (${indexerBlock.transactions.length} tx)`);
  }

  const tape = {
    $comment:
      "Stagenet archive tape for UmbraDB (recorded fixture). Public, finalized chain data read " +
      "with test/integration/fixtures/stagenet-archive/record-tape.ts; served back by fake-chain-server.ts. " +
      values.comment,
    network: "stagenet",
    genesisHash: STAGENET_GENESIS,
    nodeUrl: values.node,
    indexerUrl: values.indexer,
    recordedOn: new Date().toISOString().slice(0, 10),
    finalizedHeightAtRecording: finalizedHeight,
    indexerQuerySha256: sha256Hex(BLOCK_BY_HEIGHT_QUERY),
    heights,
    blocks,
  };
  writeFileSync(values.out, JSON.stringify(tape, null, 1) + "\n");
  console.error(`wrote ${values.out}: ${heights.length} blocks`);
}

// ---------------------------------------------------------------------------------------------
// Mode 2: live sync with a recording fetch, archive digest, contractEvents.
// ---------------------------------------------------------------------------------------------

/** Every request the capture makes, by operation, with every non-2xx/transport outcome counted too;
 *  the 2xx JSON answers are kept for the tape. */
class Recorder {
  readonly exchanges: { endpoint: "node" | "indexer"; op: string; request: Record<string, unknown>; response: unknown }[] = [];
  readonly counts: Record<string, number> = {};

  private bump(key: string): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }

  static opOf(endpoint: "node" | "indexer", body: Record<string, unknown>): string {
    if (endpoint === "node") return String(body.method);
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    if (typeof vars.height === "number") return "indexer.block";
    if (String(body.query).includes("contractEvents")) return "indexer.contractEvents";
    return "indexer.tip";
  }

  fetchFor(endpoint: "node" | "indexer"): typeof fetch {
    return async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const op = Recorder.opOf(endpoint, body);
      this.bump(op);
      let res: Response;
      try {
        res = await fetch(input, init);
      } catch (err) {
        this.bump(`${op}:transport-error`);
        throw err;
      }
      const text = await res.text();
      if (res.ok) {
        try {
          this.exchanges.push({ endpoint, op, request: body, response: JSON.parse(text) as unknown });
        } catch {
          this.bump(`${op}:non-json`);
        }
      } else {
        this.bump(`${op}:http-${res.status}`);
      }
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  }

  snapshot(): Record<string, number> {
    return { ...this.counts };
  }
}

const diffCounts = (after: Record<string, number>, before: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.keys(after).sort().map((k): [string, number] => [k, after[k]! - (before[k] ?? 0)]).filter(([, n]) => n !== 0));

/** Requests actually sent (failed attempts included; the `op:outcome` sub-counters excluded). */
const requestTotal = (counts: Record<string, number>): number =>
  Object.entries(counts).filter(([k]) => !k.includes(":")).reduce((n, [, v]) => n + v, 0);

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

/** Rebuilds the tape of [from, to] from the answers the live sync received (a key answered twice
 *  with different content stops the capture). */
function assembleTape(rec: Recorder, from: number, to: number): TapeBlock[] {
  const one = new Map<string, unknown>();
  const put = (key: string, value: unknown): void => {
    const prev = one.get(key);
    if (prev !== undefined && canonicalJson(prev) !== canonicalJson(value)) throw new Error(`two different answers for ${key}`);
    one.set(key, value);
  };
  for (const x of rec.exchanges) {
    if (x.endpoint === "node") {
      const params = (x.request.params ?? []) as unknown[];
      const result = (x.response as { result?: unknown }).result;
      if (result === undefined || result === null) continue;
      if (x.op === "chain_getBlockHash" && typeof params[0] === "number") put(`hash:${params[0]}`, result);
      if (x.op === "chain_getBlock") put(`block:${noPrefix(String(params[0]))}`, result);
    } else if (x.op === "indexer.block") {
      const height = (x.request.variables as { height: number }).height;
      const block = (x.response as { data?: { block?: unknown } }).data?.block;
      if (block !== undefined && block !== null) put(`indexer:${height}`, block);
    }
  }
  const blocks: TapeBlock[] = [];
  for (let height = from; height <= to; height++) {
    const blockHash = one.get(`hash:${height}`) as string | undefined;
    const nodeBlock = blockHash === undefined ? undefined : one.get(`block:${noPrefix(blockHash)}`) as SubstrateBlock | undefined;
    const indexerBlock = one.get(`indexer:${height}`) as IndexerBlock | undefined;
    if (blockHash === undefined || nodeBlock === undefined || indexerBlock === undefined) {
      throw new Error(`the live sync left no complete record of height ${height}`);
    }
    blocks.push({ height, blockHash, nodeBlock, indexerBlock });
  }
  return blocks;
}

/** The query of the cross-check capture: every `ContractEvent` type with its own fields. `maxId`
 *  (the indexer's current maximum id, which changes over time) is deliberately not requested. The
 *  shielded types' nullable `amount` is aliased (`shieldedAmount`) so it never shares a response
 *  name with the unshielded types' non-null `amount`. */
export const CONTRACT_EVENTS_QUERY = `query($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    __typename id raw protocolVersion version contractAddress transactionId
    transaction { hash block { height hash } }
    ... on MiscContractEvent { name payload }
    ... on ShieldedSpendEvent { nullifier }
    ... on ShieldedReceiveEvent { commitment ciphertext receivingContractAddress }
    ... on ShieldedMintEvent { commitment domainSep shieldedAmount: amount }
    ... on ShieldedBurnEvent { nullifier shieldedAmount: amount }
    ... on UnshieldedSpendEvent { sender { kind userAddress contractAddress } domainSep tokenType amount }
    ... on UnshieldedReceiveEvent { recipient { kind userAddress contractAddress } domainSep tokenType amount }
    ... on UnshieldedMintEvent { domainSep tokenType amount }
    ... on UnshieldedBurnEvent { sender { kind userAddress contractAddress } tokenType amount }
  }
}`;

export const CONTRACT_EVENTS_PAGE = 500;

type CallPair = Omit<ContractEventsPair, "pages" | "events">;

/** (transaction, called contract) pairs of a tape, in block order, transaction order and first call
 *  order; the addresses come from the `ContractCall` actions of the decoded raw transaction. */
export function callPairsOf(tape: { blocks: readonly TapeBlock[] }): CallPair[] {
  const out: CallPair[] = [];
  for (const b of tape.blocks) {
    b.indexerBlock.transactions.forEach((t, txPosition) => {
      if (t.__typename !== "RegularTransaction") return;
      const tx = ledger.Transaction.deserialize("signature", "proof", "binding", Buffer.from(noPrefix(t.raw), "hex")) as unknown as {
        intents?: Map<number, { actions: unknown[] }>;
      };
      const calls = new Map<string, number>();
      for (const [, intent] of [...(tx.intents ?? new Map<number, { actions: unknown[] }>())].sort(([a], [z]) => a - z)) {
        for (const action of intent.actions) {
          if (!(action instanceof ledger.ContractCall)) continue;
          const address = noPrefix(String(action.address));
          calls.set(address, (calls.get(address) ?? 0) + 1);
        }
      }
      for (const [contractAddress, callActions] of calls) {
        out.push({ height: b.height, blockHash: noPrefix(b.blockHash), txHash: noPrefix(t.hash), txPosition, contractAddress, callActions });
      }
    });
  }
  return out;
}

async function captureContractEvents(rec: Recorder, indexerUrl: string, pairs: CallPair[]): Promise<ContractEventsPair[]> {
  const fetchImpl = rec.fetchFor("indexer");
  const pacer = new RequestPacer(PUBLIC_MIN_INTERVAL_MS);
  const page = async (filter: Record<string, unknown>, offset: number): Promise<RecordedContractEvent[]> => {
    await pacer.wait();
    let res: Response;
    try {
      res = await fetchImpl(indexerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: CONTRACT_EVENTS_QUERY, variables: { filter, limit: CONTRACT_EVENTS_PAGE, offset } }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new IndexerClientError("contractEvents request failed", err);
    }
    if (!res.ok) {
      throw new IndexerClientError(`contractEvents HTTP ${res.status}`, undefined, res.status, parseRetryAfterMs(res.headers.get("retry-after")));
    }
    let body: { data?: { contractEvents?: RecordedContractEvent[] }; errors?: { message: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new IndexerClientParseError("contractEvents response was not JSON", "indexer", err);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new IndexerClientError(`contractEvents GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    const events = body.data?.contractEvents;
    if (!Array.isArray(events)) throw new IndexerClientError("contractEvents answered without a list");
    return events;
  };

  const out: ContractEventsPair[] = [];
  for (const p of pairs) {
    const filter = { contractAddress: p.contractAddress, transactionHash: p.txHash };
    const events: RecordedContractEvent[] = [];
    let pages = 0;
    // Stop only on an EMPTY page, so a server that silently returns fewer rows than asked can never truncate.
    for (let offset = 0; ;) {
      const got = await withRetry("indexer.contractEvents", () => page(filter, offset), {
        onRetry: (i) => log("retry", { op: i.operation, status: i.httpStatus, delayMs: i.delayMs, message: i.message }),
      });
      pages++;
      if (got.length > CONTRACT_EVENTS_PAGE) throw new Error(`page larger than ${CONTRACT_EVENTS_PAGE}`);
      if (got.length === 0) break;
      for (const e of got) {
        const prev = events[events.length - 1];
        if (prev !== undefined && e.id <= prev.id) throw new Error(`event ids not increasing for ${p.txHash}`);
        if (noPrefix(e.transaction.hash) !== p.txHash || noPrefix(e.contractAddress) !== p.contractAddress) {
          throw new Error(`event ${e.id} is not of ${p.txHash}/${p.contractAddress}`);
        }
        if (e.transaction.block.height !== p.height || noPrefix(e.transaction.block.hash) !== p.blockHash) {
          throw new Error(`event ${e.id} is not in block ${p.height}`);
        }
        events.push(e);
      }
      offset += got.length;
    }
    out.push({ ...p, pages, events });
    log("contract-events", { height: p.height, tx: p.txHash.slice(0, 12), contract: p.contractAddress.slice(0, 12), events: events.length });
  }
  return out;
}

interface RawCaptureRange {
  name: string;
  from: number;
  to: number;
  tape: ArchiveTape & Record<string, unknown>;
  liveSync: RangeFixture["liveSync"];
  requests: Record<string, number>;
}

interface RawCapture {
  format: "umbradb-stagenet-raw-capture/1";
  recordedAt: string;
  genesisHash: string;
  nodeUrl: string;
  indexerUrl: string;
  finalizedHeightAtRecording: number;
  indexerTipAtRecording: number;
  ledgerV9: string;
  ranges: RawCaptureRange[];
  contractEvents: { query: string; pageSize: number; pairs: ContractEventsPair[]; requests: Record<string, number> };
  requests: Record<string, number>;
}

async function capture(values: { range?: string[]; pg?: string; "raw-out"?: string; node: string; indexer: string; concurrency: string }): Promise<void> {
  const ranges = (values.range ?? []).map((spec, i) => {
    const m = /^(\d+)-(\d+)(?::(\w+))?$/.exec(spec);
    if (m === null) throw new Error(`--range must be <from>-<to>[:<name>], got ${spec}`);
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (to < from || to - from > 5_000) throw new Error(`bad or too large range ${spec}`);
    return { from, to, name: m[3] ?? `r${i}` };
  });
  if (ranges.length === 0 || values.pg === undefined || values["raw-out"] === undefined) {
    throw new Error("usage: record-tape.ts --capture --range <from>-<to>[:<name>] [...] --pg <url> --raw-out <file>");
  }
  const concurrency = Number(values.concurrency);
  const rec = new Recorder();
  const node = new NodeRpcClient({ url: values.node, timeoutMs: 30_000, fetchImpl: rec.fetchFor("node") });
  const indexer = new IndexerClient({ url: values.indexer, timeoutMs: 30_000, fetchImpl: rec.fetchFor("indexer") });
  const retry = <T>(op: string, call: () => Promise<T>): Promise<T> =>
    withRetry(op, call, { onRetry: (i) => log("retry", { op, status: i.httpStatus, delayMs: i.delayMs, message: i.message }) });

  const genesisHash = (await retry("genesis", () => node.getBlockHash(0))).toLowerCase();
  if (genesisHash !== STAGENET_GENESIS) throw new Error(`refusing to record: genesis ${genesisHash} is not Stagenet's`);
  const finalizedHeight = await retry("finalized-height", async () => node.getHeightOf(await node.getFinalizedHead()));
  const indexerTip = await retry("indexer-tip", () => indexer.getTipHeight());
  log("capture-start", { genesisHash, finalizedHeight, indexerTip, ranges, concurrency });
  if (ranges.some((r) => r.to > Math.min(finalizedHeight, indexerTip))) throw new Error("a range ends above the finalized tip");

  const out: RawCaptureRange[] = [];
  for (const r of ranges) {
    const schema = `stagenet_capture_${r.from}_${r.to}`;
    const sql = createClient({ connectionString: values.pg, schema });
    try {
      await bootstrapChainArchiveSchema(sql, schema);
      const before = rec.snapshot();
      const svc = new ChainArchiveSyncService({
        sql, net: NET, schema,
        node: { url: values.node, timeoutMs: 30_000, fetchImpl: rec.fetchFor("node") },
        indexer: { url: values.indexer, timeoutMs: 30_000, fetchImpl: rec.fetchFor("indexer") },
        startHeight: r.from, endHeight: r.to, concurrency,
        backoff: { onRetry: (i) => log("retry", { op: i.operation, status: i.httpStatus, delayMs: i.delayMs, message: i.message }) },
      });
      if ((await svc.getSyncCursor()) !== undefined) throw new Error(`schema ${schema} is not fresh`);
      const started = Date.now();
      let batches = 0;
      let retries = 0;
      let throttled = 0;
      let loopBackoffMs = 1_000;
      for (;;) {
        try {
          const res = await svc.syncOnce({ maxBlocks: 100 });
          batches++;
          retries += res.retries;
          throttled += res.throttled;
          log("batch", { range: r.name, from: res.fromHeight, to: res.toHeight, ingested: res.ingestedBlocks, retries: res.retries, throttled: res.throttled, ms: res.elapsedMs });
          loopBackoffMs = 1_000;
          if (res.reachedEnd) break;
          if (res.ingestedBlocks === 0) await abortableSleep(10_000);
        } catch (err) {
          if (err instanceof SyncRangeError) throw err;
          log("batch-error", { range: r.name, message: err instanceof Error ? err.message : String(err), waitMs: loopBackoffMs });
          await abortableSleep(loopBackoffMs);
          loopBackoffMs = Math.min(loopBackoffMs * 2, 60_000);
        }
      }
      const elapsedMs = Date.now() - started;
      const digest: ArchiveDigest = archiveDigest(await dumpArchive(sql, schema));
      const blocks = assembleTape(rec, r.from, r.to);
      const tape = {
        $comment:
          `Stagenet archive tape for UmbraDB (recorded fixture): every answer a live ` +
          `polite sync of ${r.from}-${r.to} read from the public node and indexer (record-tape.ts --capture).`,
        network: NET,
        genesisHash: STAGENET_GENESIS,
        nodeUrl: values.node,
        indexerUrl: values.indexer,
        recordedOn: new Date().toISOString().slice(0, 10),
        finalizedHeightAtRecording: finalizedHeight,
        indexerQuerySha256: sha256Hex(BLOCK_BY_HEIGHT_QUERY),
        heights: blocks.map((b) => b.height),
        blocks,
      };
      out.push({
        ...r, tape,
        liveSync: {
          net: NET, schema, concurrency: svc.fetchConcurrency, minIntervalMs: svc.minIntervalMs,
          batches, elapsedMs, retries, throttled, archiveDigest: digest,
        },
        requests: diffCounts(rec.snapshot(), before),
      });
      log("range-done", { range: r.name, blocks: blocks.length, elapsedMs, digest: digest.sha256, tables: digest.tables });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const beforeEvents = rec.snapshot();
  const pairs = out.flatMap((r) => callPairsOf(r.tape));
  log("contract-events-start", { pairs: pairs.length });
  const events = await captureContractEvents(rec, values.indexer, pairs);
  const raw: RawCapture = {
    format: "umbradb-stagenet-raw-capture/1",
    recordedAt: new Date().toISOString(),
    genesisHash,
    nodeUrl: values.node,
    indexerUrl: values.indexer,
    finalizedHeightAtRecording: finalizedHeight,
    indexerTipAtRecording: indexerTip,
    ledgerV9: (JSON.parse(readFileSync("node_modules/@midnightntwrk/ledger-v9/package.json", "utf8")) as { version: string }).version,
    ranges: out,
    contractEvents: { query: CONTRACT_EVENTS_QUERY, pageSize: CONTRACT_EVENTS_PAGE, pairs: events, requests: diffCounts(rec.snapshot(), beforeEvents) },
    requests: rec.snapshot(),
  };
  writeFileSync(values["raw-out"], JSON.stringify(raw) + "\n");
  log("capture-done", { out: values["raw-out"], requests: raw.requests, total: requestTotal(raw.requests) });
}

// ---------------------------------------------------------------------------------------------
// Mode 3: pack the committed fixtures (no network).
// ---------------------------------------------------------------------------------------------

/** Target for all fixture files together ("< 1 MB"). */
export const SIZE_TARGET_BYTES = 1_000_000;

/** Named slices of the recorded ranges (`loadTape` serves them by name). */
const ALIASES: FixtureManifest["aliases"] = {
  "c04-714637-714663.tape.json": {
    heights: "714637-714663",
    comment: "Case C04 of midnight-experiments/mip-0018 (deploy 714637, shielded mint 714643, unshielded mint 714649, mintLedger 714655, publish 714663), every block of the range.",
  },
  "cases-sparse.tape.json": {
    heights: "714501,714557,714617,714683,714689,714802,714813,714891,715109,715177,715183,715409,715428,715433",
    comment: "One block per reference Stagenet case transaction kind: C01 publish 714501, C02 shielded mint 714557, C03 unshielded mint 714617, C05 mints 714683/714689, IDX third-party shielded mint 714802, C06 withdraw 714813, C07 raw emitter 714891, C08 two events 715109, C10 publish 715177 and VerifierKeyRemove 715183, U1 mint 715409, VerifierKeyInsert 715428, upgraded call 715433.",
  },
};

function pack(values: { raw?: string; "out-dir"?: string; cases?: string; "reference-commit"?: string; compress: string; "events-compress": string }): void {
  if (values.raw === undefined || values["out-dir"] === undefined) {
    throw new Error("usage: record-tape.ts --pack --raw <file> --out-dir <dir> [--cases <dir> --reference-commit <sha>]");
  }
  const dir = values["out-dir"];
  const raw = readJsonFile<RawCapture>(values.raw);
  const ext = values.compress === "none" ? "" : `.${values.compress}`;
  const eventsExt = values["events-compress"] === "none" ? "" : `.${values["events-compress"]}`;
  const files: FixtureFile[] = [];
  const write = (name: string, text: string, role: FixtureFile["role"]): void => {
    const data = compressFor(name, text);
    writeFileSync(join(dir, name), data);
    files.push({ path: name, bytes: data.length, sha256: sha256Hex(data), role });
  };

  const ranges: RangeFixture[] = [];
  for (const r of raw.ranges) {
    const file = `stagenet-${r.from}-${r.to}.tape.json${ext}`;
    write(file, JSON.stringify(encodeTape(r.tape)) + "\n", "tape");
    const results: Record<string, number> = {};
    for (const b of r.tape.blocks) {
      for (const t of b.indexerBlock.transactions) {
        const k = t.transactionResult?.status ?? `none:${t.__typename ?? "?"}`;
        results[k] = (results[k] ?? 0) + 1;
      }
    }
    ranges.push({
      name: r.name, from: r.from, to: r.to, file,
      blocks: r.tape.blocks.length,
      transactions: r.tape.blocks.reduce((n, b) => n + b.indexerBlock.transactions.length, 0),
      results,
      callPairs: raw.contractEvents.pairs.filter((p) => p.height >= r.from && p.height <= r.to).length,
      liveSync: r.liveSync,
      requests: r.requests,
    });
  }

  const eventsFile = `stagenet-contract-events.json${eventsExt}`;
  const eventsFixture: ContractEventsFixture = {
    format: CONTRACT_EVENTS_FORMAT,
    $comment:
      "The Stagenet indexer's contractEvents (all event types, in the indexer's order) for every (transaction, called " +
      "contract) pair of the recorded ranges -- the test-only cross-check of UmbraDB's raw-transaction event decoding. " +
      "Captured by record-tape.ts --capture right after the live sync; read-only public data.",
    indexerUrl: raw.indexerUrl,
    recordedAt: raw.recordedAt,
    query: raw.contractEvents.query,
    querySha256: sha256Hex(raw.contractEvents.query),
    pageSize: raw.contractEvents.pageSize,
    pairs: raw.contractEvents.pairs,
  };
  write(eventsFile, JSON.stringify(eventsFixture, null, 1) + "\n", "contract-events");

  const caseIndexFile = "case-index.json";
  if (values.cases !== undefined) {
    if (values["reference-commit"] === undefined) throw new Error("--cases needs --reference-commit <full sha>");
    const index = buildCaseIndex({
      casesDir: values.cases,
      repository: "https://github.com/midnight-experiments/mip-0018",
      commit: values["reference-commit"],
      casesPath: "deployments/stagenet/cases",
      ranges: raw.ranges.map((r) => ({ name: r.name, from: r.from, to: r.to, tape: r.tape })),
      callPairs: raw.contractEvents.pairs,
    });
    write(caseIndexFile, JSON.stringify(index, null, 1) + "\n", "case-index");
  } else {
    if (!existsSync(join(dir, caseIndexFile))) throw new Error("no --cases and no existing case-index.json");
    const data = readFileSync(join(dir, caseIndexFile));
    files.push({ path: caseIndexFile, bytes: data.length, sha256: sha256Hex(data), role: "case-index" });
  }

  const byType: Record<string, number> = {};
  for (const p of raw.contractEvents.pairs) for (const e of p.events) byType[e.__typename] = (byType[e.__typename] ?? 0) + 1;
  const manifest: FixtureManifest = {
    format: FIXTURE_MANIFEST_FORMAT,
    $comment:
      "Recorded Stagenet fixtures of UmbraDB. Public, finalized, " +
      "read-only chain data captured once by a live polite sync (record-tape.ts --capture) and packed by record-tape.ts " +
      "--pack. CI replays the tapes through the unchanged chain-archive-sync and must reproduce each range's live archive " +
      "digest (test/integration/stagenet-fixtures*.test.ts).",
    network: "stagenet",
    genesisHash: raw.genesisHash,
    nodeUrl: raw.nodeUrl,
    indexerUrl: raw.indexerUrl,
    recordedAt: raw.recordedAt,
    finalizedHeightAtRecording: raw.finalizedHeightAtRecording,
    indexerTipAtRecording: raw.indexerTipAtRecording,
    recorder: "test/integration/fixtures/stagenet-archive/record-tape.ts",
    ledgerV9: raw.ledgerV9,
    queries: { indexerBlockSha256: sha256Hex(BLOCK_BY_HEIGHT_QUERY), contractEventsSha256: sha256Hex(raw.contractEvents.query) },
    ranges,
    contractEvents: {
      file: eventsFile,
      pairs: raw.contractEvents.pairs.length,
      events: raw.contractEvents.pairs.reduce((n, p) => n + p.events.length, 0),
      byType,
      requests: requestTotal(raw.contractEvents.requests),
    },
    caseIndex: { file: caseIndexFile },
    aliases: ALIASES,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    sizeTargetBytes: SIZE_TARGET_BYTES,
    totalRequests: requestTotal(raw.requests),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  log("pack-done", { files, totalBytes: manifest.totalBytes, target: SIZE_TARGET_BYTES });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      heights: { type: "string" },
      out: { type: "string" },
      node: { type: "string", default: STAGENET_NODE_URL },
      indexer: { type: "string", default: STAGENET_INDEXER_URL },
      comment: { type: "string", default: "" },
      capture: { type: "boolean", default: false },
      range: { type: "string", multiple: true },
      pg: { type: "string" },
      "raw-out": { type: "string" },
      concurrency: { type: "string", default: "4" },
      pack: { type: "boolean", default: false },
      raw: { type: "string" },
      "out-dir": { type: "string" },
      cases: { type: "string" },
      "reference-commit": { type: "string" },
      compress: { type: "string", default: "gz" },
      "events-compress": { type: "string", default: "gz" },
    },
    strict: true,
  });
  if (values.capture) await capture(values);
  else if (values.pack) pack(values);
  else await recordHeights(values);
}

if (process.argv[1]?.endsWith("record-tape.ts")) {
  await main();
}
