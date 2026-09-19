-- Paywai core schema
-- Everything is user-scoped and protected by RLS: a row is only ever
-- readable/writable by the authenticated user it belongs to.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text,
  account_type       text not null default 'personal'
                       check (account_type in ('personal','business')),
  country            text,
  full_name          text,
  phone              text,
  phone_verified     boolean not null default false,
  business_name      text,
  business_type      text,
  business_category  text,
  onboarding_step   integer not null default 1 check (onboarding_step between 1 and 7),
  onboarding_status  text not null default 'started'
                       check (onboarding_status in
                         ('started','details_pending','kyc_pending','submitted','verified','rejected')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------- kyc_applications
create table if not exists public.kyc_applications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  status           text not null default 'draft'
                     check (status in ('draft','submitted','pending_review','verified','rejected')),
  legal_name       text,
  date_of_birth    date,
  nationality      text,
  first_name       text,
  middle_name      text,
  last_name        text,
  occupation       text,
  place_of_birth   text,
  country_of_birth text,
  secondary_nationality text,
  gender           text,
  marital_status   text,
  employer         text,
  address_line1    text,
  address_line2    text,
  city             text,
  region           text,
  postal_code      text,
  tax_residence    text,
  document_type    text,
  document_number  text,
  document_country text,
  submitted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id)
);

-- ------------------------------------------------------ security_settings
-- Transaction password and TOTP live here, configured *after* sign-up
-- from account settings, never during registration.
create table if not exists public.security_settings (
  user_id                       uuid primary key references auth.users(id) on delete cascade,
  transaction_password_hash     text,
  transaction_password_salt     text,
  transaction_password_iterations integer,
  mfa_secret                    text,
  mfa_enabled                   boolean not null default false,
  updated_at                    timestamptz not null default now()
);

-- -------------------------------------------------------- ledger_accounts
create table if not exists public.ledger_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  available_minor bigint not null default 0,
  pending_minor   bigint not null default 0,
  status          text not null default 'unfunded'
                    check (status in ('unfunded','active','restricted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, currency)
);

-- ---------------------------------------------------------- transactions
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  currency     text not null,
  amount_minor bigint not null,
  direction    text not null check (direction in ('in','out')),
  status       text not null default 'pending'
                 check (status in ('pending','authorized','settled','failed')),
  rail         text,
  reference    text,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------- audit_events
create table if not exists public.audit_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  event      text not null,
  entity     text,
  entity_id  text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ RLS
alter table public.profiles          enable row level security;
alter table public.kyc_applications  enable row level security;
alter table public.security_settings enable row level security;
alter table public.ledger_accounts   enable row level security;
alter table public.transactions      enable row level security;
alter table public.audit_events      enable row level security;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select using (auth.uid() = id);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists kyc_select on public.kyc_applications;
drop policy if exists kyc_insert on public.kyc_applications;
drop policy if exists kyc_update on public.kyc_applications;
create policy kyc_select on public.kyc_applications for select using (auth.uid() = user_id);
create policy kyc_insert on public.kyc_applications for insert with check (auth.uid() = user_id);
create policy kyc_update on public.kyc_applications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists security_select on public.security_settings;
drop policy if exists security_insert on public.security_settings;
drop policy if exists security_update on public.security_settings;
create policy security_select on public.security_settings for select using (auth.uid() = user_id);
create policy security_insert on public.security_settings for insert with check (auth.uid() = user_id);
create policy security_update on public.security_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists ledger_select on public.ledger_accounts;
drop policy if exists ledger_insert on public.ledger_accounts;
drop policy if exists ledger_update on public.ledger_accounts;
create policy ledger_select on public.ledger_accounts for select using (auth.uid() = user_id);
create policy ledger_insert on public.ledger_accounts for insert with check (auth.uid() = user_id);
create policy ledger_update on public.ledger_accounts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists tx_select on public.transactions;
drop policy if exists tx_insert on public.transactions;
create policy tx_select on public.transactions for select using (auth.uid() = user_id);
create policy tx_insert on public.transactions for insert with check (auth.uid() = user_id);

drop policy if exists audit_select on public.audit_events;
drop policy if exists audit_insert on public.audit_events;
create policy audit_select on public.audit_events for select using (auth.uid() = user_id);
create policy audit_insert on public.audit_events for insert with check (auth.uid() = user_id);

-- -------------------------------------------------------- signup trigger
-- Every new auth user gets a profile row so the app never has to
-- handle a "user exists but profile does not" state.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, country, full_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'country', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------- updated_at touch
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists kyc_touch on public.kyc_applications;
create trigger kyc_touch before update on public.kyc_applications
  for each row execute function public.touch_updated_at();

drop trigger if exists ledger_touch on public.ledger_accounts;
create trigger ledger_touch before update on public.ledger_accounts
  for each row execute function public.touch_updated_at();
