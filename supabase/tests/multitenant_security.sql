begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(13);

select extensions.is(
  (select permission_mode from private.multitenant_runtime_state where id = true),
  'tenant',
  'tenant permission mode is active'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.column_name = 'shop_id'
      and column_info.table_name in (
        'products', 'product_skus', 'warehouses', 'warehouse_skus',
        'purchase_orders', 'temu_orders', 'temu_order_shipments',
        'finance_expenses', 'finance_settlement_records'
      )
      and exists (
        select 1
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = column_info.table_schema
          and relation.relname = column_info.table_name
          and not relation.relrowsecurity
      )
  ),
  'representative tenant tables have RLS enabled'
);

select extensions.is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = 'temu_orders'
      and policy.cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  4,
  'orders expose exactly four tenant CRUD policies'
);

select extensions.is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = 'finance_settlement_records'
      and policy.cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  4,
  'finance records expose exactly four tenant CRUD policies'
);

select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'v'
      and not coalesce(relation.reloptions, array[]::text[])
        @> array['security_invoker=true']
  ),
  'all public views use invoker security'
);

select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.prokind = 'f'
      and procedure.prosecdef
      and procedure.proname not in (
        'get_temu_tracking_cron_secret',
        'get_temu_tracking_candidates',
        'save_temu_tracking_result',
        'verify_temu_tracking_proxy_secret',
        'rls_auto_enable'
      )
  ),
  'public business RPCs do not bypass caller RLS'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.get_temu_tracking_candidates(uuid[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_temu_tracking_candidates(uuid[])',
    'EXECUTE'
  ),
  'tracking candidate lookup is restricted to the authorized worker'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.save_temu_tracking_result(uuid,text,text,timestamptz,text,text,text,text,timestamptz,boolean,text,text,boolean,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.save_temu_tracking_result(uuid,text,text,timestamptz,text,text,text,text,timestamptz,boolean,text,text,boolean,boolean,text)',
    'EXECUTE'
  ),
  'tracking persistence is restricted to the authorized worker'
);

select extensions.ok(
  exists (
    select 1 from pg_catalog.pg_indexes index_info
    where index_info.schemaname = 'public'
      and index_info.tablename = 'shop_operator_assignments'
      and index_info.indexdef ilike 'create unique index%'
      and index_info.indexdef ilike '%(user_id)%'
  ),
  'a shop operator can belong to only one shop'
);

select extensions.ok(
  exists (
    select 1 from pg_catalog.pg_indexes index_info
    where index_info.schemaname = 'public'
      and index_info.tablename = 'shared_inventory_group_members'
      and index_info.indexdef ilike 'create unique index%'
      and index_info.indexdef ilike '%sku_id%'
      and index_info.indexdef ilike '%left_at is null%'
  ),
  'a SKU can have only one active shared inventory group'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conname = 'temu_order_inventory_reservation_target_check'
      and constraint_info.convalidated
  ),
  'inventory reservations enforce one valid inventory target'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conrelid = 'public.warehouses'::regclass
      and constraint_info.contype = 'f'
      and constraint_info.convalidated
      and pg_catalog.pg_get_constraintdef(constraint_info.oid)
        ilike '%stock_location_id%'
  ),
  'warehouse physical stock location foreign key is validated'
);

select extensions.ok(
  exists (
    select 1 from pg_catalog.pg_indexes index_info
    where index_info.schemaname = 'public'
      and index_info.tablename = 'temu_orders'
      and index_info.indexdef ilike 'create unique index%'
      and index_info.indexdef ilike '%(shop_id, order_no, sub_order_no)%'
  )
  and not exists (
    select 1 from pg_catalog.pg_indexes index_info
    where index_info.schemaname = 'public'
      and index_info.tablename = 'temu_orders'
      and index_info.indexname = 'idx_temu_orders_team_order_line'
  ),
  'order identity is unique per shop rather than globally'
);

select * from extensions.finish();
rollback;
