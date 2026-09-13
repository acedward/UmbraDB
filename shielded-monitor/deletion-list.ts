import type { DeletionRecord, ShieldedMonitorStore } from "./store.js";

/**
 * The deletion list: the one piece of project-B state that must survive a database restore
 * (organizer spec FR-024, and the "restored to an older snapshot" edge case).
 *
 * **Why it cannot live only in the database.** A snapshot taken before a delete does not contain
 * the delete — that is what a snapshot is. No amount of care inside the database can recover a
 * fact that post-dates the backup it is being restored from. So the record has to be exported and
 * kept outside the snapshot's rollback domain, and re-applied on boot. Restoring a backup must
 * never bring a consumer's deleted monitor — and the matches it collected — back to life.
 *
 * **What is in it, and what deliberately is not.** Monitor id, network, epoch and timestamp. No
 * key material, no fingerprint, no association data, no coverage — so the file is safe to store
 * next to the backups, on a different host, or in a configuration repository, which is exactly
 * where it has to live to be useful. The id is enough: it is stable across a restore, and it is
 * what the re-apply looks the monitor up by.
 *
 * **Since owner decision Q33 this is a DELETION list, not a revocation list.** Revoke is gone
 * from the product — a key is given or it is deleted — so the property this mechanism protects is
 * now stated directly: *a monitor deleted before the snapshot is deleted again after the restore*.
 * Re-applying is a real `delete`, not a softer stand-in, because there is no softer stand-in left
 * and because a delete is exactly what the operator already did once.
 *
 * The operator procedure is `docs/shielded-monitor-restore.md`; the drill is executed as a test
 * (`test/shielded-monitor/restore-drill.integration.test.ts`) with a real `pg_dump`/`psql` round
 * trip, so the procedure is proven rather than merely written down.
 */

/** The file format. Versioned so a future change (a signature, a tenant column) can be detected
 *  rather than mis-parsed. Version 1 was the revocation list this replaces; a file written by a
 *  pre-Q33 build is refused rather than half-understood. */
export interface DeletionListFile {
  readonly version: 2;
  readonly exportedAt: string;
  readonly schema: string;
  readonly deletions: readonly DeletionRecord[];
}

/** What {@link applyDeletionList} did. Reported so an operator sees, in the boot log, exactly how
 *  many monitors the restore had to delete again — a non-zero `reapplied` after a restore is
 *  expected; a non-zero `reapplied` at an ordinary boot means someone restored a snapshot without
 *  saying so. */
export interface DeletionApplyReport {
  readonly examined: number;
  readonly reapplied: readonly string[];
  readonly alreadyDeleted: readonly string[];
  readonly absent: readonly string[];
}

/** Exports every monitor that has been deleted. */
export async function exportDeletionList(
  store: ShieldedMonitorStore,
  schema: string,
): Promise<DeletionListFile> {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    schema,
    deletions: await store.listDeletions(),
  };
}

/**
 * Re-applies an exported deletion list to a database that may be older than it.
 *
 * For each entry: a monitor the restored database already shows as `deleted` is left exactly as it
 * is (no epoch bump, no lifecycle event — idempotency matters here, because this runs on every
 * boot); a monitor the restore brought back is **deleted again**, with `actor: "restore"` so the
 * lifecycle log says why; an id the database does not know at all is reported, not created.
 *
 * The re-applied delete destroys the associations the restore resurrected, which is the point: a
 * consumer who deleted a monitor asked for its matches to be gone, and a backup is not a reason
 * to hand them back. That the act is irreversible is not a reason to withhold it — it is the same
 * irreversible act the consumer already asked for, and the report names every monitor it touched.
 */
export async function applyDeletionList(
  store: ShieldedMonitorStore,
  list: DeletionListFile,
  actor = "restore",
): Promise<DeletionApplyReport> {
  if (list.version !== 2) {
    throw new Error(`applyDeletionList: unsupported deletion list version ${String(list.version)}`);
  }
  const reapplied: string[] = [];
  const alreadyDeleted: string[] = [];
  const absent: string[] = [];

  for (const entry of list.deletions) {
    const current = await store.getIncludingDeleted(entry.monitorId);
    if (current === undefined) {
      absent.push(entry.monitorId);
      continue;
    }
    if (current.state === "deleted") {
      alreadyDeleted.push(entry.monitorId);
      continue;
    }
    await store.delete(entry.monitorId, actor);
    await store.recordAudit(actor, "deletion-list-reapplied", entry.monitorId, {
      exportedEpoch: entry.epoch,
      exportedAt: entry.at,
    });
    reapplied.push(entry.monitorId);
  }

  return { examined: list.deletions.length, reapplied, alreadyDeleted, absent };
}
