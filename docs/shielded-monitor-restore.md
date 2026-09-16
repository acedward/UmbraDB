# Backup and restore — `shielded_monitor` (project B)

Status: alpha. Applies to the `shielded_monitor` schema introduced by the 00009-02 change
(`openspec/changes/00009-02-monitor-store/`). Organizer spec requirement: **FR-024** ("a
documented backup/restore procedure MUST exist; after a restore, deleted monitors MUST remain
gone … and scanning MUST resume from the restored coverage without duplicates").

Since owner decision Q33 the lifecycle is **give or delete** — a viewing key is registered or it is
deleted, and there is no pause, resume or revoke — so the fact this procedure protects is a DELETE.
The mechanism is unchanged in shape: export the record, keep it outside the snapshot's rollback
domain, re-apply it on boot.

The drill described here is executed as a test on every run of the required gate —
`test/shielded-monitor/restore-drill.integration.test.ts`, required id
`shielded-monitor.restore.deletion-survives-snapshot-restore`. If you change this document,
change that test with it; if the two ever disagree, the test is the one that is checked.

---

## 1. Read this first: what a restore cannot recover on its own

A database snapshot taken at time *T* does not contain anything that happened after *T*. That is
what a snapshot is. So if a consumer deletes a monitor at *T+1* and the database is later restored
to *T*, the restored database shows that monitor as **live** — identity present, coverage intact,
its matches back, ready to be scanned again the moment someone gives it a key.

For most data that is simply the accepted cost of a point-in-time restore. For a deletion it is
not: deleting is how a key's owner says "destroy this", and a restore silently undoing it is the
one failure this procedure exists to prevent.

The fix is not clever: **keep the deletion record somewhere the snapshot's rollback cannot reach,
and re-apply it on boot.** Everything below is the mechanics of doing that reliably.

---

## 2. What is in the schema

| Table | Contents | Restore-critical? |
|---|---|---|
| `monitors` | one row per registered viewing key: its **fingerprint** (a SHA-256 hash, never the key), state, epoch, coverage, archive-identity binding | yes |
| `associations` | the relevant transaction observations found for each monitor | yes |
| `lifecycle_events` | the ordered record of every transition, with epoch and actor | yes |
| `monitor_gaps` | the ranges below a monitor's coverage that were never actually read for it | yes |
| `audit_events` | operator-facing entries (e.g. a deletion list re-applied after a restore) | useful, not critical |

> **Alpha trust model.** Since 00009-09 **no viewing key is in this schema at all**: a key lives
> in the RAM of the one monitor-node it was sent to, and the database keeps only its SHA-256
> fingerprint. A backup is therefore no longer key material — but it still holds the **linkage**,
> in plaintext: which monitor matched which transaction, at which height. Anyone who can read this
> schema, or a backup of it, learns that. Encryption of the associations is deferred; `SECURITY.md`
> carries the full list. A restored backup also holds no keys, so every monitor in it reports
> `key needed` until its client sends the key again — which is the design, not damage.

---

## 3. Taking a backup

Back up the schema on its own. Project B is deliberately restorable independently of the archive
(owner Rule B) — the two share no table, and B's only dependency on the archive is a read
interface, so a B-only restore is coherent.

```sh
pg_dump \
  --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" \
  --schema shielded_monitor \
  --file "shielded-monitor-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Then, **as a separate step and to a separate destination**, export the deletion list:

```sh
npm run shielded-monitor:harness -- export-deletions \
  --dsn "$DATABASE_URL" --schema shielded_monitor \
  --out /var/lib/umbradb/deletions.json
```

The list is a small JSON file:

```json
{
  "version": 2,
  "exportedAt": "2026-09-10T12:00:00.000Z",
  "schema": "shielded_monitor",
  "deletions": [
    { "monitorId": "…uuid…", "net": "undeployed", "epoch": "4", "at": "…" }
  ]
}
```

Version 2 is the deletion list; version 1 was the revocation list it replaces, and a version-1
file is **refused** rather than half-understood — its entries mean "refuse reads", and this build
has no such state to put a monitor into.

Three properties of that file matter:

1. **It contains no key material, no fingerprint and no association content.** Unlike the dump, it
   is not secret. That is what makes it safe to keep in a configuration repository, a secrets
   manager, or an object store in another account — which is exactly where it has to live.
2. **It must not share a failure domain with the database.** A copy inside the same snapshot, the
   same volume, or the same restore procedure is worthless: it would be rolled back with
   everything else. Put it somewhere a database restore cannot touch.
3. **It is append-only in practice.** Never remove an entry to "clean up". An entry is the record
   that a key's owner asked for their data to be destroyed; it stays until you are certain no
   snapshot old enough to resurrect that monitor can still be restored.

Export it **every time a monitor is deleted**, not on a backup schedule. A deletion that has not
reached the file yet is a deletion a restore can undo.

---

## 4. Restoring

### 4.1 Restore the schema

```sh
psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" \
     --set ON_ERROR_STOP=1 \
     --file shielded-monitor-20260910T120000Z.sql
```

If the schema still exists, drop it first (`DROP SCHEMA shielded_monitor CASCADE`) — the dump
recreates it, including the `shielded_monitor_valid_segments` helper function that the
`associations` CHECK constraint calls. `pg_dump` emits that function before the table that
references it; the drill asserts the ordering, so a restore that failed on it would be caught
before an operator hit it.

**Stop every monitor-node and the balancer before restoring, and keep them stopped until step 4.2
has run.** A node that connects between the restore and the re-application of the deletion list
would see a deleted monitor as live, and a client re-sending that key would start it scanning
again. There is no other window in which that can happen: after 4.2 the monitor is a tombstone
whose fingerprint is shed, and giving the key again mints a fresh monitor rather than resurrecting
the old one.

### 4.2 Re-apply the deletion list — before anything else connects

```sh
npm run shielded-monitor:harness -- apply-deletions \
  --dsn "$DATABASE_URL" --schema shielded_monitor \
  --in /var/lib/umbradb/deletions.json
```

Output:

```json
{ "examined": 12, "reapplied": ["…uuid…"], "alreadyDeleted": ["…"], "absent": [] }
```

| Field | Meaning | What to do |
|---|---|---|
| `reapplied` | monitors the restored database brought back and that have now been deleted again | Nothing — this is the procedure working. A non-empty list at an *ordinary* boot means someone restored a snapshot without saying so; investigate. |
| `alreadyDeleted` | monitors already `deleted` in the restored database | Nothing. The operation is idempotent: no epoch bump, no lifecycle event. |
| `absent` | ids the restored database does not know at all | Investigate. Usually a restore from a snapshot older than the monitor's creation. The list never invents a monitor. |

The command is safe to run on every boot, and running it twice changes nothing.

**Re-applying a deletion destroys the matches the restore brought back.** That is the point, and it
is irreversible: the consumer asked for them to be gone once, and a backup is not a reason to hand
them back. Every monitor it touched appears in `reapplied`, and `audit_events` records
`deletion-list-reapplied` with what the list said, so the act is auditable afterwards:

```sql
SELECT monitor_id, detail->>'exportedEpoch' AS exported_epoch, at
  FROM shielded_monitor.audit_events
 WHERE action = 'deletion-list-reapplied';
```

### 4.3 Restart the nodes

Coverage is persisted per monitor as block heights (`scannedFrom` / `scannedThrough`). Scanning
resumes from the restored `scannedThrough` and re-reads the blocks after it. This neither skips nor
duplicates:

- **No skip**, because coverage only ever advances in the same transaction that writes that
  height's associations, so a persisted `scannedThrough` is a height whose associations are
  durable.
- **No duplicate**, because `associations` carries
  `UNIQUE (monitor_id, block_height, block_hash, position)` and the coverage advance is monotonic —
  a batch re-run after a restore is reported as `already-advanced` rather than written twice.

Blocks scanned between the snapshot and the failure are re-scanned. That is expected and cheap;
it is the price of restoring to an older point.

---

## 5. Verifying a restore

Run these against the restored database before returning it to service.

```sql
-- 1. Every monitor in your deletion list is deleted. Expect zero rows.
SELECT id, state FROM shielded_monitor.monitors
 WHERE id = ANY($1::uuid[]) AND state <> 'deleted';

-- 2. Coverage is coherent: no monitor claims a through-height it has no from-height for.
--    (The schema's CHECK guarantees this; the query is here to catch a hand-edited restore.)
SELECT id FROM shielded_monitor.monitors
 WHERE scanned_through_height IS NOT NULL AND scanned_from_height IS NULL;

-- 3. Association sequences are strictly increasing per monitor. NOT dense: a back-sync that
--    re-read a range it already held skips the rows it has and leaves their numbers unused
--    (owner decision Q32). Expect zero rows.
SELECT monitor_id FROM shielded_monitor.associations
 GROUP BY monitor_id
HAVING count(*) <> count(DISTINCT seq);

-- 4. A deleted monitor has shed its identity; every other monitor has one. Expect zero rows.
SELECT id FROM shielded_monitor.monitors
 WHERE (state = 'deleted') <> (fingerprint IS NULL);

-- 5. No monitor's gap rows survive its deletion. Expect zero rows.
SELECT g.monitor_id FROM shielded_monitor.monitor_gaps g
  JOIN shielded_monitor.monitors m ON m.id = g.monitor_id
 WHERE m.state = 'deleted';
```

Then confirm a deleted monitor really is gone, from the outside:

```sh
npm run shielded-monitor:harness -- status --dsn "$DATABASE_URL" --id <deleted-uuid>
# expected: an error saying there is no such monitor — the same one an id that never existed gets
```

---

## 6. What is deliberately not covered here

- **Point-in-time recovery (WAL archiving).** Nothing in this procedure conflicts with it; PITR to
  a moment after the last deletion makes step 4.2 a no-op, which is the ideal case. The deletion
  list is the fallback for when you cannot recover to that point.
- **Restoring project A (`chain_archive`).** A separate concern by construction — the two schemas
  share no table and no write path (owner Rule B). If the archive is restored to a *different*
  archive identity, monitors bound to the old one move to `stale_source` on the scanner's next
  pass rather than silently mixing histories.
- **Recovering a viewing key.** Not possible and not a goal: since 00009-09 the database never
  holds one, and the owner is the only source of truth. After any restore, every monitor reports
  `key needed` until its client registers the key again — which reaches the same monitor and
  carries on from the restored coverage.
- **Encrypted backups and encryption of the associations.** Deferred; a backup is no longer key
  material but it is still the linkage — see the warning in §2.
