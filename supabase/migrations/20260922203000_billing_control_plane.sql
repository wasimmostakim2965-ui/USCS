create table if not exists public.billing_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  deploy_minutes numeric not null default 0 check (deploy_minutes >= 0),
  storage_gb numeric not null default 0 check (storage_gb >= 0),
  bandwidth_gb numeric not null default 0 check (bandwidth_gb >= 0),
  estimated_amount numeric not null default 0 check (estimated_amount >= 0),
  source text not null default 'telemetry' check (source in ('telemetry', 'not_configured')),
  created_at timestamptz not null default now(),
  unique (organization_id, period_start, period_end)
);
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_ref text,
  status text not null default 'not_configured' check (status in ('draft', 'open', 'paid', 'void', 'not_configured')),
  amount numeric not null default 0 check (amount >= 0),
  currency text not null default 'usd',
  issued_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.billing_payment_methods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  method_ref text,
  brand text,
  last4 text,
  status text not null default 'not_configured' check (status in ('active', 'expired', 'not_configured')),
  created_at timestamptz not null default now()
);
create index if not exists billing_usage_org_idx on public.billing_usage(organization_id, period_end desc);
create index if not exists billing_invoices_org_idx on public.billing_invoices(organization_id, created_at desc);
create index if not exists billing_payment_methods_org_idx on public.billing_payment_methods(organization_id, created_at desc);
alter table public.billing_usage enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_payment_methods enable row level security;
create policy billing_usage_member_select on public.billing_usage for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy billing_invoices_member_select on public.billing_invoices for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy billing_payment_methods_member_select on public.billing_payment_methods for select to authenticated using ((select private.is_organization_member(organization_id)));
grant select on public.billing_usage, public.billing_invoices, public.billing_payment_methods to authenticated;
