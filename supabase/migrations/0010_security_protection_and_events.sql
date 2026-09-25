-- ---------------------------------------------------------------------------
-- 0010 — protection mode, the deny list, and the edge's decided traffic
--
-- The brief asks the question this migration is the answer's data half of: how
-- does the edge stop an attacker without stopping Googlebot, a scraper-budget
-- problem, or a normal visitor? The compiler half is
-- `packages/adapters/src/security-edge.ts` (a deterministic decision ladder that
-- allows verified bots and internal requests *before* any challenge). This half
-- is the state that ladder is compiled from.
--
-- Three additions:
--
--   * security_policies.protection_mode — `normal` or `attack`, the scoped
--     "under attack" posture. It is the customer's to set (it is an input, like
--     risk_level), so it stays client-writable and is not guarded below.
--
--   * security_rules — a per-organization deny list (IP / CIDR / ASN / UA). Rows
--     are a customer's own input; the *value* is validated at the API boundary
--     and again at compile time, so a value that would be directive syntax never
--     becomes one.
--
--   * security_events — what the edge actually decided, per request. This is an
--     engine-observed fact, exactly like `domains.verified`: a client must not be
--     able to write it, or it could erase a block against itself. Rows are
--     append-only and written only through the service role. The dashboard's
--     "what was blocked" view reads it; nothing fabricates it.
--
-- The class of bug this migration is careful about is the one ADR-0006/0009
-- record: "there is no UPDATE policy" is not the same as "the column is
-- protected". For a brand-new table the cleaner mechanism is to drop the client
-- write grant outright — the 0007 pattern — which is what is done for
-- `security_events` below.
-- ---------------------------------------------------------------------------

alter table security_policies
  add column if not exists protection_mode text not null default 'normal'
    check (protection_mode in ('normal', 'attack')),
  add column if not exists protection_expires_at timestamptz;

comment on column security_policies.protection_mode is
  'normal = inspect only; attack = challenge browsers while verified bots and internal requests still pass. The customer sets it; the compiled ladder enforces it.';
comment on column security_policies.protection_expires_at is
  'When attack mode ends on its own. NULL with mode=normal means "not in attack mode"; a past timestamp means the mode has lapsed and the compiler treats it as normal. An expiring posture is what keeps a panicked "under attack" click from becoming a permanent self-inflicted outage.';

-- ---------------------------------------------------------------------------
-- The deny list
-- ---------------------------------------------------------------------------

create table if not exists security_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind            text not null check (kind in ('ip', 'cidr', 'asn', 'user-agent')),
  -- A short, plain value. The grammar is enforced at the API and the compiler;
  -- this check is the backstop that keeps a multi-line value out of the table
  -- even if a procedure is bypassed.
  value           text not null
                    check (length(value) between 1 and 120)
                    check (value ~ '^[A-Za-z0-9 ._/:()+-]+$'),
  note            text check (note is null or length(note) <= 200),
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  unique (organization_id, kind, value)
);

create index if not exists security_rules_org_idx
  on security_rules (organization_id, created_at desc);

alter table security_rules enable row level security;

create policy security_rules_select on security_rules for select to authenticated
using (public.is_org_member(organization_id));

-- Only an admin may add a rule, and it is always attributed.
create policy security_rules_insert on security_rules for insert to authenticated
with check (public.role_at_least(organization_id, 'admin') and created_by = auth.uid());

create policy security_rules_delete on security_rules for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- No UPDATE policy: a rule is add-or-remove, never silently edited, so an audit
-- reader can trust that the rule that blocked a request is the rule that was
-- added.

-- ---------------------------------------------------------------------------
-- Decided traffic — the edge's own observation
-- ---------------------------------------------------------------------------

create table if not exists security_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  host            text not null,
  -- The stage of the compiled ladder that decided, and the action it took. These
  -- are observed by the edge, never asserted by a client.
  stage           text not null check (
                    stage in ('allow-verified-bot','allow-internal','block-deny-list',
                              'challenge','waf','log','pass')
                  ),
  action          text not null check (
                    action in ('allow','log','challenge','block','quarantine')
                  ),
  -- The rule id from the compiled config, so a decision is traceable to a rule.
  rule_id         integer,
  policy_version  integer,
  -- A redacted request identity. Never a full IP in the clear beyond what the
  -- operator chooses to store; the column is here so a block is attributable.
  client_ip       text,
  method          text,
  path            text,
  user_agent      text,
  -- When the edge observed it (its clock), distinct from when we stored it.
  observed_at     timestamptz not null,
  created_at      timestamptz not null default now()
);

create index if not exists security_events_org_idx
  on security_events (organization_id, observed_at desc);

alter table security_events enable row level security;

create policy security_events_select on security_events for select to authenticated
using (public.is_org_member(organization_id));

-- The edge reports through the service role (the adapter holds the edge token
-- on the API/worker side, never in a browser). A client must never be able to
-- write a security event: if it could, it could erase a block against itself or
-- fabricate one against somebody else. Update and delete are dropped too, so the
-- table is append-only for every non-service role — the same guarantee
-- `audit_logs` and `security_policy_events` carry, expressed by grant rather than
-- by a policy, because a new table can simply be denied the write it never needed.
revoke insert, update, delete on security_events from authenticated;

