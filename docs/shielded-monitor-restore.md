# Backup and restore — `shielded_monitor` (project B)

Status: alpha. Applies to the `shielded_monitor` schema introduced by the 00009-02 change
(`openspec/changes/00009-02-monitor-store/`). Organizer spec requirement: **FR-024** ("a
documented backup/restore procedure MUST exist; after a restore, revoked and deleted monitors MUST
remain refused … and scanning MUST resume from the restored coverage without duplicates").

The drill described here is executed as a test on every run of the required gate —
`test/shielded-monitor/restore-drill.integration.test.ts`, required id
`shielded-monitor.restore.revocation-survives-snapshot-restore`. If you change this document,
change that test with it; if the two ever disagree, the test is the one that is checked.

---

## 1. Read this first: what a restore cannot recover on its own

A database snapshot taken at time *T* does not contain anything that happened after *T*. That is
what a snapshot is. So if an operator revokes a monitor at *T+1* and the database is later
restored to *T*, the restored database shows that monitor as **live** — key present, coverage
intact, ready to be scanned again.

For most data that is simply the accepted cost of a point-in-time restore. For a revocation it is
not: revoking is how a key's owner says "stop processing this", and a restore silently undoing it
is the one failure this procedure exists to prevent.

The fix is not clever: **keep the revocation record somewhere the snapshot's rollback cannot reach,
and re-apply it on boot.** Everything below is the mechanics of doing that reliably.

---

## 2. What is in the schema

| Table | Contents | Restore-critical? |
|---|---|---|
| `monitors` | one row per registered viewing key: **the key itself, in plaintext**, its fingerprint, state, epoch, coverage, archive-identity binding | yes |
| `associations` | the relevant transaction observations found for each monitor | yes |
| `lifecycle_events` | the ordered record of every transition, with epoch and actor | yes |
| `audit_events` | operator-facing entries (e.g. a revocation list re-applied after a restore) | useful, not critical |

> **Alpha trust model.** `monitors.key_serialized` holds the **plaintext** serialized encryption
> secret key. There is no at-rest encryption, no key wrapping and no key-encryption key: anyone
> who can read this schema — or a backup of it — can read every registered viewing key, and
> therefore decrypt those wallets' shielded transaction history. This is a deliberate,
> owner-approved property of the alpha (User Story 4 deferred, 2026-09-10), not an oversight.
> **Treat every backup of this schema as key material**: encrypt it at rest, restrict who can
> read it, and delete it on the same schedule you would delete a key. `SECURITY.md` carries the
> full deferred-hardening list.

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

Then, **as a separate step and to a separate destination**, export the revocation list:

```sh
npm run shielded-monitor:harness -- export-revocations \
  --dsn "$DATABASE_URL" --schema shielded_monitor \
  --out /var/lib/umbradb/revocations.json
```

The list is a small JSON file:

```json
{
  "version": 1,
  "exportedAt": "2026-09-10T12:00:00.000Z",
  "schema": "shielded_monitor",
  "revocations": [
    { "monitorId": "…uuid…", "net": "undeployed", "state": "revoked", "epoch": "4", "at": "…" }
  ]
}
```

Three properties of that file matter:

1. **It contains no key material, no fingerprint and no association content.** Unlike the dump, it
   is not secret. That is what makes it safe to keep in a configuration repository, a secrets
   manager, or an object store in another account — which is exactly where it has to live.
2. **It must not share a failure domain with the database.** A copy inside the same snapshot, the
   same volume, or the same restore procedure is worthless: it would be rolled back with
   everything else. Put it somewhere a database restore cannot touch.
3. **It is append-only in practice.** Never remove an entry to "clean up". An entry is the record
   that a key's owner asked for processing to stop; it stays until the monitor is deleted *and*
   you are certain no snapshot old enough to resurrect it can still be restored.

Export it **every time a monitor is revoked or deleted**, not on a backup schedule. A revocation
that has not reached the file yet is a revocation a restore can undo.

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

**Stop the scanner and any API process before restoring, and keep them stopped until step 4.2 has
run.** A worker that connects between the restore and the re-application of the revocation list
would see a revoked monitor as live and could advance it. There is no other window in which that
can happen: after 4.2, the fence and the state machine prevent it.

### 4.2 Re-apply the revocation list — before anything else connects

```sh
npm run shielded-monitor:harness -- apply-revocations \
  --dsn "$DATABASE_URL" --schema shielded_monitor \
  --in /var/lib/umbradb/revocations.json
```

Output:

```json
{ "examined": 12, "reapplied": ["…uuid…"], "alreadyRefused": ["…"], "absent": [] }
```

| Field | Meaning | What to do |
|---|---|---|
| `reapplied` | monitors the restored database showed as live and that have now been revoked again | Nothing — this is the procedure working. A non-empty list at an *ordinary* boot means someone restored a snapshot without saying so; investigate. |
| `alreadyRefused` | monitors already `revoked` or `deleted` in the restored database | Nothing. The operation is idempotent: no epoch bump, no lifecycle event. |
| `absent` | ids the restored database does not know at all | Investigate. Usually a restore from a snapshot older than the monitor's creation. The list never invents a monitor. |

The command is safe to run on every boot, and running it twice changes nothing.

**A monitor exported as `deleted` is re-applied as a `revoke`, not a delete.** The restored
database may hold associations that the original delete destroyed, and destroying them again
unattended during a boot is an irreversible act taken with no operator in the loop. Revoking stops
all processing and all access — the safety property the restore has to preserve — and leaves the
delete to you. Those monitors appear in `reapplied`, and `audit_events` records
`revocation-list-reapplied` with the exported state, so you can find them:

```sql
SELECT monitor_id, detail->>'exportedState' AS exported_state, at
  FROM shielded_monitor.audit_events
 WHERE action = 'revocation-list-reapplied' AND detail->>'exportedState' = 'deleted';
```

Issue the deletes yourself once you have confirmed that is what you want:

```sh
npm run shielded-monitor:harness -- delete --dsn "$DATABASE_URL" --id <uuid>
```

### 4.3 Restart the scanner

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
-- 1. Every revoked/deleted monitor in your list is refused. Expect zero rows.
SELECT id, state FROM shielded_monitor.monitors
 WHERE id = ANY($1::uuid[]) AND state NOT IN ('revoked', 'deleted');

-- 2. Coverage is coherent: no monitor claims a through-height it has no from-height for.
--    (The schema's CHECK guarantees this; the query is here to catch a hand-edited restore.)
SELECT id FROM shielded_monitor.monitors
 WHERE scanned_through_height IS NOT NULL AND scanned_from_height IS NULL;

-- 3. Association sequences are gapless per monitor. Expect zero rows.
SELECT monitor_id FROM shielded_monitor.associations
 GROUP BY monitor_id
HAVING max(seq) <> count(*) OR min(seq) <> 1;

-- 4. No monitor is half-shredded: a deleted monitor has neither key nor fingerprint, every
--    other monitor has both. Expect zero rows.
--
--    Written as a CASE for the same reason the schema constraint is: the shorter
--    `(state = 'deleted') <> (key_serialized IS NULL AND fingerprint IS NULL)` MISSES the
--    half-shredded row (key gone, fingerprint kept) that this check exists to find — both sides
--    evaluate false and the row looks fine.
SELECT id FROM shielded_monitor.monitors
 WHERE NOT (CASE WHEN state = 'deleted'
                 THEN key_serialized IS NULL AND fingerprint IS NULL
                 ELSE key_serialized IS NOT NULL AND fingerprint IS NOT NULL
            END);
```

Then confirm the fence is intact by checking that a revoked monitor refuses a read:

```sh
npm run shielded-monitor:harness -- status --dsn "$DATABASE_URL" --id <revoked-uuid>
# expected: an error naming the monitor as revoked
```

---

## 6. What is deliberately not covered here

- **Point-in-time recovery (WAL archiving).** Nothing in this procedure conflicts with it; PITR to
  a moment after the last revocation makes step 4.2 a no-op, which is the ideal case. The
  revocation list is the fallback for when you cannot recover to that point.
- **Restoring project A (`chain_archive`).** A separate concern by construction — the two schemas
  share no table and no write path (owner Rule B). If the archive is restored to a *different*
  archive identity, monitors bound to the old one move to `stale_source` on the scanner's next
  pass rather than silently mixing histories.
- **Recovering a lost viewing key.** Not possible and not a goal: the service stores the key its
  owner submitted, and the owner is the source of truth. A monitor whose key is gone from the
  database is re-created by registering the key again.
- **Encrypted backups, key rotation, per-monitor shredding of key material.** Deferred with User
  Story 4. Until then the backup *is* key material — see the warning in §2.
