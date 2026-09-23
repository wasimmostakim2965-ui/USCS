-- ---------------------------------------------------------------------------
-- Job queue probe.
--
-- Proves, against a real PostgreSQL, the two properties migration 0003 claims:
--
--   1. The idempotency key is (organization_id, kind, idempotency_key): the same
--      key on a different kind is accepted, and the same key on the same kind is
--      rejected.
--   2. A queued job can be claimed exactly once by an exclusive lease, and a
--      lapsed lease is recoverable.
--
-- As with the isolation probe, every check raises on failure, so the script
-- exits non-zero rather than printing a warning nobody reads.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- Fixtures: two organizations, each with a creator.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'creator@example.test')
on conflict (id) do nothing;

insert into organizations (id, name, slug, created_by) values
  ('00000000-0000-0000-0000-0000000000a1', 'Jobs Org A', 'jobs-org-a', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000b1', 'Jobs Org B', 'jobs-org-b', '00000000-0000-0000-0000-0000000000c1');

-- 1a. The same key may be used on a different kind.
insert into orchestration_jobs (organization_id, kind, idempotency_key)
values ('00000000-0000-0000-0000-0000000000a1', 'deploy', 'request-1');

insert into orchestration_jobs (organization_id, kind, idempotency_key)
values ('00000000-0000-0000-0000-0000000000a1', 'backup', 'request-1');

do $$
begin
  if (select count(*) from orchestration_jobs where idempotency_key = 'request-1') <> 2 then
    raise exception 'expected the same key to be accepted across two kinds';
  end if;
end $$;

-- 1b. The same key on the same kind is rejected.
do $$
begin
  begin
    insert into orchestration_jobs (organization_id, kind, idempotency_key)
    values ('00000000-0000-0000-0000-0000000000a1', 'deploy', 'request-1');
    raise exception 'a duplicate (organization, kind, key) was accepted';
  exception
    when unique_violation then null; -- expected
  end;
end $$;

-- 1c. The same key in another organization is independent.
insert into orchestration_jobs (organization_id, kind, idempotency_key)
values ('00000000-0000-0000-0000-0000000000b1', 'deploy', 'request-1');

do $$
begin
  if (select count(*) from orchestration_jobs where idempotency_key = 'request-1') <> 3 then
    raise exception 'the key was not independent across organizations';
  end if;
end $$;

-- 2. A claim is exclusive: two claims in one transaction would see the same row
--    unless the claim uses `for update skip locked`.
do $$
declare
  first_claim uuid;
  second_claim uuid;
begin
  update orchestration_jobs
     set state = 'running',
         attempts = attempts + 1,
         worker_id = 'worker-1',
         lease_expires_at = now() + interval '30 seconds'
   where id = (
     select id from orchestration_jobs
      where state = 'queued' and organization_id = '00000000-0000-0000-0000-0000000000a1'
      order by created_at
      limit 1
      for update skip locked
   )
  returning id into first_claim;

  update orchestration_jobs
     set state = 'running',
         attempts = attempts + 1,
         worker_id = 'worker-2',
         lease_expires_at = now() + interval '30 seconds'
   where id = (
     select id from orchestration_jobs
      where state = 'queued' and organization_id = '00000000-0000-0000-0000-0000000000a1'
      order by created_at
      limit 1
      for update skip locked
   )
  returning id into second_claim;

  if first_claim = second_claim then
    raise exception 'two workers claimed the same job';
  end if;
  if second_claim is null then
    raise exception 'expected a second distinct job to be claimable';
  end if;
end $$;

-- 2b. A lapsed lease is recoverable, and a running job with attempts left goes
--     back to queued rather than being lost or marked succeeded.
update orchestration_jobs
   set lease_expires_at = now() - interval '1 second'
 where state = 'running' and worker_id = 'worker-1';

update orchestration_jobs
   set state = 'queued',
       worker_id = null,
       lease_expires_at = null,
       last_error = 'lease expired'
 where state = 'running'
   and lease_expires_at < now()
   and attempts < max_attempts;

do $$
begin
  if (select count(*) from orchestration_jobs where worker_id = 'worker-1') <> 0 then
    raise exception 'a lapsed lease was not returned to the queue';
  end if;
  if (select count(*) from orchestration_jobs where state = 'succeeded') <> 0 then
    raise exception 'a job was recorded as succeeded without an engine result';
  end if;
end $$;

select 'job queue probe passed' as result;
