-- This final migration is the database half of the controlled cutover. It is kept as
-- a separate final migration so all expansion/backfill/frontend work can be
-- deployed and verified first. PostgreSQL applies the policy replacement and
-- runtime-mode flip in one transaction.

create or replace function private.current_user_can_read_shop(
  p_shop_id uuid,
  p_resource text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_context_shop_id uuid;
  v_enterprise_id uuid;
begin
  if auth.uid() is null or p_shop_id is null then
    return false;
  end if;

  v_context_shop_id := private.current_context_shop_id();

  if private.current_user_is_platform_owner() then
    return v_context_shop_id is null or v_context_shop_id = p_shop_id;
  end if;

  select shop.enterprise_id into v_enterprise_id
  from public.shops shop
  where shop.id = p_shop_id and shop.status = 'active';
  if v_enterprise_id is null then
    return false;
  end if;

  if private.current_user_is_enterprise_owner(v_enterprise_id) then
    return v_context_shop_id is null or v_context_shop_id = p_shop_id;
  end if;

  return private.current_user_has_shop_action(p_shop_id, p_resource, 'view');
end
$function$;

revoke all on function private.current_user_can_read_shop(uuid, text)
  from public, anon;
grant execute on function private.current_user_can_read_shop(uuid, text)
  to authenticated;

create or replace function private.enforce_finance_legacy_partition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_mode text;
  v_owner_id uuid;
begin
  select state.permission_mode into v_mode
  from private.multitenant_runtime_state state where state.id = true;
  if v_mode <> 'tenant' then
    return new;
  end if;

  select shop.legacy_owner_id into v_owner_id
  from public.shops shop where shop.id = new.shop_id;
  if v_owner_id is null then
    raise exception using
      errcode = '23514',
      message = 'The shop has no legacy finance partition owner.';
  end if;
  new.user_id := v_owner_id;
  return new;
end
$function$;

revoke all on function private.enforce_finance_legacy_partition()
  from public, anon;

-- Transitional compatibility for older invoker RPCs that still call the
-- page-era edit predicate. Exact authorization remains enforced by the new
-- resource/action RLS policies on every row they touch.
create or replace function public.current_account_can_edit()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  with selected_shop as (
    select private.current_write_shop_id() as shop_id
  )
  select exists (
    select 1
    from selected_shop
    where shop_id is not null
      and (
        private.current_user_is_platform_owner()
        or exists (
          select 1
          from public.shops shop
          where shop.id = selected_shop.shop_id
            and private.current_user_is_enterprise_owner(shop.enterprise_id)
        )
        or exists (
          select 1
          from public.shop_operator_permissions permission
          where permission.user_id = (select auth.uid())
            and permission.shop_id = selected_shop.shop_id
            and permission.allowed
            and permission.action <> 'view'
        )
      )
  )
$function$;

revoke all on function public.current_account_can_edit() from public, anon;
grant execute on function public.current_account_can_edit() to authenticated;

create or replace function public.current_account_permission()
returns text
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select case
    when private.current_user_is_platform_owner() then 'admin'
    when exists (
      select 1 from public.enterprise_members member
      where member.user_id = (select auth.uid())
        and member.role = 'enterprise_owner'
        and member.status = 'active'
    ) then 'admin'
    when exists (
      select 1 from public.shop_operator_assignments assignment
      where assignment.user_id = (select auth.uid())
        and assignment.status = 'active'
    ) then 'editor'
    else 'viewer'
  end
$function$;

create or replace function public.current_account_can_delete()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  with selected_shop as (
    select private.current_write_shop_id() as shop_id
  )
  select exists (
    select 1
    from selected_shop
    where shop_id is not null
      and (
        private.current_user_is_platform_owner()
        or exists (
          select 1 from public.shops shop
          where shop.id = selected_shop.shop_id
            and private.current_user_is_enterprise_owner(shop.enterprise_id)
        )
        or exists (
          select 1 from public.shop_operator_permissions permission
          where permission.user_id = (select auth.uid())
            and permission.shop_id = selected_shop.shop_id
            and permission.allowed
            and permission.action = 'delete'
        )
      )
  )
$function$;

revoke all on function public.current_account_permission() from public, anon;
revoke all on function public.current_account_can_delete() from public, anon;
grant execute on function public.current_account_permission() to authenticated;
grant execute on function public.current_account_can_delete() to authenticated;

do $identity_policies$
declare
  v_policy record;
begin
  for v_policy in
    select policyname from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'account_permissions'
  loop
    execute format(
      'drop policy if exists %I on public.account_permissions',
      v_policy.policyname
    );
  end loop;
  create policy mt_select on public.account_permissions
    for select to authenticated
    using (
      private.current_user_is_platform_owner()
      or lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    );
  create policy mt_insert on public.account_permissions
    for insert to authenticated
    with check (private.current_user_is_platform_owner());
  create policy mt_update on public.account_permissions
    for update to authenticated
    using (private.current_user_is_platform_owner())
    with check (private.current_user_is_platform_owner());
  create policy mt_delete on public.account_permissions
    for delete to authenticated
    using (private.current_user_is_platform_owner());

  for v_policy in
    select policyname from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'account_profiles'
  loop
    execute format(
      'drop policy if exists %I on public.account_profiles',
      v_policy.policyname
    );
  end loop;
  create policy mt_select on public.account_profiles
    for select to authenticated
    using (
      owner_id = (select auth.uid())
      or private.current_user_is_platform_owner()
      or exists (
        select 1
        from public.enterprise_members visible_owner
        join public.enterprise_members current_owner
          on current_owner.enterprise_id = visible_owner.enterprise_id
        where visible_owner.user_id = account_profiles.owner_id
          and visible_owner.status = 'active'
          and current_owner.user_id = (select auth.uid())
          and current_owner.role = 'enterprise_owner'
          and current_owner.status = 'active'
      )
      or exists (
        select 1
        from public.shop_operator_assignments visible_operator
        where visible_operator.user_id = account_profiles.owner_id
          and visible_operator.status = 'active'
          and (
            private.current_user_is_enterprise_owner(visible_operator.enterprise_id)
            or exists (
              select 1 from public.shop_operator_assignments current_operator
              where current_operator.user_id = (select auth.uid())
                and current_operator.shop_id = visible_operator.shop_id
                and current_operator.status = 'active'
            )
          )
      )
    );
  create policy mt_insert on public.account_profiles
    for insert to authenticated
    with check (owner_id = (select auth.uid()));
  create policy mt_update on public.account_profiles
    for update to authenticated
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()));
end
$identity_policies$;

do $finance_functions$
declare
  v_expected record;
  v_oid oid;
  v_definition text;
begin
  -- Preserve every existing finance formula verbatim. Only the legacy
  -- auth.uid() partition key and ON CONFLICT keys are mechanically replaced.
  -- The MD5 precondition makes any production drift abort the entire cutover.
  for v_expected in
    select * from (values
      ('ensure_actual_shipping_fee_default_templates()', 'fe60d87a47359fdcc1d18c1c8ea3070c', 'finance', 'create'),
      ('ensure_shipping_export_default_template()', '6acd1e238374689fc2c41d68474b4096', 'orders', 'import'),
      ('ensure_temu_order_file_import_default_templates()', '764988314df238d2f319aeec940d6938', 'orders', 'import'),
      ('get_actual_shipping_fee_report_v2(integer,integer,text,uuid,text)', '421d592182a8e14aaacfe6a5f8caada1', 'finance', 'view'),
      ('get_finance_ledger_page(integer,integer,text,text)', 'e3f72c4265524c92e2c47195bdcb6827', 'finance', 'view'),
      ('get_finance_logistics_cash_summary()', '76281be0481df4d37b5f67e784dff5b3', 'finance', 'view'),
      ('get_finance_order_metrics()', 'b278fcca445df8723e5af4c8649b2eaf', 'finance', 'view'),
      ('get_finance_settlement_records_page(uuid,integer,integer,text)', '461c86985d0ea262e48f5582f12f6d49', 'finance', 'view'),
      ('get_finance_settlement_summary()', '60dc6360285d61567be27ca9f95e683d', 'finance', 'view'),
      ('get_first_leg_monthly_settlements()', '2adfb499b40ceeff982f81da40d04019', 'finance', 'view'),
      ('get_first_leg_payment_records(text)', 'b741aa968ef0bd2bb0a3522f5e7ab74c', 'finance', 'view'),
      ('get_logistics_payment_records_v2(uuid,text)', '80fca7a46f130855bf71b0ceaaf7990e', 'finance', 'view'),
      ('import_actual_shipping_fees_v2(text,uuid,jsonb)', '50eacaa739782219669e8bb5be772016', 'finance', 'create'),
      ('import_finance_settlement_atomic(text,timestamp with time zone,numeric,numeric,numeric,jsonb)', '2a9469b5ac6873c5ef735b550aa6a32f', 'finance', 'create'),
      ('preview_actual_shipping_fee_import_v2(jsonb)', '7b90076da71a1a9392973a3cf93f1a21', 'finance', 'view'),
      ('record_first_leg_payment(text,numeric,timestamp with time zone,text,uuid)', 'bf920d796d473ccdeb9bdbc949b830cc', 'finance', 'create'),
      ('record_logistics_payment_v2(uuid,text,numeric,timestamp with time zone,text,uuid)', 'a6a0beb2681fea9d8c7d2dad095d26dc', 'finance', 'create'),
      ('save_first_leg_monthly_actual(text,numeric,numeric)', '606df2ec97c83e9a8faf1b1ed5168c8d', 'finance', 'update'),
      ('void_first_leg_payment(uuid,text)', '6d47127e96f00e27ab9995299681aad7', 'finance', 'delete'),
      ('void_logistics_payment(uuid,text)', '7b2e50b1917cbe7b8ac15b3a3114268c', 'finance', 'delete')
    ) as expected(signature, definition_md5, resource, action)
  loop
    v_oid := to_regprocedure(v_expected.signature);
    if v_oid is null then
      raise exception using
        errcode = '42883',
        message = 'Multitenant cutover blocked: missing finance function ' || v_expected.signature;
    end if;
    v_definition := pg_get_functiondef(v_oid);
    if md5(v_definition) <> v_expected.definition_md5 then
      raise exception using
        errcode = '55000',
        message = 'Multitenant cutover blocked: finance function drifted: ' || v_expected.signature;
    end if;

    v_definition := replace(
      v_definition,
      'auth.uid()',
      'private.current_shop_legacy_owner_id()'
    );
    v_definition := replace(
      v_definition,
      'public.current_account_can_edit()',
      format(
        'public.current_account_can(%L, %L)',
        v_expected.resource,
        v_expected.action
      )
    );
    v_definition := replace(
      v_definition,
      'current_account_can_edit()',
      format(
        'public.current_account_can(%L, %L)',
        v_expected.resource,
        v_expected.action
      )
    );
    v_definition := replace(
      v_definition,
      'on conflict (user_id, logistics_method_id, logistics_tracking_no)',
      'on conflict (shop_id, logistics_method_id, logistics_tracking_no)'
    );
    v_definition := replace(
      v_definition,
      'on conflict (user_id, logistics_method_id, shipping_month)',
      'on conflict (shop_id, logistics_method_id, shipping_month)'
    );
    v_definition := replace(
      v_definition,
      'on conflict (user_id, shipping_month)',
      'on conflict (shop_id, shipping_month)'
    );
    execute v_definition;
  end loop;
end
$finance_functions$;

-- This template RPC is introduced by a repository migration immediately
-- before the multitenant series, so it is safe to transform without a
-- production MD5 baseline. Its data becomes shop-owned through the canonical
-- compatibility owner while RLS supplies the actual authorization boundary.
do $temu_upload_template$
declare
  v_oid oid := to_regprocedure('public.ensure_temu_upload_export_default_template()');
  v_definition text;
begin
  if v_oid is not null then
    v_definition := pg_get_functiondef(v_oid);
    v_definition := replace(
      v_definition,
      'auth.uid()',
      'private.current_shop_legacy_owner_id()'
    );
    v_definition := replace(
      v_definition,
      'public.current_account_can_edit()',
      'public.current_account_can(''orders'', ''import'')'
    );
    execute v_definition;
  end if;
end
$temu_upload_template$;

do $finance_partition$
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
    'finance_settlement_records'
  ];
begin
  foreach v_table in array v_tables loop
    execute format(
      'update public.%I row set user_id = shop.legacy_owner_id from public.shops shop where row.shop_id = shop.id and row.user_id is distinct from shop.legacy_owner_id',
      v_table
    );
    execute format(
      'drop trigger if exists multitenant_finance_partition on public.%I',
      v_table
    );
    execute format(
      'create trigger multitenant_finance_partition before insert or update of user_id, shop_id on public.%I for each row execute function private.enforce_finance_legacy_partition()',
      v_table
    );
  end loop;
end
$finance_partition$;

do $preflight$
declare
  v_table text;
  v_missing bigint;
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
      'select count(*) from public.%I where enterprise_id is null or shop_id is null',
      v_table
    ) into v_missing;
    if v_missing <> 0 then
      raise exception using
        errcode = '23514',
        message = format(
          'Multitenant cutover blocked: %s has %s unscoped rows.',
          v_table,
          v_missing
        );
    end if;
  end loop;

  if exists (
    select 1
    from public.temu_order_sku_inventory_reservations reservation
    where not (
      (
        reservation.warehouse_sku_id is not null
        and reservation.shared_inventory_balance_id is null
        and reservation.shared_inventory_group_member_id is null
        and reservation.quantity_base_units is null
      )
      or
      (
        reservation.warehouse_sku_id is null
        and reservation.shared_inventory_balance_id is not null
        and reservation.shared_inventory_group_member_id is not null
        and reservation.quantity_base_units > 0
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Multitenant cutover blocked: an inventory reservation has an invalid target.';
  end if;

  if exists (
    select 1 from public.shops shop
    where shop.status = 'active' and shop.legacy_owner_id is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Multitenant cutover blocked: an active shop has no compatibility owner.';
  end if;
end
$preflight$;

do $policies$
declare
  v_rule record;
  v_policy record;
begin
  for v_rule in
    select * from (values
      ('products', 'products', 'create', 'update', 'delete'),
      ('product_items', 'products', 'create', 'update', 'delete'),
      ('product_skus', 'products', 'create', 'update', 'delete'),
      ('product_sku_items', 'products', 'create', 'update', 'delete'),
      ('product_warehouse_shipping_limits', 'products', 'update', 'update', 'update'),
      ('pricing_results', 'pricing', 'update', 'update', 'update'),
      ('profit_calculations', 'pricing', 'update', 'update', 'update'),
      ('product_strategy_states', 'pricing', 'update', 'update', 'update'),
      ('warehouses', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('warehouse_products', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('warehouse_skus', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('warehouse_sku_stock_adjustments', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('warehouse_item_stocks', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('warehouse_item_stock_adjustments', 'inventory', 'adjust', 'adjust', 'adjust'),
      ('purchase_orders', 'purchases', 'create', 'update', 'delete'),
      ('purchase_order_items', 'purchases', 'create', 'update', 'delete'),
      ('purchase_order_sources', 'purchases', 'create', 'update', 'delete'),
      ('purchase_packages', 'purchases', 'create', 'update', 'delete'),
      ('purchase_package_items', 'purchases', 'create', 'update', 'delete'),
      ('temu_orders', 'orders', 'import', 'update', 'delete'),
      ('temu_order_shipments', 'orders', 'import', 'update', 'delete'),
      ('temu_order_shipment_items', 'orders', 'import', 'update', 'delete'),
      ('temu_order_sku_inventory_reservations', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('temu_order_split_events', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('temu_order_combined_shipments', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('temu_order_combined_shipment_members', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('temu_order_file_import_templates', 'orders', 'import', 'import', 'import'),
      ('shipping_batches', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('shipping_batch_items', 'orders', 'fulfill', 'fulfill', 'fulfill'),
      ('finance_actual_shipping_fee_import_templates', 'finance', 'create', 'update', 'delete'),
      ('finance_actual_shipping_fees', 'finance', 'create', 'update', 'delete'),
      ('finance_expenses', 'finance', 'create', 'update', 'delete'),
      ('finance_first_leg_monthly_settlements', 'finance', 'create', 'update', 'delete'),
      ('finance_first_leg_payments', 'finance', 'create', 'update', 'delete'),
      ('finance_logistics_payments', 'finance', 'create', 'update', 'delete'),
      ('finance_logistics_settlements', 'finance', 'create', 'update', 'delete'),
      ('finance_settlement_files', 'finance', 'create', 'update', 'delete'),
      ('finance_settlement_records', 'finance', 'create', 'update', 'delete'),
      ('pricing_settings', 'settings', 'update', 'update', 'update'),
      ('logistics_methods', 'settings', 'update', 'update', 'update'),
      ('warehouse_logistics_methods', 'settings', 'update', 'update', 'update'),
      ('strategy_rule_settings', 'settings', 'update', 'update', 'update')
    ) as rules(table_name, resource, insert_action, update_action, delete_action)
  loop
    for v_policy in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = v_rule.table_name
    loop
      execute format(
        'drop policy if exists %I on public.%I',
        v_policy.policyname,
        v_rule.table_name
      );
    end loop;

    execute format(
      'create policy mt_select on public.%I for select to authenticated using (private.current_user_can_read_shop(shop_id, %L))',
      v_rule.table_name,
      v_rule.resource
    );
    execute format(
      'create policy mt_insert on public.%I for insert to authenticated with check (private.current_user_has_shop_action(shop_id, %L, %L))',
      v_rule.table_name,
      v_rule.resource,
      v_rule.insert_action
    );
    execute format(
      'create policy mt_update on public.%I for update to authenticated using (private.current_user_has_shop_action(shop_id, %L, %L)) with check (private.current_user_has_shop_action(shop_id, %L, %L))',
      v_rule.table_name,
      v_rule.resource,
      v_rule.update_action,
      v_rule.resource,
      v_rule.update_action
    );
    execute format(
      'create policy mt_delete on public.%I for delete to authenticated using (private.current_user_has_shop_action(shop_id, %L, %L))',
      v_rule.table_name,
      v_rule.resource,
      v_rule.delete_action
    );
  end loop;

  for v_policy in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'shop_order_auto_match_settings'
  loop
    execute format(
      'drop policy if exists %I on public.shop_order_auto_match_settings',
      v_policy.policyname
    );
  end loop;
  create policy mt_select on public.shop_order_auto_match_settings
    for select to authenticated
    using (private.current_user_can_read_shop(shop_id, 'settings'));
  create policy mt_insert on public.shop_order_auto_match_settings
    for insert to authenticated
    with check (private.current_user_has_shop_action(shop_id, 'settings', 'update'));
  create policy mt_update on public.shop_order_auto_match_settings
    for update to authenticated
    using (private.current_user_has_shop_action(shop_id, 'settings', 'update'))
    with check (private.current_user_has_shop_action(shop_id, 'settings', 'update'));
  create policy mt_delete on public.shop_order_auto_match_settings
    for delete to authenticated
    using (private.current_user_has_shop_action(shop_id, 'settings', 'update'));
end
$policies$;

do $shared_inventory_read_policies$
declare
  v_table text;
  v_policy record;
begin
  foreach v_table in array array[
    'stock_locations',
    'shared_inventory_groups',
    'shared_inventory_group_members',
    'shared_inventory_balances',
    'shared_inventory_adjustments',
    'shared_inventory_membership_operations',
    'shared_inventory_membership_operation_lines'
  ]
  loop
    for v_policy in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = v_table
    loop
      execute format('drop policy if exists %I on public.%I', v_policy.policyname, v_table);
    end loop;
  end loop;

  create policy mt_select on public.stock_locations
    for select to authenticated
    using (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(enterprise_id)
      or exists (
        select 1 from public.warehouses warehouse
        where warehouse.stock_location_id = stock_locations.id
          and private.current_user_can_read_shop(warehouse.shop_id, 'inventory')
      )
    );
  create policy mt_select on public.shared_inventory_groups
    for select to authenticated
    using (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(enterprise_id)
      or exists (
        select 1 from public.shared_inventory_group_members member
        where member.group_id = shared_inventory_groups.id
          and member.left_at is null
          and private.current_user_can_read_shop(member.shop_id, 'inventory')
      )
    );
  create policy mt_select on public.shared_inventory_group_members
    for select to authenticated
    using (private.current_user_can_read_shop(shop_id, 'inventory'));
  create policy mt_select on public.shared_inventory_balances
    for select to authenticated
    using (
      exists (
        select 1 from public.shared_inventory_group_members member
        where member.group_id = shared_inventory_balances.group_id
          and member.left_at is null
          and private.current_user_can_read_shop(member.shop_id, 'inventory')
      )
    );
  create policy mt_select on public.shared_inventory_adjustments
    for select to authenticated
    using (
      case
        when shop_id is not null
          then private.current_user_can_read_shop(shop_id, 'inventory')
        else private.current_user_is_platform_owner()
          or private.current_user_is_enterprise_owner(enterprise_id)
      end
    );
  create policy mt_select on public.shared_inventory_membership_operations
    for select to authenticated
    using (private.current_user_can_read_shop(shop_id, 'inventory'));
  create policy mt_select on public.shared_inventory_membership_operation_lines
    for select to authenticated
    using (
      exists (
        select 1 from public.shared_inventory_membership_operations operation
        where operation.id = shared_inventory_membership_operation_lines.operation_id
          and private.current_user_can_read_shop(operation.shop_id, 'inventory')
      )
    );
end
$shared_inventory_read_policies$;

alter table public.temu_order_sku_inventory_reservations
  validate constraint temu_order_inventory_reservation_target_check;
alter table public.warehouses
  validate constraint warehouses_stock_location_fkey;

drop index if exists public.idx_temu_orders_team_order_line;
drop index if exists public.logistics_methods_name_unique;
alter table public.purchase_orders
  drop constraint if exists purchase_orders_order_code_key;
drop index if exists public.temu_order_shipments_order_package_uidx;
drop index if exists public.temu_order_combined_shipments_no_key;
drop index if exists public.warehouses_auto_match_priority_unique;
drop index if exists public.warehouses_name_exact_unique;
drop index if exists public.finance_actual_shipping_fee_templates_user_name_uidx;
drop index if exists public.finance_actual_shipping_fee_templates_user_system_uidx;
drop index if exists public.temu_order_file_import_templates_user_name_uidx;
drop index if exists public.temu_order_file_import_templates_user_system_uidx;

alter table public.finance_actual_shipping_fees
  drop constraint if exists finance_actual_shipping_fees_user_method_tracking_unique;
alter table public.finance_first_leg_monthly_settlements
  drop constraint if exists finance_first_leg_monthly_settlements_user_month_unique;
alter table public.finance_first_leg_payments
  drop constraint if exists finance_first_leg_payments_user_request_unique;
alter table public.finance_logistics_payments
  drop constraint if exists finance_logistics_payments_user_request_unique;
alter table public.finance_logistics_settlements
  drop constraint if exists finance_logistics_settlements_user_carrier_month_unique;
alter table public.finance_logistics_settlements
  drop constraint if exists finance_logistics_settlements_user_method_month_unique;
alter table public.pricing_settings
  drop constraint if exists pricing_settings_owner_unique;
alter table public.product_strategy_states
  drop constraint if exists product_strategy_states_owner_id_product_id_key;
alter table public.products
  drop constraint if exists products_owner_code_unique;
alter table public.shipping_batches
  drop constraint if exists shipping_batches_owner_code_unique;
alter table public.strategy_rule_settings
  drop constraint if exists strategy_rule_settings_owner_id_phase_key;
alter table public.temu_orders
  drop constraint if exists temu_orders_owner_id_order_no_sub_order_no_key;
alter table public.temu_order_combined_shipments
  drop constraint if exists temu_order_combined_shipments_combined_no_key;

drop function if exists public.save_temu_tracking_result(
  text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
);
drop function if exists public.import_actual_shipping_fees(text, text, jsonb);
drop function if exists public.preview_actual_shipping_fee_import(jsonb);
drop function if exists public.get_actual_shipping_fee_report(
  integer, integer, text, text, text
);
drop function if exists public.record_logistics_payment(
  text, text, numeric, timestamptz, text, uuid
);
drop function if exists public.get_logistics_payment_records(text, text);

update private.multitenant_runtime_state
set permission_mode = 'tenant',
    updated_at = statement_timestamp()
where id = true;

do $security_manifest$
declare
  v_table text;
  v_missing text[] := array[]::text[];
  v_tables constant text[] := array[
    'products', 'product_items', 'product_skus', 'product_sku_items',
    'product_warehouse_shipping_limits', 'pricing_results',
    'profit_calculations', 'product_strategy_states', 'warehouses',
    'warehouse_products', 'warehouse_skus', 'warehouse_sku_stock_adjustments',
    'warehouse_item_stocks', 'warehouse_item_stock_adjustments',
    'purchase_orders', 'purchase_order_items', 'purchase_order_sources',
    'purchase_packages', 'purchase_package_items', 'temu_orders',
    'temu_order_shipments', 'temu_order_shipment_items',
    'temu_order_sku_inventory_reservations', 'temu_order_split_events',
    'temu_order_combined_shipments', 'temu_order_combined_shipment_members',
    'temu_order_file_import_templates', 'shipping_batches',
    'shipping_batch_items', 'finance_actual_shipping_fee_import_templates',
    'finance_actual_shipping_fees', 'finance_expenses',
    'finance_first_leg_monthly_settlements', 'finance_first_leg_payments',
    'finance_logistics_payments', 'finance_logistics_settlements',
    'finance_settlement_files', 'finance_settlement_records',
    'pricing_settings', 'logistics_methods', 'warehouse_logistics_methods',
    'strategy_rule_settings', 'shop_order_auto_match_settings'
  ];
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = v_table
        and relation.relrowsecurity
    ) then
      v_missing := array_append(v_missing, v_table || ':rls');
    end if;
    if (
      select count(distinct policy.cmd)
      from pg_catalog.pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename = v_table
        and policy.cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) <> 4 then
      v_missing := array_append(v_missing, v_table || ':crud-policies');
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_class view_relation
    join pg_catalog.pg_namespace namespace on namespace.oid = view_relation.relnamespace
    where namespace.nspname = 'public'
      and view_relation.relkind = 'v'
      and not coalesce(view_relation.reloptions, array[]::text[])
        @> array['security_invoker=true']
  ) then
    v_missing := array_append(v_missing, 'public-views:security-invoker');
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.prokind = 'f'
      and procedure.prosecdef
      and procedure.proname not in (
        'get_temu_tracking_cron_secret',
        'verify_temu_tracking_proxy_secret',
        'rls_auto_enable'
      )
  ) then
    v_missing := array_append(v_missing, 'public-functions:security-definer');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception using
      errcode = '55000',
      message = 'Multitenant cutover blocked: security manifest failed: '
        || array_to_string(v_missing, ', ');
  end if;
end
$security_manifest$;
