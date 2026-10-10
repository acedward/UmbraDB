/**
 * The browser engine's host: what the worker (`worker.ts`) runs, written against injected dependencies only, so tests
 * drive it in Node with an in-memory PGlite (`memory://`).
 *
 * **Boot**, once, in phases reported to the page as `boot` notices and in `status`:
 * 1. `capabilities`: the capability check (`capabilities.ts`). A refusal ends the boot as `unsupported`; nothing is
 *    opened or started.
 * 2. `store`: PGlite opens the store (`store.ts`); on a first open it creates the database (about a second in Chrome,
 *    with a second PGlite heap while it runs). Under the store's lock, first: an import a previous worker left
 *    unfinished (its journal) is finished, which replaces the store (see Snapshots). Otherwise the store's identity
 *    file (`store-identity.ts`) is read: a store another PGlite version wrote is refused unopened, and so is a store
 *    whose identity file cannot be read; a new store is marked "creating" before PGlite creates it. A store marked
 *    "creating" (its first boot never completed: a worker that ended while PGlite created it leaves files PGlite cannot
 *    open, and nothing was stored) is removed and created again. Any other store that fails to open is reported.
 * 3. `ledger`: loads ledger-v9 (WASM) and checks that its classes kept their names: the scan stores a contract action's
 *    class name, so a build that renamed them would write wrong rows. A renamed class fails the boot.
 * 4. `migrate`: both schema lineages, the chain archive's and MIP-0018's, as the Node commands run them.
 * Then the store's identity is written (a boot that cannot write it fails), the saved configuration is read (after a
 * finished import, the one that continues it is saved first, and only then is the import's journal removed), and the
 * boot is `ready`. A failure in 2–4 or after ends the boot `failed` and closes the store (its lock is released). When
 * the store is the reason (refused, unopenable, or opened but unusable: its migrations, its identity or finishing an
 * import failed), `storeProblem` says so, and the requests that replace the store (`reset`, `range`, `import`) then
 * replace it under its lock and run the boot again; nothing is ever read from a refused store. A ledger that fails to
 * load is not the store's fault: no `storeProblem`, and nothing offers to drop the store's data for it.
 *
 * **Requests** (`protocol.ts`): `status` answers at any time; `api` waits for the boot and answers through the running
 * engine's API handler, or, while no engine runs, a handler of the same store with no loops (`scanner: "off"`);
 * `start` runs a new engine (sync + scan in follow mode) with the given configuration, or the saved one, `stop` stops
 * it; `range` saves the new range, then replaces the store with a new, empty one and starts the range, `reset` does the
 * same with the saved configuration (replacing the store: PGlite is closed, every file of the store is removed, and
 * the boot runs again from its store phase, so nothing of the old database survives); all four run one at a time, in
 * arrival order. `digest` computes the store's archive and range-tables digests
 * in one read-only transaction (the loops wait for it); `system` watches or refreshes the system snapshot and `watchdog`
 * sets the page's watchdog and starts the heartbeat (`host-system.ts`).
 *
 * **Snapshots** (`snapshot-store.ts`): `export` writes a snapshot file (the rows of the store's tables) while the engine
 * runs (a consistent read between two transactions). `import` checks a snapshot file and loads its rows into a trial
 * store in memory without touching anything (a refusal changes nothing, and a running engine keeps running); then it
 * saves the file as the store's import journal (a failure to save it changes nothing), stops the engine, waits for the
 * requests reading the store, closes PGlite keeping the store's lock, and runs the boot again from its store phase,
 * which finishes the import from the journal; meanwhile the requests that read the store wait. An import stops the
 * engine as `stop` does (the automatic start is off) and saves a configuration that continues the imported archive: its
 * first height as the start, no end, the saved source and tuning; a `start` then continues from the snapshot's height
 * + 1. A failed import closes every store it opened. The last export and import are in `status` and in the system
 * snapshot.
 *
 * **Engine**: the engine (`../engine/engine.ts`) runs with a scheduler that yields to the event loop before each step
 * (`scheduler.ts`), so requests and `stop` are served while it syncs; the chain is the network (`fetch` to the node and
 * the indexer) or a recorded range replayed in the worker (`tapes.ts`). A store whose archive has a cursor continues
 * from it, through any gap since it stopped (never jumping to the new tip). A new archive starts at `startHeight`, by
 * default the finalized tip both sources serve, `min(node finalized height, indexer tip)`, resolved when the sync
 * begins: while the endpoints fail the engine waits with back-off, and it never starts at genesis by default. The
 * clients reach PGlite through the session monitor (`session.ts`), which also gives the event loop a turn between
 * statements, so API requests are served between block transactions while a step runs. A sync loop that ends with an
 * error (a range the archive cannot honour, a failed cursor read) ends the engine, so the scan never follows an
 * archive that no longer grows: the engine is reported failed with the sync's error (`status`, an `engine` notice),
 * and the API keeps answering.
 *
 * **Saved configuration** (`settings.ts`): the last `start` configuration or `range`, kept beside the store, and
 * whether the engine should start by itself (`autoStart`; a `stop` request turns it off until the next `start`). A
 * `start` with no configuration runs it; the leader tab sends one when its worker has booted (`tabs.ts`), so a new
 * store starts at the tip and a reopened one resumes, a chosen range keeping its end.
 *
 * **Storage** (`quota.ts`): the boot takes the first reading of the browser's usage and quota before `ready`, so every
 * `status` of a ready worker reports one (`storage`); before each sync batch the guard reads them again and pauses the
 * sync before the quota is reached; it resumes once space frees. A write the browser refuses anyway (a sync or scan
 * error saying a file could not grow) rolls its block back and pauses the sync the same way, with the refusal as the
 * reason, until a later batch can write.
 *
 * **Reopen**: PGlite fails every statement once a database has failed about 1,700 statements (and until it is
 * reopened). The host counts the statements the database fails and, at {@link REOPEN_AFTER_FAILED_STATEMENTS} since
 * the store was opened, or at once when a statement fails with "stack depth limit exceeded", reopens the store: it
 * holds new requests, stops the engine (its steps in flight end, so both cursors are at a full block), lets the
 * requests reading the store end, closes PGlite, opens it again and runs the engine again with the same configuration
 * (it continues at the cursors).
 */
import { archiveDigest, dumpArchive } from "../../chain-archive-sync/archive-digest.js";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { durabilityModeOf } from "../../src/postgres/durability-probe.js";
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
import { pgliteVersionOf, type SnapshotManifest, type SnapshotRecord, SnapshotRefusal, snapshotRecord } from "./snapshot.ts";
import {
  exportSnapshot,
  type ExportedSnapshot,
  openFinishingImport,
  type OpenedStore,
  prepareImport,
  type SnapshotFiles,
  snapshotFilesFor,
  type PreparedImport,
  type TrialOpener,
} from "./snapshot-store.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, migrateStore, openStore, type OpenStoreOptions, type Store, StoreBusyError } from "./store.ts";
import { STORE_IDENTITY_FORMAT, storeIdentityFor, type StoreIdentityFile, unopenableStore, unreadableIdentity, unusableStore, versionRefusal } from "./store-identity.ts";
import type { HeldLock } from "./tab-locks.ts";
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
  /** Runs both schema lineages' migrations on the store (the boot's `migrate` phase). Default: {@link migrateStore}. */
  migrate?: (store: Store) => Promise<void>;
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
  quota?: { checkEveryMs?: number; recheckMs?: number; storeEveryMs?: number; readTimeoutMs?: number };
  /** Called with the store before `range` or `reset` replaces it (an export can be taken there). */
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
  /** Where a snapshot import keeps its journal and how the store's files are found and removed. Default: beside an
   *  `opfs-ahp://` store in OPFS, else memory. */
  snapshotFiles?: SnapshotFiles;
  /** Opens the new, empty store an import's trial loads the snapshot into. Default: `openStore("memory://")` (through
   *  {@link openStore} when that is given). */
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

/** The store cannot be used: refused (`version`), not opened (`unopenable`) or not usable once open (`unusable`); its
 *  message tells the user what to do. */
class StoreProblem extends Error {
  constructor(readonly kind: NonNullable<BootState["storeProblem"]>, message: string) {
    super(message);
  }
}

/** How the boot's store phase treats the store: as it is (a pending import finished first), or removed and created
 *  anew (`reset`, `range`; a pending import is dropped). */
type StoreOpening = "open" | "reset";

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
  const quota = createQuotaGuard({
    env: opts.storage ?? browserStorageEnvironment(opts.dataDir),
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    ...(opts.quota?.checkEveryMs === undefined ? {} : { checkEveryMs: opts.quota.checkEveryMs }),
    ...(opts.quota?.recheckMs === undefined ? {} : { recheckMs: opts.quota.recheckMs }),
    ...(opts.quota?.storeEveryMs === undefined ? {} : { storeEveryMs: opts.quota.storeEveryMs }),
    ...(opts.quota?.readTimeoutMs === undefined ? {} : { readTimeoutMs: opts.quota.readTimeoutMs }),
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
  /** The manifest of an import the boot's store phase finished (its configuration is saved once the settings are
   *  read), and why one could not be finished (the store was opened empty). */
  let finishedImport: SnapshotManifest | undefined;
  let importFailure: string | undefined;
  /** An `import` request is running the boot (its log lines say so). */
  let importing = false;
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

  const migrate = (s: Store): Promise<void> => (opts.migrate ?? migrateStore)(s);

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

  /** Writes the store's identity (`store-identity.ts`) unless it is on file already: the versions read from the store.
   *  Fails (`unusable`) when it cannot be written: a store the boot used must have one. */
  async function recordIdentity(s: Store): Promise<void> {
    const [v] = await s.archive<{ version: string; server: string }[]>`select version() as version, current_setting('server_version') as server`;
    const pglite = pgliteVersionOf(v!.version);
    if (pglite === null) return;
    const identity = { format: STORE_IDENTITY_FORMAT, pglite, postgres: v!.server } as const;
    const onFile = await identityFile.read();
    if (onFile.kind === "identity" && onFile.identity.pglite === identity.pglite && onFile.identity.postgres === identity.postgres) return;
    try {
      await identityFile.save(identity);
    } catch (e) {
      throw new StoreProblem("unusable", unusableStore(`its identity could not be saved: ${messageOf(e)}`));
    }
  }

  /** The `store` phase (see the module documentation); `lock`: the store's lock, already held (a store closed for a
   *  `reset`, a `range` or an import). */
  async function openForBoot(mode: StoreOpening, lock?: HeldLock): Promise<Store> {
    const running = opts.build?.pgliteVersion ?? null;
    /** The store holds nothing yet: its first boot has not completed, so it may be created again. */
    let creating = false;
    const markCreating = async (): Promise<void> => {
      try {
        await identityFile.markCreating();
      } catch (e) {
        throw new StoreProblem("unusable", unusableStore(`its identity file could not be written: ${messageOf(e)}`));
      }
      creating = true;
    };
    // Under the store's lock, before PGlite opens the store.
    const beforeOpen = async (_dir: string, importing: SnapshotManifest | null): Promise<void> => {
      if (mode === "reset") {
        await snapshotFiles.removeStore();
        await markCreating();
        return;
      }
      // A pending import replaces the store: what its identity says does not matter.
      if (importing !== null) {
        await markCreating();
        return;
      }
      const state = await identityFile.read();
      if (state.kind === "unreadable") throw new StoreProblem("unopenable", unreadableIdentity(state.error));
      if (state.kind === "identity" && running !== null && state.identity.pglite !== running) throw new StoreProblem("version", versionRefusal(state.identity, running));
      if (state.kind === "creating") creating = true;
      else if (state.kind === "absent" && !(await snapshotFiles.storeExists())) await markCreating();
    };
    try {
      return noteFinishedImport(await openFinishingImport(opener, opts.dataDir, snapshotFiles, opts.network, {
        beforeOpen,
        discardJournal: mode === "reset",
        ...(lock === undefined ? {} : { lock }),
      }));
    } catch (e) {
      if (e instanceof StoreProblem || e instanceof StoreBusyError) throw e;
      if (!creating) throw new StoreProblem("unopenable", unopenableStore(messageOf(e)));
      // The store's first boot never completed (PGlite's creation of it was interrupted): nothing was stored yet.
      log("warn", `the store's first boot did not complete and it cannot be opened (${messageOf(e)}): it is created again`);
      try {
        return noteFinishedImport(await openFinishingImport(opener, opts.dataDir, snapshotFiles, opts.network, { beforeOpen: async () => { await snapshotFiles.removeStore(); } }));
      } catch (e2) {
        if (e2 instanceof StoreBusyError) throw e2;
        throw new StoreProblem("unopenable", unopenableStore(messageOf(e2)));
      }
    }
  }

  /** Runs `fn`; a failure that is not already a {@link StoreProblem} makes the store `unusable` (`what` says what failed). */
  async function usable<T>(fn: () => Promise<T>, what?: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StoreProblem) throw e;
      throw new StoreProblem("unusable", unusableStore(what === undefined ? messageOf(e) : `${what}: ${messageOf(e)}`));
    }
  }

  /** The boot from the `store` phase on: open (finishing a pending import), ledger, migrations, identity, saved
   *  settings (after a finished import: the continuing configuration saved, then its journal removed), then `ready`. On
   *  a failure the boot is `failed` (with `storeProblem` when the store is the reason) and the store is closed, its lock
   *  released. Never rejects. */
  async function bootStore(mode: StoreOpening, lock?: HeldLock): Promise<void> {
    const t0 = monotonic();
    bootState.error = null;
    bootState.storeProblem = null;
    finishedImport = undefined;
    importFailure = undefined;
    try {
      let s: Store | undefined;
      try {
        s = await phase("store", "storeMs", () => openForBoot(mode, lock));
        const opened = s;
        await phase("ledger", "ledgerMs", checkLedger);
        await phase("migrate", "migrateMs", () => usable(() => migrate(opened)));
        storeInfo = await usable(() => readStoreInfo(opened));
        await recordIdentity(opened);
        saved = (await settingsStore.load()) ?? { config: opts.defaultStart ?? {}, autoStart: true };
        // Set by the store phase (`noteFinishedImport`).
        const imported = finishedImport as SnapshotManifest | undefined;
        if (imported !== undefined) {
          // The journal stays until the configuration that continues the import is saved: a worker that ends before
          // that finishes the import again at its next boot.
          await usable(() => saveImported(imported), "the configuration that continues the imported snapshot could not be saved");
          await usable(() => snapshotFiles.removeJournal(), "the import's journal could not be removed");
          lastImport = snapshotRecord(imported, clock.now(), null);
          if (!importing) log("warn", `finished an interrupted snapshot import: the store now holds ${imported.network} up to ${imported.archive.height}`);
        }
      } catch (e) {
        if (s !== undefined) await s.close().catch(() => {});
        throw e;
      }
      useStore(s);
      // The first storage reading, before `ready`: every status of a ready worker carries one (the walk of the store's
      // files, which can be slow, fills in its size later).
      await quota.check();
      bootState.phase = "ready";
      log("info", `store ${s.dataDir} ready (${s.created ? "created" : "reopened"}, PostgreSQL ${storeInfo.serverVersion})`);
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
    const failed = !closed && bootState.phase === "failed" && bootState.storeProblem !== null && store === undefined;
    // The saved configuration lives beside the store, not in it: a store that could not be used still has it.
    if (failed && saved === undefined) saved = await settingsStore.load();
    return failed;
  }

  /** Requests that read the store wait while `fn` runs (it replaces the store). */
  async function swap<T>(fn: () => Promise<T>): Promise<T> {
    let done!: () => void;
    swapping = new Promise<void>((resolve) => (done = resolve));
    try {
      return await fn();
    } finally {
      swapping = undefined;
      done();
    }
  }

  /**
   * Runs the boot again from its store phase in `mode` (a `reset`, a `range` or an import). The open store `s`, if any,
   * is taken out of use first: the engine stopped, the requests reading it ended, PGlite closed with the store's lock
   * kept for the new open. Fails with `boot-failed` when the boot fails (every store it opened is closed then, its lock
   * released, and `storeProblem` says whether `reset`, `range` and `import` can replace the store).
   */
  async function rebootStore(mode: StoreOpening, s: Store | undefined): Promise<Store> {
    await swap(async () => {
      let lock: HeldLock | undefined;
      if (s !== undefined) {
        await halt();
        while (reading > 0) await clock.sleep(5, new AbortController().signal);
        system.unbind();
        store = undefined;
        try {
          lock = await s.detach();
        } catch (e) {
          // PGlite did not close cleanly (its lock is released then): the boot takes the lock again.
          log("error", `closing the store failed: ${messageOf(e)}`);
        }
      }
      log("warn", mode === "reset" ? "the store is removed and created again" : "the store is replaced by a snapshot");
      await bootStore(mode, lock);
    });
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
      settings: saved ?? null,
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
      if (saved !== undefined) await settingsStore.save(saved);
    } catch (e) {
      log("warn", `the engine settings could not be saved: ${messageOf(e)}`);
    }
  }

  /** Saves `next` as the saved configuration before the store is replaced (`range`, `reset`), so that a worker that ends
   *  meanwhile starts it on the new store; fails (and nothing is changed) when it cannot be saved. */
  async function saveBeforeReplacing(next: EngineSettings, what: string): Promise<void> {
    try {
      await settingsStore.save(next);
    } catch (e) {
      throw new HostError("start-failed", `${what} could not be saved (${messageOf(e)}): nothing was changed`);
    }
    saved = next;
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
          // A sync loop that ended with an error (a refused range, a failed cursor read) ends the engine.
          if (e.source === "sync" && e.event === "stop") queueMicrotask(() => void endIfSyncFailed(engine));
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
      record.error ??= messageOf(e);
      if (active === engine) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error: record.error } });
    });
    if (announce) notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "running", error: null } });
    void endIfSyncFailed(engine); // a sync that failed before the engine was recorded
  }

  /** Ends `engine` when its sync loop has failed: the scan does not follow an archive that no longer grows. The engine is
   *  then failed with the sync's error (`status` and an `engine` notice), as an engine whose loops all ended is. */
  async function endIfSyncFailed(engine: IndexerEngine): Promise<void> {
    const sync = engine.status().sync;
    if (sync.phase !== "failed" || active !== engine) return;
    const record = last;
    const error = `the sync stopped: ${sync.lastError ?? "unknown error"}`;
    if (record?.engine === engine) record.error = error;
    log("error", error);
    await serial(async () => {
      if (active !== engine) return;
      record?.run.abort();
      await engine.stop();
      active = undefined;
      notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "failed", error } });
    });
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

  /** Replaces the store with a new, empty one made by the migrations (see {@link rebootStore}): every file of the old
   *  store is removed, so nothing of its database survives. */
  async function replaceWithNewStore(s: Store | undefined): Promise<void> {
    if (s !== undefined && opts.beforeWipe !== undefined) await opts.beforeWipe(s);
    await rebootStore("reset", s);
    log("info", "the store was replaced by a new, empty one");
  }

  /** A `range` request: a new range means a new archive (one archive has no gaps and no backfill), so the new range is
   *  saved, the store replaced by a new one, and the range started; the source and tuning of the saved configuration
   *  stay. */
  async function range(startHeight: number | "tip", endHeight: number | undefined): Promise<HostStatus> {
    const failed = await storeFailed();
    const s = failed ? undefined : await ready();
    const config: StartConfig = { ...(saved?.config ?? opts.defaultStart ?? {}), startHeight };
    delete config.endHeight;
    if (endHeight !== undefined) config.endHeight = endHeight;
    const valid = StartConfigSchema.safeParse(config);
    if (!valid.success) throw new HostError("bad-request", issuesOf(valid.error));
    await saveBeforeReplacing({ config, autoStart: true }, "the new range");
    await replaceWithNewStore(s);
    return start(config);
  }

  /** A `reset` request: the store is replaced by a new one and the saved configuration starts again (a tip start
   *  resolves the tip anew). */
  async function reset(): Promise<HostStatus> {
    const failed = await storeFailed();
    const s = failed ? undefined : await ready();
    await saveBeforeReplacing({ config: saved?.config ?? opts.defaultStart ?? {}, autoStart: true }, "the configuration to start after the reset");
    await replaceWithNewStore(s);
    return start(undefined);
  }

  /** The store's archive and range-tables digests, read in one read-only transaction: the loops' statements wait for it
   *  (one session), so both digests describe one state, also while the engine runs. */
  async function digest(s: Store): Promise<DigestResult> {
    const t = monotonic();
    return s.mip0018.begin("read only", async (tx) => {
      const sql = tx as unknown as UmbraDBSql;
      const archive = archiveDigest(await dumpArchive(sql, ARCHIVE_SCHEMA));
      const { digest: tables, nullElements } = await rangeTables(sql, ARCHIVE_SCHEMA, MIP0018_SCHEMA);
      return { archive, tables, nullElements, elapsedMs: monotonic() - t };
    });
  }

  /**
   * Saves the configuration that continues an imported archive: the saved source and tuning, the snapshot's first height
   * as the start (it agrees with the archive, so a start continues at its cursor + 1), no end height, and no automatic
   * start (an import stops the engine as `stop` does). Fails when it cannot be saved.
   */
  async function saveImported(manifest: SnapshotManifest): Promise<void> {
    const config: StartConfig = { ...(saved?.config ?? opts.defaultStart ?? {}), startHeight: manifest.archive.startHeight ?? manifest.archive.height };
    delete config.endHeight;
    const next = { config, autoStart: false };
    await settingsStore.save(next);
    saved = next;
  }

  /** Records what the store's open did with a pending import: finished it (its configuration and journal are dealt
   *  with by the boot), or could not (the store was opened empty). */
  function noteFinishedImport(opened: OpenedStore): Store {
    if (opened.imported !== null) finishedImport = opened.imported;
    if (opened.failure !== null) {
      importFailure = opened.failure;
      log("error", `${importing ? "the snapshot" : "an interrupted snapshot import"} could not be loaded and the store was opened empty: ${opened.failure}`);
    }
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

  /**
   * An `import` request (see the module documentation): the trial, then the journal, then the boot again from its store
   * phase, which finishes the import from the journal. Before the journal is saved nothing has changed (a refusal, or a
   * journal that cannot be written, leaves the store and a running engine as they were). Once it is saved the import
   * goes on: a failure after that leaves the store closed and `storeProblem` set (the journal finishes the import at the
   * next boot, or `reset`, `range` or `import` replaces the store), or, when even the rows could not be loaded, the store
   * opened empty.
   */
  async function importStore(snapshot: Blob): Promise<ImportResult> {
    const t0 = monotonic();
    const live = (await storeFailed()) ? undefined : await ready();
    const running = opts.build?.pgliteVersion ?? null;
    let prepared: PreparedImport;
    try {
      prepared = await prepareImport(
        snapshot,
        {
          network: opts.network,
          genesisHash: genesisHash(),
          schemaVersions: { chain_archive: chainArchiveMigrations.map((m) => m.name), mip0018: mip0018Migrations.map((m) => m.name) },
          // Checked before the trial when the build knows its PGlite; the trial's store is this build's PGlite in any case.
          ...(running === null ? {} : { pglite: { version: running, ...(live === undefined || storeInfo === undefined ? {} : { serverVersion: storeInfo.serverVersion }) } }),
        },
        { monotonic, trial: opts.snapshotTrial ?? (() => (opts.openStore ?? openStore)("memory://", {})) },
      );
    } catch (e) {
      if (e instanceof SnapshotRefusal) throw new HostError("snapshot-refused", e.message);
      throw e;
    }
    const tSwap = monotonic();
    try {
      await snapshotFiles.writeJournal(prepared.file);
    } catch (e) {
      await snapshotFiles.removeJournal().catch(() => {});
      throw new HostError("snapshot-failed", `the import's journal could not be saved (${messageOf(e)}): nothing was changed`);
    }
    importing = true;
    try {
      await rebootStore("open", live).catch((e: unknown) => {
        if (!(e instanceof HostError)) throw e;
      });
    } finally {
      importing = false;
    }
    if (store === undefined)
      throw new HostError("snapshot-failed", `the snapshot was checked, but the store could not be used after it (it is finished at the next boot, or reset or import again): ${bootState.error ?? "the boot failed"}`);
    if (importFailure !== undefined) throw new HostError("snapshot-failed", `the snapshot could not be loaded and the store was opened empty: ${importFailure}`);
    if (finishedImport === undefined) throw new HostError("snapshot-failed", "the import's journal could not be read back: the store was opened as it was");
    lastImport = snapshotRecord(prepared.manifest, clock.now(), prepared.file.length);
    log("info", `imported a snapshot of ${prepared.manifest.network} up to ${prepared.manifest.archive.height} (${prepared.file.length} bytes)`);
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
    }
  }

  return {
    boot,

    async receive(raw: unknown): Promise<Response> {
      let r: Request | undefined;
      try {
        const parsed = parseRequest(raw);
        if (!parsed.ok) return fail(parsed.id, parsed.request, parsed.error);
        r = parsed.request;
        return ok(r, await perform(r));
      } catch (e) {
        if (e instanceof HostError) return fail(r?.id ?? null, r?.type ?? null, { code: e.code, message: e.message });
        log("error", `${r?.type ?? "a request"} failed: ${messageOf(e)}`);
        return fail(r?.id ?? null, r?.type ?? null, { code: "internal", message: messageOf(e) });
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
