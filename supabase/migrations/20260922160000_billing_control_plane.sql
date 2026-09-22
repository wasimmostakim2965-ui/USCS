create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  provider_customer_id text unique,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_customer_id uuid references public.billing_customers(id) on delete set null,
  provider text not null default 'stripe',
  provider_subscription_id text unique,
  plan_id text not null,
  status text not null default 'incomplete' check (status in ('incomplete','trialing','active','past_due','canceled','unpaid','paused')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create index if not exists billing_subscriptions_org_idx on public.billing_subscriptions(organization_id);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;

drop policy if exists billing_customers_member_select on public.billing_customers;
create policy billing_customers_member_select on public.billing_customers for select using (private.is_organization_member(organization_id));
drop policy if exists billing_subscriptions_member_select on public.billing_subscriptions;
create policy billing_subscriptions_member_select on public.billing_subscriptions for select using (private.is_organization_member(organization_id));

grant select on public.billing_customers, public.billing_subscriptions to authenticated;
revoke all on public.billing_customers, public.billing_subscriptions from anon;
