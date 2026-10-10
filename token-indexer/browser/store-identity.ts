/**
 * Which PGlite wrote the browser engine's store: a small JSON file kept beside the store in the Origin Private File
 * System (`<store directory>.store.json` in the OPFS root, next to its saved configuration), outside the database.
 *
 * - **Written** once a boot has opened and migrated the store (a new store: once it is complete), and after a snapshot
 *   import: the PGlite and PostgreSQL versions the store was last opened with, read from the open database.
 * - **Checked** at boot, before PGlite opens the store: a data directory written by another PGlite version is refused
 *   unopened (opening it could fail, or rewrite it in a form the version that wrote it no longer reads). The boot ends
 *   `failed`, and the user can reset the store (its data is dropped and synced again) or load a snapshot made by this
 *   build.
 * - **Absent** for a store whose first boot never completed: a worker ended while PGlite was creating the database, which
 *   leaves files PGlite cannot open again. The boot then removes them and creates the store anew (nothing was stored
 *   yet). A store with the file that fails to open is reported instead: the user decides.
 *
 * A file that is missing, unreadable or invalid reads as absent. Tests and `memory://` stores keep it in memory.
 */
import { z } from "zod";

export const STORE_IDENTITY_FORMAT = 1;

export const StoreIdentitySchema = z.strictObject({
  format: z.literal(STORE_IDENTITY_FORMAT),
  /** The PGlite version (`0.5.8`) and its PostgreSQL version (`18.3`) that last opened the store. */
  pglite: z.string().min(1).max(64),
  postgres: z.string().min(1).max(64),
});
export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;

export interface StoreIdentityFile {
  /** The identity on file, or `undefined` when there is none (or it is invalid). */
  load(): Promise<StoreIdentity | undefined>;
  save(identity: StoreIdentity): Promise<void>;
  remove(): Promise<void>;
}

const parse = (value: unknown): StoreIdentity | undefined => {
  const r = StoreIdentitySchema.safeParse(value);
  return r.success ? r.data : undefined;
};

export function memoryStoreIdentity(initial?: StoreIdentity): StoreIdentityFile {
  let saved: StoreIdentity | undefined = initial === undefined ? undefined : { ...initial };
  return {
    load: async () => (saved === undefined ? undefined : { ...saved }),
    save: async (identity) => { saved = { ...identity }; },
    remove: async () => { saved = undefined; },
  };
}

const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "NotFoundError";

/** The identity file of an `opfs-ahp://<name>` store, in the OPFS root. */
export function opfsStoreIdentity(dataDir: string, storage: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined = globalThis.navigator?.storage): StoreIdentityFile {
  const name = `${dataDir.slice("opfs-ahp://".length).replaceAll("/", "_")}.store.json`;
  const root = async (): Promise<FileSystemDirectoryHandle> => {
    if (typeof storage?.getDirectory !== "function") throw new Error("this context has no Origin Private File System");
    return storage.getDirectory();
  };
  return {
    async load(): Promise<StoreIdentity | undefined> {
      try {
        return parse(JSON.parse(await (await (await (await root()).getFileHandle(name)).getFile()).text()));
      } catch {
        return undefined;
      }
    },
    async save(identity: StoreIdentity): Promise<void> {
      // A writable stream replaces the file's content when it closes: the file is the old identity or the new one.
      const w = await (await (await root()).getFileHandle(name, { create: true })).createWritable();
      await w.write(JSON.stringify(identity));
      await w.close();
    },
    async remove(): Promise<void> {
      try {
        await (await root()).removeEntry(name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

/** The identity file of the store `dataDir`: OPFS for `opfs-ahp://`, memory otherwise. */
export function storeIdentityFor(dataDir: string): StoreIdentityFile {
  return dataDir.startsWith("opfs-ahp://") ? opfsStoreIdentity(dataDir) : memoryStoreIdentity();
}

/** What the user is told when a store written by another PGlite version is refused. */
export function versionRefusal(identity: StoreIdentity, runningPglite: string): string {
  return `this store was written by PGlite ${identity.pglite} (PostgreSQL ${identity.postgres}) and this build runs PGlite ${runningPglite}, so it is not opened: reset it (its data is dropped and synced again) or load a snapshot made by this build`;
}

/** What the user is told when a store that completed a boot before fails to open. */
export function unopenableStore(error: string): string {
  return `the store could not be opened (${error}): reset it (its data is dropped and synced again) or load a snapshot made by this build`;
}
