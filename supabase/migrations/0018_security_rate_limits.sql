-- ---------------------------------------------------------------------------
-- 0018 — per-route request rate limits (matrix X12 / audit S8)
--
-- The deny list in `0010` answers "what must the edge block outright". This
-- migration answers the neighbouring question the master plan names as the
-- scraper-budget problem: what may the edge *throttle* so a scraper walking a
-- catalogue cannot burn a tenant's bill, without touching a normal visitor, a
-- crawler, or a customer's own webhook sender?
--
-- A rate limit is the right instrument for that, and the wrong one is a deny
-- rule: a scraper is not necessarily hostile, it is simply disproportionate.
-- Throttling it to a visitor's budget keeps the site usable for a human while
-- making the scrape uneconomic.
--
-- Why a separate table rather than a new column on `security_policies`: limits
-- are a list with their own key and window, and folding a list into a scalar
-- policy column would force one limit per organization. A row is one limit,
-- org-scoped, exactly like a deny rule.
--
-- The compile side lives in `packages/adapters/src/security-edge.ts`, which
-- emits the limit *after* the allow steps (verified bots, internal requests,
-- trusted sources) so an allowed crawler is never counted against a visitor's
-- budget. The key and the numeric bounds are validated at the API boundary,
-- again in the compiler, and as a backstop here.
-- ---------------------------------------------------------------------------

create table if not exists security_rate_limits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- What a request is counted against. `ip` is one source address, `header` is a
  -- request header's value (an API key or tenant id), `global` is the route as a
  -- whole. These are the three Vercel's firewall exposes for a custom rule.
  key             text not null check (key in ('ip', 'header', 'global')),
  -- Only a header-keyed limit names a header. The check pairs the two so a rule
  -- cannot be half-specified: header is present exactly when key='header'.
  header_name     text
                    check (header_name is null or header_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,60}$'),
  check ((key = 'header') = (header_name is not null)),
  -- Requests allowed per window, and the window length. Bounds are the
  -- compiler's; this check is the backstop that keeps an absurd value out of the
  -- table even if a procedure is bypassed.
  limit_count     integer not null check (limit_count between 1 and 1000000),
  window_seconds  integer not null check (window_seconds between 1 and 86400),
  note            text check (note is null or length(note) <= 200),
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  -- One rule per key/header pair, so a duplicate is a no-op rather than two
  -- competing limits for the same traffic.
  unique (organization_id, key, header_name)
);

create index if not exists security_rate_limits_org_idx
  on security_rate_limits (organization_id, created_at desc);

alter table security_rate_limits enable row level security;

create policy security_rate_limits_select on security_rate_limits for select to authenticated
using (public.is_org_member(organization_id));

-- Only an admin may set a limit, and it is always attributed. This is the same
-- threshold the deny list sets: a rate limit is a security-policy change, and a
-- limit so low it denies everyone is a self-inflicted outage, so it is a
-- deliberate admin action rather than something any member can do.
create policy security_rate_limits_insert on security_rate_limits for insert to authenticated
with check (public.role_at_least(organization_id, 'admin') and created_by = auth.uid());

create policy security_rate_limits_delete on security_rate_limits for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- No UPDATE policy: a limit is set-or-removed, never silently edited, so an audit
-- reader can trust that the limit that throttled a request is the limit recorded.

-- ---------------------------------------------------------------------------
-- Widen the recorded decision stages to match the compiled ladder.
--
-- Two stages the compiler has emitted for a while were never accepted by the
-- `security_events.stage` check: `allow-trusted-ip` (the trusted-source allow
-- step from `0016`) and `ratelimit` (added above). An edge that reported either
-- decision would have had the insert rejected, so those decisions were silently
-- unrecordable. This restates the check from the ladder the compiler produces.
-- ---------------------------------------------------------------------------

alter table security_events
  drop constraint if exists security_events_stage_check;

alter table security_events
  add constraint security_events_stage_check check (
    stage in ('allow-verified-bot','allow-internal','allow-trusted-ip',
              'block-deny-list','ratelimit','challenge','waf','log','pass')
  );
