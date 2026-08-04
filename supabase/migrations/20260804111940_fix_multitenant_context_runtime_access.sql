create or replace function private.current_permission_mode()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce((
    select state.permission_mode
    from private.multitenant_runtime_state state
    where state.id = true
  ), 'legacy')
$function$;

revoke all on function private.current_permission_mode() from public, anon;
grant execute on function private.current_permission_mode() to authenticated;

create or replace function public.current_multitenant_context()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'is_platform_owner', private.current_user_is_platform_owner(),
    'enterprise_owner_ids', coalesce((
      select jsonb_agg(member.enterprise_id order by member.enterprise_id)
      from public.enterprise_members member
      where member.user_id = (select auth.uid())
        and member.role = 'enterprise_owner'
        and member.status = 'active'
    ), '[]'::jsonb),
    'operator_shop_id', (
      select assignment.shop_id
      from public.shop_operator_assignments assignment
      where assignment.user_id = (select auth.uid())
        and assignment.status = 'active'
      limit 1
    ),
    'current_shop_id', private.current_context_shop_id(),
    'permission_mode', private.current_permission_mode()
  )
$function$;

revoke all on function public.current_multitenant_context() from public, anon;
grant execute on function public.current_multitenant_context() to authenticated;
