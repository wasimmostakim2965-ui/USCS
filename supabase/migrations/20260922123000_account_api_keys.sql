create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.api_keys enable row level security;

drop policy if exists api_keys_select_own on public.api_keys;
create policy api_keys_select_own on public.api_keys
for select using ((select auth.uid()) = user_id);

drop policy if exists api_keys_insert_own on public.api_keys;
create policy api_keys_insert_own on public.api_keys
for insert with check ((select auth.uid()) = user_id);

drop policy if exists api_keys_update_own on public.api_keys;
create policy api_keys_update_own on public.api_keys
for update using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create index if not exists api_keys_user_id_idx on public.api_keys(user_id);
create index if not exists api_keys_active_idx on public.api_keys(user_id, revoked_at)
where revoked_at is null;
