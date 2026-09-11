import type { ArchiveReadContract } from "../src/interfaces/archive-read-contract.js";
import { HttpArchiveReadContract } from "./archive-http-client.js";
import { NO_WAKE, pgListenWake, sseWake, type ArchiveWakeSource, type ListenCapable } from "./wake.js";

/**
 * Where project B's view of the archive comes from — the ONE place that decides
 * (organizer sub-plan 00009-08; `spec/00009` FR-025, FR-026).
 *
 * Two topologies, one seam:
 *
 * ```text
 *   split  (ARCHIVE_URL set)   B ── HTTP ──► umbradb-archive-read-api ──► A's PostgreSQL
 *                              B's own PostgreSQL holds shielded_monitor only.
 *                              B has NO credential for A's database and no archive schema name.
 *
 *   single-host (no ARCHIVE_URL)  B ── in-process PgArchiveReadContract ──► the SAME PostgreSQL,
 *                              read-only on the archive schema. The mode this repository shipped
 *                              before 00009-08; kept working, byte for byte.
 * ```
 *
 * ── Why the PostgreSQL implementation is reached by a DYNAMIC import ────────────────────────
 * `spec/00009` FR-025 asks for a project B whose only dependency on A is the read contract, so it
 * "can later run in a separate process or TEE". A static `import { PgArchiveReadContract }` here
 * would put A's storage adapter — and `postgres`, and the archive's schema-shaped SQL — into the
 * STATIC import graph of every B module, including a scanner configured to speak only HTTP. The
 * dynamic import makes the dependency exactly as conditional as the mode that needs it: with
 * `ARCHIVE_URL` set, the module is never loaded into the process at all.
 *
 * That is a checkable claim rather than a stylistic one, and it is checked twice:
 * `test/shielded-monitor/import-boundary.test.ts` walks B's whole static import graph and fails
 * on any path into A's storage modules (with a planted-import positive control), and
 * `test/shielded-monitor/archive-source.test.ts` drives this function with a spy loader and
 * asserts it is never called on the HTTP path.
 *
 * It is NOT a claim that the code is absent from the image — it ships in `dist-cli/`, and a TEE
 * build that wanted it gone would drop the module. It is the claim that matters for a deployment:
 * a split B loads no archive storage code and holds no archive credential.
 */

/** Constructs the in-process implementation. Structurally typed so that naming it here does not
 *  require importing A's module even as a type. */
export type PgArchiveReadContractLoader = () => Promise<
  new (sql: never, schema: string) => ArchiveReadContract
>;

export interface OpenArchiveSourceOptions {
  /** `ARCHIVE_URL` — set means "speak HTTP to the read API at this base URL". */
  readonly archiveUrl?: string;
  /** The archive's schema, used only on the in-process path. */
  readonly archiveSchema: string;
  /** B's own connection. On the in-process path it doubles as the archive reader's handle and as
   *  the `LISTEN` connection, because in that topology it is the same database. */
  readonly sql?: ListenCapable;
  /** Injected by tests and by the guard suite; defaults to the dynamic import above. */
  readonly loadPgArchiveReadContract?: PgArchiveReadContractLoader;
  readonly fetch?: typeof fetch;
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
  /** True when the archive is reached over the network, and therefore when the scanner must
   *  verify each transaction's claimed identity against its bytes. */
  readonly remote: boolean;
}

const defaultLoader: PgArchiveReadContractLoader = async () => {
  const module = (await import("../src/postgres/archive-read-contract.js")) as {
    PgArchiveReadContract: new (sql: never, schema: string) => ArchiveReadContract;
  };
  return module.PgArchiveReadContract;
};

/**
 * Build the archive source for this process.
 *
 * @throws {Error} when neither `archiveUrl` nor `sql` is given — a scanner with no way to read
 *   the archive is a misconfiguration, not a degraded mode.
 */
export async function openArchiveSource(options: OpenArchiveSourceOptions): Promise<ArchiveSource> {
  const wantWake = options.wake ?? true;
  if (options.archiveUrl !== undefined && options.archiveUrl !== "") {
    const archive = new HttpArchiveReadContract(options.archiveUrl, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const wake = wantWake
      ? sseWake(archive.baseUrl, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        })
      : NO_WAKE;
    return { archive, wake, remote: true, describe: `archive=${archive.baseUrl} (HTTP, split deployment)` };
  }

  if (options.sql === undefined) {
    throw new Error(
      "no archive source: set ARCHIVE_URL to reach an umbradb-archive-read-api, or supply a " +
        "database connection for the single-host mode. Refusing to start a scanner that cannot " +
        "read history — it would report itself healthy and at the tip forever.",
    );
  }

  const Pg = await (options.loadPgArchiveReadContract ?? defaultLoader)();
  const archive = new Pg(options.sql as never, options.archiveSchema);
  return {
    archive,
    wake: wantWake ? pgListenWake(options.sql) : NO_WAKE,
    remote: false,
    describe: `archive=schema:${options.archiveSchema} (in-process, single-host deployment)`,
  };
}
