/**
 * The reference states of a recorded range for the crash tests: the digest of every table after a given block,
 * computed by the browser engine's worker host in Node (in-memory PGlite) with no interruption.
 *
 * The sync writes only the chain archive's tables (a block, its transactions and its cursor in one transaction) and the
 * scan writes only the `mip0018` tables (a block's rows and its cursor in one transaction), so the state of a store is
 * described by its two cursors: its archive tables must equal the reference after its archive height, its `mip0018`
 * tables the reference after its scanned height. Every table counts, found in the catalog (`range-tables.ts`), so a
 * torn block shows in whichever table it left rows in (or lacks them).
 *
 * {@link referenceStates} computes them for the heights a test saw: first one block per step over the range's first two
 * blocks, recording the state after every step (before the first block a height has two states: with and without the
 * scan's cursor row, which the scan creates before it scans anything), then one forward pass that stops the engine at
 * each further height asked for.
 */
import { rangeTables, type TableDigest } from "../../engine/range-tables.ts";
import { yieldingScheduler } from "../../browser/scheduler.ts";
import type { HostStatus, TapeRange } from "../../browser/protocol.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA } from "../../browser/store.ts";
import { result, testHost, untilStatus } from "./worker-host.ts";

/** A table key (`archive.<table>` or `mip0018.<table>`) → its row count and SHA-256. */
export type TableState = Record<string, { rows: number; sha256: string }>;

export interface RangeReference {
  /** The archive's tables after the given archive height (`null`: before the first block). */
  archive: Map<number | null, TableState[]>;
  /** The `mip0018` tables after the given scanned height (`null`: before the first block). */
  scan: Map<number | null, TableState[]>;
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

const same = (a: TableState, b: TableState): boolean => JSON.stringify(a) === JSON.stringify(b);

function add(m: Map<number | null, TableState[]>, h: number | null, state: TableState): void {
  const states = m.get(h) ?? [];
  if (!states.some((x) => same(x, state))) states.push(state);
  m.set(h, states);
}

/** Replays `range` from `from` and records the reference states at `heights` (and every state before the first block). */
export async function referenceStates(range: TapeRange, from: number, heights: Iterable<number | null>): Promise<RangeReference> {
  const t0 = performance.now();
  const ref: RangeReference = { archive: new Map(), scan: new Map(), elapsedMs: 0 };
  const config = { source: { kind: "tape", range }, startHeight: from, sync: { idleMs: 50 }, scan: { idleMs: 100 } } as const;

  // The first two blocks, one block per step, the state recorded after every step.
  {
    let tail: Promise<unknown> = Promise.resolve();
    const t = testHost({
      schedule: (kind, step) => {
        const run = tail.then(async () => {
          const r = await yieldingScheduler(kind, step);
          await record(t, ref);
          return r;
        });
        tail = run.catch(() => {});
        return run;
      },
    });
    try {
      await t.host.boot();
      await record(t, ref);
      await result(t.host, "start", { config: { ...config, endHeight: from + 1, sync: { idleMs: 50, maxBlocks: 1 }, scan: { idleMs: 100, batch: 1 } } });
      await untilStatus(t.host, "the first two blocks", (s) => s.cursors?.sync?.height === from + 1 && s.cursors?.scan?.nextHeight === from + 2, 120_000);
      await tail;
    } finally {
      await t.host.close();
    }
  }

  // Then one pass that stops at each further height.
  const later = [...new Set([...heights].filter((h): h is number => h !== null && h > from + 1))].sort((a, b) => a - b);
  if (later.length > 0) {
    const t = testHost();
    try {
      await t.host.boot();
      for (const h of later) {
        await result(t.host, "start", { config: { ...config, endHeight: h } });
        await untilStatus(t.host, `height ${h}`, (s) => s.cursors?.sync?.height === h && s.cursors?.scan?.nextHeight === h + 1, 600_000);
        await result(t.host, "stop");
        await record(t, ref);
      }
    } finally {
      await t.host.close();
    }
  }
  ref.elapsedMs = performance.now() - t0;
  return ref;
}

/** Records the store's state at its cursors, read in one transaction while no step runs. */
async function record(t: ReturnType<typeof testHost>, ref: RangeReference): Promise<void> {
  const store = t.opened.at(-1)!;
  const h = storedHeights(await result<HostStatus>(t.host, "status"));
  const { digest } = await store.mip0018.begin("read only", async (tx) => rangeTables(tx as unknown as typeof store.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA));
  add(ref.archive, h.archive, tablesWithPrefix(digest.tables, "archive."));
  add(ref.scan, h.scan, tablesWithPrefix(digest.tables, "mip0018."));
}

/** The tables of a store (its per-table digests) that differ from the reference at its heights; `[]` when none does. */
export function tornTables(ref: RangeReference, heights: { archive: number | null; scan: number | null }, actual: Record<string, { rows: number; sha256: string }>): string[] {
  const out: string[] = [];
  const check = (prefix: "archive." | "mip0018.", states: TableState[] | undefined, at: number | null): void => {
    if (states === undefined) {
      out.push(`${prefix} no reference state at height ${at}`);
      return;
    }
    const got = tablesWithPrefix(actual, prefix);
    if (states.some((x) => same(x, got))) return;
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
