alter table public.profiles
  add column if not exists onboarding_step integer not null default 1;

alter table public.profiles
  drop constraint if exists profiles_onboarding_step_check;

alter table public.profiles
  add constraint profiles_onboarding_step_check
  check (onboarding_step between 1 and 7);
