/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UmbraDBSql } from "../../../src/postgres/client.js";

/**
 * Statement-indexed fault injection for the archive's per-height transaction (owner Rule A,
 * `spec/00009` FR-029), WITHOUT touching `src/`.
 *
 * The repo's established crash-worker discipline is that a fault is a pause at a NAMED PROGRAM
 * POINT between real operations, never a timer, and never fault code compiled into `src/`
 * (`test/integration/crash/crash-worker.ts`'s header). `putBlockBundle` is one call that issues
 * ~10-30 statements inside a single transaction, so its named program points ARE its statements:
 * "before the Nth statement of the bundle transaction" is precise, reproducible, and covers every
 * point at which a crash could land.
 *
 * The instrumentation is a PROXY around the `postgres.js` handle the store is constructed with.
 * `PgChainArchiveStore` is unchanged and unaware: it receives what looks like an ordinary
 * `UmbraDBSql`, and the proxy counts the tagged-template statements its transaction callback
 * issues, running a caller-supplied hook immediately before the chosen one.
 *
 * Both crash lanes share this module deliberately, so a statement index means the same thing in
 * the in-process PostgreSQL-kill lane and in the child-process SIGKILL lane.
 */

export interface FaultState {
  /** Statements issued so far in the current transaction (1-based once incremented). */
  count: number;
  /** Pause before issuing this statement index; `undefined` runs the transaction untouched. */
  killAtStatement?: number;
  /** Backend pid of the connection running the transaction, discovered at the pause. */
  backendPid?: number;
  /** Invoked once, immediately before the chosen statement is issued. Whatever it does (kill
   *  this backend, signal a parent that will SIGKILL this process) happens with the transaction
   *  open and every earlier statement issued but NOT committed. */
  onReached: (backendPid: number) => Promise<void>;
}

/** True for a tagged-template call (`sql\`...\``), false for the identifier/fragment helper form
 *  (`sql(schema)`, `sql(arrayOfValues)`) the store also uses. A template-strings array is the one
 *  array that carries a `raw` property, which is exactly how the driver itself tells them apart. */
function isTaggedStatement(args: readonly unknown[]): boolean {
  const first = args[0];
  return Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw");
}

function wrapTransaction(tx: any, state: FaultState): any {
  const wrapped = (...args: any[]): any => {
    if (!isTaggedStatement(args)) return tx(...args);
    state.count += 1;
    const index = state.count;
    return (async () => {
      if (state.killAtStatement !== undefined && index === state.killAtStatement) {
        // Discovered here rather than up front: the pid must be the one running THIS
        // transaction, and `postgres.js` only pins a connection once the transaction starts.
        // This extra statement is the harness's own and is deliberately NOT counted -- the
        // indices a test chooses must describe the store's statements only.
        state.backendPid ??= Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
        await state.onReached(state.backendPid);
      }
      return await tx(...args);
    })();
  };
  return new Proxy(wrapped, {
    get: (_target, property) => {
      const value = tx[property];
      return typeof value === "function" ? value.bind(tx) : value;
    },
    has: (_target, property) => property in tx,
  });
}

/**
 * A drop-in `UmbraDBSql` whose `begin` hands the callback an instrumented transaction handle.
 * Every other property and call form passes straight through to the real handle.
 */
export function withStatementFault(sql: UmbraDBSql, state: FaultState): UmbraDBSql {
  const wrapped = (...args: any[]): any => (sql as any)(...args);
  return new Proxy(wrapped, {
    get: (_target, property) => {
      if (property === "begin") {
        return (fn: any) => (sql as any).begin((tx: any) => fn(wrapTransaction(tx, state)));
      }
      const value = (sql as any)[property];
      return typeof value === "function" ? value.bind(sql) : value;
    },
    has: (_target, property) => property in (sql as any),
  }) as unknown as UmbraDBSql;
}

/**
 * What is durably observable about ONE block height, read from a connection that had nothing to
 * do with the write.
 *
 * Rule A says exactly two of these are reachable: everything zero with the watermark below the
 * height, or everything present with the watermark AT the height. Every field is counted
 * separately (rather than, say, trusting the block row to imply the rest) precisely because the
 * failure this guards against is a PARTIAL height.
 */
export interface HeightObservation {
  blockRows: number;
  transactionRows: number;
  observationRows: number;
  checkpointRows: number;
  /** Whether the block row carries its decoded timestamp (migration 008). */
  timestampPresent: boolean;
  /** The archive's own sync watermark for this net, or `undefined` if never written. */
  watermarkHeight: number | undefined;
}

export async function observeHeight(
  sql: UmbraDBSql, schema: string, net: string, height: number, watermarkKey: string,
): Promise<HeightObservation> {
  const [block] = await sql<{ n: number; ts: string | null }[]>`
    SELECT count(*)::int AS n, max(timestamp_ms)::text AS ts
    FROM ${sql(schema)}.blocks WHERE net = ${net} AND height = ${height}
  `;
  const [txs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.transactions
    WHERE net = ${net} AND block_height = ${height}
  `;
  const [obs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.bridge_observations
    WHERE net = ${net} AND block_height = ${height}
  `;
  const [ckpt] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.replay_checkpoints
    WHERE net = ${net} AND block_height = ${height}
  `;
  const [wm] = await sql<{ height: string | null }[]>`
    SELECT (value ->> 'height') AS height FROM ${sql(schema)}.watermarks
    WHERE kind = 'chain_archive' AND key = ${watermarkKey}
  `;
  return {
    blockRows: block?.n ?? 0,
    transactionRows: txs?.n ?? 0,
    observationRows: obs?.n ?? 0,
    checkpointRows: ckpt?.n ?? 0,
    timestampPresent: block?.ts !== null && block?.ts !== undefined,
    watermarkHeight: wm?.height == null ? undefined : Number(wm.height),
  };
}

/** The two -- and only two -- states Rule A permits for a height. */
export type RuleAState = "nothing-of-height" | "all-of-height";

/**
 * Classify an observation, or throw naming the partial state found.
 *
 * Throwing rather than returning a third value is the point: any state that is neither of the two
 * is a Rule A violation, and the message has to say WHICH part of the height survived on its own,
 * because that is the whole diagnostic.
 */
export function classifyRuleAState(
  observed: HeightObservation,
  expected: { height: number; transactionRows: number; observationRows: number; checkpointRows: number },
): RuleAState {
  const nothing =
    observed.blockRows === 0 && observed.transactionRows === 0 &&
    observed.observationRows === 0 && observed.checkpointRows === 0 &&
    (observed.watermarkHeight === undefined || observed.watermarkHeight < expected.height);
  if (nothing) return "nothing-of-height";

  const all =
    observed.blockRows === 1 &&
    observed.transactionRows === expected.transactionRows &&
    observed.observationRows === expected.observationRows &&
    observed.checkpointRows === expected.checkpointRows &&
    observed.timestampPresent &&
    observed.watermarkHeight === expected.height;
  if (all) return "all-of-height";

  throw new Error(
    `Rule A violation at height ${expected.height}: a PARTIAL height is durably observable. ` +
      `Observed ${JSON.stringify(observed)}; a complete height would be ` +
      `${JSON.stringify({ blockRows: 1, ...expected, timestampPresent: true, watermarkHeight: expected.height })} ` +
      "and an absent one would be all zeros with the watermark below it. Everything the archive " +
      "writes for one height must commit in one transaction.",
  );
}
