-- Harden user workspace provisioning.
-- The provisioning function is SECURITY DEFINER because it is also used by the
-- auth trigger, so it must never be callable by anonymous clients.
revoke execute on function public.ensure_user_workspace(uuid, text, jsonb) from public;
revoke execute on function public.ensure_user_workspace(uuid, text, jsonb) from anon;
grant execute on function public.ensure_user_workspace(uuid, text, jsonb) to authenticated;

-- Browser recovery path: derive identity from the caller's JWT instead of
-- accepting an arbitrary user id/email/metadata from the browser.
create or replace function public.ensure_current_user_workspace()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_user_id uuid;
  current_email text;
  current_metadata jsonb;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception 'authentication required';
  end if;

  select u.email, u.raw_user_meta_data
    into current_email, current_metadata
  from auth.users u
  where u.id = current_user_id;

  if not found then
    raise exception 'authenticated user not found';
  end if;

  perform public.ensure_user_workspace(
    current_user_id,
    current_email,
    coalesce(current_metadata, '{}'::jsonb)
  );
end;
$function$;

revoke execute on function public.ensure_current_user_workspace() from public;
revoke execute on function public.ensure_current_user_workspace() from anon;
grant execute on function public.ensure_current_user_workspace() to authenticated;
