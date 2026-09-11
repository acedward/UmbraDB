import type { RevocationRecord, ShieldedMonitorStore } from "./store.js";

/**
 * The revocation list: the one piece of project-B state that must survive a database restore
 * (organizer spec FR-024, and the "restored to an older snapshot" edge case).
 *
 * **Why it cannot live only in the database.** A snapshot taken before a revoke does not contain
 * the revoke — that is what a snapshot is. No amount of care inside the database can recover a
 * fact that post-dates the backup it is being restored from. So the record has to be exported and
 * kept outside the snapshot's rollback domain, and re-applied on boot.
 *
 * **What is in it, and what deliberately is not.** Monitor id, network, state, epoch and
 * timestamp. No key material, no fingerprint, no association data, no coverage — so the file is
 * safe to store next to the backups, on a different host, or in a configuration repository,
 * which is exactly where it has to live to be useful.
 *
 * The operator procedure is `docs/shielded-monitor-restore.md`; the drill is executed as a test
 * (`test/shielded-monitor/restore-drill.integration.test.ts`) with a real `pg_dump`/`psql` round
 * trip, so the procedure is proven rather than merely written down.
 */

/** The file format. Versioned so a future change (a signature, a tenant column) can be detected
 *  rather than mis-parsed. */
export interface RevocationListFile {
  readonly version: 1;
  readonly exportedAt: string;
  readonly schema: string;
  readonly revocations: readonly RevocationRecord[];
}

/** What {@link applyRevocationList} did. Reported so an operator sees, in the boot log, exactly
 *  how many monitors the restore had to re-revoke — a non-zero `reapplied` after a restore is
 *  expected; a non-zero `reapplied` at an ordinary boot means someone restored a snapshot
 *  without saying so. */
export interface RevocationApplyReport {
  readonly examined: number;
  readonly reapplied: readonly string[];
  readonly alreadyRefused: readonly string[];
  readonly absent: readonly string[];
}

/** Exports every monitor whose access must stay refused. */
export async function exportRevocationList(
  store: ShieldedMonitorStore,
  schema: string,
): Promise<RevocationListFile> {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    schema,
    revocations: await store.listRevocations(),
  };
}

/**
 * Re-applies an exported revocation list to a database that may be older than it.
 *
 * For each entry: a monitor that is already `revoked` or `deleted` is left exactly as it is (no
 * epoch bump, no lifecycle event — idempotency matters here, because this runs on every boot); a
 * monitor that the restored database still shows as live is revoked, with `actor: "restore"` so
 * the lifecycle log says why; an id the database does not know at all is reported, not created.
 *
 * An entry whose exported state was `deleted` is re-applied as a **revoke**, not a delete. The
 * distinction is deliberate: the restored database may hold associations that the original
 * delete had destroyed, and silently destroying them again during a boot would be an
 * irreversible act taken without an operator in the loop. Revoking stops all processing and all
 * access — the safety property the restore has to preserve — and leaves the operator to issue the
 * delete. The report names those monitors so the operator knows to.
 */
export async function applyRevocationList(
  store: ShieldedMonitorStore,
  list: RevocationListFile,
  actor = "restore",
): Promise<RevocationApplyReport> {
  if (list.version !== 1) {
    throw new Error(`applyRevocationList: unsupported revocation list version ${String(list.version)}`);
  }
  const reapplied: string[] = [];
  const alreadyRefused: string[] = [];
  const absent: string[] = [];

  for (const entry of list.revocations) {
    const current = await store.getIncludingRevoked(entry.monitorId);
    if (current === undefined) {
      absent.push(entry.monitorId);
      continue;
    }
    if (current.state === "revoked" || current.state === "deleted") {
      alreadyRefused.push(entry.monitorId);
      continue;
    }
    await store.revoke(entry.monitorId, actor);
    await store.recordAudit(actor, "revocation-list-reapplied", entry.monitorId, {
      exportedState: entry.state,
      exportedEpoch: entry.epoch,
      exportedAt: entry.at,
    });
    reapplied.push(entry.monitorId);
  }

  return { examined: list.revocations.length, reapplied, alreadyRefused, absent };
}
