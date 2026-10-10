/**
 * Which PGlite wrote the browser engine's store: a small JSON file kept beside the store in the Origin Private File
 * System (`<store directory>.store.json` in the OPFS root, next to its saved configuration), outside the database.
 *
 * - **"creating"** is written before PGlite creates the store (a new store, or one `reset`, `range` or an import
 *   replaces): the store's first boot has not completed, so it holds nothing yet.
 * - **The identity** replaces it once a boot has opened and migrated the store (and, after an import, loaded its rows):
 *   the PGlite and PostgreSQL versions the store was last opened with, read from the open database. A boot that cannot
 *   save it fails.
 * - **Checked** at boot, before PGlite opens the store: a data directory written by another PGlite version is refused
 *   unopened (opening it could fail, or rewrite it in a form the version that wrote it no longer reads). The boot ends
 *   `failed`, and the user can reset the store (its data is dropped and synced again) or load a snapshot made by this
 *   build.
 * - Only a store marked "creating" (or one with neither this file nor database files) is created again by the boot when
 *   PGlite cannot open it: a worker that ended while PGlite created the database leaves files PGlite cannot open, and
 *   nothing was stored yet. Any other store that fails to open is reported, and the user decides.
 *
 * A file that is missing reads as absent; a file that cannot be read, is not JSON or is not an identity reads as
 * unreadable (reported, never taken as absent). Tests and `memory://` stores keep it in memory.
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

/** The file while PGlite creates the store, before its first boot completes. */
const CreatingSchema = z.strictObject({ format: z.literal(STORE_IDENTITY_FORMAT), creating: z.literal(true) });

/** What the identity file says. */
export type StoreIdentityState =
  | { kind: "absent" }
  | { kind: "creating" }
  | { kind: "identity"; identity: StoreIdentity }
  | { kind: "unreadable"; error: string };

export interface StoreIdentityFile {
  read(): Promise<StoreIdentityState>;
  /** The identity on file, or `undefined` when there is none (absent, "creating" or unreadable). */
  load(): Promise<StoreIdentity | undefined>;
  save(identity: StoreIdentity): Promise<void>;
  /** Marks the store as being created (its first boot not completed). */
  markCreating(): Promise<void>;
  remove(): Promise<void>;
}

/** The state of an identity file's parsed content. */
export function identityStateOf(value: unknown): StoreIdentityState {
  const identity = StoreIdentitySchema.safeParse(value);
  if (identity.success) return { kind: "identity", identity: identity.data };
  if (CreatingSchema.safeParse(value).success) return { kind: "creating" };
  return { kind: "unreadable", error: "the file is not a store identity" };
}

const loadOf = async (file: Pick<StoreIdentityFile, "read">): Promise<StoreIdentity | undefined> => {
  const s = await file.read();
  return s.kind === "identity" ? s.identity : undefined;
};

/** An identity file in memory, holding `initial` (`"creating"`: the store marked as being created). */
export function memoryStoreIdentity(initial?: StoreIdentity | "creating"): StoreIdentityFile {
  let saved: unknown = initial === undefined ? undefined : initial === "creating" ? { format: STORE_IDENTITY_FORMAT, creating: true } : { ...initial };
  const file: StoreIdentityFile = {
    read: async () => (saved === undefined ? { kind: "absent" } : identityStateOf(saved)),
    load: () => loadOf(file),
    save: async (identity) => { saved = { ...identity }; },
    markCreating: async () => { saved = { format: STORE_IDENTITY_FORMAT, creating: true }; },
    remove: async () => { saved = undefined; },
  };
  return file;
}

const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "NotFoundError";
const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e));

/** The identity file of an `opfs-ahp://<name>` store, in the OPFS root. */
export function opfsStoreIdentity(dataDir: string, storage: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined = globalThis.navigator?.storage): StoreIdentityFile {
  const name = `${dataDir.slice("opfs-ahp://".length).replaceAll("/", "_")}.store.json`;
  const root = async (): Promise<FileSystemDirectoryHandle> => {
    if (typeof storage?.getDirectory !== "function") throw new Error("this context has no Origin Private File System");
    return storage.getDirectory();
  };
  const write = async (value: unknown): Promise<void> => {
    // A writable stream replaces the file's content when it closes: the file is the old content or the new one.
    const w = await (await (await root()).getFileHandle(name, { create: true })).createWritable();
    await w.write(JSON.stringify(value));
    await w.close();
  };
  const file: StoreIdentityFile = {
    async read(): Promise<StoreIdentityState> {
      let text: string;
      try {
        text = await (await (await (await root()).getFileHandle(name)).getFile()).text();
      } catch (e) {
        if (isNotFound(e)) return { kind: "absent" };
        return { kind: "unreadable", error: messageOf(e) };
      }
      try {
        return identityStateOf(JSON.parse(text));
      } catch {
        return { kind: "unreadable", error: "the file is not JSON" };
      }
    },
    load: () => loadOf(file),
    save: (identity) => write(identity),
    markCreating: () => write({ format: STORE_IDENTITY_FORMAT, creating: true }),
    async remove(): Promise<void> {
      try {
        await (await root()).removeEntry(name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
  return file;
}

/** The identity file of the store `dataDir`: OPFS for `opfs-ahp://`, memory otherwise. */
export function storeIdentityFor(dataDir: string): StoreIdentityFile {
  return dataDir.startsWith("opfs-ahp://") ? opfsStoreIdentity(dataDir) : memoryStoreIdentity();
}

const CHOICES = "reset it (its data is dropped and synced again) or load a snapshot made by this build";

/** What the user is told when a store written by another PGlite version is refused. */
export function versionRefusal(identity: StoreIdentity, runningPglite: string): string {
  return `this store was written by PGlite ${identity.pglite} (PostgreSQL ${identity.postgres}) and this build runs PGlite ${runningPglite}, so it is not opened: ${CHOICES}`;
}

/** What the user is told when a store that is not being created fails to open. */
export function unopenableStore(error: string): string {
  return `the store could not be opened (${error}): ${CHOICES}`;
}

/** What the user is told when the store's identity file cannot be read: which PGlite wrote the store is unknown. */
export function unreadableIdentity(error: string): string {
  return `the store's identity file cannot be read (${error}), so which PGlite version wrote the store is unknown and it is not opened: ${CHOICES}`;
}

/** What the user is told when the store opened but the boot could not complete on it. */
export function unusableStore(error: string): string {
  return `the store could not be used (${error}): ${CHOICES}`;
}
