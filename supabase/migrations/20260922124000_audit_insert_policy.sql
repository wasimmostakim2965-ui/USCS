drop policy if exists audit_logs_member_insert on public.audit_logs;
create policy audit_logs_member_insert on public.audit_logs
for insert with check (
  actor_id = (select auth.uid())
  and exists (
    select 1 from public.organization_members m
    where m.organization_id = audit_logs.organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner','admin','security')
  )
);

grant insert on public.audit_logs to authenticated;
