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
 */
import type { PGlite } from "@electric-sql/pglite";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { DurabilityMode } from "../../src/postgres/durability-probe.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";

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

/** Opens (creating it on a first open) the PGlite database at `dataDir` and its two clients. */
export async function openStore(dataDir: string): Promise<Store> {
  const existed = await storeExists(dataDir);
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = await PGlite.create({ dataDir });
  return {
    dataDir,
    created: !existed,
    pglite,
    archive: clientFor(pglite, ARCHIVE_SCHEMA),
    mip0018: clientFor(pglite, MIP0018_SCHEMA),
    close: () => pglite.close(),
  };
}
