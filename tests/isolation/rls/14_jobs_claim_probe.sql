-- ---------------------------------------------------------------------------
-- Job claim/reap function probe.
--
-- Migration 0008 moved the claim and the reaper into SQL functions, because a
-- REST client cannot express `for update skip locked` plus an attempt increment
-- plus a lease write as one atomic step. This probe proves, against a real
-- PostgreSQL, the three properties those functions must hold:
--
--   1. A claim takes exactly one job, increments its attempt, and leaves a
--      lease. A second worker gets a *different* job, not the same one.
--   2. A job out of attempts is never claimable, so a retry budget is a budget
--      and not a suggestion.
--   3. The reaper returns a lapsed job to queued, or fails it once attempts are
--      spent — and in no branch does a job become `succeeded`.
--
-- It also proves the client boundary: the browser holds the anon key, so an
-- object the browser can execute is an object a tenant can use to run engine
-- work. `authenticated` must not be able to call either function.
--
-- Every check raises on failure, so the script exits non-zero rather than
-- printing a warning nobody reads.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'claim-owner@example.test')
on conflict (id) do nothing;

insert into organizations (id, name, slug, created_by) values
  ('00000000-0000-0000-0000-0000000000e1', 'Claim Org', 'claim-org', '00000000-0000-0000-0000-0000000000d1');

-- Three queued jobs: two claimable, one already out of attempts.
insert into orchestration_jobs (organization_id, kind, idempotency_key, created_at)
values
  ('00000000-0000-0000-0000-0000000000e1', 'deployment.create', 'claim-1', now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000000e1', 'deployment.create', 'claim-2', now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000000e1', 'deployment.create', 'claim-spent', now() - interval '1 minute');

update orchestration_jobs
   set attempts = max_attempts
 where idempotency_key = 'claim-spent';

-- 1. A claim takes one job and increments its attempt.
do $$
declare
  claimed orchestration_jobs;
begin
  select * into claimed from public.claim_orchestration_job('worker-1', 30);

  if claimed.id is null then
    raise exception 'a queued job with attempts left was not claimed';
  end if;
  if claimed.state <> 'running' then
    raise exception 'a claimed job was not marked running (got %)', claimed.state;
  end if;
  if claimed.attempts <> 1 then
    raise exception 'a claim did not increment the attempt (got %)', claimed.attempts;
  end if;
  if claimed.lease_expires_at is null then
    raise exception 'a claim left no lease';
  end if;
  if claimed.worker_id <> 'worker-1' then
    raise exception 'a claim did not record the worker';
  end if;
end $$;

-- 1b. A second worker gets a different job, and the spent job stays unclaimable.
--     Scoped to this probe's own organization: an earlier probe leaves queued
--     jobs behind, and a claim is not scoped to one tenant by design.
do $$
declare
  second orchestration_jobs;
  claimable integer;
begin
  select * into second from public.claim_orchestration_job('worker-2', 30);

  if second.id is null then
    raise exception 'the second claimable job was not claimed';
  end if;
  if second.idempotency_key = 'claim-spent' then
    raise exception 'a job out of attempts was claimed';
  end if;

  select count(*) into claimable
    from orchestration_jobs
   where organization_id = '00000000-0000-0000-0000-0000000000e1'
     and state = 'queued'
     and attempts < max_attempts;

  if claimable <> 0 then
    raise exception 'a job out of attempts was left claimable (or a claim was lost)';
  end if;
end $$;

-- 2. The reaper returns a lapsed lease to queued. No job is ever succeeded.
update orchestration_jobs
   set lease_expires_at = now() - interval '1 second'
 where worker_id = 'worker-1';

do $$
declare
  reaped integer;
begin
  reaped := public.reap_expired_jobs(now());
  if reaped <> 1 then
    raise exception 'the reaper returned % jobs, expected 1', reaped;
  end if;
  if exists (select 1 from orchestration_jobs where worker_id = 'worker-1') then
    raise exception 'a lapsed lease was not cleared';
  end if;
  if exists (select 1 from orchestration_jobs where state = 'succeeded') then
    raise exception 'the reaper marked a job succeeded; only an engine may do that';
  end if;
end $$;

-- 2b. A reaped job with attempts left is queued again and claimable.
do $$
declare
  reclaimed orchestration_jobs;
begin
  select * into reclaimed from public.claim_orchestration_job('worker-1', 30);
  if reclaimed.id is null then
    raise exception 'a reaped job with attempts left was not claimable again';
  end if;
  if reclaimed.attempts <> 2 then
    raise exception 'a re-claim did not increment the attempt (got %)', reclaimed.attempts;
  end if;
end $$;

-- 3. A lapsed job out of attempts is failed by the reaper, never succeeded.
insert into orchestration_jobs (organization_id, kind, idempotency_key, state, attempts, max_attempts, worker_id, lease_expires_at)
values (
  '00000000-0000-0000-0000-0000000000e1', 'deployment.create', 'claim-expired',
  'running', 3, 3, 'worker-x', now() - interval '1 second'
);

do $$
begin
  perform public.reap_expired_jobs(now());
  if (select state from orchestration_jobs where idempotency_key = 'claim-expired') <> 'failed' then
    raise exception 'a lapsed job out of attempts was not failed';
  end if;
  if exists (select 1 from orchestration_jobs where state = 'succeeded') then
    raise exception 'the reaper marked a job succeeded; only an engine may do that';
  end if;
end $$;

-- 4. The client boundary: the browser's role must not be able to claim or reap.
--    Checked through the catalog rather than by `set role`: the probe runs as a
--    superuser, and a superuser bypasses every privilege check, so a `set role`
--    attempt would appear to succeed no matter what the grant says.
do $$
begin
  if has_function_privilege('authenticated', 'public.claim_orchestration_job(text, integer)', 'EXECUTE') then
    raise exception 'the authenticated role holds EXECUTE on the claim function';
  end if;
  if has_function_privilege('anon', 'public.claim_orchestration_job(text, integer)', 'EXECUTE') then
    raise exception 'the anon role holds EXECUTE on the claim function';
  end if;
  if has_function_privilege('authenticated', 'public.reap_expired_jobs(timestamptz)', 'EXECUTE') then
    raise exception 'the authenticated role holds EXECUTE on the reap function';
  end if;
  if not has_function_privilege('service_role', 'public.claim_orchestration_job(text, integer)', 'EXECUTE') then
    raise exception 'the service role cannot claim a job';
  end if;
  if not has_function_privilege('service_role', 'public.reap_expired_jobs(timestamptz)', 'EXECUTE') then
    raise exception 'the service role cannot reap jobs';
  end if;
end $$;

select 'job claim/reap probe passed' as result;
