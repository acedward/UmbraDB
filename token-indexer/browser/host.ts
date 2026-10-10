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
 * `start` runs a new engine (sync + scan in follow mode) with the given configuration, or the saved one, `stop` stops
 * it; `range` drops the store's data and starts the new range, `reset` drops it and starts the saved configuration
 * again; all four run one at a time, in arrival order. `digest` computes the store's archive and range-tables digests
 * in one read-only transaction (the loops wait for it); `system` watches or refreshes the system snapshot and `watchdog`
 * sets the page's watchdog and starts the heartbeat (`host-system.ts`); `export` and `import` answer `not-implemented`.
 *
 * **Engine**: the engine (`../engine/engine.ts`) runs with a scheduler that yields to the event loop before each step
 * (`scheduler.ts`), so requests and `stop` are served while it syncs; the chain is the network (`fetch` to the node and
 * the indexer) or a recorded range replayed in the worker (`tapes.ts`). A store whose archive has a cursor continues
 * from it, through any gap since it stopped (never jumping to the new tip). A new archive starts at `startHeight`, by
 * default the finalized tip both sources serve, `min(node finalized height, indexer tip)`, resolved when the sync
 * begins: while the endpoints fail the engine waits with back-off, and it never starts at genesis by default. The
 * clients reach PGlite through the session monitor (`session.ts`), which also gives the event loop a turn between
 * statements, so API requests are served between block transactions while a step runs.
 *
 * **Saved configuration** (`settings.ts`): the last `start` configuration or `range`, kept beside the store, and
 * whether the engine should start by itself (`autoStart`; a `stop` request turns it off until the next `start`). A
 * `start` with no configuration runs it; the leader tab sends one when its worker has booted (`tabs.ts`), so a new
 * store starts at the tip and a reopened one resumes, a chosen range keeping its end.
 *
 * **Storage** (`quota.ts`): before each sync batch the guard compares the browser's usage with the quota and pauses the
 * sync before it is reached (`storage` in `status`); it resumes once space frees.
 *
 * **Reopen**: PGlite fails every statement once a database has failed about 1,700 statements (and until it is
 * reopened). The host counts the statements the database fails and, at {@link REOPEN_AFTER_FAILED_STATEMENTS} since
 * the store was opened, or at once when a statement fails with "stack depth limit exceeded", reopens the store: it
 * holds new requests, stops the engine (its steps in flight end, so both cursors are at a full block), lets the
 * requests reading the store end, closes PGlite, opens it again and runs the engine again with the same configuration
 * (it continues at the cursors).
 */
import { archiveDigest, dumpArchive } from "../../chain-archive-sync/archive-digest.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { durabilityModeOf } from "../../src/postgres/durability-probe.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { createIndexerEngine, type EngineClock, type EngineEvent, type EngineOptions, type EngineScheduler, type IndexerEngine, systemClock } from "../engine/engine.ts";
import { rangeTables } from "../engine/range-tables.ts";
import { checkCapabilities } from "./capabilities.ts";
import { type BuildInfo, createHostSystem, type SystemProviders } from "./host-system.ts";
import {
  type BootState,
  type CapabilityReport,
  type DigestResult,
  type EngineSettings,
  type ErrorCode,
  type HostStatus,
  issuesOf,
  type Notice,
  parseRequest,
  PROTOCOL_VERSION,
  type ProtocolError,
  type Request,
  type RequestType,
  type Response,
  type StartConfig,
  StartConfigSchema,
  type StoreInfo,
  type TapeRange,
} from "./protocol.ts";
import { browserStorageEnvironment, createQuotaGuard, type StorageEnvironment } from "./quota.ts";
import { yieldingScheduler } from "./scheduler.ts";
import { STACK_DEPTH_EXCEEDED } from "./session.ts";
import { type EngineSettingsStore, memorySettingsStore, opfsSettingsStore } from "./settings.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, openStore, type OpenStoreOptions, type Store } from "./store.ts";
import { loadTape } from "./tapes.ts";

/** Heights per sync batch unless `start` says otherwise: a stop waits for at most one batch. */
export const DEFAULT_SYNC_MAX_BLOCKS = 20;
/** Blocks per scan step unless `start` says otherwise: API requests are served between steps. */
export const DEFAULT_SCAN_BATCH = 10;

/** Failed statements since the store was opened at which the host reopens it: well below the about 1,700 (`exec`) to
 *  1,870 (`query`) after which PGlite 0.5.8 fails every statement. */
export const REOPEN_AFTER_FAILED_STATEMENTS = 1_000;

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
  /** Default: {@link openStore}. The host passes the session monitor's options. */
  openStore?: (dataDir: string, opts?: OpenStoreOptions) => Promise<Store>;
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
  /** The configuration of a store with no saved one. Default `{}` (the network endpoints, from the finalized tip). */
  defaultStart?: StartConfig;
  /** Where the saved configuration is kept. Default: a file beside an `opfs-ahp://` store, else memory. */
  settings?: EngineSettingsStore;
  /** What the storage guard reads. Default: `navigator.storage` and the store's OPFS directory. */
  storage?: StorageEnvironment;
  /** The storage guard's intervals (`quota.ts`). */
  quota?: { checkEveryMs?: number; recheckMs?: number; storeEveryMs?: number };
  /** Called with the store before `range` or `reset` drops its data (an export can be taken there). */
  beforeWipe?: (store: Store) => Promise<void>;
  /** Facts of the build for the system snapshot. */
  build?: BuildInfo | null;
  /** What the system snapshot reads from other parts of the host (each has a placeholder default, `host-system.ts`). */
  system?: SystemProviders;
  /** Collection intervals of the system snapshot. Default 2 s and 30 s. */
  systemIntervals?: { countersEveryMs?: number; databaseEveryMs?: number };
  /** Time between two turns the session gives the event loop while statements run back to back (`session.ts`). */
  sliceMs?: number;
  /** Failed statements since the store was opened at which it is reopened. Default {@link REOPEN_AFTER_FAILED_STATEMENTS}. */
  reopenAfterFailedStatements?: number;
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
  const consoleLog = opts.log ?? defaultLog;
  const monotonic = opts.monotonic ?? (() => performance.now());
  const clock = opts.clock ?? systemClock;
  const reopenAfter = opts.reopenAfterFailedStatements ?? REOPEN_AFTER_FAILED_STATEMENTS;
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
  const system = createHostSystem({
    clock,
    notify,
    build: opts.build ?? null,
    providers: {
      storage: () => quota.reading(),
      startMode: () => (typeof saved?.config.startHeight === "number" ? "range" : "tip"),
      autoStart: () => saved?.autoStart ?? false,
      ...opts.system,
    },
    ...opts.systemIntervals,
  });
  /** A host line: to the console and to the telemetry's log ring. */
  const log = (level: LogLevel, message: string): void => {
    consoleLog(level, message);
    system.telemetry.log(level, "host", message);
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
  let last: { engine: IndexerEngine; config: StartConfig; error: string | null; run: AbortController } | undefined;
  let booting: Promise<BootState> | undefined;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** The options of each engine the host created (the system snapshot describes the one answering). */
  const optionsOf = new WeakMap<IndexerEngine, EngineOptions>();
  let detachTelemetry: (() => void) | undefined;
  let detachIdle: (() => void) | undefined;
  /** Requests wait for a reopen in progress. */
  let reopening: Promise<void> | undefined;
  let failedSinceOpen = 0;
  /** Requests reading the store now (`status`, `api`, `system`); a reopen waits for them. */
  let reading = 0;

  const settingsStore = opts.settings ?? (opts.dataDir.startsWith("opfs-ahp://") ? opfsSettingsStore(opts.dataDir) : memorySettingsStore());
  /** The saved configuration, read once the store is open. */
  let saved: EngineSettings | undefined;
  const quota = createQuotaGuard({
    env: opts.storage ?? browserStorageEnvironment(opts.dataDir),
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    ...(opts.quota?.checkEveryMs === undefined ? {} : { checkEveryMs: opts.quota.checkEveryMs }),
    ...(opts.quota?.recheckMs === undefined ? {} : { recheckMs: opts.quota.recheckMs }),
    ...(opts.quota?.storeEveryMs === undefined ? {} : { storeEveryMs: opts.quota.storeEveryMs }),
    log,
  });

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
  function engineOf(s: Store, extra: Partial<EngineOptions> = {}): IndexerEngine {
    const options: EngineOptions = {
      sql: s.mip0018,
      archiveSql: s.archive,
      network: opts.network,
      schema: MIP0018_SCHEMA,
      archiveSchema: ARCHIVE_SCHEMA,
      clock,
      ...extra,
    };
    const engine = createIndexerEngine(options);
    optionsOf.set(engine, options);
    return engine;
  }

  /** The session monitor's options for the store the host opens. */
  const storeOptions = (): OpenStoreOptions => ({
    session: { ...(opts.sliceMs === undefined ? {} : { sliceMs: opts.sliceMs }), onFailedStatement },
  });

  /** The engines and the system snapshot of a newly opened store. */
  function useStore(s: Store): void {
    store = s;
    failedSinceOpen = 0;
    idleApi = engineOf(s);
    detachIdle?.();
    detachIdle = system.telemetry.attach(idleApi);
    // Never started: its sync and scan settings only let it read the stored cursors.
    cursorReader = engineOf(s, { sync: { nodeUrl: "http://cursor.invalid/", indexerUrl: "http://cursor.invalid/" }, scan: {} });
    system.bind({
      sql: s.mip0018,
      dataDir: s.dataDir,
      engine: () => active ?? idleApi!,
      engineOptions: () => optionsOf.get(active ?? idleApi!)!,
      browser: () => (bootState.capabilities === null ? null : { browser: bootState.capabilities.browser, checks: { ...bootState.capabilities.checks } }),
    });
  }

  function onFailedStatement(code: string): void {
    system.telemetry.noteFailedStatement();
    failedSinceOpen++;
    if (store === undefined || closed || reopening !== undefined) return;
    if (code !== STACK_DEPTH_EXCEEDED && failedSinceOpen < reopenAfter) return;
    const why = code === STACK_DEPTH_EXCEEDED
      ? `a statement failed with "stack depth limit exceeded" (${code})`
      : `${failedSinceOpen} statements failed since the store was opened`;
    const p = serial(() => reopen(why));
    reopening = p.then(() => undefined, () => undefined).finally(() => { reopening = undefined; });
  }

  async function reopen(reason: string): Promise<void> {
    const s = store;
    if (s === undefined || closed) return;
    const t0 = monotonic();
    const resume = active !== undefined ? last?.config : undefined;
    const engine = active;
    await halt(false);
    while (reading > 0) await clock.sleep(5, new AbortController().signal);
    system.unbind();
    store = undefined;
    try {
      await s.close();
      useStore(await (opts.openStore ?? openStore)(opts.dataDir, storeOptions()));
    } catch (e) {
      bootState.phase = "failed";
      bootState.error = `reopening the store failed: ${messageOf(e)}`;
      system.telemetry.noteFatal(bootState.error);
      log("error", bootState.error);
      announceBoot();
      if (engine !== undefined) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error: bootState.error } });
      return;
    }
    system.telemetry.notePgliteReopen();
    log("warn", `PGlite reopened in ${Math.round(monotonic() - t0)} ms: ${reason}`);
    if (resume !== undefined) {
      try {
        await run(store!, resume, false);
      } catch (e) {
        if (last !== undefined) last.error = messageOf(e);
        log("error", `the engine did not start again after the reopen: ${messageOf(e)}`);
        notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error: messageOf(e) } });
      }
    }
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
        s = await phase("store", "storeMs", () => (opts.openStore ?? openStore)(opts.dataDir, storeOptions()));
        await phase("ledger", "ledgerMs", checkLedger);
        await phase("migrate", "migrateMs", () => migrate(s!));
        storeInfo = await readStoreInfo(s);
      } catch (e) {
        if (s !== undefined) await s.close().catch(() => {});
        throw e;
      }
      saved = (await settingsStore.load()) ?? { config: opts.defaultStart ?? {}, autoStart: true };
      useStore(s);
      bootState.phase = "ready";
      log("info", `store ${s.dataDir} ready (${s.created ? "created" : "reopened"}, PostgreSQL ${storeInfo.serverVersion})`);
      void quota.check({ store: true }).catch(() => {});
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
      settings: saved ?? null,
      storage: quota.status(),
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

  /** The scheduler of a run: before a sync batch, the storage guard admits it (it waits while the sync is paused before
   *  the quota; a stop ends the wait and the batch is not run). */
  const gated = (run: AbortSignal, base: EngineScheduler): EngineScheduler => async (kind, step) => {
    if (kind === "sync") await quota.admit(run);
    return base(kind, step);
  };

  /** Starts `config` (or the saved configuration) and saves it, with the automatic start on. */
  async function start(config: StartConfig | undefined): Promise<HostStatus> {
    const s = await ready();
    if (active !== undefined) throw new HostError("already-running", "the engine is running; stop it first");
    const effective = config ?? saved?.config ?? opts.defaultStart ?? {};
    await run(s, effective);
    saved = { config: effective, autoStart: true };
    await saveSettings();
    return status();
  }

  async function saveSettings(): Promise<void> {
    try {
      if (saved !== undefined) await settingsStore.save(saved);
    } catch (e) {
      log("warn", `the engine settings could not be saved: ${messageOf(e)}`);
    }
  }

  /** Runs a new engine (sync + scan in follow mode) with `config`. A new archive starts at `config.startHeight`, by
   *  default the finalized tip. Its events go to the telemetry; `announce: false` posts no `engine` notice (a reopen). */
  async function run(s: Store, config: StartConfig, announce = true): Promise<void> {
    const chain = await chainOf(config);
    system.telemetry.setEndpoints({ node: chain.nodeUrl, indexer: chain.indexerUrl });
    const runner = new AbortController();
    let engine: IndexerEngine;
    try {
      engine = engineOf(s, {
        sync: {
          nodeUrl: chain.nodeUrl,
          indexerUrl: chain.indexerUrl,
          startHeight: config.startHeight ?? "tip",
          ...(config.endHeight === undefined ? {} : { endHeight: config.endHeight }),
          maxBlocks: config.sync?.maxBlocks ?? DEFAULT_SYNC_MAX_BLOCKS,
          ...(config.sync?.concurrency === undefined ? {} : { concurrency: config.sync.concurrency }),
          ...(config.sync?.minIntervalMs === undefined ? {} : { minIntervalMs: config.sync.minIntervalMs }),
          ...(config.sync?.idleMs === undefined ? {} : { idleMs: config.sync.idleMs }),
          ...(config.sync?.backoff === undefined ? {} : { backoff: config.sync.backoff }),
        },
        scan: {
          mode: "follow",
          batch: config.scan?.batch ?? DEFAULT_SCAN_BATCH,
          ...(config.scan?.idleMs === undefined ? {} : { idleMs: config.scan.idleMs }),
        },
        fetch: system.telemetry.instrumentFetch(chain.fetch),
        schedule: gated(runner.signal, opts.schedule ?? yieldingScheduler),
        signal: runner.signal,
        onEvent: (e) => {
          const line = logLineOf(e);
          if (line !== undefined) consoleLog(line[0], line[1]);
        },
      });
      detachTelemetry?.();
      detachTelemetry = system.telemetry.attach(engine);
      await engine.start();
    } catch (e) {
      runner.abort();
      throw new HostError("start-failed", messageOf(e));
    }
    const record = { engine, config, error: null as string | null, run: runner };
    active = engine;
    last = record;
    engine.finished.catch((e: unknown) => {
      record.error = messageOf(e);
      if (active === engine) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error: record.error } });
    });
    if (announce) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "running", error: null } });
  }

  /** Stops the running engine; resolves once its steps in flight have ended. `announce: false` posts no `engine`
   *  notice (a reopen). */
  async function halt(announce = true): Promise<void> {
    const engine = active;
    if (engine !== undefined) {
      last?.run.abort();
      await engine.stop();
      active = undefined;
      if (announce) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "stopped", error: last?.error ?? null } });
    }
  }

  /** A `stop` request: halts the engine and turns the automatic start off until the next `start`. */
  async function stop(): Promise<HostStatus> {
    await halt();
    if (saved !== undefined && saved.autoStart && bootState.phase === "ready") {
      saved = { ...saved, autoStart: false };
      await saveSettings();
    }
    return status();
  }

  /**
   * Drops the store's data: both schemas in one transaction (the archive and everything scanned from it), then the
   * migrations again, so the store is as new. The saved configuration stays.
   */
  async function wipe(s: Store): Promise<void> {
    if (opts.beforeWipe !== undefined) await opts.beforeWipe(s);
    await s.archive.begin(async (tx) => {
      await tx`DROP SCHEMA IF EXISTS ${tx(MIP0018_SCHEMA)} CASCADE`;
      await tx`DROP SCHEMA IF EXISTS ${tx(ARCHIVE_SCHEMA)} CASCADE`;
    });
    await migrate(s);
    storeInfo = await readStoreInfo(s);
    log("info", "the store's data was dropped");
  }

  /** A `range` request: a new range means a new archive (one archive has no gaps and no backfill), so the store's data
   *  is dropped and the range starts; the source and tuning of the saved configuration stay. */
  async function range(startHeight: number | "tip", endHeight: number | undefined): Promise<HostStatus> {
    const s = await ready();
    const config: StartConfig = { ...(saved?.config ?? opts.defaultStart ?? {}), startHeight };
    delete config.endHeight;
    if (endHeight !== undefined) config.endHeight = endHeight;
    const valid = StartConfigSchema.safeParse(config);
    if (!valid.success) throw new HostError("bad-request", issuesOf(valid.error));
    await halt();
    await wipe(s);
    return start(config);
  }

  /** A `reset` request: drops the store's data and starts the saved configuration again (a tip start resolves the tip
   *  anew). */
  async function reset(): Promise<HostStatus> {
    const s = await ready();
    await halt();
    await wipe(s);
    return start(undefined);
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

  /** Runs `fn` as a request reading the store: after any reopen in progress, and counted so a reopen waits for it. */
  async function readingStore<T>(fn: () => Promise<T>): Promise<T> {
    while (reopening !== undefined) await reopening;
    reading++;
    try {
      return await fn();
    } finally {
      reading--;
    }
  }

  async function perform(r: Request): Promise<unknown> {
    switch (r.type) {
      case "status":
        return readingStore(status);
      case "api":
        return readingStore(async () => {
          await ready();
          return (active ?? idleApi!).handle(r.method, r.target);
        });
      case "system":
        return readingStore(async () => {
          await ready();
          return system.system(r);
        });
      case "watchdog":
        return system.watchdog(r);
      case "start":
        return serial(() => start(r.config));
      case "range":
        return serial(() => range(r.startHeight, r.endHeight));
      case "reset":
        return serial(() => reset());
      case "stop":
        return serial(() => stop());
      case "digest":
        return readingStore(async () => digest(await ready()));
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
      system.close();
      await serial(async () => {
        await halt();
        closed = true;
      });
      await boot();
      if (store !== undefined) await store.close();
    },
  };
}
