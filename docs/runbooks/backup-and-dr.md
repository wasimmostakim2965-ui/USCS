# Backup, restore and disaster recovery

Status: draft runbook. **Restore has not been executed against a real tenant
database or bucket.** Blueprint gate 9 ("backup restore is verified") stays open
until it has, and this file says so rather than implying otherwise.

## What is backed up

| Data | Where | Mechanism | Retention target |
|---|---|---|---|
| Control-plane Postgres | Supabase | managed PITR + daily snapshot | 30 days |
| Tenant databases | Coolify | `DatabaseAdapter.backup`, engine-owned artifacts | per plan |
| Tenant buckets | MinIO | bucket replication | per plan |
| Audit log | control-plane Postgres | append-only, included in PITR | 1 year |

Tenant data and control-plane data have separate destinations and separate
credentials. A tenant backup must never land in the control-plane store, and a
control-plane credential must never be able to read a tenant bucket.

## Restore procedure (tenant database)

1. Identify the backup by its engine reference
   (`<databaseUuid>/<backupUuid>`), which is what `DatabaseAdapter.backup`
   returns and `restore` accepts. Do not reconstruct this by hand.
2. Restore through the engine (`DatabaseAdapter.restore`), into the tenant's own
   target database. The engine's team token scopes the operation, so a restore
   cannot cross an organization boundary even if the ref was tampered with.
3. **Verify the restore by reading from it.** A row count and a checksum against
   the source at the backup timestamp. A restore that "completed" without a read
   is not verified.
4. Record the restore in the audit log, with the backup ref and the verification
   result.

## Restore procedure (tenant bucket)

1. Restore objects from the replicated copy into a bucket whose name carries the
   organization's prefix (`cw-<sha256(org)[0:12]>-`). `MinIO`'s `deleteBucket`
   refuses a bucket without that prefix, and the same check governs a restore
   target.
2. Verify by listing and reading a known object, not by trusting the copy tool's
   exit code.

## Control-plane database

Supabase PITR to a point before the incident. After restoring:

1. Re-apply migrations `0001`–`0003` are already in the snapshot; confirm the
   schema matches `pnpm build` expectations.
2. Run `pnpm verify:rls` against the restored database. A restored database with
   broken RLS is worse than no restore.

## Disaster recovery

| Scenario | Response | RTO target | RPO target |
|---|---|---|---|
| Control-plane DB loss | Supabase PITR | 1 h | 5 min |
| Single tenant DB loss | engine restore | 2 h | last backup |
| Edge loss | redeploy Envoy + Coraza from pinned images, re-distribute policy from `security_policies` | 30 min | policy version is monotonic, so re-push is safe |
| Region loss | not yet designed | — | — |

RTO/RPO are targets and unmeasured. Region loss has no design yet; it is listed
as a gap, not a plan.

## Verification checklist (the part that is actually a gate)

- [ ] Restore a tenant database and read a known row from it.
- [ ] Restore a tenant bucket and read a known object from it.
- [ ] Confirm a restore cannot target another organization's data.
- [ ] Run `pnpm verify:rls` against a restored control-plane database.
- [ ] Time each step and record actual RTO.

Every box is unchecked today. Gate 9 remains open.
