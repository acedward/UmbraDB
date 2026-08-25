/**
 * Stdout sentinels shared between `crash-ingest-worker.ts` and `ingest-crash.test.ts`.
 *
 * They live in their own module because the worker's entry file RUNS on import — a test importing
 * constants from it would start a second ingester inside the test process. Same reason
 * `test/postgres/setup.ts` keeps its sentinel constants beside the spawner rather than in the
 * worker.
 */

export const CRASH_INGEST_READY = "@@CRASH_INGEST_READY@@";
export const CRASH_INGEST_COMMITTED = "@@CRASH_INGEST_COMMITTED@@";
