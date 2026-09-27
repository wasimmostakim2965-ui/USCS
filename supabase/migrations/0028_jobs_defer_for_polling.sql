-- ---------------------------------------------------------------------------
-- 0028 — a deferred poll for work the engine has accepted but not settled
--
-- The queue's retry budget (`max_attempts`) exists for *transient failures*: an
-- engine call that threw or a lease that lapsed. In-flight work is neither. A
-- hosting engine that returns `running` from `deploy` has accepted the build and
-- is carrying it out; the deployment is progressing, not failing.
--
-- Before this migration the processor routed that `running` answer through
-- `fail`, which spends an attempt. A build that outlives `max_attempts` polls
-- was therefore recorded `failed` while the engine was still building it — the
-- platform would report a failed deployment for a build that later succeeds.
-- Worse, the loop had no backoff: it re-claimed and re-polled in the same tick,
-- so all attempts were spent in milliseconds and the real build (`in_progress`
-- for minutes) could never be observed to finish.
--
-- `deferred_until` lets a job be returned to the queue without spending an
-- attempt, and *not before* a due time, so the poll has a real interval. The
-- claim below skips a job whose backoff has not elapsed. A deferred job is still
-- bounded: `orchestration_jobs_defer_idx` and the reconciler's hard ceiling in
-- the worker settle a row whose engine never answers, so this cannot poll
-- forever.
-- ---------------------------------------------------------------------------

alter table orchestration_jobs
  add column if not exists deferred_until timestamptz;

comment on column orchestration_jobs.deferred_until is
  'When a deferred job may next be claimed. Null means claimable now. Set by the worker for in-flight engine work; never a success.';

-- The claim must not only look at `queued` and attempts, but also honour the
-- backoff a deferral wrote.
create index if not exists orchestration_jobs_defer_idx
  on orchestration_jobs (deferred_until)
  where state = 'queued' and deferred_until is not null;

-- Redefine the claim to skip a job still inside its poll interval. Everything
-- else is unchanged from 0008: `for update skip locked`, the atomic attempt
-- increment, one lease write. Only the where clause grows a due-time test.
create or replace function public.claim_orchestration_job(
  p_worker_id text,
  p_lease_seconds integer
)
returns setof orchestration_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed orchestration_jobs;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'a worker id is required to claim a job';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'a positive lease is required to claim a job';
  end if;

  select *
    into claimed
    from orchestration_jobs
   where state = 'queued'
     and attempts < max_attempts
     and (deferred_until is null or deferred_until <= now())
   order by created_at
   for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update orchestration_jobs
     set state            = 'running',
         attempts         = attempts + 1,
         started_at       = now(),
         worker_id        = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         deferred_until   = null
   where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$$;

revoke all on function public.claim_orchestration_job(text, integer) from public;
revoke all on function public.claim_orchestration_job(text, integer) from anon;
revoke all on function public.claim_orchestration_job(text, integer) from authenticated;
grant execute on function public.claim_orchestration_job(text, integer) to service_role;

-- Return an in-flight job to the queue and hand back the attempt its claim
-- spent. `attempts` is the budget for *transient failures*; a poll that found
-- the engine's build still running is not one, so it must not erode the budget
-- or the job would become unclaimable after `max_attempts` polls. It also sets
-- `deferred_until` so the poll has a real interval. Only a job currently
-- `running` is deferred, so a stale caller cannot resurrect a settled job.
create or replace function public.defer_orchestration_job(
  p_job_id uuid,
  p_reason text,
  p_defer_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  if p_defer_seconds is null or p_defer_seconds < 0 then
    raise exception 'a non-negative defer interval is required';
  end if;

  update orchestration_jobs
     set state          = 'queued',
         attempts       = greatest(attempts - 1, 0),
         started_at     = null,
         worker_id      = null,
         lease_expires_at = null,
         finished_at    = null,
         last_error     = p_reason,
         deferred_until = case
           when p_defer_seconds > 0 then now() + make_interval(secs => p_defer_seconds)
           else null
         end
   where id = p_job_id
     and state = 'running';

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

revoke all on function public.defer_orchestration_job(uuid, text, integer) from public;
revoke all on function public.defer_orchestration_job(uuid, text, integer) from anon;
revoke all on function public.defer_orchestration_job(uuid, text, integer) from authenticated;
grant execute on function public.defer_orchestration_job(uuid, text, integer) to service_role;

comment on function public.defer_orchestration_job(uuid, text, integer) is
  'Return an in-flight job to the queue without eroding its failure budget, and gate its next claim to the poll interval. Never marks work succeeded.';
