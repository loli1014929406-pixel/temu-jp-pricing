create or replace function private.assign_existing_user_membership_v2(
  p_email text,
  p_enterprise_id uuid,
  p_shop_id uuid,
  p_role text,
  p_permissions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_user_id uuid;
  v_enterprise_id uuid;
  v_permission record;
begin
  if auth.uid() is null
    or btrim(coalesce(p_email, '')) = ''
    or p_role not in ('enterprise_owner', 'shop_operator')
    or (p_role = 'enterprise_owner' and (p_enterprise_id is null or p_shop_id is not null))
    or (p_role = 'shop_operator' and p_shop_id is null)
  then
    raise exception using errcode = '22023', message = 'Email and a valid membership target are required.';
  end if;

  if p_role = 'enterprise_owner' then
    select enterprise.id
    into v_enterprise_id
    from public.enterprises enterprise
    where enterprise.id = p_enterprise_id
      and enterprise.status = 'active';
  else
    select shop.enterprise_id
    into v_enterprise_id
    from public.shops shop
    where shop.id = p_shop_id
      and shop.status = 'active'
      and (p_enterprise_id is null or shop.enterprise_id = p_enterprise_id);
  end if;

  if v_enterprise_id is null
    or not (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(v_enterprise_id)
    )
  then
    raise exception using errcode = '42501', message = 'Member management access denied.';
  end if;

  select users.id
  into v_user_id
  from auth.users users
  where lower(users.email) = lower(btrim(p_email))
  order by users.created_at, users.id
  limit 1;

  if v_user_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'The account does not exist yet. Ask the user to register first.';
  end if;

  if exists (
    select 1 from public.enterprise_members member
    where member.user_id = v_user_id
      and member.enterprise_id <> v_enterprise_id
      and member.status = 'active'
  ) or exists (
    select 1 from public.shop_operator_assignments assignment
    where assignment.user_id = v_user_id
      and assignment.enterprise_id <> v_enterprise_id
      and assignment.status = 'active'
  ) then
    raise exception using errcode = '23505', message = 'An account cannot belong to multiple enterprises.';
  end if;

  if p_role = 'enterprise_owner' then
    delete from public.shop_operator_permissions permission
    where permission.user_id = v_user_id;
    delete from public.shop_operator_assignments assignment
    where assignment.user_id = v_user_id;

    insert into public.enterprise_members (
      enterprise_id, user_id, role, status, created_by
    ) values (
      v_enterprise_id, v_user_id, 'enterprise_owner', 'active', auth.uid()
    ) on conflict (user_id) do update
      set enterprise_id = excluded.enterprise_id,
          role = excluded.role,
          status = 'active';
  else
    delete from public.enterprise_members member
    where member.user_id = v_user_id;

    insert into public.shop_operator_assignments (
      user_id, enterprise_id, shop_id, status, created_by
    ) values (
      v_user_id, v_enterprise_id, p_shop_id, 'active', auth.uid()
    ) on conflict (user_id) do update
      set enterprise_id = excluded.enterprise_id,
          shop_id = excluded.shop_id,
          status = 'active';

    delete from public.shop_operator_permissions permission
    where permission.user_id = v_user_id;

    if coalesce(jsonb_typeof(p_permissions), 'null') <> 'array' then
      raise exception using errcode = '22023', message = 'Permissions must be an array.';
    end if;

    for v_permission in
      select line.resource, line.action, coalesce(line.allowed, true) as allowed
      from jsonb_to_recordset(p_permissions)
        as line(resource text, action text, allowed boolean)
    loop
      if not exists (
        select 1 from public.permission_catalog catalog
        where catalog.resource = v_permission.resource
          and catalog.action = v_permission.action
      ) then
        raise exception using errcode = '22023', message = 'Unknown resource permission.';
      end if;

      insert into public.shop_operator_permissions (
        user_id, shop_id, resource, action, allowed, granted_by
      ) values (
        v_user_id, p_shop_id, v_permission.resource, v_permission.action,
        v_permission.allowed, auth.uid()
      );
    end loop;
  end if;

  return jsonb_build_object(
    'user_id', v_user_id,
    'enterprise_id', v_enterprise_id,
    'shop_id', case when p_role = 'shop_operator' then p_shop_id else null end,
    'role', p_role
  );
end
$function$;

create or replace function public.assign_existing_user_membership_v2(
  p_email text,
  p_enterprise_id uuid,
  p_shop_id uuid,
  p_role text,
  p_permissions jsonb default '[]'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.assign_existing_user_membership_v2(
    p_email, p_enterprise_id, p_shop_id, p_role, p_permissions
  )
$function$;

revoke all on function private.assign_existing_user_membership_v2(
  text, uuid, uuid, text, jsonb
) from public, anon;
revoke all on function public.assign_existing_user_membership_v2(
  text, uuid, uuid, text, jsonb
) from public, anon;

grant execute on function private.assign_existing_user_membership_v2(
  text, uuid, uuid, text, jsonb
) to authenticated;
grant execute on function public.assign_existing_user_membership_v2(
  text, uuid, uuid, text, jsonb
) to authenticated;
