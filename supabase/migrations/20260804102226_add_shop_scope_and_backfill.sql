-- Expand the existing single-team model without changing any existing RLS
-- policy. All tenant columns remain nullable until the final hardening phase.

do $block$
declare
  v_table text;
  v_tables constant text[] := array[
    'finance_actual_shipping_fee_import_templates',
    'finance_actual_shipping_fees',
    'finance_expenses',
    'finance_first_leg_monthly_settlements',
    'finance_first_leg_payments',
    'finance_logistics_payments',
    'finance_logistics_settlements',
    'finance_settlement_files',
    'finance_settlement_records',
    'logistics_methods',
    'pricing_results',
    'pricing_settings',
    'product_items',
    'product_sku_items',
    'product_skus',
    'product_strategy_states',
    'product_warehouse_shipping_limits',
    'products',
    'profit_calculations',
    'purchase_order_items',
    'purchase_order_sources',
    'purchase_orders',
    'purchase_package_items',
    'purchase_packages',
    'shipping_batch_items',
    'shipping_batches',
    'strategy_rule_settings',
    'temu_order_combined_shipment_members',
    'temu_order_combined_shipments',
    'temu_order_file_import_templates',
    'temu_order_shipment_items',
    'temu_order_shipments',
    'temu_order_sku_inventory_reservations',
    'temu_order_split_events',
    'temu_orders',
    'warehouse_item_stock_adjustments',
    'warehouse_item_stocks',
    'warehouse_logistics_methods',
    'warehouse_products',
    'warehouse_sku_stock_adjustments',
    'warehouse_skus',
    'warehouses'
  ];
begin
  foreach v_table in array v_tables loop
    execute format(
      'alter table public.%I add column if not exists enterprise_id uuid',
      v_table
    );
    execute format(
      'alter table public.%I add column if not exists shop_id uuid',
      v_table
    );
  end loop;
end
$block$;

create table public.shop_order_auto_match_settings (
  enterprise_id uuid not null,
  shop_id uuid primary key,
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_order_auto_match_settings_scope_fkey
    foreign key (enterprise_id, shop_id)
    references public.shops(enterprise_id, id)
    on delete cascade
);

drop trigger if exists shop_order_auto_match_settings_set_updated_at
  on public.shop_order_auto_match_settings;
create trigger shop_order_auto_match_settings_set_updated_at
before update on public.shop_order_auto_match_settings
for each row execute function public.set_updated_at();

create or replace function private.current_session_id()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid
$function$;

create or replace function private.current_context_shop_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select context.shop_id
  from private.user_shop_contexts context
  where context.session_id = private.current_session_id()
    and context.user_id = (select auth.uid())
    and context.expires_at > statement_timestamp()
  limit 1
$function$;

create or replace function private.current_write_shop_id()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_shop_id uuid;
  v_shop_count integer;
  v_permission_mode text;
begin
  if auth.uid() is null then
    return null;
  end if;

  v_shop_id := private.current_context_shop_id();
  if v_shop_id is not null then
    return v_shop_id;
  end if;

  select state.permission_mode
  into v_permission_mode
  from private.multitenant_runtime_state state
  where state.id = true;

  if private.current_user_is_platform_owner()
    and v_permission_mode = 'tenant'
  then
    return null;
  end if;

  select assignment.shop_id
  into v_shop_id
  from public.shop_operator_assignments assignment
  where assignment.user_id = (select auth.uid())
    and assignment.status = 'active'
  limit 1;
  if v_shop_id is not null then
    return v_shop_id;
  end if;

  select (array_agg(shop.id order by shop.id))[1], count(*)::integer
  into v_shop_id, v_shop_count
  from public.enterprise_members member
  join public.shops shop
    on shop.enterprise_id = member.enterprise_id
   and shop.status = 'active'
  where member.user_id = (select auth.uid())
    and member.role = 'enterprise_owner'
    and member.status = 'active';

  if v_shop_count = 1 then
    return v_shop_id;
  end if;
  return null;
end
$function$;

create or replace function private.enforce_row_shop_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_enterprise_id uuid;
  v_shop_id uuid;
begin
  if tg_op = 'UPDATE'
    and old.shop_id is not null
    and (
      new.shop_id is distinct from old.shop_id
      or new.enterprise_id is distinct from old.enterprise_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'A business row cannot be moved to another shop.';
  end if;

  v_shop_id := new.shop_id;
  if v_shop_id is null then
    v_shop_id := private.current_write_shop_id();
  end if;
  if v_shop_id is null then
    raise exception using
      errcode = '42501',
      message = 'Select a shop context before writing business data.';
  end if;

  select shop.enterprise_id
  into v_enterprise_id
  from public.shops shop
  where shop.id = v_shop_id
    and shop.status = 'active';
  if v_enterprise_id is null then
    raise exception using
      errcode = '23503',
      message = 'The selected shop does not exist or is inactive.';
  end if;
  if new.enterprise_id is not null
    and new.enterprise_id <> v_enterprise_id
  then
    raise exception using
      errcode = '23514',
      message = 'The enterprise and shop scope do not match.';
  end if;

  new.enterprise_id := v_enterprise_id;
  new.shop_id := v_shop_id;
  return new;
end
$function$;

create or replace function private.current_shop_legacy_owner_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select shop.legacy_owner_id
  from public.shops shop
  where shop.id = private.current_write_shop_id()
    and shop.status = 'active'
  limit 1
$function$;

create or replace function private.set_current_shop_context(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := private.current_session_id();
  v_enterprise_id uuid;
begin
  if v_user_id is null or v_session_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  select shop.enterprise_id
  into v_enterprise_id
  from public.shops shop
  where shop.id = p_shop_id
    and shop.status = 'active';

  if v_enterprise_id is null
    or not (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(v_enterprise_id)
      or private.current_user_is_shop_operator(p_shop_id)
    )
  then
    raise exception using errcode = '42501', message = 'Shop access denied.';
  end if;

  insert into private.user_shop_contexts (
    session_id,
    user_id,
    enterprise_id,
    shop_id,
    entered_at,
    expires_at
  ) values (
    v_session_id,
    v_user_id,
    v_enterprise_id,
    p_shop_id,
    statement_timestamp(),
    statement_timestamp() + interval '12 hours'
  )
  on conflict (session_id) do update
  set user_id = excluded.user_id,
      enterprise_id = excluded.enterprise_id,
      shop_id = excluded.shop_id,
      entered_at = excluded.entered_at,
      expires_at = excluded.expires_at;

  return jsonb_build_object(
    'enterprise_id', v_enterprise_id,
    'shop_id', p_shop_id,
    'expires_at', statement_timestamp() + interval '12 hours'
  );
end
$function$;

create or replace function private.clear_current_shop_context()
returns void
language sql
volatile
security definer
set search_path = pg_catalog
as $function$
  delete from private.user_shop_contexts context
  where context.session_id = private.current_session_id()
    and context.user_id = (select auth.uid())
$function$;

create or replace function public.set_current_shop_context(p_shop_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.set_current_shop_context(p_shop_id)
$function$;

create or replace function public.clear_current_shop_context()
returns void
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.clear_current_shop_context()
$function$;

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
    'permission_mode', (
      select state.permission_mode
      from private.multitenant_runtime_state state
      where state.id = true
    )
  )
$function$;

revoke all on function private.current_session_id() from public, anon;
revoke all on function private.current_context_shop_id() from public, anon;
revoke all on function private.current_write_shop_id() from public, anon;
revoke all on function private.enforce_row_shop_scope() from public, anon;
revoke all on function private.current_shop_legacy_owner_id() from public, anon;
revoke all on function private.set_current_shop_context(uuid) from public, anon;
revoke all on function private.clear_current_shop_context() from public, anon;
revoke all on function public.set_current_shop_context(uuid) from public, anon;
revoke all on function public.clear_current_shop_context() from public, anon;
revoke all on function public.current_multitenant_context() from public, anon;
grant execute on function private.current_session_id() to authenticated;
grant execute on function private.current_context_shop_id() to authenticated;
grant execute on function private.current_write_shop_id() to authenticated;
grant execute on function private.current_shop_legacy_owner_id() to authenticated;
grant execute on function private.set_current_shop_context(uuid) to authenticated;
grant execute on function private.clear_current_shop_context() to authenticated;
grant execute on function public.set_current_shop_context(uuid) to authenticated;
grant execute on function public.clear_current_shop_context() to authenticated;
grant execute on function public.current_multitenant_context() to authenticated;

-- Legacy pricing settings were user-scoped, so a single existing shop may
-- have more than one row. Preserve every original row in the private schema
-- before selecting the admin-owned row as the shop-level canonical settings.
create table if not exists private.pricing_settings_legacy_user_backup (
  source_id uuid primary key,
  source_owner_id uuid,
  source_row jsonb not null,
  archived_at timestamptz not null default now()
);

revoke all on table private.pricing_settings_legacy_user_backup
  from public, anon, authenticated;

do $block$
declare
  v_enterprise_id uuid;
  v_shop_id uuid;
  v_admin_id uuid;
  v_table text;
  v_tables constant text[] := array[
    'finance_actual_shipping_fee_import_templates',
    'finance_actual_shipping_fees',
    'finance_expenses',
    'finance_first_leg_monthly_settlements',
    'finance_first_leg_payments',
    'finance_logistics_payments',
    'finance_logistics_settlements',
    'finance_settlement_files',
    'finance_settlement_records',
    'logistics_methods',
    'pricing_results',
    'pricing_settings',
    'product_items',
    'product_sku_items',
    'product_skus',
    'product_strategy_states',
    'product_warehouse_shipping_limits',
    'products',
    'profit_calculations',
    'purchase_order_items',
    'purchase_order_sources',
    'purchase_orders',
    'purchase_package_items',
    'purchase_packages',
    'shipping_batch_items',
    'shipping_batches',
    'strategy_rule_settings',
    'temu_order_combined_shipment_members',
    'temu_order_combined_shipments',
    'temu_order_file_import_templates',
    'temu_order_shipment_items',
    'temu_order_shipments',
    'temu_order_sku_inventory_reservations',
    'temu_order_split_events',
    'temu_orders',
    'warehouse_item_stock_adjustments',
    'warehouse_item_stocks',
    'warehouse_logistics_methods',
    'warehouse_products',
    'warehouse_sku_stock_adjustments',
    'warehouse_skus',
    'warehouses'
  ];
begin
  select users.id
  into v_admin_id
  from auth.users users
  join public.account_permissions permission
    on lower(permission.email) = lower(users.email)
  where permission.permission_level = 'admin'
  order by users.created_at, users.id
  limit 1;

  insert into private.pricing_settings_legacy_user_backup (
    source_id,
    source_owner_id,
    source_row
  )
  select settings.id, settings.owner_id, to_jsonb(settings)
  from public.pricing_settings settings
  on conflict (source_id) do nothing;

  -- Keep every legacy user-scoped settings row active while permission_mode is
  -- still legacy. The atomic cutover selects one canonical row per shop only
  -- after the compatible frontend and all pre-cutover checks are in place.

  insert into public.enterprises (code, name, created_by)
  values ('enterprise-1', '企业1', v_admin_id)
  on conflict (code) do update set name = excluded.name
  returning id into v_enterprise_id;

  insert into public.shops (
    enterprise_id,
    code,
    name,
    platform,
    legacy_owner_id,
    created_by
  )
  values (
    v_enterprise_id,
    'shop-1',
    '店铺1（现有网站）',
    'temu',
    v_admin_id,
    v_admin_id
  )
  on conflict (enterprise_id, code) do update
  set name = excluded.name,
      legacy_owner_id = coalesce(public.shops.legacy_owner_id, excluded.legacy_owner_id)
  returning id into v_shop_id;

  insert into public.platform_members (user_id, created_by)
  select users.id, v_admin_id
  from auth.users users
  join public.account_permissions permission
    on lower(permission.email) = lower(users.email)
  where permission.permission_level = 'admin'
  on conflict (user_id) do nothing;

  insert into public.enterprise_members (
    enterprise_id,
    user_id,
    role,
    created_by
  )
  select v_enterprise_id, users.id, 'enterprise_owner', v_admin_id
  from auth.users users
  join public.account_permissions permission
    on lower(permission.email) = lower(users.email)
  where permission.permission_level = 'admin'
  on conflict (user_id) do update
  set enterprise_id = excluded.enterprise_id,
      role = excluded.role,
      status = 'active';

  insert into public.shop_operator_assignments (
    user_id,
    enterprise_id,
    shop_id,
    created_by
  )
  select users.id, v_enterprise_id, v_shop_id, v_admin_id
  from auth.users users
  join public.account_permissions permission
    on lower(permission.email) = lower(users.email)
  where permission.permission_level in ('editor', 'viewer')
  on conflict (user_id) do update
  set enterprise_id = excluded.enterprise_id,
      shop_id = excluded.shop_id,
      status = 'active';

  insert into public.shop_operator_permissions (
    user_id,
    shop_id,
    resource,
    action,
    allowed,
    granted_by
  )
  select
    users.id,
    v_shop_id,
    catalog.resource,
    catalog.action,
    true,
    v_admin_id
  from auth.users users
  join public.account_permissions permission
    on lower(permission.email) = lower(users.email)
  cross join public.permission_catalog catalog
  where (
      permission.permission_level = 'editor'
      and catalog.resource not in ('shops', 'members', 'diagnostics')
      and catalog.action <> 'delete'
    )
    or (
      permission.permission_level = 'viewer'
      and catalog.resource not in ('shops', 'members', 'diagnostics')
      and catalog.action = 'view'
    )
  on conflict (user_id, shop_id, resource, action) do update
  set allowed = excluded.allowed,
      granted_by = excluded.granted_by;

  foreach v_table in array v_tables loop
    -- Build the non-unique lookup index before the backfill. Several shipment
    -- tables have deferred constraint triggers; creating an index after their
    -- rows have been updated in the same transaction is rejected by Postgres
    -- while those trigger events are still pending.
    execute format(
      'create index if not exists %I on public.%I (shop_id)',
      'mt_' || substr(md5(v_table), 1, 12) || '_shop_idx',
      v_table
    );

    execute format(
      'update public.%I set enterprise_id = $1, shop_id = $2 where enterprise_id is null or shop_id is null',
      v_table
    ) using v_enterprise_id, v_shop_id;

    execute format(
      'drop trigger if exists multitenant_fill_shop_scope on public.%I',
      v_table
    );
    execute format(
      'create trigger multitenant_fill_shop_scope before insert or update of enterprise_id, shop_id on public.%I for each row execute function private.enforce_row_shop_scope()',
      v_table
    );
  end loop;

  insert into public.shop_order_auto_match_settings (
    enterprise_id,
    shop_id,
    enabled,
    updated_by
  )
  select v_enterprise_id, v_shop_id, settings.enabled, settings.updated_by
  from public.order_auto_match_settings settings
  where settings.id = true
  on conflict (shop_id) do update
  set enabled = excluded.enabled,
      updated_by = excluded.updated_by;
end
$block$;

-- Flush deferred foreign-key checks created by the backfill before building
-- the tenant-native unique indexes below. This keeps the whole migration
-- atomic while avoiding CREATE INDEX against tables with pending events.
set constraints all immediate;

-- Build the tenant-native uniqueness rules while keeping the legacy owner/user
-- constraints in place until the atomic permission cutover. NULL shop values
-- remain compatible during expansion, while full unique indexes can be inferred
-- by PostgREST ON CONFLICT calls during the dual-model period.
create unique index if not exists products_shop_code_unique
  on public.products (shop_id, product_code);
create unique index if not exists product_strategy_states_shop_product_unique
  on public.product_strategy_states (shop_id, product_id);
create unique index if not exists shipping_batches_shop_code_unique
  on public.shipping_batches (shop_id, batch_code);
create unique index if not exists strategy_rule_settings_shop_phase_unique
  on public.strategy_rule_settings (shop_id, phase);
create unique index if not exists temu_orders_shop_order_sub_order_unique
  on public.temu_orders (shop_id, order_no, sub_order_no);
create unique index if not exists finance_actual_shipping_fees_shop_tracking_unique
  on public.finance_actual_shipping_fees (
    shop_id,
    logistics_method_id,
    logistics_tracking_no
  );
create unique index if not exists finance_first_leg_settlements_shop_month_unique
  on public.finance_first_leg_monthly_settlements (shop_id, shipping_month);
create unique index if not exists finance_first_leg_payments_shop_request_unique
  on public.finance_first_leg_payments (shop_id, request_key);
create unique index if not exists finance_logistics_payments_shop_request_unique
  on public.finance_logistics_payments (shop_id, request_key);
create unique index if not exists finance_logistics_settlements_shop_carrier_month_unique
  on public.finance_logistics_settlements (shop_id, carrier, shipping_month);
create unique index if not exists finance_logistics_settlements_shop_method_month_unique
  on public.finance_logistics_settlements (
    shop_id,
    logistics_method_id,
    shipping_month
  );
create unique index if not exists finance_actual_shipping_fee_templates_shop_name_uidx
  on public.finance_actual_shipping_fee_import_templates (
    shop_id,
    lower(btrim(name))
  )
  where deleted_at is null;
create unique index if not exists finance_actual_shipping_fee_templates_shop_system_uidx
  on public.finance_actual_shipping_fee_import_templates (shop_id, system_key)
  where btrim(system_key) <> '';
create unique index if not exists temu_order_file_import_templates_shop_name_uidx
  on public.temu_order_file_import_templates (
    shop_id,
    import_type,
    lower(btrim(name))
  )
  where deleted_at is null;
create unique index if not exists temu_order_file_import_templates_shop_system_uidx
  on public.temu_order_file_import_templates (shop_id, import_type, system_key)
  where btrim(system_key) <> '';

alter table public.shop_order_auto_match_settings enable row level security;

create policy shop_order_auto_match_settings_select_authorized
on public.shop_order_auto_match_settings for select to authenticated
using (private.current_user_can_view_shop(shop_id));

revoke all on table public.shop_order_auto_match_settings from public, anon;
grant select on table public.shop_order_auto_match_settings to authenticated;
