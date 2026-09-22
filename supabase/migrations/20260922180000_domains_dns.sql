create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  hostname text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'not_configured')),
  registrar_ref text,
  nameservers text[] not null default '{}',
  ssl_status text not null default 'not_configured' check (ssl_status in ('pending', 'active', 'failed', 'not_configured')),
  dnssec_enabled boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, hostname)
);

create table if not exists public.dns_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain_id uuid not null references public.domains(id) on delete cascade,
  record_type text not null check (record_type in ('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS')),
  name text not null check (char_length(name) between 1 and 253),
  value text not null check (char_length(value) between 1 and 2048),
  ttl integer not null default 3600 check (ttl between 60 and 86400),
  priority integer check (priority is null or priority between 0 and 65535),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain_id, record_type, name, value)
);

create index if not exists domains_organization_idx on public.domains(organization_id, created_at desc);
create index if not exists domains_project_idx on public.domains(organization_id, project_id);
create index if not exists dns_records_domain_idx on public.dns_records(organization_id, domain_id, record_type, name);

alter table public.domains enable row level security;
alter table public.dns_records enable row level security;

drop policy if exists domains_member_select on public.domains;
create policy domains_member_select on public.domains
for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists domains_member_insert on public.domains;
create policy domains_member_insert on public.domains
for insert to authenticated with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and (project_id is null or exists (select 1 from public.projects where projects.id = domains.project_id and projects.organization_id = domains.organization_id))
);
drop policy if exists domains_member_update on public.domains;
create policy domains_member_update on public.domains
for update to authenticated using ((select private.is_organization_member(organization_id)))
with check ((select private.is_organization_member(organization_id)));

drop policy if exists dns_records_member_select on public.dns_records;
create policy dns_records_member_select on public.dns_records
for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists dns_records_member_insert on public.dns_records;
create policy dns_records_member_insert on public.dns_records
for insert to authenticated with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (select 1 from public.domains where domains.id = dns_records.domain_id and domains.organization_id = dns_records.organization_id)
);
drop policy if exists dns_records_member_update on public.dns_records;
create policy dns_records_member_update on public.dns_records
for update to authenticated using ((select private.is_organization_member(organization_id)))
with check ((select private.is_organization_member(organization_id)));
drop policy if exists dns_records_member_delete on public.dns_records;
create policy dns_records_member_delete on public.dns_records
for delete to authenticated using ((select private.is_organization_member(organization_id)));

grant select, insert, update on public.domains to authenticated;
grant select, insert, update, delete on public.dns_records to authenticated;
