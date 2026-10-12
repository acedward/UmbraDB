/**
 * Test page: the MIP-0018 vector consumer that answers through the PGlite store (`worker.ts`), in a dedicated
 * worker on OPFS. `window.vectorConsumer` sends one request at a time to the worker:
 * - `info()`: the store the consumer answers from (data directory, whether it was created, server version, `fsync`,
 *   durability mode);
 * - `handle(request)`: one runner-protocol request, answered by `createPgVectorConsumer` (`vector-consumer-pg.ts`);
 * - `schemas(prefix)`: how many schemas whose name starts with `prefix` exist in the store;
 * - `created()`: how many fresh schemas the consumer has created.
 */
declare global {
  interface Window {
    vectorConsumer?: {
      info(): Promise<unknown>;
      handle(request: unknown): Promise<unknown>;
      schemas(prefix: string): Promise<number>;
      created(): Promise<number>;
    };
  }
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 1;

worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>) => {
  const p = pending.get(e.data.id);
  if (p === undefined) return;
  pending.delete(e.data.id);
  if (e.data.ok) p.resolve(e.data.value);
  else p.reject(new Error(e.data.error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(`worker error: ${e.message}`));
  pending.clear();
};

function call<T>(op: "info" | "handle" | "schemas" | "created", arg?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, op, arg });
  });
}

window.vectorConsumer = {
  info: () => call("info"),
  handle: (request) => call("handle", request),
  schemas: (prefix) => call("schemas", prefix),
  created: () => call("created"),
};

export {};
