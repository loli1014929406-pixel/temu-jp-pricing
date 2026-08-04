create or replace function private.create_enterprise(
  p_code text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_enterprise public.enterprises%rowtype;
begin
  if auth.uid() is null or not private.current_user_is_platform_owner() then
    raise exception using errcode = '42501', message = 'Platform owner access required.';
  end if;
  if btrim(coalesce(p_code, '')) = '' or btrim(coalesce(p_name, '')) = '' then
    raise exception using errcode = '22023', message = 'Enterprise code and name are required.';
  end if;
  insert into public.enterprises (code, name, created_by)
  values (btrim(p_code), btrim(p_name), auth.uid())
  returning * into v_enterprise;
  return to_jsonb(v_enterprise);
end
$function$;

create or replace function private.create_shop(
  p_enterprise_id uuid,
  p_code text,
  p_name text,
  p_platform text default 'temu'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_shop public.shops%rowtype;
begin
  if auth.uid() is null
    or not (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(p_enterprise_id)
    )
  then
    raise exception using errcode = '42501', message = 'Shop management access denied.';
  end if;
  if btrim(coalesce(p_code, '')) = '' or btrim(coalesce(p_name, '')) = '' then
    raise exception using errcode = '22023', message = 'Shop code and name are required.';
  end if;
  insert into public.shops (
    enterprise_id,
    code,
    name,
    platform,
    legacy_owner_id,
    created_by
  ) values (
    p_enterprise_id,
    btrim(p_code),
    btrim(p_name),
    coalesce(nullif(btrim(p_platform), ''), 'temu'),
    auth.uid(),
    auth.uid()
  ) returning * into v_shop;
  return to_jsonb(v_shop);
end
$function$;

create or replace function private.assign_existing_user_membership(
  p_email text,
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
  if auth.uid() is null or p_shop_id is null
    or p_role not in ('enterprise_owner', 'shop_operator')
  then
    raise exception using errcode = '22023', message = 'Email, shop and supported role are required.';
  end if;

  select shop.enterprise_id into v_enterprise_id
  from public.shops shop
  where shop.id = p_shop_id and shop.status = 'active';
  if v_enterprise_id is null
    or not (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(v_enterprise_id)
    )
  then
    raise exception using errcode = '42501', message = 'Member management access denied.';
  end if;

  select users.id into v_user_id
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
      enterprise_id,
      user_id,
      role,
      status,
      created_by
    ) values (
      v_enterprise_id,
      v_user_id,
      'enterprise_owner',
      'active',
      auth.uid()
    ) on conflict (user_id) do update
      set enterprise_id = excluded.enterprise_id,
          role = excluded.role,
          status = 'active';
  else
    delete from public.enterprise_members member
    where member.user_id = v_user_id;

    insert into public.shop_operator_assignments (
      user_id,
      enterprise_id,
      shop_id,
      status,
      created_by
    ) values (
      v_user_id,
      v_enterprise_id,
      p_shop_id,
      'active',
      auth.uid()
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
        user_id,
        shop_id,
        resource,
        action,
        allowed,
        granted_by
      ) values (
        v_user_id,
        p_shop_id,
        v_permission.resource,
        v_permission.action,
        v_permission.allowed,
        auth.uid()
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

create or replace function public.create_enterprise(p_code text, p_name text)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $function$
  select private.create_enterprise(p_code, p_name)
$function$;

create or replace function public.create_shop(
  p_enterprise_id uuid,
  p_code text,
  p_name text,
  p_platform text default 'temu'
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $function$
  select private.create_shop(p_enterprise_id, p_code, p_name, p_platform)
$function$;

create or replace function public.assign_existing_user_membership(
  p_email text,
  p_shop_id uuid,
  p_role text,
  p_permissions jsonb default '[]'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $function$
  select private.assign_existing_user_membership(
    p_email, p_shop_id, p_role, p_permissions
  )
$function$;

revoke all on function private.create_enterprise(text, text) from public, anon;
revoke all on function private.create_shop(uuid, text, text, text) from public, anon;
revoke all on function private.assign_existing_user_membership(text, uuid, text, jsonb)
  from public, anon;
revoke all on function public.create_enterprise(text, text) from public, anon;
revoke all on function public.create_shop(uuid, text, text, text) from public, anon;
revoke all on function public.assign_existing_user_membership(text, uuid, text, jsonb)
  from public, anon;
grant execute on function private.create_enterprise(text, text) to authenticated;
grant execute on function private.create_shop(uuid, text, text, text) to authenticated;
grant execute on function private.assign_existing_user_membership(text, uuid, text, jsonb)
  to authenticated;
grant execute on function public.create_enterprise(text, text) to authenticated;
grant execute on function public.create_shop(uuid, text, text, text) to authenticated;
grant execute on function public.assign_existing_user_membership(text, uuid, text, jsonb)
  to authenticated;
