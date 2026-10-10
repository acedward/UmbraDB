/**
 * The browser engine's store: one PGlite database (`opfs-ahp://<name>` in Chrome, `memory://` in tests) shared by two
 * postgres.js-compatible clients (`src/postgres/pglite-sql.ts`), one per schema lineage: `chain_archive` (the sync) and
 * `mip0018` (the scan and the API). Both clients share PGlite's single session.
 *
 * PGlite opens with its default start parameters (`fsync` off) and both clients are `non-durable`: the durability probe
 * the migrations run accepts `fsync=off` on PGlite in that mode, and `/v1/status` reports it. On OPFS, PGlite flushes
 * the files it wrote after every statement, so a committed block is on disk once its statement returns; the store is
 * a cache of public chain data that a reset or a snapshot rebuilds. The clients' defaults give results and errors as
 * postgres.js does (int8 as `bigint`, numeric as text, database errors as `PostgresError`); bytea is a `Uint8Array`.
 *
 * Only one worker has an OPFS store open at a time: opening it first takes the Web Lock `umbradb-store:<dataDir>`
 * (`tab-locks.ts`), held until the store is closed or the worker ends, and then waits until no other context still holds
 * the store's state file (a closed tab's worker, or a replaced one, can take a moment to let go of its files). Only
 * the leader tab runs a worker (`tabs.ts`); the lock also covers a worker the leader tab replaces.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { DurabilityMode } from "../../src/postgres/durability-probe.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { defaultLocks, type HeldLock, holdLock, type LockManagerLike, storeLockName } from "./tab-locks.ts";

/** The durability mode of the browser store's clients. */
export const STORE_DURABILITY: DurabilityMode = "non-durable";

export const ARCHIVE_SCHEMA = "chain_archive";
export const MIP0018_SCHEMA = "mip0018";

/** PGlite's OPFS store keeps this file at the root of its directory once it has been opened. */
const OPFS_AHP_STATE_FILE = "state.txt";

export interface Store {
  readonly dataDir: string;
  /** The store did not exist before this open (PGlite created the database). */
  readonly created: boolean;
  readonly pglite: PGlite;
  /** Client of the `chain_archive` schema. */
  readonly archive: UmbraDBSql;
  /** Client of the `mip0018` schema. */
  readonly mip0018: UmbraDBSql;
  close(): Promise<void>;
  /** Closes PGlite and hands over the store's lock still held (`undefined` for a store opened without one), for a
   *  caller that replaces the store's files and opens it again with {@link OpenStoreOptions.lock}. */
  detach(): Promise<HeldLock | undefined>;
}

function clientFor(pglite: PGlite, schema: string): UmbraDBSql {
  return createPgliteClient({ pglite, schema, durability: STORE_DURABILITY });
}

/** Whether `dataDir` names an OPFS store that has been opened before. Only `opfs-ahp://` stores persist here. */
export async function storeExists(dataDir: string, storage: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined = globalThis.navigator?.storage): Promise<boolean> {
  if (!dataDir.startsWith("opfs-ahp://") || typeof storage?.getDirectory !== "function") return false;
  try {
    let dir = await storage.getDirectory();
    for (const part of dataDir.slice("opfs-ahp://".length).split("/").filter((p) => p !== "")) dir = await dir.getDirectoryHandle(part);
    const state = await (await dir.getFileHandle(OPFS_AHP_STATE_FILE)).getFile();
    return state.size > 0;
  } catch {
    return false;
  }
}

/** How long opening an OPFS store waits for another worker to let go of it before failing. */
export const STORE_OPEN_WAIT_MS = 10_000;

export interface OpenStoreOptions {
  /** Default: `navigator.locks` (without it no lock is taken). */
  locks?: LockManagerLike;
  /** Default: `navigator.storage`. */
  storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  /** Default {@link STORE_OPEN_WAIT_MS}. */
  waitMs?: number;
  /** The store's lock, already held (from {@link Store.detach}): it is kept instead of taking the lock again. */
  lock?: HeldLock;
  /**
   * Runs under the store's lock before PGlite opens the store. It may return a data directory (a tar of `PGDATA`, as
   * PGlite's `dumpDataDir` writes it) for PGlite to load into the store, whose files it has removed: a snapshot import
   * (`snapshot-store.ts`).
   */
  prepare?: (dataDir: string) => Promise<Blob | undefined | void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the store's lock (`umbradb-store:<dataDir>`), waiting up to `waitMs` while another worker holds it. Resolves with
 * the held lock; fails, naming the store, when it is not released in time.
 */
export async function acquireStoreLock(dataDir: string, locks: LockManagerLike, waitMs: number = STORE_OPEN_WAIT_MS): Promise<HeldLock> {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), waitMs);
  const lock = holdLock(locks, storeLockName(dataDir), { signal: giveUp.signal });
  try {
    if (!(await lock.acquired))
      throw new Error(`the store ${dataDir} is open in another engine worker (another tab of this browser profile?) and was not released within ${waitMs} ms`);
  } finally {
    clearTimeout(timer);
  }
  return lock;
}

/**
 * Waits until no other context holds the store's state file (PGlite holds it open for as long as the store is open), by
 * opening and closing a sync access handle on it; returns at once for a store that does not exist yet.
 */
async function waitForStoreFiles(dataDir: string, storage: OpenStoreOptions["storage"], deadline: number): Promise<void> {
  if (typeof storage?.getDirectory !== "function") return;
  let file: FileSystemFileHandle;
  try {
    let dir = await storage.getDirectory();
    for (const part of dataDir.slice("opfs-ahp://".length).split("/").filter((p) => p !== "")) dir = await dir.getDirectoryHandle(part);
    file = await dir.getFileHandle(OPFS_AHP_STATE_FILE);
  } catch {
    return;
  }
  const probe = file as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{ close(): void }> };
  if (typeof probe.createSyncAccessHandle !== "function") return;
  for (;;) {
    try {
      (await probe.createSyncAccessHandle()).close();
      return;
    } catch (e) {
      const busy = typeof e === "object" && e !== null && (e as { name?: unknown }).name === "NoModificationAllowedError";
      if (!busy) throw e;
      if (Date.now() > deadline) throw new Error(`the store ${dataDir} is still held by another context`);
      await sleep(20);
    }
  }
}

/** Opens (creating it on a first open) the PGlite database at `dataDir` and its two clients. */
export async function openStore(dataDir: string, options: OpenStoreOptions = {}): Promise<Store> {
  const persistent = dataDir.startsWith("opfs-ahp://");
  const locks = options.locks ?? defaultLocks();
  const waitMs = options.waitMs ?? STORE_OPEN_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const lock = options.lock ?? (persistent && locks !== undefined ? await acquireStoreLock(dataDir, locks, waitMs) : undefined);
  let pglite: PGlite;
  let existed: boolean;
  try {
    if (persistent) await waitForStoreFiles(dataDir, options.storage ?? globalThis.navigator?.storage, deadline);
    const load = await options.prepare?.(dataDir);
    existed = await storeExists(dataDir, options.storage);
    const { PGlite } = await import("@electric-sql/pglite");
    pglite = await PGlite.create(load instanceof Blob ? { dataDir, loadDataDir: load } : { dataDir });
  } catch (e) {
    lock?.release();
    throw e;
  }
  return {
    dataDir,
    created: !existed,
    pglite,
    archive: clientFor(pglite, ARCHIVE_SCHEMA),
    mip0018: clientFor(pglite, MIP0018_SCHEMA),
    close: async () => {
      try {
        await pglite.close();
      } finally {
        lock?.release();
      }
    },
    detach: async () => {
      try {
        await pglite.close();
      } catch (e) {
        lock?.release();
        throw e;
      }
      return lock;
    },
  };
}
