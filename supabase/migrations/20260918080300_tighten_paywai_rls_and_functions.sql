drop index if exists public.ledger_accounts_user_currency_uidx;

alter policy profiles_select on public.profiles using ((select auth.uid()) = id);
alter policy profiles_insert on public.profiles with check ((select auth.uid()) = id);
alter policy profiles_update on public.profiles using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

alter policy kyc_select on public.kyc_applications using ((select auth.uid()) = user_id);
alter policy kyc_insert on public.kyc_applications with check ((select auth.uid()) = user_id);
alter policy kyc_update on public.kyc_applications using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

alter policy security_select on public.security_settings using ((select auth.uid()) = user_id);
alter policy security_insert on public.security_settings with check ((select auth.uid()) = user_id);
alter policy security_update on public.security_settings using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

alter policy ledger_select on public.ledger_accounts using ((select auth.uid()) = user_id);
alter policy ledger_insert on public.ledger_accounts with check ((select auth.uid()) = user_id);
alter policy ledger_update on public.ledger_accounts using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

alter policy tx_select on public.transactions using ((select auth.uid()) = user_id);
alter policy tx_insert on public.transactions with check ((select auth.uid()) = user_id);

alter policy audit_select on public.audit_events using ((select auth.uid()) = user_id);
alter policy audit_insert on public.audit_events with check ((select auth.uid()) = user_id);

revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.rls_auto_enable() from anon, authenticated;

alter function public.touch_updated_at() set search_path = public;
