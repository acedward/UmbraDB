/**
 * The two names the archive's PostgreSQL deployment publishes to a *consumer*: the schema it is
 * installed into by default, and the `LISTEN/NOTIFY` channel its writer signals progress on.
 *
 * **Why they live in their own module.** Project B (the shielded-monitor scanner) must be able to
 * point an implementation at the archive and to wait on its wake-up channel, but B is forbidden
 * from carrying archive schema knowledge of its own — owner Rule B / FR-025, enforced
 * mechanically by `test/shielded-monitor/schema-isolation.integration.test.ts`, which fails if
 * the string `chain_archive` appears anywhere in B's source outside a comment. A consumer that
 * hardcoded either name would be asserting a convention it does not own, and the two copies could
 * drift — a scanner listening on a channel the writer no longer notifies degrades silently to
 * polling, which is exactly the kind of failure no test notices.
 *
 * So A declares them here, once, with no dependencies of its own, and every consumer — including
 * an out-of-process one — imports them rather than retyping them.
 *
 * Neither name belongs in `src/interfaces/archive-read-contract.ts`: that interface is
 * deliberately transport-agnostic (it must survive being served over RPC to a B in another
 * process or a TEE), and a schema name and a PostgreSQL channel are both properties of *this*
 * storage backend, not of the contract.
 */

/** The schema `PgArchiveReadContract` and the archive CLIs address when the operator names none. */
export const DEFAULT_ARCHIVE_SCHEMA = "chain_archive";

/**
 * The channel the archive's writer notifies INSIDE each height's own transaction, payload
 * `"<net>:<height>"` (00009-01, spec/00009 US7's wake-up hook).
 *
 * An OPTIMISATION, never a contract: PostgreSQL does not queue notifications for a listener that
 * is not connected, so a consumer that misses one finds the height on its next poll. Nothing may
 * depend on receiving it.
 */
export const ARCHIVE_PROGRESS_CHANNEL = "chain_archive_progress";
