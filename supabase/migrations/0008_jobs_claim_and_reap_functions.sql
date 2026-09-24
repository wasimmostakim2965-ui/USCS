-- ---------------------------------------------------------------------------
-- 0008 — the orchestration queue's SQL contract, as functions
--
-- The in-memory queue (packages/adapters/src/queue.ts) promised three
-- properties: idempotent enqueue, an exclusive leased claim, and a reaper that
-- returns a lapsed lease to the queue. Enqueue and the idempotency constraint
-- are already SQL (0001/0003). What a REST client cannot express is the claim
-- itself: `select ... for update skip locked` plus an increment of `attempts`
-- and the lease write must be one atomic step, or two workers can both "claim"
-- the same job and the retry budget is lost to a lost update.
--
-- So the claim and the reap are functions, both `security definer`, both
-- executable only by `service_role`. The browser holds the anon key and cannot
-- call them: the queue is service-role written, and a client that could claim a
-- job could execute engine work it did not request.
-- ---------------------------------------------------------------------------

-- Claim the oldest queued job that still has attempts left.
--
-- `for update skip locked` makes the row invisible to a concurrent claimer
-- rather than blocking it, so N workers claim N distinct jobs in one pass. The
-- attempt is incremented in the same statement that flips the state, so a claim
-- that is not completed still counts against the retry budget.
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
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$$;

-- Return every lapsed running job to the queue, or fail it once its attempts
-- are spent. A crashed worker must not wedge a job forever, and it must not be
-- silently made successful either — a job with no attempts left becomes
-- `failed`, never `succeeded`.
create or replace function public.reap_expired_jobs(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reaped integer;
begin
  with expired as (
    update orchestration_jobs
       set state       = case
                           when attempts >= max_attempts then 'failed'::job_state
                           else 'queued'::job_state
                         end,
           last_error  = case
                           when attempts >= max_attempts
                             then 'lease expired and no attempts remain'
                           else 'lease expired'
                         end,
           finished_at = case
                           when attempts >= max_attempts then p_now
                           else finished_at
                         end,
           worker_id        = null,
           lease_expires_at = null
     where state = 'running'
       and lease_expires_at is not null
       and lease_expires_at <= p_now
    returning 1
  )
  select count(*) into reaped from expired;
  return reaped;
end;
$$;

-- Service-role only.
--
-- `revoke ... from public` alone is not enough. Supabase's standard setup grants
-- EXECUTE on new `public` functions to `authenticated` and `anon` by default
-- privilege (the test harness's auth shim mirrors this), so a function that only
-- revokes from PUBLIC still carries an explicit grant to the browser's role. A
-- browser that can execute these is a tenant that can claim engine work, so the
-- revoke names every client role rather than trusting the default.
revoke all on function public.claim_orchestration_job(text, integer) from public;
revoke all on function public.claim_orchestration_job(text, integer) from anon;
revoke all on function public.claim_orchestration_job(text, integer) from authenticated;
revoke all on function public.reap_expired_jobs(timestamptz) from public;
revoke all on function public.reap_expired_jobs(timestamptz) from anon;
revoke all on function public.reap_expired_jobs(timestamptz) from authenticated;
grant execute on function public.claim_orchestration_job(text, integer) to service_role;
grant execute on function public.reap_expired_jobs(timestamptz) to service_role;

comment on function public.claim_orchestration_job(text, integer) is
  'Atomically claim one queued, attempt-bearing job. Service-role only; a client must not execute engine work.';
comment on function public.reap_expired_jobs(timestamptz) is
  'Return lapsed running jobs to queued, or fail those out of attempts. Never marks work succeeded.';
