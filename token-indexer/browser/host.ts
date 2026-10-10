/**
 * The browser engine's host: what the worker (`worker.ts`) runs, written against injected dependencies only, so tests
 * drive it in Node with an in-memory PGlite (`memory://`).
 *
 * **Boot**, once, in phases reported to the page as `boot` notices and in `status`:
 * 1. `capabilities`: the capability check (`capabilities.ts`). A refusal ends the boot as `unsupported`; nothing is
 *    opened or started.
 * 2. `store`: PGlite opens the store (`store.ts`); on a first open it creates the database (about a second in Chrome,
 *    with a second PGlite heap while it runs). Before that, the store's identity file (`store-identity.ts`) is read: a
 *    store another PGlite version wrote is refused unopened. A store whose first boot never completed (a worker that
 *    ended while PGlite created it leaves files PGlite cannot open) is removed and created again. A store that
 *    completed a boot before and now fails to open is reported. Both reports end the boot `failed` with
 *    `storeProblem` set, and the requests that replace the store's data (`reset`, `range`, `import`) then replace the
 *    store itself under its lock and run the rest of the boot; nothing is ever read from the refused store.
 * 3. `ledger`: loads ledger-v9 (WASM) and checks that its classes kept their names: the scan stores a contract action's
 *    class name, so a build that renamed them would write wrong rows. A renamed class fails the boot.
 * 4. `migrate`: both schema lineages, the chain archive's and MIP-0018's, as the Node commands run them.
 * Then `ready`, and the store's identity is written. A failure in 2–4 ends the boot as `failed` and closes the store.
 *
 * **Requests** (`protocol.ts`): `status` answers at any time; `api` waits for the boot and answers through the running
 * engine's API handler, or, while no engine runs, a handler of the same store with no loops (`scanner: "off"`);
 * `start` runs a new engine (sync + scan in follow mode) with the given configuration, or the saved one, `stop` stops
 * it; `range` drops the store's data and starts the new range, `reset` drops it and starts the saved configuration
 * again; all four run one at a time, in arrival order. `digest` computes the store's archive and range-tables digests
 * in one read-only transaction (the loops wait for it); `system` watches or refreshes the system snapshot and `watchdog`
 * sets the page's watchdog and starts the heartbeat (`host-system.ts`). `module` switches the token indexer (the
 * MIP-0018 scan) off or on: off, the running engine's scan stops at a block boundary while its sync goes on; on, it
 * continues from its cursor; the choice is saved with the settings, and every engine the host runs afterwards (a
 * `start`, a reopen, the next worker or tab) starts with it. `tables` and `rows` read the store's catalog and a page of
 * one of its tables for the Database tab (`store-tables.ts`), between the engine's transactions.
 *
 * **Snapshots** (`snapshot-store.ts`): `export` writes a snapshot file of the store while the engine runs (a consistent
 * read between two transactions). `import` checks a snapshot file without touching anything (a refusal changes
 * nothing, and a running engine keeps running), then stops the engine, waits for the requests reading the store,
 * replaces the store under its lock (journaled) and opens it again; meanwhile the requests that read the store wait. An
 * import stops the engine as `stop` does (the automatic start is off) and saves a configuration that continues the
 * imported archive: its first height as the start, no end, the saved source and tuning; a `start` then continues from
 * the snapshot's height + 1. The boot finishes an import that a previous worker left unfinished before it opens the
 * store. The last export and import are in `status` and in the system snapshot.
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
 * sync before it is reached (`storage` in `status`); it resumes once space frees. A write the browser refuses anyway (a
 * sync or scan error saying a file could not grow) rolls its block back and pauses the sync the same way, with the
 * refusal as the reason, until a later batch can write.
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
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { KNOWN_GENESIS } from "../mip0018/api-views.ts";
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
  type ImportResult,
  issuesOf,
  type ModuleId,
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
import { browserStorageEnvironment, createQuotaGuard, isRefusedWrite, type StorageEnvironment } from "./quota.ts";
import { yieldingScheduler } from "./scheduler.ts";
import { STACK_DEPTH_EXCEEDED } from "./session.ts";
import { type EngineSettingsStore, memorySettingsStore, opfsSettingsStore } from "./settings.ts";
import { decodeSnapshotFile, MAX_SNAPSHOT_FILE_BYTES, pgliteVersionOf, type SnapshotExpectation, type SnapshotManifest, type SnapshotRecord, SnapshotRefusal, snapshotRecord } from "./snapshot.ts";
import {
  exportSnapshot,
  type ExportedSnapshot,
  openFinishingImport,
  type OpenedStore,
  prepareImport,
  readStoreFacts,
  replaceStore,
  type SnapshotFiles,
  snapshotFilesFor,
  type PreparedImport,
  type TrialOpener,
} from "./snapshot-store.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, openStore, type OpenStoreOptions, type Store, StoreBusyError } from "./store.ts";
import { STORE_IDENTITY_FORMAT, storeIdentityFor, type StoreIdentityFile, unopenableStore, versionRefusal } from "./store-identity.ts";
import { listTables, readRows, TableRefusal } from "./store-tables.ts";
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
  /** Default: {@link openStore}. The host passes the session monitor's options and those that finish a pending
   *  snapshot import. */
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
  /** Where a snapshot import keeps its journal and how it removes the store's files. Default: beside an
   *  `opfs-ahp://` store in OPFS, else memory. */
  snapshotFiles?: SnapshotFiles;
  /** Opens a snapshot's data directory for the trial an import runs. Default: an in-memory PGlite. */
  snapshotTrial?: TrialOpener;
  /** Where the store's identity (the PGlite version that wrote it) is kept. Default: beside an `opfs-ahp://` store in
   *  OPFS, else memory. The check before opening needs the running version: `build.pgliteVersion`. */
  storeIdentity?: StoreIdentityFile;
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

/** The store cannot be used: refused (`version`) or not opened (`unopenable`); its message tells the user what to do. */
class StoreProblem extends Error {
  constructor(readonly kind: NonNullable<BootState["storeProblem"]>, message: string) {
    super(message);
  }
}

/** How the boot's store phase treats the store's files: as they are, removed first (`reset`, `range`), or replaced
 *  by the pending import's journal (`import`). */
type StoreOpening = "open" | "reset" | "import";

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
      snapshots: () => ({ lastExport, lastImport }),
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
    storeProblem: null,
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
  /** The modules switched off or on, saved with the configuration (a module not named is on). */
  let modules: NonNullable<EngineSettings["modules"]> = {};
  /** The saved settings: the configuration and the automatic start (returned), and the modules (kept in `modules`). */
  async function loadSettings(): Promise<EngineSettings | undefined> {
    const loaded = await settingsStore.load();
    if (loaded === undefined) return undefined;
    const { modules: m, ...rest } = loaded;
    modules = m ?? {};
    return rest;
  }
  const withModules = (s: EngineSettings): EngineSettings => (Object.keys(modules).length === 0 ? s : { ...s, modules: { ...modules } });
  /** Whether the token indexer (the MIP-0018 scan) is on. */
  const scanEnabled = (): boolean => modules["token-indexer"] ?? true;
  const quota = createQuotaGuard({
    env: opts.storage ?? browserStorageEnvironment(opts.dataDir),
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    ...(opts.quota?.checkEveryMs === undefined ? {} : { checkEveryMs: opts.quota.checkEveryMs }),
    ...(opts.quota?.recheckMs === undefined ? {} : { recheckMs: opts.quota.recheckMs }),
    ...(opts.quota?.storeEveryMs === undefined ? {} : { storeEveryMs: opts.quota.storeEveryMs }),
    log,
  });

  // Snapshots: the last export and import, the journal, and the swap in progress (`status` and `api` wait for it).
  const snapshotFiles = opts.snapshotFiles ?? snapshotFilesFor(opts.dataDir);
  /** Opens the store with the session monitor's options (`storeOptions`) and those a snapshot import adds. */
  const opener = (dataDir: string, options: OpenStoreOptions): Promise<Store> => (opts.openStore ?? openStore)(dataDir, { ...storeOptions(), ...options });
  const genesisHash = (): string | null => KNOWN_GENESIS[opts.network] ?? null;
  let lastExport: SnapshotRecord | null = null;
  let lastImport: SnapshotRecord | null = null;
  let swapping: Promise<void> | undefined;
  /** The manifest of an import the boot finished (its configuration is saved once the settings are read). */
  let finishedImport: SnapshotManifest | undefined;
  const identityFile = opts.storeIdentity ?? storeIdentityFor(opts.dataDir);

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

  /** Writes the store's identity (`store-identity.ts`) when it is not on file yet: the versions read from the store. */
  async function recordIdentity(s: Store): Promise<void> {
    const [v] = await s.archive<{ version: string; server: string }[]>`select version() as version, current_setting('server_version') as server`;
    const pglite = pgliteVersionOf(v!.version);
    if (pglite === null) return;
    const identity = { format: STORE_IDENTITY_FORMAT, pglite, postgres: v!.server } as const;
    const onFile = await identityFile.load();
    if (onFile?.pglite === identity.pglite && onFile.postgres === identity.postgres) return;
    try {
      await identityFile.save(identity);
    } catch (e) {
      log("warn", `the store's identity could not be saved: ${messageOf(e)}`);
    }
  }

  /** The `store` phase (see the module documentation). */
  async function openForBoot(mode: StoreOpening): Promise<Store> {
    const removeStore = async (): Promise<void> => {
      await snapshotFiles.removeStore();
      await identityFile.remove();
    };
    if (mode === "reset") {
      return noteFinishedImport(await openFinishingImport(opener, opts.dataDir, snapshotFiles, opts.network, {
        prepare: async () => {
          await snapshotFiles.removeJournal();
          await removeStore();
        },
      }));
    }
    // An import's journal replaces the store's files as it opens: the identity goes with them.
    if (mode === "import") await identityFile.remove();
    const identity = mode === "open" ? await identityFile.load() : undefined;
    const running = opts.build?.pgliteVersion ?? null;
    if (identity !== undefined && running !== null && identity.pglite !== running) throw new StoreProblem("version", versionRefusal(identity, running));
    try {
      return noteFinishedImport(await openFinishingImport(opener, opts.dataDir, snapshotFiles, opts.network));
    } catch (e) {
      if (e instanceof StoreBusyError) throw e;
      if (identity !== undefined || mode !== "open") throw new StoreProblem("unopenable", unopenableStore(messageOf(e)));
      // No boot ever completed on this store: PGlite's creation of it was interrupted. Nothing was stored yet.
      log("warn", `the store's first boot did not complete and it cannot be opened (${messageOf(e)}): it is created again`);
      try {
        return noteFinishedImport(await openFinishingImport(opener, opts.dataDir, snapshotFiles, opts.network, { prepare: removeStore }));
      } catch (e2) {
        if (e2 instanceof StoreBusyError) throw e2;
        throw new StoreProblem("unopenable", unopenableStore(messageOf(e2)));
      }
    }
  }

  /** The boot from the `store` phase on: open, ledger, migrations, identity, saved settings, then `ready`. On a failure
   *  the boot is `failed` (with `storeProblem` when the store is the reason) and the store is closed. Never rejects. */
  async function bootStore(mode: StoreOpening): Promise<void> {
    const t0 = monotonic();
    bootState.error = null;
    bootState.storeProblem = null;
    try {
      let s: Store | undefined;
      try {
        s = await phase("store", "storeMs", () => openForBoot(mode));
        await phase("ledger", "ledgerMs", checkLedger);
        await phase("migrate", "migrateMs", () => migrate(s!));
        storeInfo = await readStoreInfo(s);
        await recordIdentity(s);
      } catch (e) {
        if (s !== undefined) await s.close().catch(() => {});
        throw e;
      }
      saved = (await loadSettings()) ?? { config: opts.defaultStart ?? {}, autoStart: true };
      if (finishedImport !== undefined) await saveImported(finishedImport);
      useStore(s);
      bootState.phase = "ready";
      log("info", `store ${s.dataDir} ready (${s.created ? "created" : "reopened"}, PostgreSQL ${storeInfo.serverVersion})`);
      void quota.check({ store: true }).catch(() => {});
    } catch (e) {
      bootState.phase = "failed";
      bootState.error = messageOf(e);
      bootState.storeProblem = e instanceof StoreProblem ? e.kind : null;
      log("error", `boot failed: ${bootState.error}`);
    } finally {
      bootState.timings.totalMs = (bootState.timings.capabilitiesMs ?? 0) + monotonic() - t0;
      announceBoot();
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
        bootState.timings.totalMs = monotonic() - t0;
        announceBoot();
        return snapshotBoot();
      }
    } catch (e) {
      bootState.phase = "failed";
      bootState.error = messageOf(e);
      log("error", `boot failed: ${bootState.error}`);
      bootState.timings.totalMs = monotonic() - t0;
      announceBoot();
      return snapshotBoot();
    }
    await bootStore("open");
    return snapshotBoot();
  }

  /** Whether the boot ended `failed` because of the store (see {@link openForBoot}): `reset`, `range` and `import`
   *  then replace the store. */
  async function storeFailed(): Promise<boolean> {
    await boot();
    const failed = !closed && bootState.phase === "failed" && bootState.storeProblem !== null;
    // The saved configuration lives beside the store, not in it: a store that could not be used still has it.
    if (failed && saved === undefined) saved = await loadSettings();
    return failed;
  }

  /** Replaces a store the boot could not use and runs the rest of the boot; fails with `boot-failed` if it fails again. */
  async function recoverStore(mode: "reset" | "import"): Promise<Store> {
    log("warn", mode === "reset" ? "the store is removed and created again" : "the store is replaced by a snapshot");
    await bootStore(mode);
    if (store === undefined) throw new HostError("boot-failed", bootState.error ?? "the boot failed");
    return store;
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
      settings: saved === undefined ? null : withModules(saved),
      storage: quota.status(),
      snapshots: { lastExport, lastImport },
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
      if (saved !== undefined) await settingsStore.save(withModules(saved));
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
          enabled: scanEnabled(),
        },
        fetch: system.telemetry.instrumentFetch(chain.fetch),
        schedule: gated(runner.signal, opts.schedule ?? yieldingScheduler),
        signal: runner.signal,
        onEvent: (e) => {
          const line = logLineOf(e);
          if (line !== undefined) consoleLog(line[0], line[1]);
          // A write the browser refused for lack of space: the storage guard pauses the sync and says why.
          if (e.event === "error" && (e.source === "sync" || e.source === "scan")) {
            const message = String(e.source === "sync" ? e.fields.message : e.fields.error);
            if (isRefusedWrite(message)) quota.refusedWrite(message);
          }
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
    const failed = await storeFailed();
    const s = failed ? undefined : await ready();
    const config: StartConfig = { ...(saved?.config ?? opts.defaultStart ?? {}), startHeight };
    delete config.endHeight;
    if (endHeight !== undefined) config.endHeight = endHeight;
    const valid = StartConfigSchema.safeParse(config);
    if (!valid.success) throw new HostError("bad-request", issuesOf(valid.error));
    if (s === undefined) await recoverStore("reset");
    else {
      await halt();
      await wipe(s);
    }
    return start(config);
  }

  /** A `reset` request: drops the store's data and starts the saved configuration again (a tip start resolves the tip
   *  anew). */
  async function reset(): Promise<HostStatus> {
    if (await storeFailed()) {
      await recoverStore("reset");
      return start(undefined);
    }
    const s = await ready();
    await halt();
    await wipe(s);
    return start(undefined);
  }

  /** A `module` request: switches the module and saves the choice with the settings; a running engine follows at once
   *  (switched off, the answer comes once its scan has stopped at a block boundary). */
  async function setModule(module: ModuleId, enabled: boolean): Promise<HostStatus> {
    await ready();
    modules = { ...modules, [module]: enabled };
    await saveSettings();
    await active?.setScanEnabled(enabled);
    log("info", enabled
      ? "the token indexer is on: the MIP-0018 scan continues from its cursor"
      : "the token indexer is off: the MIP-0018 scan stopped at a block boundary; the chain archive keeps syncing");
    return status();
  }

  /** The store's schemas, the only ones the Database tab reads. */
  const STORE_SCHEMAS = [ARCHIVE_SCHEMA, MIP0018_SCHEMA] as const;

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

  /**
   * Saves the configuration that continues an imported archive: the saved source and tuning, the snapshot's first height
   * as the start (it agrees with the archive, so a start continues at its cursor + 1), no end height, and no automatic
   * start (an import stops the engine as `stop` does).
   */
  async function saveImported(manifest: SnapshotManifest): Promise<void> {
    const config: StartConfig = { ...(saved?.config ?? opts.defaultStart ?? {}), startHeight: manifest.archive.startHeight ?? manifest.archive.height };
    delete config.endHeight;
    saved = { config, autoStart: false };
    await saveSettings();
  }

  /** Logs (and records) an import a previous worker left unfinished that the store's open finished or dropped. */
  function noteFinishedImport(opened: OpenedStore): Store {
    if (opened.imported !== null) {
      finishedImport = opened.imported;
      lastImport = snapshotRecord(opened.imported, clock.now(), null);
      log("warn", `finished an interrupted snapshot import: the store now holds ${opened.imported.network} up to ${opened.imported.archive.height}`);
    }
    if (opened.failure !== null) log("error", `an interrupted snapshot import could not be finished and the store was opened empty: ${opened.failure}`);
    return opened.store;
  }

  async function exportStore(): Promise<ExportedSnapshot> {
    const s = await ready();
    let out: ExportedSnapshot;
    try {
      out = await exportSnapshot(s, { network: opts.network, genesisHash: genesisHash(), appCommit: opts.build?.appCommit ?? null, now: () => clock.now(), monotonic });
    } catch (e) {
      if (e instanceof SnapshotRefusal) throw new HostError("snapshot-refused", e.message);
      throw e;
    }
    lastExport = snapshotRecord(out.manifest, clock.now(), out.bytes);
    log("info", `exported a snapshot of ${out.manifest.network} up to ${out.manifest.archive.height} (${out.bytes} bytes; the session was held ${out.timings.holdMs} ms)`);
    return out;
  }

  /** The store `s` as the host's store: migrations (none to run for a snapshot of this build), facts, engines and the
   *  system snapshot's binding. */
  async function adoptStore(s: Store): Promise<void> {
    await migrate(s);
    storeInfo = await readStoreInfo(s);
    useStore(s);
  }

  /** An import into a store the boot could not use: checked against this build, journaled, then the boot runs again and
   *  its store phase loads the journal into the store's place. */
  async function importReplacingStore(snapshot: Blob): Promise<ImportResult> {
    const t0 = monotonic();
    const running = opts.build?.pgliteVersion ?? null;
    let prepared: PreparedImport;
    try {
      if (snapshot.size > MAX_SNAPSHOT_FILE_BYTES) throw new SnapshotRefusal("format", `the file is ${snapshot.size} bytes, more than the ${MAX_SNAPSHOT_FILE_BYTES} a snapshot may have`);
      const { manifest } = decodeSnapshotFile(new Uint8Array(await snapshot.arrayBuffer()));
      const expected: SnapshotExpectation = {
        network: opts.network,
        genesisHash: genesisHash(),
        schemaVersions: { chain_archive: chainArchiveMigrations.map((m) => m.name), mip0018: mip0018Migrations.map((m) => m.name) },
        // The trial opens the data with this build's PGlite and compares the versions it reads with the manifest's.
        pglite: { version: running ?? manifest.pglite.version, serverVersion: manifest.pglite.serverVersion },
      };
      prepared = await prepareImport(snapshot, expected, { monotonic, ...(opts.snapshotTrial === undefined ? {} : { trial: opts.snapshotTrial }) });
    } catch (e) {
      if (e instanceof SnapshotRefusal) throw new HostError("snapshot-refused", e.message);
      throw e;
    }
    const tSwap = monotonic();
    await snapshotFiles.writeJournal(prepared.file);
    finishedImport = undefined;
    await recoverStore("import");
    if (finishedImport === undefined) throw new HostError("snapshot-failed", "the snapshot could not be loaded and the store was opened empty");
    lastImport = snapshotRecord(prepared.manifest, clock.now(), prepared.file.length);
    log("info", `imported a snapshot of ${prepared.manifest.network} up to ${prepared.manifest.archive.height} (${prepared.file.length} bytes) in place of a store that could not be used`);
    const swapMs = Math.round((monotonic() - tSwap) * 10) / 10;
    return { manifest: prepared.manifest, timings: { ...prepared.timings, swapMs, totalMs: Math.round((monotonic() - t0) * 10) / 10 }, status: await status() };
  }

  async function importStore(snapshot: Blob): Promise<ImportResult> {
    if (await storeFailed()) return importReplacingStore(snapshot);
    const t0 = monotonic();
    const s = await ready();
    const facts = await readStoreFacts(s.mip0018, opts.network);
    const expected: SnapshotExpectation = { network: opts.network, genesisHash: genesisHash(), schemaVersions: facts.schemaVersions, pglite: facts.pglite };
    let prepared: PreparedImport;
    try {
      prepared = await prepareImport(snapshot, expected, { monotonic, ...(opts.snapshotTrial === undefined ? {} : { trial: opts.snapshotTrial }) });
    } catch (e) {
      if (e instanceof SnapshotRefusal) throw new HostError("snapshot-refused", e.message);
      throw e;
    }
    const tSwap = monotonic();
    let done!: () => void;
    swapping = new Promise<void>((resolve) => (done = resolve));
    try {
      await halt();
      while (reading > 0) await clock.sleep(5, new AbortController().signal);
      system.unbind();
      store = undefined;
      let opened: OpenedStore;
      try {
        opened = await replaceStore(s, prepared, opener, snapshotFiles);
        await adoptStore(opened.store);
      } catch (e) {
        bootState.phase = "failed";
        bootState.error = `the store could not be opened again after a snapshot import: ${messageOf(e)}`;
        bootState.storeProblem = "unopenable";
        log("error", bootState.error);
        announceBoot();
        throw new HostError("snapshot-failed", bootState.error);
      }
      if (opened.failure !== null) {
        log("error", `the snapshot could not be loaded and the store was opened empty: ${opened.failure}`);
        throw new HostError("snapshot-failed", `${opened.failure}; the store was opened empty`);
      }
      await saveImported(prepared.manifest);
      lastImport = snapshotRecord(prepared.manifest, clock.now(), prepared.file.length);
      log("info", `imported a snapshot of ${prepared.manifest.network} up to ${prepared.manifest.archive.height} (${prepared.file.length} bytes)`);
    } finally {
      swapping = undefined;
      done();
    }
    const swapMs = Math.round((monotonic() - tSwap) * 10) / 10;
    return { manifest: prepared.manifest, timings: { ...prepared.timings, swapMs, totalMs: Math.round((monotonic() - t0) * 10) / 10 }, status: await status() };
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

  /** Runs `fn` as a request reading the store: after any reopen or snapshot swap in progress, and counted so that they
   *  wait for it. */
  async function readingStore<T>(fn: () => Promise<T>): Promise<T> {
    while (reopening !== undefined || swapping !== undefined) await (reopening ?? swapping);
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
      case "export":
        return serial(() => exportStore());
      case "import":
        return serial(() => importStore(r.snapshot));
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
      case "module":
        return serial(() => setModule(r.module, r.enabled));
      case "tables":
        return readingStore(async () => listTables((await ready()).mip0018, STORE_SCHEMAS));
      case "rows":
        return readingStore(async () => {
          const s = await ready();
          try {
            return await readRows(s.mip0018, STORE_SCHEMAS, r);
          } catch (e) {
            if (e instanceof TableRefusal) throw new HostError("bad-request", e.message);
            throw e;
          }
        });
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
