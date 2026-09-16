/**
 * The DUST module's configuration (`spec/00016-dust-wallet-sync.md` §4 "Config", FR-010; plan
 * 00016 D2.2).
 *
 * ── Why this directory exists at all ────────────────────────────────────────────────────────
 * Project B holds no database. That rule (owner Q25, spec/00009 FR-025) is enforced three ways —
 * an import-graph walk, a runtime privilege test, and `no-database.ts`'s boot-time refusal — and
 * it stays enforced for every other file under `shielded-monitor/`.
 *
 * For the DUST wallet-sync experiment the owner waived it for **this one directory**
 * (2026-09-15, `spec/00016-dust-wallet-sync.md` §1 "The waiver"): the TEE-side node may open a
 * second, **read-only** connection to the archive database, because the alternative — shipping
 * the whole DUST event history through the storage API — buys nothing for a measurement whose
 * point is the shared replay. The accepted cost is written down in the spec: the database sees
 * which nullifiers a wallet asks about. A later project replaces the query with an enclave-side
 * copy and deletes the waiver.
 *
 * ── Why a separate connection string and not `STORAGE_URL` ──────────────────────────────────
 * `DUST_DATABASE_URL` names a role with `SELECT` on `dust_events` and `blocks` and nothing else
 * (`docs/shielded-monitor-deployment.md` carries the `CREATE ROLE` recipe). Reusing the archive
 * writer's credential would make the waiver unbounded; a role that cannot write is the part of
 * the boundary that survives the waiver, and `dust-reader-role.integration.test.ts` proves it.
 *
 * ── Why no name ends in `_PG` ───────────────────────────────────────────────────────────────
 * `no-database.ts` refuses to start a node whose environment holds ANY `*_PG` variable, and that
 * refusal is deliberately untouched by the waiver: it is what catches a `MONITOR_PG` left behind
 * by a migration. So the DUST variable is named `DUST_DATABASE_URL`, and a future one must not
 * be named `DUST_PG` — it would be refused at boot, correctly.
 *
 * Every numeric setting fails closed on a bad value, as `node/config.ts` does: a
 * `DUST_STATE_POLL_MS=0` that silently became the default is the class of bug this repository's
 * audit finding T6 records.
 */

/** The DUST module's settings. Present only when `DUST_DATABASE_URL` is set. */
export interface DustConfig {
  /** A read-only PostgreSQL connection string for the archive database (FR-010). */
  readonly databaseUrl: string;
  /** Where `<net>.dust-state` snapshots are written (FR-012). */
  readonly snapshotDir: string;
  /** How often the mirror asks the table for new events (FR-011). */
  readonly pollMs: number;
  /** Events between snapshots (FR-012). */
  readonly snapshotEvery: number;
  /** Events per replay call (FR-011). 1 000 is where the ledger's per-call rehash amortises —
   *  21.5 ms/event at 1, 1.72 ms at 1 000 (spec §0). */
  readonly replayBatch: number;
  /**
   * The largest snapshot file the mirror will RESTORE, in bytes (question **Q-23 option A**,
   * 2026-09-16). Above it the file is left alone and the mirror replays from zero instead.
   *
   * ── Why a mirror refuses its own snapshot ───────────────────────────────────────────────────
   * Measured on the real preprod archive at 146 253 retained leaves: restoring a 13 506 592 B
   * snapshot took **639 s**, against **154 s** to fold the identical state out of PostgreSQL from
   * nothing. `DustLocalState.deserialize` of a retained state is superlinear in its size, and it is
   * ONE synchronous WASM call, so for those 639 s the node answered no request at all — not
   * `/v1/health`, not the monitor-store routes. The replay path folds in batches with awaits
   * between them, so the process stays responsive throughout.
   *
   * The snapshot is still WRITTEN (it costs ≈ 0.2 s per 20 000 events and it is the fast path on
   * devnet and on any small chain, where a restore really is milliseconds). This setting is the
   * line between the two regimes. Raising it past a few MB re-acquires the outage.
   */
  readonly snapshotMaxBytes: number;
}

/** Thrown for any invalid DUST configuration. Names the variable, never its value when the value
 *  is a connection string (which carries a password). */
export class DustConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`invalid ${variable}: ${message}`);
    this.name = "DustConfigError";
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // `/^\d+$/` rather than Number(): `Number(" 12 ")`, `Number("1e3")` and `Number("0x10")` all
  // succeed and none of them is what an operator meant to write in an env var.
  if (!/^\d+$/.test(raw.trim())) {
    throw new DustConfigError(name, `${JSON.stringify(raw)} is not a decimal integer`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) throw new DustConfigError(name, `${value} is outside ${min}..${max}`);
  return value;
}

/**
 * Reads the DUST settings, or `undefined` when the module is disabled.
 *
 * `undefined` rather than a config with an empty URL: "disabled" is a state the node reports on
 * `/internal/status` and answers `503 DUST_DISABLED` for, and making it representable as a
 * missing object rather than as a sentinel string keeps every later `if` honest.
 *
 * The URL itself is only shape-checked (a `postgres:`/`postgresql:` URL). Whether the credential
 * works is not knowable here and is answered by the first query, which is why FR-010 says the
 * connection is opened **lazily**: a node whose DUST role was mistyped must still serve every
 * monitor-store route.
 */
export function loadDustConfig(env: NodeJS.ProcessEnv = process.env): DustConfig | undefined {
  const databaseUrl = env.DUST_DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    // The value is NOT quoted back: it is a connection string and normally carries a password.
    throw new DustConfigError("DUST_DATABASE_URL", "is not a URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DustConfigError("DUST_DATABASE_URL", `protocol ${parsed.protocol} is not postgres:`);
  }
  const snapshotDir = env.DUST_STATE_SNAPSHOT_DIR?.trim() ?? "";
  return {
    databaseUrl,
    snapshotDir: snapshotDir === "" ? "./dust-state" : snapshotDir,
    pollMs: readInt(env, "DUST_STATE_POLL_MS", 2_000, 10, 3_600_000),
    snapshotEvery: readInt(env, "DUST_STATE_SNAPSHOT_EVERY", 20_000, 1, 100_000_000),
    replayBatch: readInt(env, "DUST_REPLAY_BATCH", 1_000, 1, 100_000),
    // 2 MiB. At the measured ≈ 112 B per event this is ≈ 18 700 events, i.e. ≈ 20 s of replay --
    // comfortably inside the regime where restoring is the cheaper of the two.
    snapshotMaxBytes: readInt(env, "DUST_STATE_SNAPSHOT_MAX_BYTES", 2_097_152, 0, 68_719_476_736),
  };
}
