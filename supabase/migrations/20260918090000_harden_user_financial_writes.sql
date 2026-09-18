-- Paywai: prevent browser clients from fabricating financial records.
-- User-facing writes that are legitimate are moved behind narrowly scoped SECURITY DEFINER RPCs.

create or replace function public.ensure_ledger_account(p_currency text default 'USD')
returns public.ledger_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  row public.ledger_accounts;
begin
  if uid is null then
    raise exception 'authentication required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid currency';
  end if;

  select * into row
  from public.ledger_accounts
  where user_id = uid and currency = p_currency
  limit 1;

  if found then
    return row;
  end if;

  insert into public.ledger_accounts(user_id,currency,status,available_minor,pending_minor)
  values(uid,p_currency,'unfunded',0,0)
  returning * into row;

  return row;
end;
$$;

create or replace function public.record_audit(
  p_event text,
  p_entity text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.audit_events
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  row public.audit_events;
begin
  if uid is null then
    raise exception 'authentication required';
  end if;
  insert into public.audit_events(user_id,event,entity,entity_id,metadata)
  values(uid,p_event,p_entity,coalesce(p_entity_id,uid::text),coalesce(p_metadata,'{}'::jsonb))
  returning * into row;
  return row;
end;
$$;

revoke insert, update on public.ledger_accounts from authenticated;
revoke insert on public.transactions from authenticated;
revoke insert on public.audit_events from authenticated;

grant execute on function public.ensure_ledger_account(text) to authenticated;
grant execute on function public.record_audit(text,text,text,jsonb) to authenticated;

-- Customers may submit/edit their own KYC draft, but may not self-approve,
-- reject, or mark an application as verified.
create or replace function public.protect_kyc_review_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() = old.user_id then
    if new.status not in ('draft','submitted') then
      raise exception 'KYC review status can only be changed by an authorized reviewer';
    end if;
    if old.status in ('verified','rejected','pending_review') and new.status <> old.status then
      raise exception 'KYC review status is locked';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_kyc_review_fields on public.kyc_applications;
create trigger protect_kyc_review_fields
before update on public.kyc_applications
for each row execute function public.protect_kyc_review_fields();

-- KYC insert/update remain user-scoped through the existing RLS policies.
