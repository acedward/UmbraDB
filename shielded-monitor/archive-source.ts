import type { ArchiveReadContract } from "../src/interfaces/archive-read-contract.js";
import { HttpArchiveReadContract, type FetchLike } from "./archive-http-client.js";
import { NO_WAKE, sseWake, type ArchiveWakeSource } from "./wake.js";

/**
 * Where project B's view of the archive comes from — the ONE place that decides
 * (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-025, FR-026).
 *
 * ```text
 *   B ── HTTP ──► umbradb-storage-api ──► the one main PostgreSQL
 *        │                                (chain_archive, read-only through the contract)
 *        └──────► the same process also serves B's own records (/v1/monitor-store/*)
 *
 *   B holds ONE base URL and no credential of any kind. It has no driver, no connection
 *   string, no schema name, and no way to reach a database even if it wanted to.
 * ```
 *
 * ── What changed in v2, and why the in-process mode is gone ─────────────────────────────────
 * The first 00009-08 design kept a single-host mode in which B constructed
 * `PgArchiveReadContract` itself through a dynamic import (organizer question Q24 option A). The
 * owner's v2 decision (Q25) removes it: B must have **no database connection at all**, so that
 * the boundary crossed here is the one that later carries encryption and attestation. The dynamic
 * import is therefore gone as well, and `test/shielded-monitor/import-boundary.test.ts` now fails
 * on a `postgres` or `src/postgres/**` dependency of ANY kind — static or dynamic — reachable
 * from `shielded-monitor/**`.
 *
 * That is a breaking change for a deployment that ran the scanner or the private API against
 * `MONITOR_PG`: those processes now require `STORAGE_URL` and refuse to start while any `*_PG`
 * variable is present. `docs/shielded-monitor-deployment.md` states the migration, and the
 * refusal message names the variables it found.
 */

export interface OpenArchiveSourceOptions {
  /** The base URL of the process serving `/v1/archive/*` — normally `STORAGE_URL` itself, since
   *  `umbradb-storage-api` serves both route families on one port. A deployment that runs the
   *  standalone `umbradb-archive-read-api` on its own port sets `ARCHIVE_URL` to point at it. */
  readonly archiveUrl: string;
  readonly fetch?: FetchLike;
  readonly logger?: (line: string) => void;
  /** `false` disables the wake-up entirely and leaves polling (`SCAN_POLL_MS`) as the only
   *  trigger. The API process passes this: it reads the tip on demand and has no loop to wake. */
  readonly wake?: boolean;
}

export interface ArchiveSource {
  readonly archive: ArchiveReadContract;
  readonly wake: ArchiveWakeSource;
  /** One log-safe line naming the topology, for the boot banner. */
  readonly describe: string;
  /**
   * True when the archive is reached over the network, and therefore when the scanner must verify
   * each transaction's claimed identity against its bytes (organizer question Q23).
   *
   * Always `true` in the v2 topology — there is no other topology left — and kept as a field
   * rather than inlined so the scanner option it feeds stays a decision of the composition root,
   * and so an embedder driving the scanner with an in-process contract in a test still gets the
   * in-process semantics.
   */
  readonly remote: boolean;
}

/**
 * Build the archive source for this process.
 *
 * @throws {Error} when `archiveUrl` is empty — a scanner with no way to read the archive is a
 *   misconfiguration, not a degraded mode: it would report itself healthy and at the tip forever.
 */
export function openArchiveSource(options: OpenArchiveSourceOptions): ArchiveSource {
  if (options.archiveUrl === "") {
    throw new Error(
      "no archive source: set STORAGE_URL (or ARCHIVE_URL) to the base URL of a umbradb-storage-api. " +
        "Refusing to start a component that cannot read history — it would report itself healthy " +
        "and at the tip forever.",
    );
  }
  const archive = new HttpArchiveReadContract(options.archiveUrl, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const wake = (options.wake ?? true)
    ? sseWake(archive.baseUrl, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      })
    : NO_WAKE;
  return { archive, wake, remote: true, describe: `archive=${archive.baseUrl} (HTTP)` };
}
