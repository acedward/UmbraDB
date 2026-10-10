/**
 * The reference states of a recorded range for the crash tests: the digest of every table after each block, computed by
 * the browser engine's worker host in Node (in-memory PGlite) with no interruption.
 *
 * The sync writes only the chain archive's tables (a block, its transactions and its cursor in one transaction) and the
 * scan writes only the `mip0018` tables (a block's rows and its cursor in one transaction), so the state of a store is
 * fully described by its two cursors: the archive's tables must equal the reference after its archive height, the
 * `mip0018` tables the reference after its scan height. The host runs one sync block and one scan block per step, and
 * after every step (no other step runs meanwhile) records the cursors and the per-table digests of `range-tables.ts`.
 */
import { rangeTables, type TableDigest } from "../../engine/range-tables.ts";
import { yieldingScheduler } from "../../browser/scheduler.ts";
import type { HostStatus, TapeRange } from "../../browser/protocol.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA } from "../../browser/store.ts";
import { result, testHost, untilStatus } from "./worker-host.ts";

/** A table key (`archive.<table>` or `mip0018.<table>`) → its row count and SHA-256. */
export type TableState = Record<string, { rows: number; sha256: string }>;

export interface RangeReference {
  /** The archive's tables after the given archive height (`null`: before the first block); a height can have more
   *  than one state when a step writes without moving the cursor (for example a cursor row created before any block). */
  archive: Map<number | null, TableState[]>;
  /** The `mip0018` tables after the given scanned height (`null`: before the first block). */
  scan: Map<number | null, TableState[]>;
  /** The whole-store digests at the end of the range (archive digest, 37-table digest). */
  final: { archive: string; tables: string };
  elapsedMs: number;
}

/** The part of a range-tables digest whose keys start with `prefix`, without the excluded-column lists. */
export function tablesWithPrefix(tables: Record<string, TableDigest | { rows: number; sha256: string }>, prefix: "archive." | "mip0018."): TableState {
  const out: TableState = {};
  for (const k of Object.keys(tables).sort()) if (k.startsWith(prefix)) out[k] = { rows: tables[k]!.rows, sha256: tables[k]!.sha256 };
  return out;
}

/** The heights a status says are stored: the archive height and the last scanned height (`null` when none). */
export function storedHeights(s: Pick<HostStatus, "cursors">): { archive: number | null; scan: number | null } {
  const sync = s.cursors?.sync ?? null;
  const scan = s.cursors?.scan ?? null;
  return {
    archive: sync === null ? null : sync.height,
    scan: scan === null || scan.nextHeight <= scan.fromHeight ? null : scan.nextHeight - 1,
  };
}

/** Replays `range` (`from`–`to`) one block per step and records the reference state after each block. */
export async function rangeReference(range: TapeRange, from: number, to: number): Promise<RangeReference> {
  const t0 = performance.now();
  const archive = new Map<number | null, TableState[]>();
  const scan = new Map<number | null, TableState[]>();
  const add = (m: Map<number | null, TableState[]>, h: number | null, state: TableState): void => {
    const states = m.get(h) ?? [];
    if (!states.some((x) => JSON.stringify(x) === JSON.stringify(state))) states.push(state);
    m.set(h, states);
  };
  let tail: Promise<unknown> = Promise.resolve();
  const t = testHost({
    // One step at a time; after each, the state is recorded before the next step starts.
    schedule: (kind, step) => {
      const run = tail.then(async () => {
        const r = await yieldingScheduler(kind, step);
        await record();
        return r;
      });
      tail = run.catch(() => {});
      return run;
    },
  });
  const record = async (): Promise<void> => {
    const store = t.opened.at(-1)!;
    const s = await result<HostStatus>(t.host, "status");
    const h = storedHeights(s);
    const { digest } = await store.mip0018.begin("read only", async (tx) => rangeTables(tx as unknown as typeof store.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA));
    add(archive, h.archive, tablesWithPrefix(digest.tables, "archive."));
    add(scan, h.scan, tablesWithPrefix(digest.tables, "mip0018."));
  };
  try {
    await t.host.boot();
    await record();
    await result(t.host, "start", { config: { source: { kind: "tape", range }, startHeight: from, endHeight: to, sync: { maxBlocks: 1, idleMs: 100 }, scan: { batch: 1, idleMs: 100 } } });
    await untilStatus(t.host, `the ${range} range`, (s) => s.cursors?.sync?.height === to && s.cursors?.scan?.nextHeight === to + 1, 600_000);
    await tail;
    await record();
    const d = await result<{ archive: { sha256: string }; tables: { sha256: string } }>(t.host, "digest");
    return { archive, scan, final: { archive: d.archive.sha256, tables: d.tables.sha256 }, elapsedMs: performance.now() - t0 };
  } finally {
    await t.host.close();
  }
}

/** The tables of `actual` (a whole-store per-table digest) that differ from the reference at the store's heights. */
export function tornTables(ref: RangeReference, heights: { archive: number | null; scan: number | null }, actual: Record<string, { rows: number; sha256: string }>): string[] {
  const out: string[] = [];
  const check = (prefix: "archive." | "mip0018.", states: TableState[] | undefined, at: number | null): void => {
    if (states === undefined) {
      out.push(`${prefix} no reference state at height ${at}`);
      return;
    }
    const got = tablesWithPrefix(actual, prefix);
    if (states.some((x) => JSON.stringify(x) === JSON.stringify(got))) return;
    // Name the differing tables against the reference's last state at that height.
    const expected = states.at(-1)!;
    for (const k of [...new Set([...Object.keys(expected), ...Object.keys(got)])].sort()) {
      const x = expected[k];
      const y = got[k];
      if (x === undefined || y === undefined || x.rows !== y.rows || x.sha256 !== y.sha256)
        out.push(`${k} at ${at}: expected ${x === undefined ? "no table" : `${x.rows} rows ${x.sha256.slice(0, 12)}`}, got ${y === undefined ? "no table" : `${y.rows} rows ${y.sha256.slice(0, 12)}`}`);
    }
  };
  check("archive.", ref.archive.get(heights.archive), heights.archive);
  check("mip0018.", ref.scan.get(heights.scan), heights.scan);
  return out;
}
