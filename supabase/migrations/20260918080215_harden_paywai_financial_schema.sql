create unique index if not exists ledger_accounts_user_currency_uidx
  on public.ledger_accounts (user_id, currency);

create index if not exists transactions_user_created_idx
  on public.transactions (user_id, created_at desc);

create index if not exists audit_events_user_created_idx
  on public.audit_events (user_id, created_at desc);

create index if not exists kyc_applications_status_idx
  on public.kyc_applications (status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists kyc_applications_set_updated_at on public.kyc_applications;
create trigger kyc_applications_set_updated_at
before update on public.kyc_applications
for each row execute function public.set_updated_at();

drop trigger if exists security_settings_set_updated_at on public.security_settings;
create trigger security_settings_set_updated_at
before update on public.security_settings
for each row execute function public.set_updated_at();

drop trigger if exists ledger_accounts_set_updated_at on public.ledger_accounts;
create trigger ledger_accounts_set_updated_at
before update on public.ledger_accounts
for each row execute function public.set_updated_at();
