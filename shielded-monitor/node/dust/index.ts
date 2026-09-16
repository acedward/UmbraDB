import { loadDustConfig, type DustConfig } from "./config.js";
import { openDustDb, type DustDb } from "./db.js";
import { DustStateMirror } from "./mirror.js";
import { createDustRoutes, DUST_ROUTE_NAMES, type DustReply, type DustRouteName } from "./routes.js";
import { disabledDustStatus, dustStatusBlock, type DustStatusBlock } from "./status.js";
import { DustHttpError, dustErrorBody } from "./wire.js";

export { DUST_ROUTE_NAMES, type DustReply, type DustRouteName } from "./routes.js";
export { type DustStatusBlock, disabledDustStatus } from "./status.js";

/**
 * The DUST module: one object the node creates when `DUST_DATABASE_URL` is set, and the only
 * thing the rest of project B knows about this directory
 * (`spec/00016-dust-wallet-sync.md` Stories 2 and 3; plan 00016 D2.2, D2.3, and question Q-22
 * option C, which replaced D2.6).
 *
 * ── Project B deserializes no ledger state, anywhere ────────────────────────────────────────
 * This module used to verify the mirror's DUST parameters by reading the newest replay checkpoint
 * and calling `ledger.LedgerState.deserialize` on it. On preprod that blob is 31 229 296 B and the
 * deserialize is MINUTES of one synchronous WASM call: the node accepted connections and answered
 * nothing — not `/v1/health`, not `/internal/status` — for as long as it ran, and the balancer
 * marked it unhealthy (question Q-22, measured 2026-09-16).
 *
 * The parameters now arrive as a three-number row the ingest wrote (`chain_archive.dust_parameters`,
 * migration 010), read by the mirror as one index scan. `LedgerState` is not referenced anywhere
 * under `shielded-monitor/node/dust/`, and a test asserts that.
 *
 * Exactly three B files outside `shielded-monitor/node/dust/` may import it — `node-cli.ts`,
 * `node/monitor-node.ts` and `api/server.ts` — and `import-boundary.test.ts` asserts that list,
 * so the waived database access cannot spread by an import someone adds in passing.
 */
export interface DustModule {
  /** Answers one `/v1/dust/*` request. Never throws: a refusal is a reply with a code. */
  handle(route: DustRouteName, url: URL, body: Buffer): Promise<DustReply>;
  status(): DustStatusBlock;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateDustModuleOptions {
  readonly net: string;
  readonly logger?: (line: string) => void;
  /** Injected by tests. Production opens the connection from the configuration. */
  readonly db?: DustDb;
  readonly config?: DustConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ledger?: any;
}

/**
 * Builds the module, or `undefined` when `DUST_DATABASE_URL` is unset.
 *
 * `undefined` is the DISABLED state, and it is not an error: a monitor node that serves no DUST
 * is the ordinary deployment of everything before this project, and it must keep working exactly
 * as it did (FR-010). The node answers `503 DUST_DISABLED` for the five routes and reports
 * `dust: { enabled: false }`.
 */
export function createDustModule(
  env: NodeJS.ProcessEnv,
  options: CreateDustModuleOptions,
): DustModule | undefined {
  const config = options.config ?? loadDustConfig(env);
  if (config === undefined) return undefined;
  const log = options.logger ?? (() => undefined);
  const db = options.db ?? openDustDb(config.databaseUrl);
  const mirror = new DustStateMirror({
    db,
    net: options.net,
    config,
    logger: log,
    ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
  });
  const routes = createDustRoutes({ db, mirror, net: options.net });
  return {
    async handle(route, url, body) {
      try {
        return await routes(route, url, body);
      } catch (err) {
        if (err instanceof DustHttpError) {
          return { status: err.status, body: dustErrorBody(err), errorCode: err.code };
        }
        // Anything unmapped is this module's own fault and its message has not been reviewed for
        // what it might quote — on `lookup` that could be a nullifier. A fixed body, and the
        // class name only, reaches the log through `errorCode`.
        log(`[dust] ${route} failed: ${err instanceof Error ? err.name : typeof err}`);
        return {
          status: 500,
          body: { error: { code: "DUST_INTERNAL_ERROR", message: "internal error" } },
          errorCode: "DUST_INTERNAL_ERROR",
        };
      }
    },

    status() {
      return dustStatusBlock(mirror.status());
    },

    async start() {
      // Nothing is fired off in the background any anymore. The start-up DUST-parameter check used
      // to be: it read the newest replay checkpoint and called `LedgerState.deserialize` on a blob
      // that is 31 MB on a real archive, which is minutes of synchronous WASM on this process's
      // only thread and left the node answering NOTHING (question Q-22). The mirror now reads the
      // three values out of `chain_archive.dust_parameters` as part of its own start, which is one
      // single-row index scan — so there is nothing to defer and nothing to wait on.
      await mirror.start();
    },

    async stop() {
      await mirror.stop();
      await db.close().catch(() => undefined);
    },
  };
}

/** Everything the module needs from its own directory, re-exported so the three permitted
 *  importers never reach past `index.ts` into its internals. */
export { disabledDustStatus as dustDisabledStatus };
