/**
 * The browser engine's JSON RPC module (`../browser/jsonrpc-module.ts`) in Node, on the production PGlite client and
 * the recorded indexer (`evm-rpc/test/recorded-indexer.ts`).
 *
 * - `[[browser.jsonrpc.module]]` — the module's `evm_rpc` database is a new in-memory PGlite made by the module's
 *   migrations (every table of the lineage, the three migrations recorded); it serves the read-only registry's
 *   methods; every `POST` case of the differential (every method, refused parameters, the not-implemented and unknown
 *   methods, the envelope, notifications, batches, bodies that are not JSON, the size cap) gets exactly Node's HTTP
 *   answer as recorded (`evm-rpc/test/fixtures/node-answers.json`) and as `npm run evm-rpc`'s server answers now (status,
 *   headers in order, body bytes); once closed it refuses requests and its database is closed.
 * - `[[browser.jsonrpc.module-rows]]` — rows written to the module's database (plain `Uint8Array` byte values, as the
 *   browser's PGlite reads them) are what the account and transaction methods answer.
 * - `[[browser.jsonrpc.paced]]` — the module's requests to a public indexer start at least 250 ms apart, and those to
 *   any other indexer are not delayed.
 * - `[[browser.jsonrpc.pacing-queue]]` — the module's pacing queue, on a test clock: callers admitted one at a time in
 *   arrival order, the interval apart; a burst beyond its bound refused at once; a cancelled wait gives up its place
 *   and the next caller moves up; closing it ends every wait.
 * - `[[browser.pacing.hold]]` — the pacing queue on a test clock: a hold lasts at most 60 s whatever an endpoint asks;
 *   a wait its caller cancels during a hold (the archive sync's `Pacer.wait` with its run's signal) leaves at once and
 *   never starts; the other callers start when the hold ends; an already-ended signal is refused at once; the last
 *   waiter cancelled leaves no timer behind.
 * - `[[browser.jsonrpc.burst]]` — a burst of requests whose indexer calls wait far longer than the indexer timeout for
 *   their pacing slots (8 batches of 8 at 30 ms apart, against a 200 ms timeout): every answer is Node's, every indexer
 *   request starts with a live timeout, the starts the interval apart; a request beyond the module's 8 in flight is
 *   refused `busy` at once, and accepted again once one is answered.
 * - `[[browser.jsonrpc.stop-cancels]]` — closing the module while its requests wait for pacing slots ends them at once
 *   (refused `stopped`, their indexer calls never made) and closes its database without waiting for their slots.
 * - `[[browser.jsonrpc.slots-bodies]]` — an indexer request of the module keeps its slot until its answer's body is
 *   read: 8 batches of 8 calls whose answers' bodies come slowly have at most 8 bodies open at once, and every call is
 *   answered as Node answers it; a body never read (the module closed) gives its slot back.
 * - `[[browser.jsonrpc.model]]` — the tab's rows are the registry's methods, each once (served ones with their source,
 *   summary, parameter kinds and example, not-implemented ones with their classification), and the Node-only methods,
 *   marked and not callable, grouped by where their answer comes from in this browser (indexer, configuration and
 *   constants, the database that is empty here, not implemented, Node only) and sorted by name in each group; a call's
 *   request is a JSON-RPC 2.0 request with the edited parameters (none when empty, refused when not JSON or too long);
 *   an answer is shown with its status and its body indented (as it is when not JSON).
 * - `[[browser.jsonrpc.explorer-model]]` — the explorer's form: every served method's example put in its typed fields
 *   gives back the example, and the request is the example's; each kind of field checks what it holds and says what is
 *   wrong (a number in decimal or hex becomes a canonical quantity; a block is a tag, a number, a hash or left out; an
 *   optional field is left out only after the last one given); the search keeps the methods holding every word; the
 *   `curl` command, run by a POSIX shell, sends exactly the request (quotes, `$(…)`, backticks and line breaks in it
 *   included); the answer tree of Node's answers shows quantities in decimal, and its block numbers, block hashes and
 *   transaction hashes open the calls that read them (and nothing else does, the all-zero hash of the genesis block's
 *   parent among them), bounded in nodes; the URL's view and
 *   method keep the shell's tab and the explorer's fragment; the history keeps the newest calls, at most 50, and what
 *   is read back from storage is checked.
 * - `[[browser.jsonrpc.status-model]]` — the status view's figures and the strip, each from its field of the engine's
 *   `jsonrpc-state` answer.
 * - `[[browser.jsonrpc.model-bounds]]` — parameters the tab cannot send or show are refused with a message, never an
 *   exception: nesting deeper than the bound (also deep enough to break serialization), and parameters whose indented
 *   text would be too long to show; an answer too long to show is shown cut, with its length. One check of the
 *   parameters (their JSON's length and depth) comes before any conversion between the JSON text and the form and
 *   before any request: a form holding parameters longer than the JSON text may be is refused, and parameters nested
 *   too deep never reach the form (putting them in it never throws). Every text shown is bounded: the request, its
 *   `curl` line, the answer's text and each string of its tree (and all of them together).
 * - `[[browser.host.jsonrpc]]` — the worker host answers `jsonrpc` with Node's answers while the module is on (by
 *   default), making the module's database at the first request; `module` `jsonrpc` off is saved first, then requests
 *   are refused `module-off` and the module's database is closed; on again, a new one answers; the token indexer's
 *   switch is its own; a switch the browser refuses to save changes nothing (`settings-failed`, still answered); a
 *   module that fails to start answers `internal` and the next request starts it again; requests without a string body
 *   or over the bound are `bad-request`, and reading a request never throws.
 * - `[[browser.host.jsonrpc-bounded]]` — the worker host refuses a `jsonrpc` request beyond the module's bound `busy` (85
 *   at once: 8 answered as Node does, the rest refused, none answered with an error of the module's own), and requests
 *   waiting for pacing slots when the module is switched off are answered `module-off` at once.
 * - `[[browser.host.jsonrpc-state]]` — the worker host's `jsonrpc-state`: the switch, the database (none before the first
 *   call, open after it), the methods' counts (the registry's and the Node-only list's), the chain ID, client version
 *   and indexer the worker was given, the calls answered, in flight, refused busy, refused off and failed (each counted
 *   as it happens), the indexer origin's pacing queue (its interval, the requests waiting, a Retry-After hold), and the
 *   last error (a failed start, an indexer that answers an HTTP error, kept when the module stops); while the store is
 *   replaced (a `range`), it is answered as a call is, once the new store is in place, never `boot-failed`.
 * - `[[browser.host.stop-during-hold]]` — a `Retry-After` hold on the indexer's origin (a `429` to the module; 600 s
 *   asked, 60 s held) while the engine's sync waits there for its turn: the stop is answered at once, the sync's wait
 *   leaves the queue, and its request is never made, also after the hold; the module's switch and the worker's close
 *   are answered at once too.
 * - `[[browser.host.stop-during-burst]]` — a burst of JSON-RPC calls (8 batches of 8 indexer-backed calls) puts at most
 *   8 of the module's indexer requests in the origin's queue beside the sync's; a stop then is prompt; every call is
 *   answered as Node answers it.
 * - `[[browser.host.jsonrpc-start-bounded]]` — while the module's start is held, 8 `jsonrpc` requests are admitted and
 *   every further one is refused `busy` at once; each slot is held until its answer; once started, the 8 are answered
 *   as Node answers them.
 * - `[[browser.host.settings-module-bound]]` — settings naming 64 modules this build does not know: a switch saves at
 *   most 64 ids (this build's first, the oldest unknown dropped), so the next worker still reads the settings.
 * - `[[browser.host.jsonrpc-restored]]` — the switch lives in the settings: a new host on them (a reload, the next
 *   worker or leader tab) refuses while it is off and answers once on; a store replaced by `range`, `reset` or
 *   `import` keeps it off.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../../evm-rpc/db.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";
import { createRpcServer } from "../../evm-rpc/server.js";
import { differentialCases } from "../../evm-rpc/test/differential-cases.js";
import { handlerAnswer, loadRecording, sendToServer } from "../../evm-rpc/test/node-answers.js";
import { BLOCK_HASH, HEIGHT, recordedIndexerAnswer, recordedIndexerFetch, TX_HASH } from "../../evm-rpc/test/recorded-indexer.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { METHOD_NOTES, NODE_ONLY_METHODS } from "../../evm-rpc/method-info.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { execFileSync } from "node:child_process";
import {
  agoText,
  answerText,
  answerTree,
  buildRequest,
  curlCommand,
  type FieldValue,
  fieldsFromParams,
  filterRows,
  groupOfSource,
  type HistoryEntry,
  MAX_HISTORY,
  MAX_PARAMS_CHARS,
  MAX_PARAMS_DEPTH,
  MAX_SHOWN_CHARS,
  MAX_LEAF_CHARS,
  MAX_TREE_NODES,
  METHOD_GROUPS,
  methodRows,
  NODE_EVM_RPC_URL,
  outcomeOf,
  paramsFromFields,
  paramsOfText,
  parseHistory,
  registryMethods,
  requestFor,
  rpcRouteOf,
  shownText,
  statusFigures,
  stripParts,
  type TreeNode,
  urlWithRpcRoute,
  withHistory,
} from "../browser/jsonrpc-model.ts";
import { defaultMinIntervalMs } from "../../chain-archive-sync/polite-http.js";
import { JSONRPC_CHAIN_ID, JSONRPC_INDEXER_SLOTS, JSONRPC_MAX_REQUESTS, jsonRpcClientVersion, type JsonRpcModule, JsonRpcModuleError, type JsonRpcModuleOptions, openEvmRpcDatabase, startJsonRpcModule } from "../browser/jsonrpc-module.ts";
import { MAX_HOLD_MS, PacingQueue, type PacingClock, QueueFullError } from "../browser/pacing-queue.ts";
import type { WorkerHost } from "../browser/host.ts";
import { type ApiResult, type ExportResult, type HostStatus, JSONRPC_MAX_BODY_CHARS, type JsonRpcStateResult, JsonRpcStateResultSchema, parseRequest, PROTOCOL_VERSION, type Response as HostResponse, type StartConfig } from "../browser/protocol.ts";
import { type EngineSettingsStore, memorySettingsStore } from "../browser/settings.ts";
import { createTapeReplay } from "../../chain-archive-sync/tape-replay.js";
import { BROWSER_INDEXER_URL, BROWSER_NODE_URL } from "../browser/config.ts";
import { loadTape } from "../browser/tapes.ts";
import { fileFetch, testHost, U1, untilStatus } from "./helpers/worker-host.ts";

const INDEXER = "http://127.0.0.1:9/api/v4/graphql";
const CLIENT_VERSION = jsonRpcClientVersion("0.9.5");

interface WireAnswer {
  status: number;
  headers: [string, string][];
  body: string;
}

/** Node's server's answer to a `POST` of `body` (a connection of its own; a failure names the request). */
async function viaHttp(port: number, body: string): Promise<WireAnswer> {
  const a = await sendToServer(port, "POST", body);
  return { status: a.status, headers: a.headers, body: a.body.toString("utf8") };
}

describe("the browser engine's JSON RPC module", () => {
  let server: ReturnType<typeof createRpcServer>;
  let port: number;
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);

  beforeAll(async () => {
    // `npm run evm-rpc` without a database: the read-only methods over the same indexer answers.
    server = createRpcServer({
      registry,
      ctx: { chainId: JSONRPC_CHAIN_ID, clientVersion: CLIENT_VERSION, indexer: new IndexerGqlClient({ url: INDEXER, fetchImpl: recordedIndexerFetch().fetch }), db: emptyEvmRpcReader },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("[[browser.jsonrpc.module]] an in-memory evm_rpc database from the migrations; every POST case answered exactly as Node's server; closed, it refuses", async () => {
    let sql: UmbraDBSql | undefined;
    const module = await startJsonRpcModule({
      indexerUrl: INDEXER,
      clientVersion: CLIENT_VERSION,
      fetch: recordedIndexerFetch().fetch,
      openDatabase: async () => (sql = await openEvmRpcDatabase()),
    });
    try {
      const tables = await sql!<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'evm_rpc' ORDER BY table_name`;
      expect(tables.map((t) => t.table_name)).toEqual(["_migrations", "address_map", "balances", "log_cursors", "logs", "tx_index", "utxos", "watermarks"]);
      const applied = await sql!<{ name: string }[]>`SELECT name FROM evm_rpc._migrations ORDER BY name`;
      expect(applied.map((m) => m.name)).toEqual(["000_schema", "001_evm_rpc_core", "010_logs"]);
      const versions = await sql!<{ version: string }[]>`SELECT version()`;
      expect(versions[0]!.version).toContain("PGlite");
      expect(module.methods).toEqual(registry.listMethods());

      const cases = differentialCases().filter((c) => c.method === "POST");
      expect(cases.length).toBeGreaterThan(120);
      const recorded = new Map(loadRecording().answers.map((r) => [r.case, r]));
      for (const c of cases) {
        const answer = await module.handle(c.body);
        // Node's answer as recorded (status line, headers, body), and as Node's server answers now.
        expect(handlerAnswer(c.name, answer, recorded.get(c.name)!), c.name).toEqual(recorded.get(c.name));
        expect({ status: answer.status, headers: Object.entries(answer.headers), body: answer.body }, c.name).toEqual(await viaHttp(port, c.body));
      }
    } finally {
      await module.close();
    }
    await expect(module.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }))).rejects.toThrow("stopped");
    await expect(sql!`SELECT 1`).rejects.toThrow();
  }, 120_000);

  it("[[browser.jsonrpc.module-rows]] rows in the module's database are what the account and transaction methods answer", async () => {
    let sql: UmbraDBSql | undefined;
    const module = await startJsonRpcModule({
      indexerUrl: INDEXER,
      clientVersion: CLIENT_VERSION,
      fetch: recordedIndexerFetch().fetch,
      openDatabase: async () => (sql = await openEvmRpcDatabase()),
    });
    const call = async (method: string, params: unknown[]): Promise<unknown> =>
      (JSON.parse((await module.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))).body) as { result?: unknown }).result;
    try {
      const account = `0x${"12".repeat(20)}`;
      const bytes = (h: string): Uint8Array => Uint8Array.from(h.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
      const from = (await sql!<{ id: bigint }[]>`INSERT INTO evm_rpc.address_map (evm_addr, kind) VALUES (${bytes(account)}, 'midnight') RETURNING id`)[0]!.id;
      await sql!`INSERT INTO evm_rpc.balances (address_id, token_type, value, updated_block) VALUES (${from}, ${new Uint8Array(32)}, 3, 42)`;
      await sql!`INSERT INTO evm_rpc.tx_index (hash, block_height, block_hash, status, fee, from_id, raw_ref)
        VALUES (${bytes(`0x${TX_HASH.partial}`)}, ${HEIGHT.head}, ${bytes(`0x${BLOCK_HASH.head}`)}, 'FAILURE', 9, ${from}, 'indexer:transaction:104')`;
      const [row] = await sql!<{ hash: unknown }[]>`SELECT hash FROM evm_rpc.tx_index`;
      expect(Object.getPrototypeOf(row!.hash)).toBe(Uint8Array.prototype);
      expect(await call("eth_getBalance", [account, "latest"])).toBe(`0x${(3n * 10n ** 12n).toString(16)}`);
      expect(await call("eth_getTransactionCount", [account, "latest"])).toBe("0x1");
      expect(await call("eth_getTransactionByHash", [`0x${TX_HASH.partial}`])).toMatchObject({ from: account, transactionIndex: "0x1", nonce: "0x0" });
      expect(await call("eth_getTransactionReceipt", [`0x${TX_HASH.partial}`])).toMatchObject({ from: account, gasUsed: "0x9", status: "0x0" });
      // A log row of the transaction: its byte columns read back as hex, in the receipt with a bloom over them.
      const contract = `0x${"56".repeat(20)}`;
      const topic0 = `0x${"ab".repeat(32)}`;
      const topic1 = `0x${"00".repeat(12)}${"12".repeat(20)}`;
      const contractId = (await sql!<{ id: bigint }[]>`INSERT INTO evm_rpc.address_map (evm_addr, kind) VALUES (${bytes(contract)}, 'contract') RETURNING id`)[0]!.id;
      await sql!`INSERT INTO evm_rpc.logs (address_id, block_number, block_hash, tx_hash, tx_index, log_index, topic0, topic1, data, source_event_id)
        VALUES (${contractId}, ${HEIGHT.head}, ${bytes(`0x${BLOCK_HASH.head}`)}, ${bytes(`0x${TX_HASH.partial}`)}, 1, 0, ${bytes(topic0)}, ${bytes(topic1)}, ${bytes("0x0b0c")}, 7)`;
      const receipt = (await call("eth_getTransactionReceipt", [`0x${TX_HASH.partial}`])) as { logs: unknown[]; logsBloom: string };
      expect(receipt.logs).toEqual([{
        address: contract, topics: [topic0, topic1], data: "0x0b0c", blockNumber: "0x2a", blockHash: `0x${BLOCK_HASH.head}`,
        transactionHash: `0x${TX_HASH.partial}`, transactionIndex: "0x1", logIndex: "0x0", removed: false,
      }]);
      expect(receipt.logsBloom).not.toBe(`0x${"00".repeat(256)}`);
      expect(await call("eth_getCode", [contract, "latest"])).toBe("0x60006000");
    } finally {
      await module.close();
    }
  }, 60_000);

  it("[[browser.jsonrpc.paced]] requests to a public indexer start at least 250 ms apart; to any other, at once", async () => {
    for (const [url, minGap] of [["https://indexer.stagenet.shielded.tools/api/v4/graphql", 250], [INDEXER, 0]] as const) {
      const starts: number[] = [];
      const recorded = recordedIndexerFetch().fetch;
      const module = await startJsonRpcModule({
        indexerUrl: url,
        clientVersion: CLIENT_VERSION,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          starts.push(performance.now());
          // As a real fetch does: a request whose signal is aborted fails without being sent.
          if (init?.signal?.aborted === true) throw init.signal.reason;
          return recorded(input, init);
        }) as typeof fetch,
      });
      try {
        // Three indexer requests: the head, then the head's block and the transaction's block for the receipt.
        await module.handle(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }, { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["latest", false] }, { jsonrpc: "2.0", id: 3, method: "eth_blockNumber" }]));
      } finally {
        await module.close();
      }
      expect(starts.length).toBe(3);
      const sorted = [...starts].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (minGap > 0) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(minGap - 5);
        else expect(sorted[i]! - sorted[i - 1]!).toBeLessThan(200);
      }
    }
  }, 60_000);

  it("[[browser.jsonrpc.pacing-queue]] FIFO admission the interval apart on a test clock; a burst beyond the bound refused; a cancelled wait gives up its place; close ends every wait", async () => {
    const t = testClock();
    const { clock, settle, advance, timers } = t;
    const now = (): number => t.now;

    const q = new PacingQueue({ minIntervalMs: 250, maxWaiting: 64, clock });
    const admittedAt = new Map<number, number>();
    const refused: number[] = [];
    const waits = Array.from({ length: 100 }, (_, i) => q.admit().then(() => { admittedAt.set(i, now()); }, (e: unknown) => {
      expect(e).toBeInstanceOf(QueueFullError);
      refused.push(i);
    }));
    await settle();
    // The first goes at once; 64 wait; the other 35 are refused at once.
    expect([...admittedAt.entries()]).toEqual([[0, 0]]);
    expect(q.waiting).toBe(64);
    expect(refused).toEqual(Array.from({ length: 35 }, (_, i) => 65 + i));
    await advance(64 * 250);
    await Promise.all(waits);
    expect([...admittedAt.keys()]).toEqual(Array.from({ length: 65 }, (_, i) => i));
    for (const [i, at] of admittedAt) expect(at, String(i)).toBe(i * 250);
    expect(q.waiting).toBe(0);

    // A cancelled wait gives up its place: the caller after it is admitted in its slot.
    const order: string[] = [];
    const c = new AbortController();
    const first = q.admit().then(() => order.push(`a@${now()}`));
    const second = q.admit(c.signal).then(() => order.push("b"), (e: unknown) => order.push(`b: ${(e as Error).message}`));
    const third = q.admit().then(() => order.push(`c@${now()}`));
    await settle();
    expect(q.waiting).toBe(3);
    c.abort(new Error("cancelled"));
    await settle();
    expect(q.waiting).toBe(2);
    await advance(1_000);
    await Promise.all([first, second, third]);
    expect(order).toEqual(["b: cancelled", `a@${64 * 250 + 250}`, `c@${64 * 250 + 500}`]);
    // An already-cancelled signal is refused without waiting.
    await expect(q.admit(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");

    // Closing ends every wait with the reason, and refuses later callers.
    const pending = [q.admit(), q.admit(), q.admit()].map((p) => p.then(() => "admitted", (e: unknown) => (e as Error).message));
    await settle();
    q.close(new Error("stopped"));
    expect(await Promise.all(pending)).toEqual(["admitted", "stopped", "stopped"]);
    await expect(q.admit()).rejects.toThrow("stopped");
    expect(timers.size).toBe(0);
  });

  it("[[browser.pacing.hold]] a hold lasts at most 60 s whatever an endpoint asks; a wait its caller cancels during a hold leaves at once and never starts, the others start when the hold ends", async () => {
    const t = testClock();
    const { clock, settle, advance } = t;
    expect(MAX_HOLD_MS).toBe(60_000);
    const q = new PacingQueue({ minIntervalMs: 250, clock });
    // Retry-After: 600 asks for ten minutes: the queue holds for 60 s.
    q.holdFor(600_000);
    expect(q.state()).toEqual({ minIntervalMs: 250, waiting: 0, heldForMs: 60_000 });
    const order: string[] = [];
    const stop = new AbortController();
    // The archive sync's wait (`Pacer.wait`) with its run's signal, and a caller without one.
    const sync = q.wait(stop.signal).then(() => order.push(`sync@${t.now}`), (e: unknown) => order.push(`sync: ${(e as Error).message} @${t.now}`));
    const other = q.wait().then(() => order.push(`other@${t.now}`));
    await settle();
    expect(q.waiting).toBe(2);
    await advance(10_000);
    stop.abort(new Error("stopped"));
    await settle();
    expect(order).toEqual(["sync: stopped @10000"]);
    expect(q.waiting).toBe(1);
    // The others keep their turn: the hold ends at 60 s, not earlier and not later.
    await advance(49_999);
    expect(order).toEqual(["sync: stopped @10000"]);
    await advance(1);
    await Promise.all([sync, other]);
    expect(order).toEqual(["sync: stopped @10000", "other@60000"]);
    // A later, shorter hold changes nothing; a longer one is cut at 60 s from its start too.
    q.holdFor(5_000);
    q.holdFor(1_000);
    expect(q.state().heldForMs).toBe(5_000);
    q.holdFor(Number.MAX_SAFE_INTEGER);
    expect(q.state().heldForMs).toBe(60_000);
    // A caller whose signal has already ended is refused without waiting.
    await expect(q.wait(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
    // The last waiter cancelled: no timer is left behind (a Node process is not kept up by it); a later caller still
    // waits for the hold.
    const alone = new AbortController();
    const lone = q.wait(alone.signal).catch((e: unknown) => (e as Error).message);
    await settle();
    expect(t.timers.size).toBe(1);
    alone.abort(new Error("stopped"));
    expect(await lone).toBe("stopped");
    expect(t.timers.size).toBe(0);
    const later = q.wait().then(() => t.now);
    await advance(60_000);
    expect(await later).toBe(120_000);
    q.close(new Error("closed"));
  });

  it("[[browser.jsonrpc.burst]] indexer calls waiting far beyond the indexer timeout for their slots: every answer Node's, every start with a live timeout, the interval apart; beyond 8 requests in flight refused busy", async () => {
    const starts: number[] = [];
    let abortedSignals = 0;
    const recorded = recordedIndexerFetch().fetch;
    const module = await startJsonRpcModule({
      indexerUrl: INDEXER,
      clientVersion: CLIENT_VERSION,
      minIntervalMs: 30,
      indexerTimeoutMs: 200,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        starts.push(performance.now());
        if (init?.signal?.aborted === true) {
          abortedSignals++;
          throw init.signal.reason;
        }
        return recorded(input, init);
      }) as typeof fetch,
    });
    try {
      expect(JSONRPC_MAX_REQUESTS).toBe(8);
      const batch = (n: number): string => JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: "2.0", id: n * 10 + i, method: "eth_blockNumber" })));
      const inFlight = Array.from({ length: JSONRPC_MAX_REQUESTS }, (_, n) => module.handle(batch(n)));
      // A ninth while eight are in flight: refused at once, never answered with an error of the module's own.
      await expect(module.handle(batch(8))).rejects.toMatchObject({ code: "busy" });
      await expect(module.handle(batch(8))).rejects.toBeInstanceOf(JsonRpcModuleError);
      const answers = await Promise.all(inFlight);
      for (const [n, answer] of answers.entries()) {
        expect({ status: answer.status, headers: Object.entries(answer.headers), body: answer.body }).toEqual(await viaHttp(port, batch(n)));
      }
      // 64 indexer calls spaced 30 ms apart span far more than the 200 ms timeout; none started with a spent timeout.
      expect(starts.length).toBe(64);
      expect(abortedSignals).toBe(0);
      expect(starts[63]! - starts[0]!).toBeGreaterThan(5 * 200);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(25);
      // Once answered, a new request is accepted.
      expect(JSON.parse((await module.handle(CHAIN_ID)).body)).toMatchObject({ result: "0x960" });
    } finally {
      await module.close();
    }
  }, 60_000);

  it("[[browser.jsonrpc.stop-cancels]] closing the module ends the requests waiting for pacing slots at once and closes its database without waiting for their slots", async () => {
    let fetches = 0;
    let sql: UmbraDBSql | undefined;
    const recorded = recordedIndexerFetch().fetch;
    const module = await startJsonRpcModule({
      indexerUrl: INDEXER,
      clientVersion: CLIENT_VERSION,
      minIntervalMs: 500,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { fetches++; return recorded(input, init); }) as typeof fetch,
      openDatabase: async () => (sql = await openEvmRpcDatabase()),
    });
    const batch = (n: number): string => JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: "2.0", id: n * 10 + i, method: "eth_blockNumber" })));
    // 6 batches of 8: 48 indexer calls, 24 s of pacing.
    const waiting = Array.from({ length: 6 }, (_, n) => module.handle(batch(n)).then(() => "answered", (e: unknown) => (e instanceof JsonRpcModuleError ? e.code : String(e))));
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    await module.close();
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(await Promise.all(waiting)).toEqual(Array(6).fill("stopped"));
    expect(fetches).toBeLessThanOrEqual(2);
    await expect(sql!`SELECT 1`).rejects.toThrow();
    await expect(module.handle(CHAIN_ID)).rejects.toMatchObject({ code: "stopped" });
  }, 30_000);

  it("[[browser.jsonrpc.slots-bodies]] an indexer request keeps its slot until its answer's body is read: with answers whose bodies come slowly, at most 8 are read at once; every call answered as Node", async () => {
    let open = 0;
    let most = 0;
    let started = 0;
    const pending: Array<() => void> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = recordedIndexerAnswer(await new Request(input, init).text());
      started++;
      open++;
      most = Math.max(most, open);
      // The headers at once; the body only when the test lets it come.
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        open--;
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          pending.push(() => {
            controller.enqueue(new TextEncoder().encode(answer.body));
            controller.close();
            finish();
          });
          init?.signal?.addEventListener("abort", () => {
            finish();
            controller.error(init.signal!.reason);
          }, { once: true });
        },
        cancel: () => finish(),
      });
      return new Response(body, { status: answer.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const module = await startJsonRpcModule({ indexerUrl: INDEXER, clientVersion: CLIENT_VERSION, fetch: fetchImpl });
    try {
      const batch = (n: number): string => JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: "2.0", id: n * 8 + i, method: "eth_blockNumber" })));
      const answers = Promise.all(Array.from({ length: JSONRPC_MAX_REQUESTS }, (_, n) => module.handle(batch(n))));
      let settled = false;
      answers.then(() => { settled = true; }, () => { settled = true; });
      // Let the bodies come one by one, slowly, until every call is answered.
      for (const end = Date.now() + 20_000; !settled; ) {
        if (Date.now() > end) throw new Error(`timed out: ${started} requests started, ${open} bodies open`);
        await new Promise((r) => setTimeout(r, 5));
        expect(open).toBeLessThanOrEqual(JSONRPC_INDEXER_SLOTS);
        pending.shift()?.();
      }
      expect(most).toBe(JSONRPC_INDEXER_SLOTS);
      expect(started).toBe(JSONRPC_MAX_REQUESTS * 8);
      for (const [n, a] of (await answers).entries()) {
        expect({ status: a.status, headers: Object.entries(a.headers), body: a.body }, `batch ${n}`).toEqual(await viaHttp(port, batch(n)));
      }
      // A body never read (the request's failure, the module's close) gives its slot back too.
      const hung = module.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" })).then(() => "answered", (e: unknown) => (e as Error).message);
      for (const end = Date.now() + 5_000; open === 0; ) {
        if (Date.now() > end) throw new Error("the request never started");
        await new Promise((r) => setTimeout(r, 5));
      }
      await module.close();
      expect(await hung).toBe("the JSON RPC module is stopped");
      expect(open).toBe(0);
    } finally {
      await module.close();
    }
  }, 60_000);

  it("[[browser.jsonrpc.model]] the rows are the registry's methods and the Node-only ones, grouped by where their answer comes from; requests and answers as text", () => {
    expect(registryMethods()).toEqual(registry.listMethods());
    const rows = methodRows();
    const names = rows.map((r) => r.method);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(registry.listMethods().length + NODE_ONLY_METHODS.length);
    const stubs = new Map(NOT_IMPLEMENTED_METHODS.map((m) => [m.method, m]));
    for (const r of rows) {
      if (stubs.has(r.method)) {
        expect(r).toMatchObject({ kind: "not-implemented", group: "not-implemented", callable: true, params: "[]", paramSpecs: [], example: [], state: `not implemented (-32004): ${stubs.get(r.method)!.classification}`, note: stubs.get(r.method)!.reason });
      } else if (registry.getMethod(r.method) !== undefined) {
        const note = METHOD_NOTES[r.method]!;
        expect(r).toMatchObject({ kind: "served", group: groupOfSource(note.source), callable: true, state: "served here", source: note.source, summary: note.summary, paramSpecs: note.paramSpecs, example: note.params, params: JSON.stringify(note.params) });
      } else {
        expect(NODE_ONLY_METHODS.map((m) => m.method)).toContain(r.method);
        expect(r).toMatchObject({ kind: "node-only", group: "node-only", callable: false, state: "served by Node only", params: "", paramSpecs: [], summary: NODE_ONLY_METHODS.find((m) => m.method === r.method)!.summary });
      }
    }
    // The list's order: the groups in turn, by name in each.
    const order: string[] = METHOD_GROUPS.map((g) => g.id);
    expect(names).toEqual([...rows].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (a.method < b.method ? -1 : 1)).map((r) => r.method));
    // Where the answer comes from in this browser: a database read first falls back to the indexer.
    expect(["indexer", "indexer; pg:tx_index with full transactions", "pg:tx_index, then indexer", "pg:tx_index, then indexer; pg:logs"].map(groupOfSource)).toEqual(["indexer", "indexer", "indexer", "indexer"]);
    expect(["pg:balances, pg:address_map", "pg:tx_index", "pg:address_map"].map(groupOfSource)).toEqual(["database", "database", "database"]);
    expect(["config", "const", "const; indexer for a block tag"].map(groupOfSource)).toEqual(["config", "config", "config"]);
    expect(rows.filter((r) => r.group === "database").map((r) => r.method)).toEqual(["eth_getBalance", "eth_getCode", "eth_getTransactionCount"]);
    expect(rows.filter((r) => r.group === "node-only").map((r) => r.method)).toEqual(NODE_ONLY_METHODS.map((m) => m.method).sort());
    expect(rows.find((r) => r.method === "eth_call")!.note).toContain("Node only");

    expect(buildRequest(7, "eth_getBalance", '[\n "0x00", "latest"]')).toEqual({ ok: true, body: '{"jsonrpc":"2.0","id":7,"method":"eth_getBalance","params":["0x00","latest"]}', text: '{\n  "jsonrpc": "2.0",\n  "id": 7,\n  "method": "eth_getBalance",\n  "params": [\n    "0x00",\n    "latest"\n  ]\n}' });
    expect(buildRequest(8, "eth_chainId", "  ")).toMatchObject({ ok: true, body: '{"jsonrpc":"2.0","id":8,"method":"eth_chainId"}' });
    expect(buildRequest(9, "eth_chainId", '{"by":"name"}')).toMatchObject({ ok: true, body: '{"jsonrpc":"2.0","id":9,"method":"eth_chainId","params":{"by":"name"}}' });
    expect(buildRequest(10, "eth_chainId", "[1,")).toMatchObject({ ok: false, error: expect.stringContaining("not JSON") });
    expect(buildRequest(11, "eth_chainId", `[${" ".repeat(MAX_PARAMS_CHARS)}]`)).toMatchObject({ ok: false, error: expect.stringContaining("longer") });

    expect(answerText({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0x960"}' })).toEqual({ status: "HTTP 200", text: '{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": "0x960"\n}', json: true });
    expect(answerText({ status: 200, body: '{"id":"a\\nb"}' }).text).toBe('{\n  "id": "a\\nb"\n}');
    expect(answerText({ status: 204, body: "" })).toEqual({ status: "HTTP 204: no answer (a notification)", text: "", json: false });
    expect(answerText({ status: 502, body: "not <b>json</b>\nline" })).toEqual({ status: "HTTP 502", text: "not <b>json</b>\nline", json: false });
  });

  it("[[browser.jsonrpc.model-bounds]] parameters nested too deep or too long to show are refused with a message, never an exception; a long answer is shown cut", () => {
    // Nesting deep enough to break JSON.stringify: refused, not thrown.
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    expect(deep.length).toBeLessThan(MAX_PARAMS_CHARS);
    expect(() => buildRequest(1, "eth_chainId", deep)).not.toThrow();
    expect(buildRequest(1, "eth_chainId", deep)).toEqual({ ok: false, error: `the parameters nest deeper than ${MAX_PARAMS_DEPTH} levels` });
    // At the bound it is sent; one level more is refused.
    const at = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    expect(buildRequest(2, "eth_chainId", at(MAX_PARAMS_DEPTH))).toMatchObject({ ok: true });
    expect(buildRequest(3, "eth_chainId", at(MAX_PARAMS_DEPTH + 1))).toMatchObject({ ok: false });
    expect(buildRequest(4, "eth_chainId", `{"a":${at(MAX_PARAMS_DEPTH)}}`)).toMatchObject({ ok: false });
    // Input that indentation would expand far beyond what the tab shows: the text shown is bounded.
    const wide = `[${Array.from({ length: 2_800 }, () => "[[[[[[[[[[1]]]]]]]]]]").join(",")}]`;
    expect(wide.length).toBeLessThan(MAX_PARAMS_CHARS);
    const built = buildRequest(5, "eth_chainId", wide);
    if (built.ok) expect(built.text.length).toBeLessThanOrEqual(MAX_SHOWN_CHARS + 200);
    else expect(built.error).toMatch(/^the parameters are too long to show indented/);
    // An answer longer than the tab shows: cut, with its length.
    const long = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(MAX_SHOWN_CHARS * 2) });
    const shown = answerText({ status: 200, body: long });
    expect(shown.text.length).toBeLessThanOrEqual(MAX_SHOWN_CHARS + 200);
    expect(shown.text).toMatch(/… \(cut: [\d,]+ characters in all\)$/);

    // One check of the parameters before any conversion: the JSON text's length, its JSON, its depth.
    const nested = `[{"x":${"[".repeat(10_000)}${"]".repeat(10_000)}}]`;
    expect(paramsOfText(nested)).toEqual({ ok: false, error: `the parameters nest deeper than ${MAX_PARAMS_DEPTH} levels` });
    expect(paramsOfText("[1,")).toMatchObject({ ok: false, error: expect.stringMatching(/^the parameters are not JSON: /) });
    expect(paramsOfText(`[${" ".repeat(MAX_PARAMS_CHARS)}]`)).toEqual({ ok: false, error: `the parameters are longer than ${MAX_PARAMS_CHARS} characters` });
    expect(paramsOfText(' [1, {"a": 2}] ')).toEqual({ ok: true, params: [1, { a: 2 }] });
    expect(paramsOfText("  ")).toEqual({ ok: true, params: undefined });
    // Values nested too deep never reach a field, and putting them in one never throws.
    const object = [{ name: "transaction", kind: "object" as const }];
    const deepValue = JSON.parse(nested.slice(1, -1)) as unknown;
    expect(() => fieldsFromParams(object, [deepValue])).not.toThrow();
    expect(paramsFromFields(object, fieldsFromParams(object, [deepValue]))).toMatchObject({ ok: false });
    expect(() => fieldsFromParams([{ name: "data", kind: "data" }], [deepValue])).not.toThrow();
    // A form's parameters are held to the JSON text's length: a field or the whole longer than it is refused.
    const long400k = `0x${"aa".repeat(200_000)}`;
    expect(paramsFromFields([{ name: "data", kind: "data" }], [{ kind: "text", text: long400k }])).toEqual({ ok: false, errors: [`data: longer than ${MAX_PARAMS_CHARS} characters`] });
    const half = `0x${"aa".repeat(17_000)}`;
    expect(paramsFromFields([{ name: "a", kind: "data" }, { name: "b", kind: "data" }], [{ kind: "text", text: half }, { kind: "text", text: half }])).toEqual({ ok: false, errors: [null, null], error: `the parameters are longer than ${MAX_PARAMS_CHARS} characters` });
    expect(requestFor(1, "web3_sha3", [long400k])).toEqual({ ok: false, error: `the parameters are longer than ${MAX_PARAMS_CHARS} characters` });
    const atBound = `0x${"aa".repeat((MAX_PARAMS_CHARS - 6) / 2)}`;
    expect(JSON.stringify([atBound]).length).toBe(MAX_PARAMS_CHARS);
    expect(requestFor(1, "web3_sha3", [atBound])).toMatchObject({ ok: true });
    expect(paramsFromFields([{ name: "data", kind: "data" }], [{ kind: "text", text: atBound }])).toEqual({ ok: true, params: [atBound] });
    expect(requestFor(1, "web3_sha3", [`${atBound}aa`])).toMatchObject({ ok: false });
    // The curl line of a request at the bound whose quotes each take four characters: shown cut, copied whole.
    const quotes = buildRequest(1, "eth_call", `["${"'".repeat(MAX_PARAMS_CHARS - 4)}"]`);
    expect(quotes.ok).toBe(true);
    if (quotes.ok) {
      expect(curlCommand(quotes.body).length).toBeGreaterThan(4 * MAX_PARAMS_CHARS);
      const line = shownText(curlCommand(quotes.body));
      expect(line.length).toBeLessThanOrEqual(MAX_SHOWN_CHARS + 60);
      expect(line).toMatch(/… \(cut: [\d,]+ characters in all\)$/);
      expect(quotes.text.length).toBeLessThanOrEqual(MAX_SHOWN_CHARS + 60);
    }
    // Each string of an answer's tree: at most MAX_LEAF_CHARS, all of them together at most MAX_SHOWN_CHARS.
    const tree = answerTree({ jsonrpc: "2.0", id: 1, result: ["x".repeat(1_000_000), ...Array.from({ length: 300 }, () => "y".repeat(5_000))] }, "eth_call");
    const leaves = tree.children[2]!.children;
    expect([leaves[0]!.text.length, leaves[0]!.cut]).toEqual([MAX_LEAF_CHARS, 1_000_000 - MAX_LEAF_CHARS]);
    expect([leaves[1]!.text.length, leaves[1]!.cut]).toEqual([MAX_LEAF_CHARS, 5_000 - MAX_LEAF_CHARS]);
    const total = leaves.reduce((a, l) => a + l.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SHOWN_CHARS);
    expect(leaves.every((l) => l.text.length + l.cut === (l === leaves[0] ? 1_000_000 : 5_000))).toBe(true);
    expect(leaves.at(-1)).toMatchObject({ text: "", cut: 5_000 });
  });

  it("[[browser.jsonrpc.explorer-model]] the form gives back every example; each kind of field is checked; search, curl, the answer tree and its next calls, the URL and the history", async () => {
    const rows = methodRows();
    // Every callable method's example through its form: the same parameters, the same request.
    for (const r of rows.filter((x) => x.callable)) {
      const back = paramsFromFields(r.paramSpecs, fieldsFromParams(r.paramSpecs, r.example));
      expect(back, r.method).toEqual({ ok: true, params: r.example });
      const request = { jsonrpc: "2.0", id: 5, method: r.method, params: r.example };
      expect(requestFor(5, r.method, r.example), r.method).toEqual({ ok: true, body: JSON.stringify(request), text: JSON.stringify(request, null, 2) });
    }
    expect(requestFor(6, "eth_chainId", undefined)).toMatchObject({ ok: true, body: '{"jsonrpc":"2.0","id":6,"method":"eth_chainId"}' });

    // Each kind of field.
    const text = (t: string): FieldValue => ({ kind: "text", text: t });
    const block = (choice: string, number = "", hash = ""): FieldValue => ({ kind: "block", choice: choice as "latest", number, hash });
    const one = (kind: string, v: FieldValue, optional = false) => paramsFromFields([{ name: "x", kind: kind as "hash", ...(optional ? { optional: true } : {}) }], [v]);
    const address = `0x${"ab".repeat(20)}`;
    const hash = `0x${BLOCK_HASH.h41}`;
    expect(one("address", text(` ${address} `))).toEqual({ ok: true, params: [address] });
    expect(one("address", text("0x12"))).toEqual({ ok: false, errors: ["x: an address: 0x and 40 hex digits"] });
    expect(one("hash", text(hash))).toEqual({ ok: true, params: [hash] });
    expect(one("hash", text(address))).toEqual({ ok: false, errors: ["x: a hash: 0x and 64 hex digits"] });
    expect(one("quantity", text("255"))).toEqual({ ok: true, params: ["0xff"] });
    expect(one("quantity", text("0x00Ff"))).toEqual({ ok: true, params: ["0xff"] });
    expect(one("quantity", text("0"))).toEqual({ ok: true, params: ["0x0"] });
    for (const bad of ["-1", "1.5", "0x", "ff", "1".repeat(81), ""]) expect(one("quantity", text(bad)), bad).toEqual({ ok: false, errors: ["x: a number: decimal, or 0x and hex digits"] });
    expect(one("data", text("0x1234"))).toEqual({ ok: true, params: ["0x1234"] });
    expect(one("data", text("0x123"))).toEqual({ ok: false, errors: ["x: data: 0x and an even number of hex digits"] });
    expect(one("boolean", { kind: "boolean", checked: true })).toEqual({ ok: true, params: [true] });
    expect(one("boolean", { kind: "boolean", checked: false })).toEqual({ ok: true, params: [false] });
    for (const tag of ["latest", "earliest", "pending", "safe", "finalized"]) expect(one("blockTag", block(tag))).toEqual({ ok: true, params: [tag] });
    expect(one("blockTag", block("number", "41"))).toEqual({ ok: true, params: ["0x29"] });
    expect(one("blockTag", block("number", "0x029"))).toEqual({ ok: true, params: ["0x29"] });
    expect(one("blockTag", block("number", "forty"))).toEqual({ ok: false, errors: ["x: a block number is a decimal number, or 0x and hex digits"] });
    expect(one("blockTag", block("hash", "", hash))).toEqual({ ok: false, errors: ["x: a hash: 0x and 64 hex digits"] });
    expect(one("blockRef", block("hash", "", hash))).toEqual({ ok: true, params: [hash] });
    expect(one("blockRef", block("hash", "", "0x1"))).toEqual({ ok: false, errors: ["x: a hash: 0x and 64 hex digits"] });
    expect(one("blockTag", block("omit"), true)).toEqual({ ok: true, params: [] });
    expect(one("blockTag", block("omit"))).toEqual({ ok: false, errors: ["x: a block tag, or a block number"] });
    expect(one("percentiles", text("25, 75.5,100"))).toEqual({ ok: true, params: [[25, 75.5, 100]] });
    expect(one("percentiles", text(""), true)).toEqual({ ok: true, params: [] });
    for (const bad of ["101", "a", "25,,75", "-1"]) expect(one("percentiles", text(bad)), bad).toEqual({ ok: false, errors: ["x: numbers from 0 to 100, separated by commas"] });
    expect(one("object", text('{"to":"0x00","data":"0x"}'))).toEqual({ ok: true, params: [{ to: "0x00", data: "0x" }] });
    for (const bad of ["[1]", "{", "7", "null"]) expect(one("object", text(bad)), bad).toEqual({ ok: false, errors: ["x: a JSON object"] });
    expect(one("object", text(`{"a":${"[".repeat(70)}${"]".repeat(70)}}`))).toEqual({ ok: false, errors: [`x: nested deeper than ${MAX_PARAMS_DEPTH - 1} levels`] });
    // An optional field left out before one that is given; every field's message at once.
    expect(paramsFromFields([{ name: "a", kind: "blockTag", optional: true }, { name: "b", kind: "percentiles", optional: true }], [block("omit"), text("5")])).toEqual({ ok: false, errors: ["a: needed when a later parameter is given", null] });
    expect(paramsFromFields([{ name: "a", kind: "address" }, { name: "b", kind: "boolean" }, { name: "c", kind: "hash" }], [text("no"), { kind: "boolean", checked: true }, text("no")])).toEqual({ ok: false, errors: ["a: an address: 0x and 40 hex digits", null, "c: a hash: 0x and 64 hex digits"] });
    // Values put back in the fields: a hash in a block reference, a number, an optional block not given.
    expect(fieldsFromParams([{ name: "b", kind: "blockRef" }], [hash])).toEqual([block("hash", "", hash)]);
    expect(fieldsFromParams([{ name: "b", kind: "blockTag" }], ["0x29"])).toEqual([block("number", "0x29")]);
    expect(fieldsFromParams([{ name: "a", kind: "address" }, { name: "b", kind: "blockTag", optional: true }], [address])).toEqual([text(address), block("omit")]);
    expect(fieldsFromParams([{ name: "p", kind: "percentiles", optional: true }, { name: "o", kind: "object" }], [[25, 75], { to: "0x" }])).toEqual([text("25, 75"), text('{"to":"0x"}')]);

    // The search: every word, case aside, in the name, source, summary or state.
    expect(filterRows(rows, "  ")).toEqual(rows);
    const found = filterRows(rows, "BLOCKNUMBER indexer");
    expect(found.length).toBeGreaterThan(1);
    for (const r of rows) {
      const t = `${r.method} ${r.source} ${r.summary} ${r.state}`.toLowerCase();
      expect(found.includes(r), r.method).toBe(t.includes("blocknumber") && t.includes("indexer"));
    }
    expect(filterRows(rows, "pg:balances").map((r) => r.method)).toEqual(["eth_getBalance"]);
    expect(filterRows(rows, "no such method")).toEqual([]);

    // The curl command: a POSIX shell passes exactly the request to curl (here a function standing in for it).
    const awkward = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ data: "it's $(id) `id` \\ \"q\"\nline'" }] });
    for (const body of [awkward, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}']) {
      const cmd = curlCommand(body);
      expect(cmd.startsWith("curl -s -X POST -H 'Content-Type: application/json' --data '")).toBe(true);
      expect(cmd.endsWith(` ${NODE_EVM_RPC_URL}`)).toBe(true);
      const args = JSON.parse(execFileSync("sh", ["-c", `curl() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; ${cmd}`], { encoding: "utf8" })) as string[];
      expect(args).toEqual(["-s", "-X", "POST", "-H", "Content-Type: application/json", "--data", body, NODE_EVM_RPC_URL]);
    }
    expect(NODE_EVM_RPC_URL).toBe("http://127.0.0.1:8545");

    // The answer tree, on Node's answers: quantities in decimal; block numbers, block hashes and transaction hashes open
    // the calls that read them, and nothing else does.
    const nodeAnswer = async (method: string, params: unknown[]): Promise<unknown> => JSON.parse((await viaHttp(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))).body);
    const walk = (t: TreeNode, path: string, out: Map<string, TreeNode>): Map<string, TreeNode> => {
      out.set(path, t);
      for (const c of t.children) walk(c, `${path}/${c.key}`, out);
      return out;
    };
    const links = (t: TreeNode): Record<string, string[]> =>
      Object.fromEntries([...walk(t, "", new Map())].filter(([, n]) => n.next.length > 0).map(([p, n]) => [p, n.next.map((x) => `${x.label}: ${x.method} ${JSON.stringify(x.params)}`)]));
    const head = answerTree(await nodeAnswer("eth_blockNumber", []), "eth_blockNumber");
    expect(head.children.map((c) => [c.key, c.text, c.decimal])).toEqual([["jsonrpc", "2.0", null], ["id", "1", null], ["result", "0x2a", "42"]]);
    expect(links(head)).toEqual({ "/result": ['open block: eth_getBlockByNumber ["0x2a",false]'] });
    // A block with its whole transactions.
    const full = answerTree(await nodeAnswer("eth_getBlockByNumber", ["0x2a", true]), "eth_getBlockByNumber");
    const blockHash = `0x${BLOCK_HASH.head}`;
    const tx0 = `0x${TX_HASH.success}`;
    const fullLinks = links(full);
    expect(fullLinks["/result/number"]).toEqual(['open block: eth_getBlockByNumber ["0x2a",false]']);
    expect(fullLinks["/result/hash"]).toEqual([`open block: eth_getBlockByHash ["${blockHash}",false]`]);
    expect(fullLinks["/result/parentHash"]).toEqual([`open block: eth_getBlockByHash ["0x${BLOCK_HASH.h41}",false]`]);
    expect(fullLinks["/result/transactions/0/hash"]).toEqual([`open transaction: eth_getTransactionByHash ["${tx0}"]`, `open receipt: eth_getTransactionReceipt ["${tx0}"]`]);
    expect(fullLinks["/result/transactions/0/blockHash"]).toEqual([`open block: eth_getBlockByHash ["${blockHash}",false]`]);
    expect(fullLinks["/result/transactions/0/blockNumber"]).toEqual(['open block: eth_getBlockByNumber ["0x2a",false]']);
    const allowed = /^\/result\/(?:number|hash|parentHash|transactions\/\d+\/(?:hash|blockHash|blockNumber))$/;
    for (const p of Object.keys(fullLinks)) expect(p).toMatch(allowed);
    const fullNodes = walk(full, "", new Map());
    expect(fullNodes.get("/result/number")!.decimal).toBe("42");
    expect(fullNodes.get("/result/hash")!.decimal).toBeNull();
    expect(fullNodes.get("/result/miner")!.next).toEqual([]);
    // A block with its transaction hashes.
    const hashes = links(answerTree(await nodeAnswer("eth_getBlockByNumber", ["0x2a", false]), "eth_getBlockByNumber"));
    expect(hashes["/result/transactions/0"]).toEqual([`open transaction: eth_getTransactionByHash ["${tx0}"]`, `open receipt: eth_getTransactionReceipt ["${tx0}"]`]);
    // A receipt: its transaction, its block, its logs'.
    const receipt = links(answerTree(await nodeAnswer("eth_getTransactionReceipt", [tx0]), "eth_getTransactionReceipt"));
    expect(receipt["/result/transactionHash"]).toEqual([`open transaction: eth_getTransactionByHash ["${tx0}"]`, `open receipt: eth_getTransactionReceipt ["${tx0}"]`]);
    expect(receipt["/result/blockHash"]).toEqual([`open block: eth_getBlockByHash ["${blockHash}",false]`]);
    expect(receipt["/result/blockNumber"]).toEqual(['open block: eth_getBlockByNumber ["0x2a",false]']);
    // The genesis block's parent hash (all zeros, which no block has) opens nothing.
    const genesis = links(answerTree(await nodeAnswer("eth_getBlockByNumber", ["0x0", false]), "eth_getBlockByNumber"));
    expect(genesis["/result/parentHash"]).toBeUndefined();
    expect(links(answerTree({ jsonrpc: "2.0", id: 1, result: { blockHash: `0x${"00".repeat(32)}`, transactionHash: `0x${"00".repeat(32)}`, transactionIndex: "0x0" } }, "eth_getTransactionReceipt"))).toEqual({});
    // A quantity that is not a block number opens nothing; a non-canonical one shows no decimal.
    expect(links(answerTree({ jsonrpc: "2.0", id: 1, result: "0x2a" }, "eth_gasPrice"))).toEqual({});
    expect(answerTree({ jsonrpc: "2.0", id: 1, result: "0x002a" }, "eth_blockNumber").children[2]).toMatchObject({ decimal: null, next: [] });
    // Bounded: a long answer keeps the first nodes and counts the rest.
    const big = answerTree({ jsonrpc: "2.0", id: 1, result: Array.from({ length: 5_000 }, (_, i) => `0x${i.toString(16)}`) }, "eth_accounts");
    const count = (t: TreeNode): number => 1 + t.children.reduce((a, c) => a + count(c), 0);
    expect(count(big)).toBe(MAX_TREE_NODES);
    expect(big.children[2]!.more).toBe(5_000 - (MAX_TREE_NODES - 4));
    // As deep as JSON nests: no overflow.
    const deep = JSON.parse(`${"[".repeat(100_000)}${"]".repeat(100_000)}`) as unknown;
    expect(count(answerTree(deep, "eth_chainId"))).toBeLessThanOrEqual(MAX_TREE_NODES);

    // The URL: the view and the method beside the shell's tab; the explorer's fragment kept.
    expect(rpcRouteOf("?tab=jsonrpc&rpc=status&rpc-method=eth_call")).toEqual({ view: "status", method: "eth_call" });
    expect(rpcRouteOf("?tab=jsonrpc")).toEqual({ view: "methods", method: null });
    expect(rpcRouteOf("?rpc=bogus&rpc-method=")).toEqual({ view: "methods", method: null });
    expect(urlWithRpcRoute("https://site.test/index.html?tab=jsonrpc#/status", { view: "status", method: "eth_call" })).toBe("https://site.test/index.html?tab=jsonrpc&rpc=status&rpc-method=eth_call#/status");
    expect(urlWithRpcRoute("https://site.test/index.html?tab=jsonrpc&rpc=status&rpc-method=eth_call#/", { view: "methods", method: null })).toBe("https://site.test/index.html?tab=jsonrpc&rpc=methods#/");

    // The history: newest first, at most 50; parameters too long to send are not kept.
    let h: HistoryEntry[] = [];
    for (let i = 0; i < 60; i++) h = withHistory(h, { method: "eth_chainId", params: "[]", at: 1_000 + i, outcome: 'result "0x960"' });
    expect(h.length).toBe(MAX_HISTORY);
    expect(h.map((e) => e.at)).toEqual(Array.from({ length: MAX_HISTORY }, (_, i) => 1_059 - i));
    expect(withHistory([], { method: "eth_call", params: `[${" ".repeat(MAX_PARAMS_CHARS)}]`, at: 1, outcome: "x" })).toEqual([]);
    const known = new Set(rows.filter((r) => r.callable).map((r) => r.method));
    expect(parseHistory(JSON.stringify(h), known)).toEqual(h);
    const good: HistoryEntry = { method: "eth_getBalance", params: JSON.stringify([address, "latest"]), at: 5, outcome: "ok" };
    expect(parseHistory(JSON.stringify([
      good,
      { ...good, method: "eth_getLogs" },
      { ...good, method: "no_such_method" },
      { ...good, params: "[1," },
      { ...good, params: `[${"[".repeat(70)}${"]".repeat(70)}]` },
      { ...good, at: "5" },
      { ...good, outcome: "x".repeat(201) },
      { ...good, params: 7 },
      "text",
      null,
      { ...good, params: "" },
    ]), known)).toEqual([good, { ...good, params: "" }]);
    for (const t of [null, "", "{", "{}", "7", JSON.stringify(Array(60).fill(good))]) expect(parseHistory(t, known).length, String(t).slice(0, 20)).toBeLessThanOrEqual(t !== null && t.startsWith("[") ? MAX_HISTORY : 0);
    expect(outcomeOf({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0x960"}' }, null)).toBe('result "0x960"');
    expect(outcomeOf({ status: 200, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}' }, null)).toBe("error -32602: bad");
    expect(outcomeOf({ status: 204, body: "" }, null)).toBe("HTTP 204");
    expect(outcomeOf({ status: 200, body: "[1,2]" }, null)).toBe("2 answers");
    expect(outcomeOf(null, "no answer · busy")).toBe("no answer · busy");
    expect(outcomeOf({ status: 200, body: JSON.stringify({ result: "x".repeat(500) }) }, null).length).toBe(80);
  });

  it("[[browser.jsonrpc.status-model]] the status view's figures and the strip, each from its field of the module's state", () => {
    const s: JsonRpcStateResult = {
      enabled: true,
      database: "open",
      chainId: "2400",
      clientVersion: "umbradb-evm-rpc/9.9.9",
      indexerUrl: "https://indexer.example/api/v4/graphql",
      methods: { served: 26, notImplemented: 41, nodeOnly: 4 },
      calls: { answered: 1234, inFlight: 2, refusedBusy: 3, refusedOff: 4, failed: 5 },
      pacing: { origin: "https://indexer.example", minIntervalMs: 250, waiting: 6, heldForMs: 2_400 },
      lastError: { at: 100_000, message: "https://indexer.example answered HTTP 503" },
    };
    expect(JsonRpcStateResultSchema.parse(s)).toEqual(s);
    expect(statusFigures(s, 130_000).map((f) => [f.field, f.label, f.value, f.bad ?? false])).toEqual([
      ["rpc-state.enabled", "module", "on", false],
      ["rpc-state.database", "evm_rpc database", "open, in memory (empty: its tables are filled in Node)", false],
      ["rpc-state.methods", "methods", "26 served here · 41 not implemented (-32004) · 4 served by Node only", false],
      ["rpc-state.chainId", "chain ID", "2400 (0x960)", false],
      ["rpc-state.clientVersion", "client version", "umbradb-evm-rpc/9.9.9", false],
      ["rpc-state.indexerUrl", "indexer", "https://indexer.example/api/v4/graphql", false],
      ["rpc-state.calls", "calls since the engine started", "1,234 answered · 2 in flight · 3 refused busy · 4 refused off · 5 failed", false],
      ["rpc-state.pacing", "pacing of https://indexer.example", "one request every 250 ms · 6 waiting · held 3 s more (Retry-After)", false],
      ["rpc-state.lastError", "last error", "https://indexer.example answered HTTP 503 (30 s ago)", true],
    ]);
    const quiet = statusFigures({ ...s, enabled: false, database: "none", pacing: { ...s.pacing, minIntervalMs: 0, waiting: 0, heldForMs: 0 }, lastError: null }, 0);
    expect(Object.fromEntries(quiet.map((f) => [f.field, [f.value, f.bad ?? false]]))).toMatchObject({
      "rpc-state.enabled": ["off", true],
      "rpc-state.database": ["none yet (made in memory at the first call)", false],
      "rpc-state.pacing": ["requests not spaced · 0 waiting", false],
      "rpc-state.lastError": ["none", false],
    });
    expect(statusFigures({ ...s, database: "starting" }, 0)[1]!.value).toBe("being made");
    expect(statusFigures({ ...s, database: "closing" }, 0)[1]!.value).toBe("being closed");
    expect(stripParts(s)).toEqual([{ label: "module", value: "on" }, { label: "answered", value: "1,234" }, { label: "in flight", value: "2" }, { label: "waiting", value: "6" }]);
    expect([agoText(0, 400), agoText(0, 59_400), agoText(0, 61_000), agoText(0, 3 * 3_600_000), agoText(5_000, 0)]).toEqual(["0 s ago", "59 s ago", "1 min ago", "3 h ago", "0 s ago"]);
    // Every field of the state is shown.
    expect(Object.keys(s).filter((k) => !statusFigures(s, 0).some((f) => f.field === `rpc-state.${k}`))).toEqual([]);
  });

  // ── The worker host ───────────────────────────────────────────────────────────────────────────────────────────────

  let nextId = 1;
  const send = (host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<HostResponse> =>
    host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  const jsonrpc = async (host: WorkerHost, body: string): Promise<ApiResult | { refused: string; message: string }> => {
    const r = await send(host, "jsonrpc", { body });
    return r.ok ? (r.result as ApiResult) : { refused: r.error.code, message: r.error.message };
  };
  const asWire = (r: ApiResult | { refused: string }): unknown => ("refused" in r ? r : { status: r.status, headers: Object.entries(r.headers), body: r.body });
  const ok = async <T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> => {
    const r = await send(host, type, params);
    if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
    return r.result as T;
  };
  const CHAIN_ID = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  const BLOCK = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["latest", true] });

  /** Starts modules as the host does, counting them and their closes. */
  /** Starts modules as the host does, counting them, their closes (once a module's database is closed) and the most
   *  open at once. */
  function counted(): { start: (o: JsonRpcModuleOptions) => Promise<JsonRpcModule>; started: number; closed: number; maxOpen: number; fail: number } {
    const c = {
      started: 0,
      closed: 0,
      maxOpen: 0,
      fail: 0,
      start: async (o: JsonRpcModuleOptions): Promise<JsonRpcModule> => {
        if (c.fail > 0) {
          c.fail--;
          throw new Error("no memory for another database");
        }
        const m = await startJsonRpcModule(o);
        c.started++;
        c.maxOpen = Math.max(c.maxOpen, c.started - c.closed);
        return { methods: m.methods, handle: (b) => m.handle(b), close: async () => { await m.close(); c.closed++; }, lastIndexerProblem: () => m.lastIndexerProblem() };
      },
    };
    return c;
  }

  function jsonRpcHost(settings: EngineSettingsStore, modules = counted(), over: Parameters<typeof testHost>[0] = {}) {
    const t = testHost({
      indexerUrl: INDEXER,
      fetch: recordedIndexerFetch().fetch,
      settings,
      jsonRpc: { clientVersion: CLIENT_VERSION, start: modules.start },
      ...over,
    });
    return { ...t, modules };
  }

  it("[[browser.host.jsonrpc]] answered while on (the database made at the first request); off saved first, then refused and closed; on again a new module; its own switch; a failed save changes nothing; a failed start is tried again; bad requests refused", async () => {
    const settings = memorySettingsStore();
    const { host, modules, logs } = jsonRpcHost(settings);
    try {
      expect((await host.boot()).phase).toBe("ready");
      expect(modules.started).toBe(0); // nothing made before the first request
      for (const body of [CHAIN_ID, BLOCK, ...differentialCases().filter((c) => c.method === "POST").slice(0, 60).map((c) => c.body)]) {
        expect(asWire(await jsonrpc(host, body))).toEqual(await viaHttp(port, body));
      }
      expect(modules.started).toBe(1);
      expect(logs.some((l) => /^info the JSON RPC module started: \d+ methods/.test(l))).toBe(true);

      // Off: saved first, refused at once, the database closed.
      const off = await ok<HostStatus>(host, "module", { module: "jsonrpc", enabled: false });
      expect(off.settings?.modules).toEqual({ jsonrpc: false });
      expect((await settings.load())?.modules).toEqual({ jsonrpc: false });
      expect(await jsonrpc(host, CHAIN_ID)).toEqual({ refused: "module-off", message: expect.stringContaining("the JSON RPC module is off") });
      await until(() => modules.closed === 1, "the module's database to close");
      // The token indexer's switch is its own.
      expect(off.engine).toBeNull();
      expect((await ok<HostStatus>(host, "status")).settings?.modules?.["token-indexer"]).toBeUndefined();

      // On again: a new module answers.
      const on = await ok<HostStatus>(host, "module", { module: "jsonrpc", enabled: true });
      expect(on.settings?.modules).toEqual({ jsonrpc: true });
      expect(asWire(await jsonrpc(host, BLOCK))).toEqual(await viaHttp(port, BLOCK));
      expect(modules.started).toBe(2);

      // A switch the browser refuses to save changes nothing.
      const failing: EngineSettingsStore = { load: () => settings.load(), save: async () => { throw new Error("QuotaExceededError"); } };
      const refused = jsonRpcHost(failing);
      try {
        await refused.host.boot();
        const r = await send(refused.host, "module", { module: "jsonrpc", enabled: false });
        expect(r.ok ? null : r.error).toEqual({ code: "settings-failed", message: expect.stringMatching(/^the JSON RPC module's switch could not be saved \(QuotaExceededError\): nothing was changed$/) });
        expect((await ok<HostStatus>(refused.host, "status")).settings?.modules).toEqual({ jsonrpc: true });
        expect(asWire(await jsonrpc(refused.host, CHAIN_ID))).toEqual(await viaHttp(port, CHAIN_ID));
      } finally {
        await refused.host.close();
      }

      // A module that fails to start: `internal`, and the next request starts it again.
      const flaky = counted();
      flaky.fail = 1;
      const retried = jsonRpcHost(memorySettingsStore(), flaky);
      try {
        expect(await jsonrpc(retried.host, CHAIN_ID)).toEqual({ refused: "internal", message: "the JSON RPC module could not start: no memory for another database" });
        await until(() => retried.logs.some((l) => l === "error the JSON RPC module could not start: no memory for another database"), "the failed start's log line");
        expect(asWire(await jsonrpc(retried.host, CHAIN_ID))).toEqual(await viaHttp(port, CHAIN_ID));
        expect(flaky.started).toBe(1);
      } finally {
        await retried.host.close();
      }

      // Requests the protocol refuses; reading a request never throws.
      for (const params of [{}, { body: 7 }, { body: null }, { body: " ".repeat(JSONRPC_MAX_BODY_CHARS + 1) }, { body: "{}", extra: 1 }]) {
        const r = await send(host, "jsonrpc", params);
        expect(r.ok ? null : r.error.code, JSON.stringify(params).slice(0, 40)).toBe("bad-request");
      }
      const hostile = { v: PROTOCOL_VERSION, id: 9, type: "jsonrpc", get body(): string { throw new Error("a getter that throws"); } };
      expect(parseRequest(hostile)).toMatchObject({ ok: false, error: { code: "bad-request" } });
      expect(parseRequest({ v: PROTOCOL_VERSION, id: 9, type: "jsonrpc", body: " ".repeat(JSONRPC_MAX_BODY_CHARS) })).toMatchObject({ ok: true });
      expect(parseRequest({ v: PROTOCOL_VERSION, id: 9, type: "module", module: "jsonrpc", enabled: false })).toMatchObject({ ok: true });
    } finally {
      await host.close();
    }
    // Closing the host closes the module's database.
    expect(modules.closed).toBe(2);
  }, 120_000);

  it("[[browser.host.jsonrpc-bounded]] 85 requests at once: 8 answered as Node does, the rest refused busy; requests waiting for pacing slots when the module is switched off are answered module-off at once", async () => {
    const paced = (minIntervalMs: number): ReturnType<typeof counted> => {
      const c = counted();
      const start = c.start;
      // A queue of the module's own, the interval apart, instead of the worker's queue of the (local) endpoint.
      c.start = (o) => start({ ...o, pacer: undefined, minIntervalMs });
      return c;
    };
    const { host } = jsonRpcHost(memorySettingsStore(), paced(20));
    try {
      await host.boot();
      const body = (i: number): string => JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_blockNumber" });
      const answers = await Promise.all(Array.from({ length: 85 }, (_, i) => jsonrpc(host, body(i))));
      const answered = answers.filter((a) => !("refused" in a)) as ApiResult[];
      const refused = answers.filter((a) => "refused" in a) as { refused: string; message: string }[];
      expect(answered.length).toBe(8);
      for (const a of answered) expect(JSON.parse(a.body)).toMatchObject({ result: "0x2a" });
      expect(asWire(answered[0]!)).toEqual(await viaHttp(port, body(JSON.parse(answered[0]!.body).id)));
      expect(refused.length).toBe(77);
      for (const r of refused) expect(r).toEqual({ refused: "busy", message: "the JSON RPC module is answering 8 requests: try again once one is answered" });
    } finally {
      await host.close();
    }

    // Switched off while requests wait for their slots (500 ms apart): they are answered module-off at once.
    const slow = jsonRpcHost(memorySettingsStore(), paced(500));
    try {
      await slow.host.boot();
      const batch = (n: number): string => JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: "2.0", id: n * 10 + i, method: "eth_blockNumber" })));
      const waiting = Array.from({ length: 4 }, (_, n) => jsonrpc(slow.host, batch(n)));
      await until(() => slow.modules.started === 1, "the module to start");
      await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      await ok(slow.host, "module", { module: "jsonrpc", enabled: false });
      const results = await Promise.all(waiting);
      expect(performance.now() - t0).toBeLessThan(2_000);
      for (const r of results) expect(r).toEqual({ refused: "module-off", message: "the JSON RPC module was switched off before this request was answered" });
      await until(() => slow.modules.closed === 1, "the module's database to close", 2_000);
    } finally {
      await slow.host.close();
    }
  }, 120_000);

  /** A `fetch` over the recorded indexer whose answers wait until `release()`, ignoring the abort signal (a request
   *  already on its way). */
  function gatedFetch(): { fetch: typeof fetch; release(): void; waiting(): number } {
    const recorded = recordedIndexerFetch().fetch;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let waiting = 0;
    return {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        waiting++;
        await opened;
        waiting--;
        return recorded(input, init);
      }) as typeof fetch,
      release: () => open(),
      waiting: () => waiting,
    };
  }

  it("[[browser.host.jsonrpc-inflight]] switched off with a request in flight: new requests refused at once, the request in flight answered module-off, the database closed only once it has ended; with a fetch that can be cut short, at once", async () => {
    const gated = gatedFetch();
    const one = jsonRpcHost(memorySettingsStore(), counted(), { fetch: gated.fetch });
    try {
      await one.host.boot();
      const inFlight = jsonrpc(one.host, BLOCK);
      await until(() => gated.waiting() === 1, "the request's indexer call in flight");
      await ok(one.host, "module", { module: "jsonrpc", enabled: false });
      expect(await jsonrpc(one.host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
      await new Promise((r) => setTimeout(r, 200));
      // The request in flight still reads: its database stays open.
      expect(one.modules.closed).toBe(0);
      gated.release();
      expect(await inFlight).toEqual({ refused: "module-off", message: "the JSON RPC module was switched off before this request was answered" });
      await until(() => one.modules.closed === 1, "the database to close");
    } finally {
      await one.host.close();
    }

    // A fetch that honours the abort, as a browser's does: the request in flight ends at once.
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const two = jsonRpcHost(memorySettingsStore(), counted(), { fetch: hanging });
    try {
      await two.host.boot();
      const inFlight = jsonrpc(two.host, BLOCK);
      await until(() => two.modules.started === 1, "the module to start");
      await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      await ok(two.host, "module", { module: "jsonrpc", enabled: false });
      expect(await inFlight).toMatchObject({ refused: "module-off" });
      expect(performance.now() - t0).toBeLessThan(1_000);
      await until(() => two.modules.closed === 1, "the database to close", 1_000);
    } finally {
      await two.host.close();
    }
  }, 60_000);

  it("[[browser.host.jsonrpc-single]] switched off and on again while a request is in flight: the new module starts only once the old one has closed, never two at once, and answers as Node", async () => {
    const gated = gatedFetch();
    const { host, modules } = jsonRpcHost(memorySettingsStore(), counted(), { fetch: gated.fetch });
    try {
      await host.boot();
      const inFlight = jsonrpc(host, BLOCK);
      await until(() => gated.waiting() === 1, "the request's indexer call in flight");
      await ok(host, "module", { module: "jsonrpc", enabled: false });
      await ok(host, "module", { module: "jsonrpc", enabled: true });
      const next = jsonrpc(host, CHAIN_ID);
      await new Promise((r) => setTimeout(r, 300));
      expect(modules.started).toBe(1);
      gated.release();
      expect(await inFlight).toMatchObject({ refused: "module-off" });
      expect(asWire(await next)).toEqual(await viaHttp(port, CHAIN_ID));
      expect([modules.started, modules.closed, modules.maxOpen]).toEqual([2, 1, 1]);
    } finally {
      await host.close();
    }
  }, 60_000);

  it("[[browser.host.shared-pacing]] one pacing queue per endpoint origin for the worker: the sync's and the JSON RPC module's requests to the public indexer start 250 ms apart together; the module gets the same queue after an off/on; a 429 to the module holds the origin for its Retry-After", async () => {
    const replay = createTapeReplay(await loadTape("u1", fileFetch()));
    const starts: Array<{ origin: string; who: "sync" | "jsonrpc"; at: number }> = [];
    let throttleNext = false;
    const recorded = recordedIndexerFetch().fetch;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = await request.text();
      // The module's queries select the block's author or look a transaction up; the sync's do neither.
      const who = url.origin === new URL(BROWSER_INDEXER_URL).origin && (body.includes("author") || body.includes("transactions(offset")) ? "jsonrpc" : "sync";
      starts.push({ origin: url.origin, who, at: performance.now() });
      if (who === "jsonrpc") {
        if (throttleNext) {
          throttleNext = false;
          return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
        }
        return recorded(input, { ...init, body });
      }
      const a = await replay.answer(`${url.origin}${url.pathname}`.replace(/\/$/, "") === BROWSER_NODE_URL ? "/rpc" : "/graphql", body);
      return new Response(a.body, { status: a.status, headers: a.headers });
    }) as typeof fetch;
    const pacers: unknown[] = [];
    const modules = counted();
    const start = modules.start;
    modules.start = (o) => {
      pacers.push(o.pacer);
      return start(o);
    };
    const { host } = jsonRpcHost(memorySettingsStore(), modules, { nodeUrl: BROWSER_NODE_URL, indexerUrl: BROWSER_INDEXER_URL, fetch: fetchImpl });
    try {
      await ok(host, "start", { config: { startHeight: U1.from, endHeight: U1.from + 3, sync: { idleMs: 100 }, scan: { idleMs: 100 } } });
      // The module's requests while the sync runs.
      let id = 0;
      while ((await ok<HostStatus>(host, "status")).engine?.status.sync.phase !== "done") {
        const a = await jsonrpc(host, JSON.stringify({ jsonrpc: "2.0", id: id++, method: "eth_blockNumber" }));
        expect(JSON.parse((a as ApiResult).body)).toMatchObject({ result: "0x2a" });
      }
      const indexer = starts.filter((x) => x.origin === new URL(BROWSER_INDEXER_URL).origin);
      expect(indexer.filter((x) => x.who === "sync").length).toBeGreaterThanOrEqual(4);
      expect(indexer.filter((x) => x.who === "jsonrpc").length).toBeGreaterThanOrEqual(2);
      const gaps = indexer.slice(1).map((x, i) => Math.round(x.at - indexer[i]!.at));
      expect(gaps.filter((g) => g < 245), JSON.stringify(gaps)).toEqual([]);

      // Off and on again: the new module paces with the same queue.
      await ok(host, "module", { module: "jsonrpc", enabled: false });
      await ok(host, "module", { module: "jsonrpc", enabled: true });
      expect(JSON.parse(((await jsonrpc(host, CHAIN_ID)) as ApiResult).body)).toMatchObject({ result: "0x960" });
      expect(pacers.length).toBe(2);
      expect(pacers[0]).toBeDefined();
      expect(pacers[1]).toBe(pacers[0]);

      // A 429 (Retry-After: 1) to the module: answered -32603 as Node answers it; the origin's next request waits 1 s.
      throttleNext = true;
      const throttled = (await jsonrpc(host, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }))) as ApiResult;
      expect(JSON.parse(throttled.body)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } });
      const at429 = starts.at(-1)!.at;
      expect(JSON.parse(((await jsonrpc(host, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }))) as ApiResult).body)).toMatchObject({ result: "0x2a" });
      expect(starts.at(-1)!.at - at429).toBeGreaterThanOrEqual(995);
    } finally {
      await host.close();
    }
  }, 120_000);

  it("[[browser.host.stop-during-hold]] a Retry-After hold on the indexer's origin (60 s at most) never holds a stop, the module's switch or the worker's close: the sync's wait for its turn ends at once and its request is never made", async () => {
    const replay = createTapeReplay(await loadTape("u1", fileFetch()));
    const indexerOrigin = new URL(BROWSER_INDEXER_URL).origin;
    const fetches: Array<{ who: "sync" | "jsonrpc"; at: number }> = [];
    let retryAfter = "3";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = await request.text();
      // The module's queries select the block's author or look a transaction up; the sync's do neither.
      const who = url.origin === indexerOrigin && (body.includes("author") || body.includes("transactions(offset")) ? "jsonrpc" : "sync";
      if (url.origin === indexerOrigin) fetches.push({ who, at: performance.now() });
      if (who === "jsonrpc") return new Response("slow down", { status: 429, headers: { "retry-after": retryAfter } });
      const a = await replay.answer(`${url.origin}${url.pathname}`.replace(/\/$/, "") === BROWSER_NODE_URL ? "/rpc" : "/graphql", body);
      return new Response(a.body, { status: a.status, headers: a.headers });
    }) as typeof fetch;
    const { host } = jsonRpcHost(memorySettingsStore(), counted(), { nodeUrl: BROWSER_NODE_URL, indexerUrl: BROWSER_INDEXER_URL, fetch: fetchImpl });
    const state = (): Promise<JsonRpcStateResult> => ok<JsonRpcStateResult>(host, "jsonrpc-state");
    const untilWaiting = async (): Promise<void> => {
      for (const end = Date.now() + 10_000; (await state()).pacing.waiting === 0; ) {
        if (Date.now() > end) throw new Error("timed out waiting for the sync's request to wait for its turn");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    /** A stop, with how long it took (or "still stopping" after 5 s). */
    const timedStop = async (): Promise<number | "still stopping"> => {
      const t0 = performance.now();
      const stopped = ok<HostStatus>(host, "stop").then(() => performance.now() - t0);
      return Promise.race([stopped, new Promise<"still stopping">((r) => setTimeout(() => r("still stopping"), 5_000))]);
    };
    const config = { startHeight: U1.from, endHeight: U1.from + 3, sync: { idleMs: 100 }, scan: { idleMs: 100 } };
    const blockNumber = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" });
    let closed = false;
    try {
      // A 429 with Retry-After: 3 to the module holds the indexer's origin for 3 s.
      expect(JSON.parse(((await jsonrpc(host, blockNumber)) as ApiResult).body)).toMatchObject({ error: { code: -32603 } });
      expect((await state()).pacing.heldForMs).toBeGreaterThan(2_000);
      // The engine starts; its indexer request waits for the origin's turn; the stop ends that wait at once.
      await ok(host, "start", { config });
      await untilWaiting();
      const stopAt = performance.now();
      const took = await timedStop();
      expect(took).toBeLessThan(1_500);
      expect((await state()).pacing.waiting).toBe(0);
      expect((await ok<HostStatus>(host, "status")).engine?.status.sync.phase).not.toBe("running");
      // The hold ends: the request the sync had queued is never made.
      for (const end = Date.now() + 10_000; (await state()).pacing.heldForMs > 0; ) {
        if (Date.now() > end) throw new Error("timed out waiting for the hold to end");
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 500));
      expect(fetches.filter((f) => f.who === "sync" && f.at >= stopAt)).toEqual([]);

      // Retry-After: 600 holds the origin for 60 s at most; a stop is as prompt.
      retryAfter = "600";
      await jsonrpc(host, blockNumber);
      const held = (await state()).pacing.heldForMs;
      expect(held).toBeGreaterThan(55_000);
      expect(held).toBeLessThanOrEqual(60_000);
      await ok(host, "start", { config });
      await untilWaiting();
      // The module's switch, off and on, while the sync waits through the hold: answered at once.
      for (const enabled of [false, true]) {
        const t0 = performance.now();
        await ok(host, "module", { module: "jsonrpc", enabled });
        expect(performance.now() - t0, `module ${enabled ? "on" : "off"}`).toBeLessThan(1_500);
      }
      expect(await timedStop()).toBeLessThan(1_500);
      expect((await state()).pacing.waiting).toBe(0);
      // Closing the worker while the origin is held: prompt too.
      await ok(host, "start", { config });
      await untilWaiting();
      const t1 = performance.now();
      await host.close();
      closed = true;
      expect(performance.now() - t1).toBeLessThan(3_000);
    } finally {
      if (!closed) await host.close();
    }
  }, 60_000);

  it("[[browser.host.stop-during-burst]] a burst of JSON-RPC calls puts at most 8 of the module's indexer requests in the origin's queue, and a stop of the sync while they wait is prompt; the calls are answered as Node", async () => {
    const replay = createTapeReplay(await loadTape("u1", fileFetch()));
    const indexerOrigin = new URL(BROWSER_INDEXER_URL).origin;
    const recorded = recordedIndexerFetch().fetch;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = await request.text();
      if (url.origin === indexerOrigin && (body.includes("author") || body.includes("transactions(offset"))) return recorded(input, { ...init, body });
      const a = await replay.answer(`${url.origin}${url.pathname}`.replace(/\/$/, "") === BROWSER_NODE_URL ? "/rpc" : "/graphql", body);
      return new Response(a.body, { status: a.status, headers: a.headers });
    }) as typeof fetch;
    const { host } = jsonRpcHost(memorySettingsStore(), counted(), { nodeUrl: BROWSER_NODE_URL, indexerUrl: BROWSER_INDEXER_URL, fetch: fetchImpl });
    const state = (): Promise<JsonRpcStateResult> => ok<JsonRpcStateResult>(host, "jsonrpc-state");
    const batch = (n: number): string => JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ jsonrpc: "2.0", id: n * 8 + i, method: "eth_blockNumber" })));
    try {
      // The module's start first, so the burst is all indexer requests.
      await jsonrpc(host, CHAIN_ID);
      await ok(host, "start", { config: { startHeight: U1.from, endHeight: U1.to, sync: { idleMs: 100 }, scan: { idleMs: 100 } } });
      // 8 batches of 8 indexer-backed calls at once, 250 ms apart in the origin's queue: 64 requests, 16 s of turns.
      const burst = Array.from({ length: 8 }, (_, n) => jsonrpc(host, batch(n)));
      let most = 0;
      for (const end = Date.now() + 1_500; Date.now() < end; ) {
        most = Math.max(most, (await state()).pacing.waiting);
        await new Promise((r) => setTimeout(r, 20));
      }
      // The module's own indexer requests waiting for a turn: at most 8 (the sync's own on top).
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThanOrEqual(8 + 4);
      const t0 = performance.now();
      await ok(host, "stop");
      expect(performance.now() - t0).toBeLessThan(1_500);
      for (const [n, a] of (await Promise.all(burst)).entries()) expect(asWire(a), `batch ${n}`).toEqual(await viaHttp(port, batch(n)));
    } finally {
      await host.close();
    }
  }, 120_000);

  it("[[browser.host.jsonrpc-start-bounded]] while the module starts, 8 requests are admitted and each further one is refused busy at once; each slot is held until its answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const modules = counted();
    const start = modules.start;
    modules.start = async (o) => {
      await gate;
      return start(o);
    };
    const { host } = jsonRpcHost(memorySettingsStore(), modules);
    const state = (): Promise<JsonRpcStateResult> => ok<JsonRpcStateResult>(host, "jsonrpc-state");
    const chainId = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_chainId" });
    /** The answer, or "still waiting" after 2 s. */
    const within = <T>(p: Promise<T>): Promise<T | "still waiting"> => Promise.race([p, new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), 2_000))]);
    try {
      expect((await host.boot()).phase).toBe("ready");
      const held = Array.from({ length: JSONRPC_MAX_REQUESTS }, (_, i) => jsonrpc(host, chainId(100 + i)));
      for (const end = Date.now() + 10_000; (await state()).calls.inFlight < JSONRPC_MAX_REQUESTS; ) {
        if (Date.now() > end) throw new Error("timed out waiting for the requests in flight");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await state()).database).toBe("starting");
      // The ninth, and twenty more: refused busy at once, none admitted.
      expect(await within(jsonrpc(host, chainId(9)))).toMatchObject({ refused: "busy" });
      const more = await within(Promise.all(Array.from({ length: 20 }, (_, i) => jsonrpc(host, chainId(200 + i)))));
      expect(more === "still waiting" ? more : more.map((r) => ("refused" in r ? r.refused : "answered"))).toEqual(Array(20).fill("busy"));
      expect((await state()).calls).toEqual({ answered: 0, inFlight: JSONRPC_MAX_REQUESTS, refusedBusy: 21, refusedOff: 0, failed: 0 });
      // The start ends: the 8 are answered as Node answers them; a new request is admitted again.
      release();
      for (const [i, a] of (await Promise.all(held)).entries()) expect(asWire(a)).toEqual(await viaHttp(port, chainId(100 + i)));
      expect((await state()).calls).toEqual({ answered: JSONRPC_MAX_REQUESTS, inFlight: 0, refusedBusy: 21, refusedOff: 0, failed: 0 });
      expect(asWire(await jsonrpc(host, CHAIN_ID))).toEqual(await viaHttp(port, CHAIN_ID));
      expect(modules.started).toBe(1);
    } finally {
      release();
      await host.close();
    }
  }, 60_000);

  it("[[browser.host.jsonrpc-chain-id]] the module reports the chain ID the worker gives it (the build's), and Node's default without one", async () => {
    const given = jsonRpcHost(memorySettingsStore(), counted(), { jsonRpc: { clientVersion: CLIENT_VERSION, chainId: 2401n } });
    try {
      expect(JSON.parse(((await jsonrpc(given.host, CHAIN_ID)) as ApiResult).body)).toMatchObject({ result: "0x961" });
      expect(JSON.parse(((await jsonrpc(given.host, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "net_version" }))) as ApiResult).body)).toMatchObject({ result: "2401" });
    } finally {
      await given.host.close();
    }
    const plain = jsonRpcHost(memorySettingsStore());
    try {
      expect(JSON.parse(((await jsonrpc(plain.host, CHAIN_ID)) as ApiResult).body)).toMatchObject({ result: "0x960" });
    } finally {
      await plain.host.close();
    }
  }, 60_000);

  it("[[browser.host.jsonrpc-state]] the module's state: the switch, the database, the methods' counts, the chain ID, client version and indexer given, the calls as they happen, the indexer origin's pacing queue, the last error", async () => {
    const recorded = recordedIndexerFetch().fetch;
    let answer: "recorded" | "500" | "429" = "recorded";
    let gate: Promise<void> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (gate !== undefined) await gate;
      if (answer === "500") return new Response("down", { status: 500 });
      if (answer === "429") {
        answer = "recorded";
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      }
      return recorded(input, init);
    }) as typeof fetch;
    const modules = counted();
    modules.fail = 1;
    const { host } = jsonRpcHost(memorySettingsStore(), modules, { fetch: fetchImpl, jsonRpc: { clientVersion: CLIENT_VERSION, chainId: 2401n, start: modules.start } });
    const state = async (): Promise<JsonRpcStateResult> => JsonRpcStateResultSchema.parse(await ok<JsonRpcStateResult>(host, "jsonrpc-state"));
    const blockNumber = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber" });
    const untilState = async (what: string, cond: (s: JsonRpcStateResult) => boolean, timeoutMs = 10_000): Promise<JsonRpcStateResult> => {
      for (const end = Date.now() + timeoutMs; ; ) {
        const s = await state();
        if (cond(s)) return s;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const rows = methodRows();
    try {
      // Before the first call: no database, nothing counted; the methods are the tab's list's.
      expect(await state()).toEqual({
        enabled: true,
        database: "none",
        chainId: "2401",
        clientVersion: CLIENT_VERSION,
        indexerUrl: INDEXER,
        methods: { served: rows.filter((r) => r.kind === "served").length, notImplemented: NOT_IMPLEMENTED_METHODS.length, nodeOnly: NODE_ONLY_METHODS.length },
        calls: { answered: 0, inFlight: 0, refusedBusy: 0, refusedOff: 0, failed: 0 },
        pacing: { origin: new URL(INDEXER).origin, minIntervalMs: defaultMinIntervalMs(INDEXER), waiting: 0, heldForMs: 0 },
        lastError: null,
      });
      expect((await state()).methods.served).toBe(Object.keys(METHOD_NOTES).length);

      // A start that fails: counted as failed, and the last error.
      const t0 = Date.now();
      expect(await jsonrpc(host, CHAIN_ID)).toMatchObject({ refused: "internal" });
      let s = await state();
      expect([s.database, s.calls]).toEqual(["none", { answered: 0, inFlight: 0, refusedBusy: 0, refusedOff: 0, failed: 1 }]);
      expect(s.lastError).toEqual({ at: expect.any(Number), message: "the JSON RPC module could not start: no memory for another database" });
      expect(s.lastError!.at).toBeGreaterThanOrEqual(t0);

      // Answered: the database open.
      await jsonrpc(host, CHAIN_ID);
      await jsonrpc(host, BLOCK);
      s = await state();
      expect([s.database, s.calls]).toEqual(["open", { answered: 2, inFlight: 0, refusedBusy: 0, refusedOff: 0, failed: 1 }]);

      // In flight: as many as the module takes, held at the indexer; one more refused busy.
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      const held = Array.from({ length: JSONRPC_MAX_REQUESTS }, (_, i) => jsonrpc(host, blockNumber(100 + i)));
      await untilState("the requests in flight", (x) => x.calls.inFlight === JSONRPC_MAX_REQUESTS);
      expect(await jsonrpc(host, CHAIN_ID)).toMatchObject({ refused: "busy" });
      expect((await state()).calls).toEqual({ answered: 2, inFlight: JSONRPC_MAX_REQUESTS, refusedBusy: 1, refusedOff: 0, failed: 1 });
      gate = undefined;
      release();
      await Promise.all(held);
      expect((await state()).calls).toEqual({ answered: 2 + JSONRPC_MAX_REQUESTS, inFlight: 0, refusedBusy: 1, refusedOff: 0, failed: 1 });

      // The indexer answers an HTTP error: the last error says which origin and what.
      answer = "500";
      const t1 = Date.now();
      expect(JSON.parse(((await jsonrpc(host, blockNumber(7))) as ApiResult).body)).toMatchObject({ error: { code: -32603 } });
      answer = "recorded";
      s = await state();
      expect(s.lastError).toEqual({ at: expect.any(Number), message: `${new URL(INDEXER).origin} answered HTTP 500` });
      expect(s.lastError!.at).toBeGreaterThanOrEqual(t1);

      // A 429 with Retry-After: the origin's queue held, the next request waiting in it.
      answer = "429";
      await jsonrpc(host, blockNumber(8));
      s = await state();
      expect(s.pacing.heldForMs).toBeGreaterThan(1_000);
      expect(s.pacing.heldForMs).toBeLessThanOrEqual(2_000);
      expect(s.lastError?.message).toBe(`${new URL(INDEXER).origin} answered HTTP 429`);
      const waiting = jsonrpc(host, blockNumber(9));
      expect((await untilState("the request to wait in the queue", (x) => x.pacing.waiting > 0, 1_500)).pacing.waiting).toBe(1);
      expect(JSON.parse(((await waiting) as ApiResult).body)).toMatchObject({ result: "0x2a" });
      expect((await state()).pacing).toMatchObject({ waiting: 0, heldForMs: 0 });

      // Off: refused off counted, the database gone; the last error outlives the module.
      await ok(host, "module", { module: "jsonrpc", enabled: false });
      expect(await jsonrpc(host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
      s = await untilState("the module's database to close", (x) => x.database === "none");
      expect(modules.closed).toBe(1);
      expect([s.enabled, s.database, s.calls.refusedOff, s.lastError?.message]).toEqual([false, "none", 1, `${new URL(INDEXER).origin} answered HTTP 429`]);
      // On again: no database until the next call.
      await ok(host, "module", { module: "jsonrpc", enabled: true });
      expect((await state()).database).toBe("none");
      await jsonrpc(host, CHAIN_ID);
      expect((await state()).database).toBe("open");
    } finally {
      await host.close();
    }
    // The public indexer's queue is the one the state shows.
    const pub = jsonRpcHost(memorySettingsStore(), counted(), { indexerUrl: BROWSER_INDEXER_URL });
    try {
      expect((await ok<JsonRpcStateResult>(pub.host, "jsonrpc-state")).pacing).toEqual({ origin: new URL(BROWSER_INDEXER_URL).origin, minIntervalMs: 250, waiting: 0, heldForMs: 0 });
    } finally {
      await pub.host.close();
    }

    // While the store is replaced (a range), the state is answered, as a call is: it waits for the new store.
    const tape = jsonRpcHost(memorySettingsStore());
    try {
      await ok(tape.host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { idleMs: 100 }, scan: { idleMs: 100 } } });
      await untilStatus(tape.host, "the U1 range", (st) => st.cursors?.scan?.nextHeight === U1.to + 1);
      const answers: string[] = [];
      let polling = true;
      const poll = (async () => {
        while (polling) {
          const r = await send(tape.host, "jsonrpc-state");
          answers.push(r.ok ? "state" : `${r.error.code}: ${r.error.message}`);
          await new Promise((res) => setTimeout(res, 5));
        }
      })();
      const replaced = ok<HostStatus>(tape.host, "range", { startHeight: U1.from + 10, endHeight: U1.to });
      const call = jsonrpc(tape.host, CHAIN_ID);
      await replaced;
      polling = false;
      await poll;
      expect(asWire(await call)).toEqual(await viaHttp(port, CHAIN_ID));
      expect(answers.length).toBeGreaterThan(1);
      expect(answers.filter((a) => a !== "state")).toEqual([]);
    } finally {
      await tape.host.close();
    }
  }, 120_000);

  it("[[browser.host.settings-unknown-module]] settings naming a module this build does not know are read (the configuration kept, the known switches applied) and the unknown one written back; other fields keep their rules", async () => {
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 2 };
    const settings = memorySettingsStore({ config, autoStart: false, modules: { "a-later-module": false, jsonrpc: false } });
    const { host } = jsonRpcHost(settings);
    try {
      expect((await host.boot()).phase).toBe("ready");
      const s = await ok<HostStatus>(host, "status");
      expect(s.settings).toEqual({ config, autoStart: false, modules: { "a-later-module": false, jsonrpc: false } });
      expect(await jsonrpc(host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
      await ok(host, "module", { module: "token-indexer", enabled: false });
      expect((await settings.load())?.modules).toEqual({ "a-later-module": false, jsonrpc: false, "token-indexer": false });
      expect((await send(host, "module", { module: "a-later-module", enabled: true })).ok).toBe(false);
    } finally {
      await host.close();
    }
    // A file whose other fields break their rules is still not read.
    expect(await memorySettingsStore({ config, autoStart: false, extra: 1 }).load()).toBeUndefined();
    expect(await memorySettingsStore({ config, autoStart: false, modules: { jsonrpc: "off" } }).load()).toBeUndefined();
  }, 60_000);

  it("[[browser.host.settings-module-bound]] settings naming 64 modules this build does not know: a switch is saved within the bound (the build's modules kept, the oldest unknown one dropped), so the next worker still reads the settings", async () => {
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 2 };
    const unknown = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`a-later-module-${i}`, i % 2 === 0]));
    const settings = memorySettingsStore({ config, autoStart: false, modules: unknown });
    expect(await settings.load()).toEqual({ config, autoStart: false, modules: unknown });
    const { host } = jsonRpcHost(settings);
    try {
      expect((await host.boot()).phase).toBe("ready");
      const on = await ok<HostStatus>(host, "module", { module: "jsonrpc", enabled: false });
      const saved = await settings.load();
      expect(saved).toBeDefined();
      expect(saved!.config).toEqual(config);
      expect(saved!.autoStart).toBe(false);
      const ids = Object.keys(saved!.modules!);
      expect(ids.length).toBe(64);
      expect(ids[0]).toBe("jsonrpc");
      expect(saved!.modules!.jsonrpc).toBe(false);
      expect(ids).not.toContain("a-later-module-0");
      expect(ids.slice(1)).toEqual(Array.from({ length: 63 }, (_, i) => `a-later-module-${i + 1}`));
      expect(on.settings?.modules).toEqual(saved!.modules);
      // The token indexer's switch too: both of the build's modules kept, the next oldest unknown one dropped.
      await ok(host, "module", { module: "token-indexer", enabled: false });
      const both = Object.keys((await settings.load())!.modules!);
      expect([both.length, both.slice(0, 2).sort(), both.includes("a-later-module-1")]).toEqual([64, ["jsonrpc", "token-indexer"], false]);
      expect(await jsonrpc(host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
    } finally {
      await host.close();
    }
    // The next worker reads them: the switches hold.
    const next = jsonRpcHost(settings);
    try {
      expect((await next.host.boot()).phase).toBe("ready");
      expect((await ok<HostStatus>(next.host, "status")).settings?.config).toEqual(config);
      expect(await jsonrpc(next.host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
    } finally {
      await next.host.close();
    }
  }, 60_000);

  it("[[browser.host.jsonrpc-restored]] the switch lives in the settings: a new host on them refuses while off and answers once on; range, reset and import keep it off", async () => {
    const settings = memorySettingsStore();
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { idleMs: 100 }, scan: { idleMs: 100 } };
    const first = jsonRpcHost(settings);
    let exported: ExportResult;
    try {
      await ok(first.host, "start", { config });
      await untilStatus(first.host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
      exported = await ok<ExportResult>(first.host, "export");
      await ok(first.host, "module", { module: "jsonrpc", enabled: false });
      expect(await jsonrpc(first.host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
    } finally {
      await first.host.close();
    }

    // A new host on the same settings (a reload, the next worker, the next leader tab): still off.
    const second = jsonRpcHost(settings);
    try {
      expect((await second.host.boot()).phase).toBe("ready");
      expect((await ok<HostStatus>(second.host, "status")).settings?.modules).toEqual({ jsonrpc: false });
      expect(await jsonrpc(second.host, CHAIN_ID)).toMatchObject({ refused: "module-off" });
      await ok(second.host, "start", { config });
      await untilStatus(second.host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);

      // The store replaced by range, reset and import: the switch stays off, and the module stays unmade.
      for (const [type, params] of [["range", { startHeight: U1.from + 10, endHeight: U1.to }], ["reset", {}], ["import", { snapshot: exported!.file }]] as const) {
        await ok(second.host, type, params);
        const s = await ok<HostStatus>(second.host, "status");
        expect(s.settings?.modules, type).toEqual({ jsonrpc: false });
        expect(await jsonrpc(second.host, CHAIN_ID), type).toMatchObject({ refused: "module-off" });
      }
      expect(second.modules.started).toBe(0);
      await ok(second.host, "module", { module: "jsonrpc", enabled: true });
    } finally {
      await second.host.close();
    }

    // On, saved: the next host answers.
    const third = jsonRpcHost(settings);
    try {
      expect(asWire(await jsonrpc(third.host, BLOCK))).toEqual(await viaHttp(port, BLOCK));
    } finally {
      await third.host.close();
    }
  }, 180_000);
});

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A test clock for the pacing queue: its time moves only when `advance` runs the timers due, in order, letting the
 *  admitted callers run after each. */
interface TestClock {
  now: number;
  clock: PacingClock;
  timers: Map<number, { at: number; fn: () => void }>;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
}
function testClock(): TestClock {
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const t: TestClock = {
    now: 0,
    timers,
    clock: {
      now: () => t.now,
      setTimer: (fn: () => void, ms: number): number => {
        const id = nextTimer++;
        timers.set(id, { at: t.now + ms, fn });
        return id;
      },
      clearTimer: (id: unknown): void => {
        timers.delete(id as number);
      },
    },
    settle,
    async advance(ms: number): Promise<void> {
      const end = t.now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (due === undefined) break;
        t.now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      t.now = end;
      await settle();
    },
  };
  return t;
}
