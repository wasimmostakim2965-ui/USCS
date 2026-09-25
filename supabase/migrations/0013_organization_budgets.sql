-- ---------------------------------------------------------------------------
-- 0013 — a hard spend cap (matrix W9)
--
-- Vercel's most-cited complaint is pricing surprise: an overage rate with no
-- hard cap, and alerts that fail silently. This migration adds the object that
-- makes a cap a *control* rather than an alert: `organization_budgets`.
--
-- One row per organization per metric:
--
--   * `metric` matches a `usage_records.metric`, so a budget is measured against
--     the same rows the dashboard shows — there is no second accounting system.
--   * `limit_quantity` is the cap for one period.
--   * `period` is `monthly` today; the column exists so the enforcement code can
--     name the window instead of hard-coding "this calendar month" in a comment.
--   * `hard_cap` decides whether the API refuses new work at the cap. When false
--     the budget is informational — the dashboard shows the ratio and nothing is
--     blocked, which is the honest meaning of a soft budget with nowhere to
--     alert.
--
-- Members read it through RLS; only the owner writes it (`billing:manage` is an
-- owner-only capability, and the policy mirrors it). The worker never touches
-- this table — enforcement lives on the request path, before a job is enqueued,
-- so a cap cannot be discovered after the work is already queued.
-- ---------------------------------------------------------------------------

create table if not exists organization_budgets (
  organization_id uuid not null references organizations (id) on delete cascade,
  metric          text not null,
  limit_quantity  numeric not null check (limit_quantity >= 0),
  period          text not null default 'monthly' check (period in ('monthly')),
  hard_cap        boolean not null default true,
  updated_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, metric)
);

alter table organization_budgets enable row level security;

-- A member reads the organization's budgets; a viewer included, since a cap is
-- a fact about the organization, not a secret and not a write.
create policy organization_budgets_select on organization_budgets for select to authenticated
using (public.is_org_member(organization_id));

-- Only an owner sets a cap. The capability matrix reserves `billing:manage` for
-- the owner role, and RLS is the second enforcement of the same rule: a member,
-- a viewer and an admin alike cannot raise the ceiling on their own spend.
create policy organization_budgets_insert on organization_budgets for insert to authenticated
with check (public.role_in(organization_id) = 'owner');

create policy organization_budgets_update on organization_budgets for update to authenticated
using (public.role_in(organization_id) = 'owner')
with check (public.role_in(organization_id) = 'owner');

-- Removing a cap is an owner action: it is the control that protects the
-- organization from a runaway bill, so unsetting it is not a routine edit.
create policy organization_budgets_delete on organization_budgets for delete to authenticated
using (public.role_in(organization_id) = 'owner');

create trigger organization_budgets_touch
  before update on organization_budgets
  for each row execute function public.touch_updated_at();
