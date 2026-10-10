/**
 * The browser engine's storage guard: it reads what the browser counts against the site's storage quota and pauses
 * the sync before the quota is reached, so the store never meets a refused write.
 *
 * **What it compares.** `navigator.storage.estimate()`'s `usage` against its `quota`. While the store is open the
 * usage is far above the size of the store's files: Chrome counts the space it reserves for every open OPFS sync
 * access handle that has grown (the session that creates the store reports about 1 GB for about 42 MB of files;
 * reopening the page releases it), and it refuses a write once usage, reservations included, would pass the quota (the
 * database then fails with "could not extend file … File too large"). So the reported usage is the figure that
 * decides, not the store's own size; the guard still reads that size (an OPFS walk of the store's directory, at most
 * every `storeEveryMs`) and reports it beside the usage, which shows how much of the usage is reserved space.
 *
 * **Readings.** A reading is the estimate and `persisted()`, each bounded by `readTimeoutMs` (a call that has not
 * answered by then counts as failed: the figures are unknown and the pause state stays). The walk runs beside the
 * readings and never delays one: it can take seconds on a slow disk or a busy machine (about 1,300 files in a new
 * store), so a reading carries the size the last finished walk found (`null` before the first) and starts a new walk
 * when that one is older than `storeEveryMs`. A pause's reason names only the figures it was decided on, so it does not
 * change when a walk ends; the size beside it (`storeBytes`) shows how much of the usage is the store's own files.
 *
 * **Rule.** The sync pauses once `usage ≥ quota − headroom`, with `headroom = max(256 MiB, 10 % of the quota)`, and
 * resumes once `usage < quota − headroom − 32 MiB` (the margin keeps it from flapping at the line). The figures are read
 * before a sync batch when the last reading is older than `checkEveryMs`; while paused, every `recheckMs`. Only the
 * sync pauses: the scan finishes the archived blocks and the API keeps answering. Space frees when the user resets the
 * store, changes its range, deletes other site data or reopens the page (which releases reserved space).
 *
 * **A refused write.** If a write is refused anyway (the figures did not show it coming: the database reports "could not
 * extend file …: File too large"), the statement fails and its block's transaction is rolled back, so the store stays at
 * the last full block. The host reports it here ({@link QuotaGuard.refusedWrite}): the sync pauses as before the quota,
 * with the refusal as the reason, until its next batch, at least `recheckMs` later, tries again (the write is what tells
 * whether space has come back; the sync's own back-off after a failed batch also applies).
 */
import type { StorageReading } from "../engine/system-collector.ts";
import type { StorageStatus } from "./protocol.ts";

const MiB = 1024 * 1024;

/** The pause rule's constants. */
export const QUOTA_RULE = {
  /** The least space kept free below the quota. */
  minHeadroomBytes: 256 * MiB,
  /** The share of the quota kept free, when larger. */
  headroomFraction: 0.1,
  /** How far under the threshold the usage must fall before the sync resumes. */
  resumeMarginBytes: 32 * MiB,
} as const;

/** The usage at which the sync pauses for a given quota. */
export function pauseThresholdBytes(quotaBytes: number): number {
  return Math.max(0, quotaBytes - Math.max(QUOTA_RULE.minHeadroomBytes, Math.floor(quotaBytes * QUOTA_RULE.headroomFraction)));
}

/** What the guard reads (in the worker: `navigator.storage` and the OPFS store directory). */
export interface StorageEnvironment {
  estimate(): Promise<{ usage?: number; quota?: number }>;
  persisted(): Promise<boolean>;
  /** The total size of the store's files, or `null` when it cannot be read. */
  storeBytes(): Promise<number | null>;
}

export interface QuotaGuardOptions {
  env: StorageEnvironment;
  /** Clock time in milliseconds. */
  now: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The longest a reading is reused before a sync batch. Default 10 s. */
  checkEveryMs?: number;
  /** The wait between readings while paused. Default 30 s. */
  recheckMs?: number;
  /** The longest the store's size is reused before a reading starts a new walk. Default 30 s. */
  storeEveryMs?: number;
  /** The longest a reading waits for `estimate()` or `persisted()`. Default 5 s. */
  readTimeoutMs?: number;
  /** Told when the sync pauses or resumes. */
  log?: (level: "info" | "warn", message: string) => void;
}

export interface QuotaGuard {
  /** Reads the figures now and updates the pause; never waits for a walk of the store. A failed or late estimate keeps
   *  the previous pause state. */
  check(): Promise<StorageStatus>;
  /** The latest reading (`null` before the first). */
  status(): StorageStatus | null;
  /** A fresh reading: the system snapshot's storage provider. */
  reading(): Promise<StorageReading>;
  /** Resolves when a sync batch may run: at once unless the sync is paused; while paused it reads the figures every
   *  `recheckMs` until the usage is back under the threshold. Rejects with the signal's reason when it aborts. */
  admit(signal: AbortSignal): Promise<void>;
  /** The browser refused a write for lack of space (`message`: the database's error): the sync pauses, with the refusal
   *  as the reason, until its next batch, at least `recheckMs` later. */
  refusedWrite(message: string): void;
}

/** Whether a database error is the browser refusing a write for lack of space (the file could not grow). */
export function isRefusedWrite(message: string): boolean {
  return /could not (extend|write to) file|File too large|No space left on device|QuotaExceededError|disk full/i.test(message);
}

const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const mb = (b: number): string => `${(b / MiB).toFixed(1)} MiB`;

export function createQuotaGuard(opts: QuotaGuardOptions): QuotaGuard {
  const checkEveryMs = opts.checkEveryMs ?? 10_000;
  const recheckMs = opts.recheckMs ?? 30_000;
  const storeEveryMs = opts.storeEveryMs ?? 30_000;
  const readTimeoutMs = opts.readTimeoutMs ?? 5_000;
  const log = opts.log ?? (() => {});
  let last: StorageStatus | null = null;
  let paused = false;
  let figures: { usage: number; quota: number; pauseAt: number } | null = null;
  let store: { bytes: number | null; at: number } | null = null;
  let walking: Promise<number | null> | undefined;
  let running: Promise<StorageStatus> | undefined;
  /** The last write the browser refused, while its pause lasts. */
  let refused: { message: string; at: number } | null = null;

  /** `call()`'s answer, or `undefined` when it fails or has not answered within `readTimeoutMs` (a real timer: it guards
   *  against a browser call that never answers, whatever clock the guard is given). */
  async function bounded<T>(call: () => Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([call().catch(() => undefined), new Promise<undefined>((resolve) => { timer = globalThis.setTimeout(() => resolve(undefined), readTimeoutMs); })]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  function refusedText(message: string): string {
    return `the browser refused to write to the store for lack of space (${message}); the store is at its last full block, and the sync tries a later batch again`;
  }

  function reasonText(): string | null {
    if (!paused) return null;
    if (refused !== null) return refusedText(refused.message);
    if (figures === null) return null;
    const { usage, quota, pauseAt } = figures;
    return `the browser counts ${mb(usage)} of this site's ${mb(quota)} quota; the sync pauses at ${mb(pauseAt)}`;
  }

  /** Walks the store once at a time; the latest reading takes the size when it ends. */
  function walk(): Promise<number | null> {
    walking ??= (async () => {
      const at = opts.now();
      const bytes = await opts.env.storeBytes().catch(() => null);
      store = { bytes, at };
      if (last !== null) last = { ...last, storeBytes: bytes };
      return bytes;
    })().finally(() => { walking = undefined; });
    return walking;
  }

  async function read(): Promise<StorageStatus> {
    const e = await bounded(() => opts.env.estimate());
    const usage = finite(e?.usage);
    const quota = finite(e?.quota);
    const persisted = (await bounded(() => opts.env.persisted())) ?? null;
    const pauseAt = quota === null ? null : pauseThresholdBytes(quota);
    if (usage !== null && quota !== null && pauseAt !== null) figures = { usage, quota, pauseAt };
    if (refused !== null) {
      paused = true;
    } else if (usage !== null && quota !== null && pauseAt !== null) {
      if (!paused && usage >= pauseAt) {
        paused = true;
        log("warn", `sync paused before the storage quota: ${reasonText()}`);
      } else if (paused && usage < pauseAt - QUOTA_RULE.resumeMarginBytes) {
        paused = false;
        log("info", `sync resumed: the browser counts ${mb(usage)} of ${mb(quota)}`);
      }
    }
    if (store === null || opts.now() - store.at >= storeEveryMs) void walk();
    last = { usageBytes: usage, quotaBytes: quota, persisted, pauseAtBytes: pauseAt, paused, pausedReason: reasonText(), storeBytes: store?.bytes ?? null, checkedAt: opts.now() };
    return last;
  }

  function check(): Promise<StorageStatus> {
    // One reading at a time; a caller during a reading gets that reading.
    running ??= read().finally(() => { running = undefined; });
    return running;
  }

  return {
    check,
    status: () => last,

    async reading(): Promise<StorageReading> {
      const s = await check();
      return { usageBytes: s.usageBytes, quotaBytes: s.quotaBytes, persisted: s.persisted, pauseAtBytes: s.pauseAtBytes, paused: s.paused, pausedReason: s.pausedReason };
    },

    refusedWrite(message: string): void {
      const first = refused === null;
      refused = { message, at: opts.now() };
      paused = true;
      if (last !== null) last = { ...last, paused: true, pausedReason: reasonText() };
      if (first) log("warn", `sync paused: ${reasonText()}`);
    },

    async admit(signal: AbortSignal): Promise<void> {
      if (refused !== null) {
        // The pause of a refused write lasts at least `recheckMs`; then this batch tries (its write tells whether space
        // came back) unless the figures say to stay paused.
        const wait = refused.at + recheckMs - opts.now();
        if (wait > 0) await opts.sleep(wait, signal);
        if (signal.aborted) throw signal.reason;
        refused = null;
        paused = false;
        log("info", "sync tries a batch again after a refused write");
        await check();
      }
      if (paused || last === null || last.checkedAt === null || opts.now() - last.checkedAt >= checkEveryMs) await check();
      while (paused) {
        if (signal.aborted) throw signal.reason;
        await opts.sleep(recheckMs, signal);
        if (signal.aborted) throw signal.reason;
        await check();
      }
    },
  };
}

/** The worker's storage: `navigator.storage` and the size of the files under the store's OPFS directory. */
export function browserStorageEnvironment(dataDir: string, storage: StorageManager | undefined = globalThis.navigator?.storage): StorageEnvironment {
  const dirName = dataDir.startsWith("opfs-ahp://") ? dataDir.slice("opfs-ahp://".length) : null;
  return {
    estimate: async () => (storage === undefined ? {} : storage.estimate()),
    persisted: async () => (storage === undefined ? false : storage.persisted()),
    async storeBytes(): Promise<number | null> {
      if (dirName === null || storage === undefined) return null;
      let dir = await storage.getDirectory();
      for (const part of dirName.split("/").filter((p) => p !== "")) dir = await dir.getDirectoryHandle(part);
      let total = 0;
      const walk = async (d: FileSystemDirectoryHandle): Promise<void> => {
        for await (const handle of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
          if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle);
          else total += (await (handle as FileSystemFileHandle).getFile()).size;
        }
      };
      await walk(dir);
      return total;
    },
  };
}
