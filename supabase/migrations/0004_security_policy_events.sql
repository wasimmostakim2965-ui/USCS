-- ---------------------------------------------------------------------------
-- 0004 — security policy events, and the applied-vs-desired split
--
-- Found while implementing the security write-flows. The security_policies
-- table holds one current row per organization, which answers "what is
-- configured". It cannot answer "what the edge actually accepted, and when" —
-- that is a history, and the dashboard's applied-history timeline is built from
-- it. Storing the history in audit_logs alone would work but would force the UI
-- to parse free-text metadata to render a state machine.
--
-- Two columns are also added to security_policies:
--   * applied_version — the version the edge confirmed. NULL until one applies.
--   * applied_at      — when it applied.
-- A desired version above the applied version is the normal "pending apply"
-- state, and it is what the dashboard shows as a diff before an apply.
-- ---------------------------------------------------------------------------

alter table security_policies
  add column if not exists applied_version integer,
  add column if not exists applied_at timestamptz;

comment on column security_policies.applied_version is
  'Version the security edge confirmed. NULL means nothing has been applied yet.';
comment on column security_policies.applied_at is
  'When the applied_version was confirmed. NULL means nothing has been applied yet.';

create table security_policy_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  policy_id       uuid not null references security_policies (id) on delete cascade,
  from_state      policy_state,
  to_state        policy_state not null,
  version         integer not null check (version >= 1),
  actor_id        uuid references auth.users (id),
  actor_email     text,
  detail          text,
  created_at      timestamptz not null default now()
);

create index security_policy_events_org_idx
  on security_policy_events (organization_id, created_at desc);

alter table security_policy_events enable row level security;

-- Members read their own organization's history.
create policy security_policy_events_select on security_policy_events
for select to authenticated
using (public.is_org_member(organization_id));

-- Rows are written by the API with the admin's identity, and only for an
-- organization the writer administers. Like audit_logs, there is intentionally
-- no UPDATE or DELETE policy: the history is append-only for every role.
create policy security_policy_events_insert on security_policy_events
for insert to authenticated
with check (public.role_at_least(organization_id, 'admin'));
