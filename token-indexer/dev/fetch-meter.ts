/**
 * Request meter for development range syncs: preloaded with
 * `node --import tsx --import ./token-indexer/dev/fetch-meter.ts <cli>`, it wraps the global `fetch` and appends ONE
 * JSON line per request to `$FETCH_METER_OUT` — host, operation (the JSON-RPC `method` or the first GraphQL field),
 * HTTP status (or the error name), duration — so request counts stay exact even when the process is killed with
 * SIGKILL (no exit handler needed). Nothing is sent anywhere; without `FETCH_METER_OUT` it does nothing.
 *
 * The clients pick up `fetch` when they are constructed (`opts.fetchImpl ?? fetch`), so the wrapper must be installed
 * before the CLI module is evaluated — which `--import` guarantees.
 */
import { appendFileSync } from "node:fs";

const out = process.env.FETCH_METER_OUT;

/** `chain_getBlock`, `block`, … — what the request asks for; never the request's data. */
export function operationOf(body: unknown): string {
  if (typeof body !== "string") return "?";
  try {
    const parsed = JSON.parse(body) as { method?: unknown; query?: unknown };
    if (typeof parsed.method === "string") return parsed.method;
    if (typeof parsed.query === "string") {
      const m = /\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(parsed.query);
      return m === null ? "graphql" : m[1]!;
    }
  } catch {
    // not JSON
  }
  return "?";
}

if (out !== undefined && out !== "") {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "?";
    try {
      host = new URL(url).host;
    } catch {
      // keep "?"
    }
    const op = operationOf(init?.body);
    const t0 = Date.now();
    const line = (status: string): void => {
      appendFileSync(out, `${JSON.stringify({ t: t0, ms: Date.now() - t0, host, op, status })}\n`);
    };
    try {
      const res = await original(input, init);
      line(String(res.status));
      return res;
    } catch (error) {
      line(`error:${(error as Error)?.name ?? "unknown"}`);
      throw error;
    }
  };
}
