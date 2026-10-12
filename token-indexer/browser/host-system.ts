/**
 * The worker host's system side (`host.ts` creates one per worker): the engine telemetry (`../engine/telemetry.ts`),
 * the `system` snapshot collector (`../engine/system-collector.ts`) bound to the open store, the viewers of the `system`
 * request, and the watchdog's heartbeat (the `watchdog` request).
 *
 * - **Telemetry** exists from the worker's start: the host's log lines go into its ring buffer, every engine the host
 *   creates is attached to it and reads the chain through its instrumented `fetch`.
 * - **`system`**: `watch` adds or removes a viewer; while at least one viewer watches, the collector reads the counters
 *   and `/v1/status` every 2 s and the catalog every 30 s, and each snapshot is posted as a `system` notice; with no
 *   viewer nothing is collected. `refresh` collects one snapshot now. The collector reads the store the host bound last
 *   (a reopened store gets a new collector; the viewers stay).
 * - **`watchdog`**: the page's limit (shown in the configuration section), the heartbeat interval, and the counts a
 *   replaced worker carried over. From then on a `heartbeat` notice is posted every interval, carrying the counts the
 *   next worker would need.
 *
 * Providers the snapshot reads from the host (`host.ts` supplies the storage guard's reading (`quota.ts`), the start
 * mode and the automatic start from the saved configuration, and the last snapshot export and import; `worker.ts` the
 * connected tabs (`tab-locks.ts`)). The defaults, for a host that supplies none:
 * - `storage`: `navigator.storage.estimate()` and `persisted()` as the worker reads them, with no quota pause
 *   (`pauseAtBytes` `null`, never paused);
 * - `snapshots`: no export and no import recorded (the host supplies its last export and import, `snapshot.ts`
 *   `snapshotRecord`);
 * - `role`: `"leader"` (only the leader tab runs a worker; a follower relabels what it relays, `tabs.ts`);
 * - `connectedTabs`: `null` (unknown);
 * - start mode `"range"` and auto-start `false`.
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { EngineClock, EngineOptions, IndexerEngine } from "../engine/engine.ts";
import { type ConfigurationExtras, createSystemCollector, type StorageReading, type SystemCollector } from "../engine/system-collector.ts";
import type { BrowserInfo, SnapshotsInfo, SystemSnapshot } from "../engine/system-snapshot.ts";
import { createEngineTelemetry, type EngineTelemetry } from "../engine/telemetry.ts";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_SYSTEM_VIEWER,
  type CarriedCountsMessage,
  type Notice,
  PROTOCOL_VERSION,
  type RequestOf,
  type SystemResult,
  type WatchdogResult,
} from "./protocol.ts";

/** Facts of the build, injected at build time (`vite.config.ts` `define`); `null` when unknown. */
export interface BuildInfo {
  appCommit: string | null;
  pgliteVersion: string | null;
  ledgerVersion: string | null;
}

/** What the snapshot reads from the parts of the host that own it (see the module documentation for the defaults). */
export interface SystemProviders {
  storage?: () => Promise<StorageReading>;
  snapshots?: () => SnapshotsInfo;
  role?: () => "leader" | "follower";
  connectedTabs?: () => number | null;
  startMode?: () => ConfigurationExtras["startMode"];
  autoStart?: () => boolean;
}

/** The parts of `navigator.storage` the placeholder storage provider reads. */
export interface StorageManagerLike {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
}

/** Placeholder storage provider: `navigator.storage.estimate()` and `persisted()`, no quota pause. */
export function placeholderStorage(storage: StorageManagerLike | undefined = globalThis.navigator?.storage): () => Promise<StorageReading> {
  return async () => {
    const estimate = typeof storage?.estimate === "function" ? await storage.estimate() : undefined;
    const persisted = typeof storage?.persisted === "function" ? await storage.persisted() : null;
    const whole = (n: number | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
    return {
      usageBytes: whole(estimate?.usage),
      quotaBytes: whole(estimate?.quota),
      persisted,
      pauseAtBytes: null,
      paused: false,
      pausedReason: null,
    };
  };
}

/** The open store as the collector reads it. */
export interface StoreBinding {
  /** Client of the `mip0018` schema (the catalog statistics are read with it). */
  sql: UmbraDBSql;
  dataDir: string;
  /** The engine answering now: the running one, or the store's engine with no loops. */
  engine: () => Pick<IndexerEngine, "status" | "handle">;
  /** The options of that engine. */
  engineOptions: () => EngineOptions;
  browser: () => BrowserInfo | null;
}

export interface HostSystemOptions {
  clock: EngineClock;
  /** Posts a notice to the page. */
  notify: (notice: Notice) => void;
  build?: BuildInfo | null;
  providers?: SystemProviders;
  /** Collection intervals (default 2 s and 30 s). */
  countersEveryMs?: number;
  databaseEveryMs?: number;
}

export interface HostSystem {
  readonly telemetry: EngineTelemetry;
  /** Reads `binding` from now on: a new collector; viewers watching keep watching. */
  bind(binding: StoreBinding): void;
  /** Stops reading the store (before it closes). */
  unbind(): void;
  system(request: RequestOf<"system">): Promise<SystemResult>;
  watchdog(request: RequestOf<"watchdog">): WatchdogResult;
  /** The page's watchdog limit, once a `watchdog` request has set it. */
  watchdogLimitMs(): number | null;
  /** The counts a worker replacing this one carries over. */
  carried(): CarriedCountsMessage;
  close(): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createHostSystem(opts: HostSystemOptions): HostSystem {
  const telemetry = createEngineTelemetry({ clock: opts.clock });
  const providers = opts.providers ?? {};
  const storage = providers.storage ?? placeholderStorage();
  const viewers = new Set<string>();
  let collector: SystemCollector | undefined;
  let unwatch: (() => void) | undefined;
  let limitMs: number | null = null;
  let heartbeatMs = DEFAULT_HEARTBEAT_MS;
  let beating: AbortController | undefined;
  let seq = 0;
  let closed = false;

  const extras = (): ConfigurationExtras => ({
    startMode: providers.startMode?.() ?? "range",
    autoStart: providers.autoStart?.() ?? false,
    watchdogLimitMs: limitMs,
    ...(opts.build === undefined || opts.build === null ? {} : { build: opts.build }),
  });

  const post = (snapshot: SystemSnapshot): void => opts.notify({ v: PROTOCOL_VERSION, type: "notice", notice: "system", snapshot });
  const failed = (e: unknown): void => telemetry.log("error", "system", `system snapshot failed: ${messageOf(e)}`);

  function watchNow(): void {
    if (collector !== undefined && unwatch === undefined && viewers.size > 0) unwatch = collector.watch(post, failed);
  }
  function unwatchNow(): void {
    unwatch?.();
    unwatch = undefined;
  }

  function carried(): CarriedCountsMessage {
    const c = telemetry.counters().engine;
    return { watchdogRestarts: c.watchdogRestarts, lastWatchdogRestart: c.lastWatchdogRestart, pgliteReopens: c.pgliteReopens };
  }

  async function beat(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !closed) {
      opts.notify({ v: PROTOCOL_VERSION, type: "notice", notice: "heartbeat", heartbeat: { at: opts.clock.now(), seq: seq++, carried: carried() } });
      await opts.clock.sleep(heartbeatMs, signal);
    }
  }

  return {
    telemetry,

    bind(binding) {
      unwatchNow();
      collector?.close();
      collector = createSystemCollector({
        engine: { status: () => binding.engine().status(), handle: (m, t) => binding.engine().handle(m, t) },
        telemetry,
        engineOptions: binding.engineOptions,
        extras,
        sql: binding.sql,
        clock: opts.clock,
        dataDir: binding.dataDir,
        browser: binding.browser,
        storage,
        ...(providers.snapshots === undefined ? {} : { snapshots: providers.snapshots }),
        ...(providers.role === undefined ? {} : { role: providers.role }),
        ...(providers.connectedTabs === undefined ? {} : { connectedTabs: providers.connectedTabs }),
        ...(opts.countersEveryMs === undefined ? {} : { countersEveryMs: opts.countersEveryMs }),
        ...(opts.databaseEveryMs === undefined ? {} : { databaseEveryMs: opts.databaseEveryMs }),
      });
      watchNow();
    },

    unbind() {
      unwatchNow();
      collector?.close();
      collector = undefined;
    },

    async system(r) {
      if (r.watch !== undefined) {
        const viewer = r.viewer ?? DEFAULT_SYSTEM_VIEWER;
        if (r.watch) viewers.add(viewer);
        else viewers.delete(viewer);
        if (viewers.size === 0) unwatchNow();
        else watchNow();
        return { watching: viewers.size > 0, viewers: viewers.size, snapshot: null };
      }
      if (collector === undefined) throw new Error("the store is not open");
      const snapshot = await collector.refresh({
        ...(r.refresh?.database === undefined ? {} : { database: r.refresh.database }),
        ...(r.refresh?.exactCounts === undefined ? {} : { exactCounts: r.refresh.exactCounts }),
      });
      return { watching: viewers.size > 0, viewers: viewers.size, snapshot };
    },

    watchdog(r) {
      limitMs = r.limitMs;
      heartbeatMs = r.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      if (r.carried !== undefined) telemetry.carry(r.carried);
      beating?.abort();
      beating = new AbortController();
      void beat(beating.signal);
      return { limitMs, heartbeatMs };
    },

    watchdogLimitMs: () => limitMs,

    carried,

    close() {
      closed = true;
      beating?.abort();
      unwatchNow();
      collector?.close();
      collector = undefined;
      viewers.clear();
    },
  };
}
