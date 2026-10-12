/**
 * The explorer's transport in the static build: the host object the explorer script (`../mip0018/ui/page.js`) reads as
 * `window.umbradbExplorerHost`. Its `api(path)` sends the `/v1` path to the browser engine (`EngineClient.api`, the API
 * handler's `{ status, headers, body }`) and answers with a fetch `Response` of that status, those headers (the handler's
 * `content-length` included) and that body, so the script reads it exactly as a fetched answer: the same 8 MiB cap
 * (announced length first, then the bytes read) and the same error rendering. An engine request that fails (the worker
 * is gone, no leader tab answers, the store did not open) rejects, which the script shows as a request that got no
 * answer. `startHeightNotes` asks the script to state the first indexed height next to every list. `shown` tells the
 * script whether it is shown (the main page's Token Indexer tab, `shell.ts`): while it is not, the script skips its
 * periodic refresh.
 */
import type { EngineClient } from "./client.ts";

/** What the explorer script uses of `window.umbradbExplorerHost`. */
export interface ExplorerHost {
  /** Answers one `GET` of a `/v1` path. */
  api(path: string): Promise<Response>;
  /** The script states the first indexed height (`/v1/status` `startHeight`) next to every list. */
  readonly startHeightNotes: boolean;
  /** Whether the explorer is shown; while it is not, its periodic refresh is skipped. */
  shown(): boolean;
}

/** Statuses whose `Response` cannot carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** The engine's answer as a fetch `Response`. */
export function responseOf(answer: { status: number; headers: Record<string, string>; body: string }): Response {
  return new Response(NULL_BODY_STATUSES.has(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
}

/** The host of the static build: every API read goes to `client`, the page's engine client; `shown` says whether the
 *  explorer is shown (default: always). */
export function engineExplorerHost(client: Pick<EngineClient, "api">, shown: () => boolean = () => true): ExplorerHost {
  return {
    startHeightNotes: true,
    shown,
    async api(path: string): Promise<Response> {
      return responseOf(await client.api("GET", path));
    },
  };
}
