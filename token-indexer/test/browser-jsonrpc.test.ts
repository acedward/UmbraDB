/**
 * The browser engine's JSON RPC module (`../browser/jsonrpc-module.ts`) in Node, on the production PGlite client and
 * the recorded indexer (`evm-rpc/test/recorded-indexer.ts`).
 *
 * - `[[browser.jsonrpc.module]]` — the module's `evm_rpc` database is a new in-memory PGlite made by the module's
 *   migrations (every table of the lineage, the three migrations recorded); it serves the read-only registry's
 *   methods; every `POST` case of the differential (every method, refused parameters, the not-implemented and unknown
 *   methods, the envelope, notifications, batches, bodies that are not JSON, the size cap) gets exactly Node's HTTP
 *   answer from `npm run evm-rpc`'s server (status, headers in order, body bytes); once closed it refuses requests and
 *   its database is closed.
 * - `[[browser.jsonrpc.module-rows]]` — rows written to the module's database (plain `Uint8Array` byte values, as the
 *   browser's PGlite reads them) are what the account and transaction methods answer.
 * - `[[browser.jsonrpc.paced]]` — the module's requests to a public indexer start at least 250 ms apart, and those to
 *   any other indexer are not delayed.
 * - `[[browser.jsonrpc.pacing-queue]]` — the module's pacing queue, on a test clock: callers admitted one at a time in
 *   arrival order, the interval apart; a burst beyond its bound refused at once; a cancelled wait gives up its place
 *   and the next caller moves up; closing it ends every wait.
 * - `[[browser.jsonrpc.burst]]` — a burst of requests whose indexer calls wait far longer than the indexer timeout for
 *   their pacing slots (8 batches of 8 at 30 ms apart, against a 200 ms timeout): every answer is Node's, every indexer
 *   request starts with a live timeout, the starts the interval apart; a request beyond the module's 8 in flight is
 *   refused `busy` at once, and accepted again once one is answered.
 * - `[[browser.jsonrpc.stop-cancels]]` — closing the module while its requests wait for pacing slots ends them at once
 *   (refused `stopped`, their indexer calls never made) and closes its database without waiting for their slots.
 * - `[[browser.jsonrpc.model]]` — the tab's rows are the registry's methods, each once (served ones with their source
 *   and example parameters, not-implemented ones with their classification), then the Node-only methods, marked and
 *   not callable; a call's request is a JSON-RPC 2.0 request with the edited parameters (none when empty, refused when
 *   not JSON or too long); an answer is shown with its status and its body indented (as it is when not JSON). * - `[[browser.jsonrpc.model-bounds]]` — parameters the tab cannot send or show are refused with a message, never an
 *   exception: nesting deeper than the bound (also deep enough to break serialization), and parameters whose indented
 *   text would be too long to show; an answer too long to show is shown cut, with its length.
 * - `[[browser.host.jsonrpc]]` — the worker host answers `jsonrpc` with Node's answers while the module is on (by
 *   default), making the module's database at the first request; `module` `jsonrpc` off is saved first, then requests
 *   are refused `module-off` and the module's database is closed; on again, a new one answers; the token indexer's
 *   switch is its own; a switch the browser refuses to save changes nothing (`settings-failed`, still answered); a
 *   module that fails to start answers `internal` and the next request starts it again; requests without a string body
 *   or over the bound are `bad-request`, and reading a request never throws.
 * - `[[browser.host.jsonrpc-bounded]]` — the worker host refuses a `jsonrpc` request beyond the module's bound `busy` (85
 *   at once: 8 answered as Node does, the rest refused, none answered with an error of the module's own), and requests
 *   waiting for pacing slots when the module is switched off are answered `module-off` at once.
 * - `[[browser.host.jsonrpc-restored]]` — the switch lives in the settings: a new host on them (a reload, the next
 *   worker or leader tab) refuses while it is off and answers once on; a store replaced by `range`, `reset` or
 *   `import` keeps it off.
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../../evm-rpc/db.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";
import { createRpcServer } from "../../evm-rpc/server.js";
import { differentialCases } from "../../evm-rpc/test/differential-cases.js";
import { BLOCK_HASH, HEIGHT, recordedIndexerFetch, TX_HASH } from "../../evm-rpc/test/recorded-indexer.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { METHOD_NOTES, NODE_ONLY_METHODS } from "../../evm-rpc/method-info.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { answerText, buildRequest, MAX_PARAMS_CHARS, MAX_PARAMS_DEPTH, MAX_SHOWN_CHARS, methodRows, registryMethods } from "../browser/jsonrpc-model.ts";
import { JSONRPC_CHAIN_ID, JSONRPC_MAX_REQUESTS, jsonRpcClientVersion, type JsonRpcModule, JsonRpcModuleError, type JsonRpcModuleOptions, openEvmRpcDatabase, startJsonRpcModule } from "../browser/jsonrpc-module.ts";
import { PacingQueue, QueueFullError } from "../browser/pacing-queue.ts";
import type { WorkerHost } from "../browser/host.ts";
import { type ApiResult, type ExportResult, type HostStatus, JSONRPC_MAX_BODY_CHARS, parseRequest, PROTOCOL_VERSION, type Response as HostResponse, type StartConfig } from "../browser/protocol.ts";
import { type EngineSettingsStore, memorySettingsStore } from "../browser/settings.ts";
import { testHost, U1, untilStatus } from "./helpers/worker-host.ts";

const INDEXER = "http://127.0.0.1:9/api/v4/graphql";
const CLIENT_VERSION = jsonRpcClientVersion("0.9.5");

interface WireAnswer {
  status: number;
  headers: [string, string][];
  body: string;
}

function viaHttp(port: number, body: string): Promise<WireAnswer> {
  const bytes = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "content-length": bytes.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const headers: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!/^(date|connection|keep-alive)$/i.test(res.rawHeaders[i]!)) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        }
        resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
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
      for (const c of cases) {
        const node = await viaHttp(port, c.body);
        const answer = await module.handle(c.body);
        expect({ status: answer.status, headers: Object.entries(answer.headers), body: answer.body }, c.name).toEqual(node);
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
    let now = 0;
    let nextTimer = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock = {
      now: () => now,
      setTimer: (fn: () => void, ms: number): number => { const id = nextTimer++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimer: (id: unknown): void => { timers.delete(id as number); },
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    /** Runs the timers due within `ms`, in order, letting the admitted callers run after each. */
    const advance = async (ms: number): Promise<void> => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (due === undefined) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    };

    const q = new PacingQueue({ minIntervalMs: 250, maxWaiting: 64, clock });
    const admittedAt = new Map<number, number>();
    const refused: number[] = [];
    const waits = Array.from({ length: 100 }, (_, i) => q.admit().then(() => { admittedAt.set(i, now); }, (e: unknown) => {
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
    const first = q.admit().then(() => order.push(`a@${now}`));
    const second = q.admit(c.signal).then(() => order.push("b"), (e: unknown) => order.push(`b: ${(e as Error).message}`));
    const third = q.admit().then(() => order.push(`c@${now}`));
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

  it("[[browser.jsonrpc.model]] the rows are the registry's methods and the Node-only ones; requests and answers as text", () => {
    expect(registryMethods()).toEqual(registry.listMethods());
    const rows = methodRows();
    const names = rows.map((r) => r.method);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(registry.listMethods().length + NODE_ONLY_METHODS.length);
    const stubs = new Map(NOT_IMPLEMENTED_METHODS.map((m) => [m.method, m]));
    for (const r of rows) {
      if (stubs.has(r.method)) {
        expect(r).toMatchObject({ kind: "not-implemented", callable: true, params: "[]", state: `not implemented (-32004): ${stubs.get(r.method)!.classification}`, note: stubs.get(r.method)!.reason });
      } else if (registry.getMethod(r.method) !== undefined) {
        const note = METHOD_NOTES[r.method]!;
        expect(r).toMatchObject({ kind: "served", callable: true, state: "served here", source: note.source, params: JSON.stringify(note.params) });
      } else {
        expect(NODE_ONLY_METHODS.map((m) => m.method)).toContain(r.method);
        expect(r).toMatchObject({ kind: "node-only", callable: false, state: "served by Node only", params: "" });
      }
    }
    expect(rows.map((r) => r.kind)).toEqual([...rows.map((r) => r.kind)].sort((a, b) => ["served", "node-only", "not-implemented"].indexOf(a) - ["served", "node-only", "not-implemented"].indexOf(b)));
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
  function counted(): { start: (o: JsonRpcModuleOptions) => Promise<JsonRpcModule>; started: number; closed: number; fail: number } {
    const c = {
      started: 0,
      closed: 0,
      fail: 0,
      start: async (o: JsonRpcModuleOptions): Promise<JsonRpcModule> => {
        if (c.fail > 0) {
          c.fail--;
          throw new Error("no memory for another database");
        }
        const m = await startJsonRpcModule(o);
        c.started++;
        return { methods: m.methods, handle: (b) => m.handle(b), close: async () => { c.closed++; await m.close(); } };
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
      c.start = (o) => start({ ...o, minIntervalMs });
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
