import { loadLedger } from "../../offers.js";
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
 * (`spec/00016-dust-wallet-sync.md` Stories 2 and 3; plan 00016 D2.2, D2.3, D2.6).
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
  /** Resolves when the start-up DUST-parameter comparison has finished. It runs in the
   *  BACKGROUND of {@link DustModule.start} — it is one database round trip against a possibly
   *  unreachable host, and a node must not spend a 30-second connect timeout before it listens —
   *  so a test that wants to assert on it waits here instead of sleeping. */
  whenParametersChecked(): Promise<void>;
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
  let parametersCheck: DustStatusBlock["parametersCheck"] = "skipped";
  let parametersProbe: Promise<void> = Promise.resolve();

  /**
   * D2.6: the mirror's DUST parameters must be the chain's.
   *
   * They do not affect the TREES at all — a `DustLocalState` takes its parameters from its
   * constructor and ignores parameter events entirely (measured in Phase 1, question Q-9) — so a
   * mismatch cannot produce a wrong root. What it produces is a wrong `params` block on
   * `GET /v1/dust/tip`, which every wallet then uses to compute `walletBalance`. That is why the
   * check exists and why a mismatch is loud rather than fatal: the segments a wallet needs to
   * spend are still correct.
   *
   * ── Why it is best-effort, and what that costs ──────────────────────────────────────────
   * The comparison needs a serialized `LedgerState`, which lives in `replay_checkpoints` joined
   * to `chain_blobs`. The role spec §5.3 defines grants `SELECT` on `dust_events` and `blocks`
   * and NOTHING else, so under the deployment the spec actually prescribes this query is denied
   * and the check reports `skipped`. Widening the role to run it would widen the waiver — the one
   * thing FR-017 asks to keep narrow. Recorded as question **Q-15** for the owner; the operator
   * recipe in `docs/shielded-monitor-deployment.md` carries the two extra GRANTs as an explicitly
   * OPTIONAL stanza for a deployment that wants the check.
   */
  async function checkParameters(): Promise<void> {
    const probe = await db.selectLatestCheckpoint(options.net);
    if (probe.status === "unavailable") {
      log(
        `[dust] parameter check skipped: this role may not read the replay checkpoints ` +
          `(${probe.reason}). See docs/shielded-monitor-deployment.md and question Q-15.`,
      );
      parametersCheck = "skipped";
      return;
    }
    if (probe.status === "none") {
      log("[dust] parameter check skipped: the archive holds no replay checkpoint for this net");
      parametersCheck = "skipped";
      return;
    }
    try {
      const ledger = options.ledger ?? (await loadLedger());
      const chainState = ledger.LedgerState.deserialize(probe.state);
      try {
        const chain = chainState.parameters.dust;
        const ours = ledger.LedgerParameters.initialParameters().dust;
        const fields = ["nightDustRatio", "generationDecayRate", "dustGracePeriodSeconds", "timeToCapSeconds"];
        const differing = fields.filter((field) => String(chain[field]) !== String(ours[field]));
        if (differing.length === 0) {
          parametersCheck = "ok";
          log(`[dust] parameter check ok against the checkpoint at height ${probe.height.toString(10)}`);
          return;
        }
        parametersCheck = "mismatch";
        // The VALUES are safe to print — DUST parameters are public chain configuration — and
        // naming them is the whole value of the line to whoever has to act on it.
        log(
          `[dust] PARAMETER MISMATCH at height ${probe.height.toString(10)}: ` +
            differing.map((field) => `${field} chain=${String(chain[field])} ours=${String(ours[field])}`).join(", ") +
            ". /v1/dust/tip will report parameters this chain does not use; balances computed from " +
            "them will be wrong. See spec 00016 D2.6 and question Q-9.",
        );
      } finally {
        chainState.free?.();
      }
    } catch (err) {
      parametersCheck = "skipped";
      log(`[dust] parameter check skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
      return dustStatusBlock(mirror.status(), parametersCheck);
    },

    async start() {
      await mirror.start();
      // Fired, not awaited: see `whenParametersChecked`. The fold is what a cold start is really
      // waiting on, and it has already begun by the time this returns.
      parametersProbe = checkParameters().catch(() => undefined);
    },

    async whenParametersChecked() {
      await parametersProbe;
    },

    async stop() {
      await parametersProbe.catch(() => undefined);
      await mirror.stop();
      await db.close().catch(() => undefined);
    },
  };
}

/** Everything the module needs from its own directory, re-exported so the three permitted
 *  importers never reach past `index.ts` into its internals. */
export { disabledDustStatus as dustDisabledStatus };
