/**
 * Where the browser engine keeps its saved configuration (`EngineSettings` in `protocol.ts`): a JSON file beside the
 * store in the Origin Private File System (`<store directory>.engine.json` in the OPFS root), outside the database, so
 * the chain archive and the MIP-0018 tables stay exactly the indexer's. A file that is missing, unreadable or invalid
 * reads as no settings (the defaults apply). Tests and `memory://` stores keep them in memory.
 */
import { type EngineSettings, EngineSettingsSchema } from "./protocol.ts";

export interface EngineSettingsStore {
  /** The saved settings, or `undefined` when there are none (or they are invalid). */
  load(): Promise<EngineSettings | undefined>;
  save(settings: EngineSettings): Promise<void>;
}

const parse = (value: unknown): EngineSettings | undefined => {
  const r = EngineSettingsSchema.safeParse(value);
  return r.success ? r.data : undefined;
};

export function memorySettingsStore(initial?: unknown): EngineSettingsStore {
  let saved: unknown = initial === undefined ? undefined : JSON.parse(JSON.stringify(initial));
  return {
    load: async () => parse(saved),
    save: async (settings) => { saved = JSON.parse(JSON.stringify(settings)); },
  };
}

/** The settings file of an `opfs-ahp://<name>` store, in the OPFS root. */
export function opfsSettingsStore(dataDir: string, storage: StorageManager | undefined = globalThis.navigator?.storage): EngineSettingsStore {
  const name = `${dataDir.slice("opfs-ahp://".length).replaceAll("/", "_")}.engine.json`;
  const file = async (create: boolean): Promise<FileSystemFileHandle> => {
    if (storage === undefined) throw new Error("no navigator.storage");
    return (await storage.getDirectory()).getFileHandle(name, { create });
  };
  return {
    async load(): Promise<EngineSettings | undefined> {
      try {
        return parse(JSON.parse(await (await (await file(false)).getFile()).text()));
      } catch {
        return undefined;
      }
    },
    async save(settings: EngineSettings): Promise<void> {
      const w = await (await file(true)).createWritable();
      await w.write(JSON.stringify(settings));
      await w.close();
    },
  };
}
