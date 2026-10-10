/**
 * Where the browser engine keeps its saved configuration (`EngineSettings` in `protocol.ts`): a JSON file beside the
 * store in the Origin Private File System (`<store directory>.engine.json` in the OPFS root), outside the database, so
 * the chain archive and the MIP-0018 tables stay exactly the indexer's. A file that is missing, unreadable or invalid
 * reads as no settings (the defaults apply). Tests and `memory://` stores keep them in memory.
 *
 * The file is the one record of what the engine should run: every worker (a reload, a worker the watchdog restarted,
 * the next leader tab) starts from it. Besides the settings it may say that the store is to be replaced by a new, empty
 * one before they apply (`newStore`): `range` and `reset` write their new settings with that mark in one write, before
 * they touch the store, and the boot that has made the new store saves them again without it. A worker that ends in
 * between leaves the mark, and the next boot makes the new store first, so the new settings never run on the old store.
 */
import { z } from "zod";
import { EngineSettingsSchema } from "./protocol.ts";

/** The settings file: the saved settings, and whether the store is to be replaced by a new one before they apply. */
export const SavedSettingsSchema = EngineSettingsSchema.extend({ newStore: z.literal(true).optional() });
export type SavedSettings = z.infer<typeof SavedSettingsSchema>;

export interface EngineSettingsStore {
  /** The saved settings, or `undefined` when there are none (or they are invalid). */
  load(): Promise<SavedSettings | undefined>;
  /** Saves the settings; they are on file in full once this resolves, and as they were when it rejects. */
  save(settings: SavedSettings): Promise<void>;
}

const parse = (value: unknown): SavedSettings | undefined => {
  const r = SavedSettingsSchema.safeParse(value);
  return r.success ? r.data : undefined;
};

export function memorySettingsStore(initial?: unknown): EngineSettingsStore {
  let saved: unknown = initial === undefined ? undefined : JSON.parse(JSON.stringify(initial));
  return {
    load: async () => parse(saved),
    save: async (settings) => { saved = JSON.parse(JSON.stringify(settings)); },
  };
}

/** The settings file of an `opfs-ahp://<name>` store, in the OPFS root (written through a writable stream, whose content
 *  replaces the file's when it closes). */
export function opfsSettingsStore(dataDir: string, storage: StorageManager | undefined = globalThis.navigator?.storage): EngineSettingsStore {
  const name = `${dataDir.slice("opfs-ahp://".length).replaceAll("/", "_")}.engine.json`;
  const file = async (create: boolean): Promise<FileSystemFileHandle> => {
    if (storage === undefined) throw new Error("no navigator.storage");
    return (await storage.getDirectory()).getFileHandle(name, { create });
  };
  return {
    async load(): Promise<SavedSettings | undefined> {
      try {
        return parse(JSON.parse(await (await (await file(false)).getFile()).text()));
      } catch {
        return undefined;
      }
    },
    async save(settings: SavedSettings): Promise<void> {
      const w = await (await file(true)).createWritable();
      await w.write(JSON.stringify(settings));
      await w.close();
    },
  };
}
