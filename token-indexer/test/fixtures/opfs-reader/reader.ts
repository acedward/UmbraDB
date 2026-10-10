/**
 * Test page: reads a PGlite store in this origin's OPFS from a dedicated worker (`reader-worker.ts`), independently of
 * the engine. `window.readStore(dataDir, statements)` opens the store, runs each statement and resolves with each
 * statement's rows (int8 values as strings). The engine's worker must be gone first: a store has one owner at a time.
 */
declare global {
  interface Window {
    readStore?: (dataDir: string, statements: string[]) => Promise<unknown[][]>;
  }
}

window.readStore = (dataDir, statements) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./reader-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ ok: boolean; rows?: unknown[][]; error?: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.rows!);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ dataDir, statements });
  });

export {};
