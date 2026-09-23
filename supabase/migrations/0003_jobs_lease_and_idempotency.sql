-- ---------------------------------------------------------------------------
-- 0003 — orchestration job uniqueness, leases and honest states
--
-- Two corrections to 0001, both found while implementing the job queue in
-- packages/adapters/src/queue.ts.
--
-- 1. The idempotency key was `(organization_id, idempotency_key)`. The queue's
--    key is `(organization_id, kind, idempotency_key)`: the same key may
--    legitimately be reused across different job kinds (a deploy and a backup
--    can share a caller-supplied request id). The narrower constraint would have
--    rejected a job the in-memory queue accepts, so the two implementations
--    would have diverged in production only.
--
-- 2. A claim needs a lease so a crashed worker does not wedge a job forever,
--    and the state vocabulary needs `succeeded` to mean "the engine said so".
--    A non-successful job must never be recorded as succeeded; the states below
--    are the ones the worker actually writes.
-- ---------------------------------------------------------------------------

-- 1. Widen the idempotency constraint to include the job kind.
alter table orchestration_jobs
  drop constraint if exists orchestration_jobs_organization_id_idempotency_key_key;

create unique index if not exists orchestration_jobs_idempotency_idx
  on orchestration_jobs (organization_id, kind, idempotency_key);

-- 2. Lease bookkeeping.
alter table orchestration_jobs
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists max_attempts integer not null default 3;

alter table orchestration_jobs
  drop constraint if exists orchestration_jobs_max_attempts_check;

alter table orchestration_jobs
  add constraint orchestration_jobs_max_attempts_check check (max_attempts > 0);

-- A claim looks for the oldest queued job that still has attempts left.
create index if not exists orchestration_jobs_claim_idx
  on orchestration_jobs (state, created_at)
  where state = 'queued';

-- Reaping looks for running jobs whose lease has lapsed.
create index if not exists orchestration_jobs_lease_idx
  on orchestration_jobs (lease_expires_at)
  where state = 'running';

comment on column orchestration_jobs.worker_id is
  'The worker holding the current lease. Cleared when the job leaves running.';
comment on column orchestration_jobs.lease_expires_at is
  'When the current claim lapses. A lapsed lease is returned to queued by a reaper.';
comment on column orchestration_jobs.last_error is
  'The adapter''s reason for the last non-success. Never a fabricated success.';
