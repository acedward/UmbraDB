/**
 * The browser engine's host: what the worker (`worker.ts`) runs, written against injected dependencies only, so tests
 * drive it in Node with an in-memory PGlite (`memory://`).
 *
 * **Boot**, once, in phases reported to the page as `boot` notices and in `status`:
 * 1. `capabilities`: the capability check (`capabilities.ts`). A refusal ends the boot as `unsupported`; nothing is
 *    opened or started.
 * 2. `store`: PGlite opens the store (`store.ts`); on a first open it creates the database (about a second in Chrome,
 *    with a second PGlite heap while it runs).
 * 3. `ledger`: loads ledger-v9 (WASM) and checks that its classes kept their names: the scan stores a contract action's
 *    class name, so a build that renamed them would write wrong rows. A renamed class fails the boot.
 * 4. `migrate`: both schema lineages, the chain archive's and MIP-0018's, as the Node commands run them.
 * Then `ready`. A failure in 2–4 ends the boot as `failed` and closes the store.
 *
 * **Requests** (`protocol.ts`): `status` answers at any time; `api` waits for the boot and answers through the running
 * engine's API handler, or, while no engine runs, a handler of the same store with no loops (`scanner: "off"`);
 * `start` runs a new engine (sync + scan in follow mode) with the given configuration, `stop` stops it, one at a time;
 * `digest` computes the store's archive and range-tables digests in one read-only transaction (the loops wait for it);
 * `range`, `reset`, `export` and `import` answer `not-implemented`.
 *
 * **Engine**: the engine (`../engine/engine.ts`) runs with a scheduler that yields to the event loop before each step
 * (`scheduler.ts`), so requests and `stop` are served while it syncs; the chain is the network (`fetch` to the node and
 * the indexer) or a recorded range replayed in the worker (`tapes.ts`). A first `start` on an empty archive needs a
 * `startHeight`; a store whose archive has a cursor continues from it.
 */
import { archiveDigest, dumpArchive } from "../../chain-archive-sync/archive-digest.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { durabilityModeOf } from "../../src/postgres/durability-probe.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { createIndexerEngine, type EngineClock, type EngineEvent, type EngineScheduler, type IndexerEngine, systemClock } from "../engine/engine.ts";
import { rangeTables } from "../engine/range-tables.ts";
import { checkCapabilities } from "./capabilities.ts";
import {
  type BootState,
  type CapabilityReport,
  type DigestResult,
  type ErrorCode,
  type HostStatus,
  type Notice,
  parseRequest,
  PROTOCOL_VERSION,
  type ProtocolError,
  type Request,
  type RequestType,
  type Response,
  type StartConfig,
  type StoreInfo,
  type TapeRange,
} from "./protocol.ts";
import { yieldingScheduler } from "./scheduler.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, openStore, type Store } from "./store.ts";
import { loadTape } from "./tapes.ts";

/** Heights per sync batch unless `start` says otherwise: a stop waits for at most one batch. */
export const DEFAULT_SYNC_MAX_BLOCKS = 20;
/** Blocks per scan step unless `start` says otherwise: API requests are served between steps. */
export const DEFAULT_SCAN_BATCH = 10;

/** The ledger-v9 classes whose names the scan stores. */
export const LEDGER_CLASS_NAMES = ["Transaction", "ContractCall", "ContractDeploy", "MaintenanceUpdate"] as const;

export type LogLevel = "info" | "warn" | "error";

export interface WorkerHostOptions {
  /** The network of the store, the sync and the API. */
  network: string;
  /** The PGlite data directory (`opfs-ahp://<name>`, `memory://`). */
  dataDir: string;
  /** The endpoints a `network` source uses when `start` names none. */
  nodeUrl: string;
  indexerUrl: string;
  /** Default: {@link checkCapabilities} on the worker's global scope. */
  checkCapabilities?: () => Promise<CapabilityReport>;
  /** Default: {@link openStore}. */
  openStore?: (dataDir: string) => Promise<Store>;
  /** Loads ledger-v9. Default: `import("@midnightntwrk/ledger-v9")`. */
  loadLedger?: () => Promise<Record<string, unknown>>;
  /** Loads a recorded range. Default: {@link loadTape}. */
  loadTape?: (range: TapeRange) => Promise<ArchiveTape>;
  /** `fetch` of a `network` source. Default: the global `fetch`. */
  fetch?: typeof fetch;
  clock?: EngineClock;
  /** Default: {@link yieldingScheduler}. */
  schedule?: EngineScheduler;
  /** Receives the host's log lines. Default: the console. */
  log?: (level: LogLevel, message: string) => void;
  /** A monotonic clock in milliseconds for the boot timings. Default `performance.now`. */
  monotonic?: () => number;
}

export interface WorkerHost {
  /** Runs the boot once; later calls return the same promise. Never rejects. */
  boot(): Promise<BootState>;
  /** Answers one incoming message. Never rejects: every failure is an error response. */
  receive(raw: unknown): Promise<Response>;
  /** Adds a notice listener; returns the function that removes it. */
  onNotice(listener: (notice: Notice) => void): () => void;
  /** Stops the engine and closes the store. */
  close(): Promise<void>;
}

class HostError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultLog = (level: LogLevel, message: string): void => {
  const line = `[umbradb engine] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/** The events worth a log line (batches and API requests are counted, not logged). */
function logLineOf(e: EngineEvent): [LogLevel, string] | undefined {
  if (e.source === "sync") {
    if (e.event === "start") return ["info", `sync start: ${e.fields.net} from ${e.fields.from} to ${e.fields.to}, cursor ${e.fields.cursor?.height ?? "none"}`];
    if (e.event === "range-complete") return ["info", `sync range complete at ${e.fields.height}`];
    if (e.event === "range-refused") return ["error", `sync range refused: ${e.fields.message}`];
    if (e.event === "error") return ["warn", `sync error (retry in about ${e.fields.retryMs} ms): ${e.fields.message}`];
    if (e.event === "backoff") return ["warn", `sync ${e.fields.operation} retried in ${e.fields.delayMs} ms: ${e.fields.message}`];
    if (e.event === "stop") return ["info", "sync stopped"];
    return undefined;
  }
  if (e.source === "scan" && e.event === "error") return ["warn", `scan error (failure ${e.fields.failures}): ${e.fields.error}`];
  if (e.source === "api" && e.event === "log") return ["error", `api: ${e.fields.line}`];
  return undefined;
}

export function createWorkerHost(opts: WorkerHostOptions): WorkerHost {
  const log = opts.log ?? defaultLog;
  const monotonic = opts.monotonic ?? (() => performance.now());
  const clock = opts.clock ?? systemClock;
  const listeners = new Set<(notice: Notice) => void>();
  const notify = (notice: Notice): void => {
    for (const l of [...listeners]) {
      try {
        l(notice);
      } catch (e) {
        log("error", `notice listener failed: ${messageOf(e)}`);
      }
    }
  };

  const bootState: BootState = {
    phase: "starting",
    error: null,
    capabilities: null,
    timings: { capabilitiesMs: null, storeMs: null, ledgerMs: null, migrateMs: null, totalMs: null },
  };
  const snapshotBoot = (): BootState => ({ ...bootState, timings: { ...bootState.timings } });
  const announceBoot = (): void => notify({ v: PROTOCOL_VERSION, type: "notice", notice: "boot", boot: snapshotBoot() });

  let store: Store | undefined;
  let storeInfo: StoreInfo | undefined;
  /** The API with no loops, answering while no engine runs. */
  let idleApi: IndexerEngine | undefined;
  /** Reads the stored cursors (never started). */
  let cursorReader: IndexerEngine | undefined;
  let active: IndexerEngine | undefined;
  let last: { engine: IndexerEngine; config: StartConfig; error: string | null } | undefined;
  let booting: Promise<BootState> | undefined;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let closed = false;

  async function phase<T>(name: BootState["phase"], key: keyof BootState["timings"], fn: () => Promise<T>): Promise<T> {
    bootState.phase = name;
    announceBoot();
    const t = monotonic();
    try {
      return await fn();
    } finally {
      bootState.timings[key] = monotonic() - t;
    }
  }

  async function checkLedger(): Promise<void> {
    const ledger = await (opts.loadLedger ?? (() => import("@midnightntwrk/ledger-v9") as Promise<Record<string, unknown>>))();
    for (const name of LEDGER_CLASS_NAMES) {
      const cls = ledger[name];
      const actual = typeof cls === "function" ? cls.name : typeof cls;
      if (actual !== name)
        throw new Error(`the ledger build renamed its class ${name} to ${JSON.stringify(actual)}; the scan stores class names, so this build cannot run`);
    }
  }

  async function migrate(s: Store): Promise<void> {
    await bootstrapChainArchiveSchema(s.archive, ARCHIVE_SCHEMA);
    await runMigrations(s.mip0018, { schema: MIP0018_SCHEMA, migrations: mip0018Migrations });
  }

  async function readStoreInfo(s: Store): Promise<StoreInfo> {
    const [settings] = await s.archive<{ version: string; fsync: string }[]>`
      select current_setting('server_version') as version, current_setting('fsync') as fsync`;
    const names = async (sql: Store["archive"], schema: string): Promise<string[]> =>
      (await sql<{ name: string }[]>`select name from ${sql(schema)}._migrations order by name`).map((r) => r.name);
    return {
      dataDir: s.dataDir,
      created: s.created,
      serverVersion: settings!.version,
      fsync: settings!.fsync,
      durability: durabilityModeOf(s.mip0018),
      migrations: { archive: await names(s.archive, ARCHIVE_SCHEMA), mip0018: await names(s.mip0018, MIP0018_SCHEMA) },
    };
  }

  /** An engine over the store; with `loops`, also the sync and scan configuration (used to read cursors or to run). */
  function engineOf(s: Store, extra: Partial<Parameters<typeof createIndexerEngine>[0]> = {}): IndexerEngine {
    return createIndexerEngine({
      sql: s.mip0018,
      archiveSql: s.archive,
      network: opts.network,
      schema: MIP0018_SCHEMA,
      archiveSchema: ARCHIVE_SCHEMA,
      clock,
      ...extra,
    });
  }

  async function runBoot(): Promise<BootState> {
    const t0 = monotonic();
    try {
      const report = await phase("capabilities", "capabilitiesMs", opts.checkCapabilities ?? (() => checkCapabilities()));
      bootState.capabilities = report;
      if (!report.supported) {
        bootState.phase = "unsupported";
        bootState.error = report.message;
        log("error", report.message);
        return snapshotBoot();
      }
      let s: Store | undefined;
      try {
        s = await phase("store", "storeMs", () => (opts.openStore ?? openStore)(opts.dataDir));
        await phase("ledger", "ledgerMs", checkLedger);
        await phase("migrate", "migrateMs", () => migrate(s!));
        storeInfo = await readStoreInfo(s);
      } catch (e) {
        if (s !== undefined) await s.close().catch(() => {});
        throw e;
      }
      store = s;
      idleApi = engineOf(s);
      // Never started: its sync and scan settings only let it read the stored cursors.
      cursorReader = engineOf(s, { sync: { nodeUrl: "http://cursor.invalid/", indexerUrl: "http://cursor.invalid/" }, scan: {} });
      bootState.phase = "ready";
      log("info", `store ${s.dataDir} ready (${s.created ? "created" : "reopened"}, PostgreSQL ${storeInfo.serverVersion})`);
    } catch (e) {
      bootState.phase = "failed";
      bootState.error = messageOf(e);
      log("error", `boot failed: ${bootState.error}`);
    } finally {
      bootState.timings.totalMs = monotonic() - t0;
      announceBoot();
    }
    return snapshotBoot();
  }

  const boot = (): Promise<BootState> => (booting ??= runBoot());

  /** The open store once the boot has succeeded. */
  async function ready(): Promise<Store> {
    await boot();
    if (closed) throw new HostError("internal", "the worker host is closed");
    if (bootState.phase === "unsupported") throw new HostError("unsupported-browser", bootState.error ?? "unsupported browser");
    if (store === undefined) throw new HostError("boot-failed", bootState.error ?? "the boot failed");
    return store;
  }

  async function readCursors(): Promise<HostStatus["cursors"]> {
    if (cursorReader === undefined) return null;
    const [sync, scan] = [await cursorReader.syncCursor(), await cursorReader.scanCursor()];
    return { sync: sync ?? null, scan: scan ?? null };
  }

  async function status(): Promise<HostStatus> {
    return {
      protocol: PROTOCOL_VERSION,
      network: opts.network,
      boot: snapshotBoot(),
      store: storeInfo ?? null,
      engine: last === undefined ? null : { running: active === last.engine, config: last.config, status: last.engine.status(), error: last.error },
      cursors: bootState.phase === "ready" && !closed ? await readCursors() : null,
    };
  }

  /** The node and indexer of a start: the network, or a recorded range replayed here. */
  async function chainOf(config: StartConfig): Promise<{ fetch: typeof fetch; nodeUrl: string; indexerUrl: string }> {
    const source = config.source ?? { kind: "network" as const };
    if (source.kind === "network") {
      const f = opts.fetch;
      return {
        fetch: f === undefined ? (input, init) => fetch(input, init) : f,
        nodeUrl: source.nodeUrl ?? opts.nodeUrl,
        indexerUrl: source.indexerUrl ?? opts.indexerUrl,
      };
    }
    let tape: ArchiveTape;
    try {
      tape = await (opts.loadTape ?? ((r: TapeRange) => loadTape(r)))(source.range);
    } catch (e) {
      throw new HostError("start-failed", `the recorded range ${source.range} could not be loaded: ${messageOf(e)}`);
    }
    if (tape.network !== opts.network) throw new HostError("start-failed", `the recorded range ${source.range} is ${tape.network}, not ${opts.network}`);
    const replay = createTapeFetch(tape, {
      ...(source.finalizedHeight === undefined ? {} : { finalizedHeight: source.finalizedHeight }),
      ...(source.advance === undefined ? {} : { advance: source.advance }),
      now: () => clock.now(),
    });
    return { fetch: replay.fetchImpl, nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl };
  }

  async function start(config: StartConfig): Promise<HostStatus> {
    const s = await ready();
    if (active !== undefined) throw new HostError("already-running", "the engine is running; stop it first");
    const cursor = await cursorReader!.syncCursor();
    if (cursor === undefined && config.startHeight === undefined)
      throw new HostError("start-failed", "the archive is empty: the first start needs a startHeight");
    const chain = await chainOf(config);
    let engine: IndexerEngine;
    try {
      engine = engineOf(s, {
        sync: {
          nodeUrl: chain.nodeUrl,
          indexerUrl: chain.indexerUrl,
          ...(config.startHeight === undefined ? {} : { startHeight: config.startHeight }),
          ...(config.endHeight === undefined ? {} : { endHeight: config.endHeight }),
          maxBlocks: config.sync?.maxBlocks ?? DEFAULT_SYNC_MAX_BLOCKS,
          ...(config.sync?.concurrency === undefined ? {} : { concurrency: config.sync.concurrency }),
          ...(config.sync?.minIntervalMs === undefined ? {} : { minIntervalMs: config.sync.minIntervalMs }),
          ...(config.sync?.idleMs === undefined ? {} : { idleMs: config.sync.idleMs }),
        },
        scan: {
          mode: "follow",
          batch: config.scan?.batch ?? DEFAULT_SCAN_BATCH,
          ...(config.scan?.idleMs === undefined ? {} : { idleMs: config.scan.idleMs }),
        },
        fetch: chain.fetch,
        schedule: opts.schedule ?? yieldingScheduler,
        onEvent: (e) => {
          const line = logLineOf(e);
          if (line !== undefined) log(line[0], line[1]);
        },
      });
      await engine.start();
    } catch (e) {
      throw new HostError("start-failed", messageOf(e));
    }
    const record = { engine, config, error: null as string | null };
    active = engine;
    last = record;
    engine.finished.catch((e: unknown) => {
      record.error = messageOf(e);
      if (active === engine) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error: record.error } });
    });
    notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "running", error: null } });
    return status();
  }

  async function stop(): Promise<HostStatus> {
    const engine = active;
    if (engine !== undefined) {
      await engine.stop();
      active = undefined;
      notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "stopped", error: last?.error ?? null } });
    }
    return status();
  }

  /** The store's archive and range-tables digests, read in one read-only transaction: the loops' statements wait for it
   *  (one session), so both digests describe one state, also while the engine runs. */
  async function digest(s: Store): Promise<DigestResult> {
    const t = monotonic();
    return s.mip0018.begin("read only", async (tx) => {
      const sql = tx as unknown as UmbraDBSql;
      const archive = archiveDigest(await dumpArchive(sql, ARCHIVE_SCHEMA));
      const { digest: tables } = await rangeTables(sql, ARCHIVE_SCHEMA, MIP0018_SCHEMA);
      return { archive, tables, elapsedMs: monotonic() - t };
    });
  }

  /** Runs start/stop one at a time, in arrival order. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = lifecycle.then(fn);
    lifecycle = p.catch(() => {});
    return p;
  }

  const fail = (id: number | null, request: RequestType | null, error: ProtocolError): Response =>
    ({ v: PROTOCOL_VERSION, type: "response", id, request, ok: false, error });
  const ok = (r: Request, result: unknown): Response =>
    ({ v: PROTOCOL_VERSION, type: "response", id: r.id, request: r.type, ok: true, result });

  async function perform(r: Request): Promise<unknown> {
    switch (r.type) {
      case "status":
        return status();
      case "api":
        await ready();
        return (active ?? idleApi!).handle(r.method, r.target);
      case "start":
        return serial(() => start(r.config));
      case "stop":
        return serial(() => stop());
      case "digest":
        return digest(await ready());
      case "range":
      case "reset":
      case "export":
      case "import":
        throw new HostError("not-implemented", `${r.type} is not implemented by this worker`);
    }
  }

  return {
    boot,

    async receive(raw: unknown): Promise<Response> {
      const parsed = parseRequest(raw);
      if (!parsed.ok) return fail(parsed.id, parsed.request, parsed.error);
      const r = parsed.request;
      try {
        return ok(r, await perform(r));
      } catch (e) {
        if (e instanceof HostError) return fail(r.id, r.type, { code: e.code, message: e.message });
        log("error", `${r.type} failed: ${messageOf(e)}`);
        return fail(r.id, r.type, { code: "internal", message: messageOf(e) });
      }
    },

    onNotice(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async close(): Promise<void> {
      await serial(async () => {
        await stop();
        closed = true;
      });
      await boot();
      if (store !== undefined) await store.close();
    },
  };
}
