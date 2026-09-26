-- ---------------------------------------------------------------------------
-- 0019 — security incidents (matrix X15 / audit S7)
--
-- The edge's per-request decisions are in `security_events` (0010). This table
-- is the layer above them: a *grouped* incident — "the edge rejected our policy
-- distribution", "an origin address leaked", "a rule started matching a lot" —
-- with a lifecycle, so an operator can see that something happened, that it is
-- being handled, and how it ended.
--
-- Why a separate table rather than a flag on `security_events`: a decision is a
-- fact about one request and is append-only; an incident is a case with a state
-- that changes over time and a resolution written when it closes. Folding them
-- together would mean mutating an append-only fact, which is exactly the
-- guarantee `security_events` exists to carry.
--
-- The class of bug this migration is careful about is the one ADR-0006/0009
-- record: "there is no UPDATE policy" is not the same as "the column is
-- protected". An incident has two kinds of column and they are treated
-- differently:
--
--   * the *observed* facts — `kind`, `severity`, `summary`, `opened_at` — are
--     the control plane's own observation of a signal. A client must not be able
--     to open an incident that did not happen, nor rewrite the one it opened to
--     say something milder, so these are service-role written and the client
--     write grant is dropped outright (the 0007 pattern).
--
--   * the *triage* — `state`, `resolution`, `closed_at`, `triaged_by` — is an
--     operator's work. An admin may move an incident through its lifecycle, but
--     the table check below refuses a transition that skips a step or a close
--     with no resolution, and the trigger stamps `closed_at` from the server
--     clock so a client cannot backdate a close.
-- ---------------------------------------------------------------------------

create table if not exists security_incidents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- The signal's kind. Kept as free text with a length bound rather than an
  -- enum: a new detector should not need a migration, and the set of detectors
  -- is expected to grow (policy rejection today, origin leak and rule-volume
  -- spikes next).
  kind            text not null check (length(kind) between 1 and 80),
  severity        text not null check (severity in ('low', 'medium', 'high', 'critical')),
  summary         text not null check (length(summary) between 1 and 500),
  state           text not null default 'open'
                    check (state in ('open', 'triaged', 'resolved', 'false_positive')),
  -- The signal's own timestamp, from the detector's clock, distinct from when
  -- the row was stored. An incident that arrived late still reads correctly.
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  resolution      text check (resolution is null or length(resolution) between 1 and 500),
  triaged_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),

  -- A closed incident must carry both a resolution and a close time; an open one
  -- must carry neither. This is the constraint that makes "an incident never
  -- silently disappears" a database fact rather than a code convention.
  constraint security_incidents_close_complete check (
    (state in ('open', 'triaged') and closed_at is null and resolution is null)
    or (state in ('resolved', 'false_positive') and closed_at is not null and resolution is not null)
  )
);

create index if not exists security_incidents_org_idx
  on security_incidents (organization_id, opened_at desc);

-- The open-incident lookup (the badge and the "needs attention" list) is the
-- hot path, so it gets its own partial index rather than scanning the history.
create index if not exists security_incidents_open_idx
  on security_incidents (organization_id, severity, opened_at desc)
  where state in ('open', 'triaged');

alter table security_incidents enable row level security;

create policy security_incidents_select on security_incidents for select to authenticated
using (public.is_org_member(organization_id));

-- Triage is an admin action: moving an incident to `resolved` is an assertion
-- that a security problem is handled, so it carries the same threshold as a
-- policy change.
create policy security_incidents_update on security_incidents for update to authenticated
using (public.role_at_least(organization_id, 'admin'))
with check (public.role_at_least(organization_id, 'admin'));

-- The observed facts are the control plane's, not a client's: an incident cannot
-- be opened, deleted or fabricated from a browser. Only the transition columns
-- are updatable, and the trigger below refuses a rewrite of the observation and
-- a skipped lifecycle step.
revoke insert, delete on security_incidents from authenticated;
revoke update on security_incidents from authenticated;
grant update (state, resolution, closed_at, triaged_by) on security_incidents to authenticated;

create or replace function public.security_incidents_guard()
returns trigger
language plpgsql
as $$
begin
  -- The observation is immutable. A client may move an incident through its
  -- lifecycle but may not change what was observed — otherwise a resolved
  -- incident could be rewritten to describe a different event than the one that
  -- opened it, and the record would be worthless as evidence.
  if new.kind is distinct from old.kind
     or new.severity is distinct from old.severity
     or new.summary is distinct from old.summary
     or new.opened_at is distinct from old.opened_at
     or new.organization_id is distinct from old.organization_id then
    raise exception 'an incident observation is immutable';
  end if;

  -- The lifecycle only moves forward. Reopening a closed incident would erase
  -- the resolution a reader relies on; a real recurrence is a new incident.
  if old.state in ('resolved', 'false_positive') and new.state <> old.state then
    raise exception 'a closed incident cannot be reopened';
  end if;
  -- Any close goes through triage. The API enforces the same rule, so this is
  -- the backstop for a path that bypasses it; keeping the two identical means a
  -- caller never sees a rule the database would have allowed.
  if old.state = 'open' and new.state in ('resolved', 'false_positive') then
    raise exception 'an incident must be triaged before it is closed';
  end if;

  -- The close time is the server's, never the client's, so a close cannot be
  -- backdated to hide how long an incident was open.
  if new.state in ('resolved', 'false_positive') then
    new.closed_at := now();
  else
    new.closed_at := null;
    new.resolution := null;
  end if;

  return new;
end;
$$;

drop trigger if exists security_incidents_guard_trigger on security_incidents;
create trigger security_incidents_guard_trigger
  before update on security_incidents
  for each row execute function public.security_incidents_guard();
