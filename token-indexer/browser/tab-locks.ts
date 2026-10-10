/**
 * The Web Locks that keep one engine per browser profile and store, shared by the tabs (`tabs.ts`) and the engine worker
 * (`store.ts`, and whatever in the worker counts the connected tabs). `scope` is the store's data directory
 * (`opfs-ahp://umbradb-stagenet`), so each store has its own leader.
 *
 * | Lock | Held by | Purpose |
 * |---|---|---|
 * | `umbradb-engine-leader:<scope>` | the leader tab, for as long as it is open | only the leader tab starts the engine worker; the other tabs queue for this lock, and the oldest becomes leader when it is released |
 * | `umbradb-engine-tab:<scope>:<tab>` | every tab, for as long as it is open | presence: the number of connected tabs, and noticing that a given tab has closed |
 * | `umbradb-store:<dataDir>` | the worker that has the store open, from open to close | only one worker opens the PGlite store at a time, including a closed tab's worker that is still shutting down |
 *
 * The browser releases a context's locks when the context ends (a tab closed, reloaded or crashed; a worker terminated),
 * with no code of its own running, which is what makes them reliable for presence and handover.
 */

/** The parts of a granted lock this code reads. */
export interface LockLike {
  readonly name: string;
}

/** One entry of a lock-manager snapshot. */
export interface LockInfoLike {
  readonly name?: string;
  readonly clientId?: string;
  readonly mode?: string;
}

export interface LockRequestOptions {
  /** Grant the lock only if no one holds it; otherwise the callback gets `null` at once. */
  ifAvailable?: boolean;
  /** Aborts a request that is still queued. */
  signal?: AbortSignal;
}

/** The subset of the Web Locks API (`navigator.locks`) used here; injectable for tests. */
export interface LockManagerLike {
  request(name: string, callback: (lock: LockLike | null) => unknown): Promise<unknown>;
  request(name: string, options: LockRequestOptions, callback: (lock: LockLike | null) => unknown): Promise<unknown>;
  query(): Promise<{ held?: LockInfoLike[]; pending?: LockInfoLike[] }>;
}

export const leaderLockName = (scope: string): string => `umbradb-engine-leader:${scope}`;
export const tabLockPrefix = (scope: string): string => `umbradb-engine-tab:${scope}:`;
export const tabLockName = (scope: string, tab: string): string => `${tabLockPrefix(scope)}${tab}`;
export const storeLockName = (dataDir: string): string => `umbradb-store:${dataDir}`;

/** The browser's lock manager, when it has one. */
export function defaultLocks(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
  return typeof locks === "object" && locks !== null ? (locks as LockManagerLike) : undefined;
}

export interface HeldLock {
  /** `true` once the lock is held; `false` when it was not available (`ifAvailable`), the queued request was aborted, or
   *  `release()` came first. */
  readonly acquired: Promise<boolean>;
  /** Releases the lock (or gives up the queued request). */
  release(): void;
}

const isAbort = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";

/** Requests the lock `name` and holds it until `release()` (or until the context ends). */
export function holdLock(locks: LockManagerLike, name: string, options: LockRequestOptions = {}): HeldLock {
  let release!: () => void;
  let released = false;
  const whenReleased = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  const acquired = new Promise<boolean>((resolve, reject) => {
    locks
      .request(name, options, (lock) => {
        if (lock === null || released) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return whenReleased;
      })
      .catch((e: unknown) => (isAbort(e) ? resolve(false) : reject(e)));
  });
  return { acquired, release: () => release() };
}

/** The number of tabs connected to the store `scope` (each holds its presence lock). */
export async function countConnectedTabs(locks: LockManagerLike, scope: string): Promise<number> {
  const prefix = tabLockPrefix(scope);
  const { held = [] } = await locks.query();
  return new Set(held.map((l) => l.name ?? "").filter((n) => n.startsWith(prefix))).size;
}

/**
 * A synchronous reading of {@link countConnectedTabs} for code that cannot wait (such as the engine's system snapshot):
 * each call returns the count read by an earlier call (`null` before the first reading has finished) and starts a new
 * reading.
 */
export function connectedTabsCounter(locks: LockManagerLike, scope: string): () => number | null {
  let last: number | null = null;
  let reading = false;
  const refresh = (): void => {
    if (reading) return;
    reading = true;
    countConnectedTabs(locks, scope).then(
      (n) => { last = n; reading = false; },
      () => { reading = false; },
    );
  };
  refresh();
  return () => {
    refresh();
    return last;
  };
}

/** Resolves once the tab `tab` has closed (its presence lock is released); never, if `signal` aborts first. */
export function whenTabGone(locks: LockManagerLike, scope: string, tab: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    locks
      .request(tabLockName(scope, tab), signal === undefined ? {} : { signal }, (lock) => {
        if (lock !== null) resolve();
        return undefined;
      })
      .catch(() => {});
  });
}
