/** The reader page's worker: opens the PGlite store at `dataDir`, runs the statements, closes it, posts the rows. */
import { PGlite } from "@electric-sql/pglite";

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<{ dataDir: string; statements: string[] }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async (e) => {
  try {
    const db = await PGlite.create({ dataDir: e.data.dataDir });
    const rows: unknown[][] = [];
    for (const s of e.data.statements) rows.push((await db.query(s)).rows);
    await db.close();
    scope.postMessage({ ok: true, rows: JSON.parse(JSON.stringify(rows, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
