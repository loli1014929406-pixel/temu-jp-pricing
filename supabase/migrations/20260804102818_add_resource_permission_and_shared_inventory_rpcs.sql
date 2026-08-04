create or replace function private.current_user_has_shop_action(
  p_shop_id uuid,
  p_resource text,
  p_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_enterprise_id uuid;
  v_permission_mode text;
begin
  if auth.uid() is null or p_shop_id is null then
    return false;
  end if;

  select shop.enterprise_id
  into v_enterprise_id
  from public.shops shop
  where shop.id = p_shop_id
    and shop.status = 'active';
  if v_enterprise_id is null then
    return false;
  end if;

  if private.current_user_is_platform_owner() then
    if p_action = 'view' then
      return true;
    end if;
    select state.permission_mode
    into v_permission_mode
    from private.multitenant_runtime_state state
    where state.id = true;
    if private.current_context_shop_id() = p_shop_id then
      return true;
    end if;
    return v_permission_mode = 'legacy'
      and private.current_user_is_enterprise_owner(v_enterprise_id);
  end if;

  if private.current_user_is_enterprise_owner(v_enterprise_id) then
    return true;
  end if;

  return exists (
    select 1
    from public.shop_operator_assignments assignment
    join public.shop_operator_permissions permission
      on permission.user_id = assignment.user_id
     and permission.shop_id = assignment.shop_id
    where assignment.user_id = (select auth.uid())
      and assignment.shop_id = p_shop_id
      and assignment.status = 'active'
      and permission.resource = p_resource
      and permission.action = p_action
      and permission.allowed
  );
end
$function$;

create or replace function public.current_account_can(
  p_resource text,
  p_action text,
  p_shop_id uuid default null
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.current_user_has_shop_action(
    coalesce(p_shop_id, private.current_write_shop_id()),
    p_resource,
    p_action
  )
$function$;

create or replace function private.create_shared_inventory_group(
  p_code text,
  p_name text,
  p_base_unit_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_shop_id uuid := private.current_write_shop_id();
  v_enterprise_id uuid;
  v_group public.shared_inventory_groups%rowtype;
begin
  if v_shop_id is null
    or not private.current_user_has_shop_action(
      v_shop_id,
      'inventory',
      'adjust'
    )
  then
    raise exception using errcode = '42501', message = 'Inventory access denied.';
  end if;
  if btrim(coalesce(p_code, '')) = ''
    or btrim(coalesce(p_name, '')) = ''
    or btrim(coalesce(p_base_unit_name, '')) = ''
  then
    raise exception using
      errcode = '22023',
      message = 'Group code, name, and base unit are required.';
  end if;

  select shop.enterprise_id
  into v_enterprise_id
  from public.shops shop
  where shop.id = v_shop_id;

  insert into public.shared_inventory_groups (
    enterprise_id,
    code,
    name,
    base_unit_name,
    created_by
  ) values (
    v_enterprise_id,
    btrim(p_code),
    btrim(p_name),
    btrim(p_base_unit_name),
    auth.uid()
  )
  returning * into v_group;

  return jsonb_build_object(
    'id', v_group.id,
    'enterprise_id', v_group.enterprise_id,
    'code', v_group.code,
    'name', v_group.name,
    'base_unit_name', v_group.base_unit_name
  );
end
$function$;

create or replace function public.create_shared_inventory_group(
  p_code text,
  p_name text,
  p_base_unit_name text default '件'
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.create_shared_inventory_group(
    p_code,
    p_name,
    p_base_unit_name
  )
$function$;

create or replace function private.join_shared_inventory_group(
  p_group_id uuid,
  p_sku_id uuid,
  p_base_units_per_sale_unit numeric,
  p_transfers jsonb,
  p_request_key uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_group public.shared_inventory_groups%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_operation public.shared_inventory_membership_operations%rowtype;
  v_shop_id uuid;
  v_enterprise_id uuid;
  v_line_count integer;
  v_distinct_line_count integer;
  v_stock record;
  v_requested_quantity integer;
  v_balance public.shared_inventory_balances%rowtype;
  v_quantity_base_units bigint;
  v_previous_balance bigint;
  v_total_base_units bigint := 0;
begin
  if p_group_id is null or p_sku_id is null or p_request_key is null then
    raise exception using errcode = '22023', message = 'Missing join identifiers.';
  end if;
  if p_base_units_per_sale_unit is null
    or p_base_units_per_sale_unit <= 0
  then
    raise exception using errcode = '22023', message = 'Conversion ratio must be positive.';
  end if;
  if p_transfers is null
    or jsonb_typeof(p_transfers) <> 'array'
    or jsonb_array_length(p_transfers) = 0
  then
    raise exception using errcode = '22023', message = 'Explicit transfer lines are required.';
  end if;

  select operation.*
  into v_operation
  from public.shared_inventory_membership_operations operation
  where operation.request_key = p_request_key;
  if found then
    if v_operation.operation_type <> 'join'
      or v_operation.group_id <> p_group_id
      or v_operation.sku_id <> p_sku_id
      or v_operation.actor_user_id <> auth.uid()
    then
      raise exception using errcode = '23505', message = 'Request key conflict.';
    end if;
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'group_member_id', v_operation.group_member_id,
      'idempotent', true
    );
  end if;

  select group_row.*
  into v_group
  from public.shared_inventory_groups group_row
  where group_row.id = p_group_id
  for update;
  if not found or v_group.status <> 'active' then
    raise exception using errcode = '22023', message = 'Shared inventory group is not active.';
  end if;

  select operation.*
  into v_operation
  from public.shared_inventory_membership_operations operation
  where operation.request_key = p_request_key;
  if found then
    if v_operation.operation_type <> 'join'
      or v_operation.group_id <> p_group_id
      or v_operation.sku_id <> p_sku_id
      or v_operation.actor_user_id <> auth.uid()
    then
      raise exception using errcode = '23505', message = 'Request key conflict.';
    end if;
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'group_member_id', v_operation.group_member_id,
      'idempotent', true
    );
  end if;

  select sku.shop_id, sku.enterprise_id
  into v_shop_id, v_enterprise_id
  from public.product_skus sku
  where sku.id = p_sku_id;
  if not found
    or v_shop_id is null
    or v_enterprise_id <> v_group.enterprise_id
  then
    raise exception using errcode = '23514', message = 'SKU and group scope do not match.';
  end if;
  if not private.current_user_has_shop_action(
    v_shop_id,
    'inventory',
    'adjust'
  ) then
    raise exception using errcode = '42501', message = 'Inventory access denied.';
  end if;

  if exists (
    select 1
    from public.shared_inventory_group_members member
    where member.sku_id = p_sku_id
      and member.left_at is null
  ) then
    raise exception using errcode = '23505', message = 'SKU already belongs to a shared group.';
  end if;

  perform reservation.id
  from public.temu_order_sku_inventory_reservations reservation
  join public.warehouse_skus stock
    on stock.id = reservation.warehouse_sku_id
  where stock.sku_id = p_sku_id
    and reservation.released_at is null
  order by reservation.id
  for update of reservation;
  if found then
    raise exception using
      errcode = '55000',
      message = 'Release active order reservations before joining a shared group.';
  end if;

  if exists (
    select 1
    from public.purchase_order_items item
    join public.purchase_orders purchase on purchase.id = item.order_id
    where item.sku_id = p_sku_id
      and purchase.status <> 'received'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Receive or cancel pending purchases before joining a shared group.';
  end if;

  select count(*), count(distinct line.warehouse_sku_id)
  into v_line_count, v_distinct_line_count
  from jsonb_to_recordset(p_transfers)
    as line(warehouse_sku_id uuid, quantity integer);
  if v_line_count <> v_distinct_line_count then
    raise exception using errcode = '22023', message = 'Duplicate transfer warehouse SKU.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    where line.warehouse_sku_id is null
      or line.quantity is null
      or line.quantity < 0
  ) then
    raise exception using errcode = '22023', message = 'Invalid transfer quantity.';
  end if;

  perform stock.id
  from public.warehouse_skus stock
  where stock.sku_id = p_sku_id
    and stock.shop_id = v_shop_id
  order by stock.id
  for update of stock;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    left join public.warehouse_skus stock
      on stock.id = line.warehouse_sku_id
     and stock.sku_id = p_sku_id
     and stock.shop_id = v_shop_id
    where stock.id is null
  ) then
    raise exception using errcode = '23514', message = 'Transfer line is outside the SKU shop.';
  end if;

  if exists (
    select 1
    from public.warehouse_skus stock
    where stock.sku_id = p_sku_id
      and stock.shop_id = v_shop_id
      and stock.stock_quantity <> 0
      and not exists (
        select 1
        from jsonb_to_recordset(p_transfers)
          as line(warehouse_sku_id uuid, quantity integer)
        where line.warehouse_sku_id = stock.id
          and line.quantity = stock.stock_quantity
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'All independent stock must be transferred explicitly.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
    where line.quantity <> stock.stock_quantity
  ) then
    raise exception using
      errcode = '23514',
      message = 'Transfer quantity changed; refresh and retry.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
    join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    where warehouse.stock_location_id is null
  ) then
    raise exception using errcode = '23514', message = 'Warehouse has no physical stock location.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    where line.quantity * p_base_units_per_sale_unit
      <> trunc(line.quantity * p_base_units_per_sale_unit)
  ) then
    raise exception using
      errcode = '22023',
      message = 'Transfer does not convert to whole base units.';
  end if;

  insert into public.shared_inventory_group_members (
    group_id,
    enterprise_id,
    shop_id,
    sku_id,
    base_units_per_sale_unit,
    created_by
  ) values (
    p_group_id,
    v_enterprise_id,
    v_shop_id,
    p_sku_id,
    p_base_units_per_sale_unit,
    auth.uid()
  )
  returning * into v_member;

  insert into public.shared_inventory_membership_operations (
    request_key,
    operation_type,
    enterprise_id,
    shop_id,
    group_id,
    group_member_id,
    sku_id,
    base_units_per_sale_unit,
    reason,
    actor_user_id
  ) values (
    p_request_key,
    'join',
    v_enterprise_id,
    v_shop_id,
    p_group_id,
    v_member.id,
    p_sku_id,
    p_base_units_per_sale_unit,
    btrim(coalesce(p_reason, '')),
    auth.uid()
  )
  returning * into v_operation;

  insert into public.shared_inventory_balances (
    group_id,
    enterprise_id,
    stock_location_id,
    quantity_base_units
  )
  select distinct
    p_group_id,
    v_enterprise_id,
    warehouse.stock_location_id,
    0
  from jsonb_to_recordset(p_transfers)
    as line(warehouse_sku_id uuid, quantity integer)
  join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
  join public.warehouses warehouse on warehouse.id = stock.warehouse_id
  on conflict (group_id, stock_location_id) do nothing;

  perform balance.id
  from public.shared_inventory_balances balance
  where balance.group_id = p_group_id
    and balance.stock_location_id in (
      select warehouse.stock_location_id
      from jsonb_to_recordset(p_transfers)
        as line(warehouse_sku_id uuid, quantity integer)
      join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
      join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    )
  order by balance.stock_location_id, balance.id
  for update of balance;

  for v_stock in
    select
      stock.id,
      stock.warehouse_id,
      stock.stock_quantity,
      warehouse.stock_location_id
    from public.warehouse_skus stock
    join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    where stock.sku_id = p_sku_id
      and stock.shop_id = v_shop_id
    order by stock.id
  loop
    select line.quantity
    into v_requested_quantity
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    where line.warehouse_sku_id = v_stock.id;
    if not found then
      continue;
    end if;

    v_quantity_base_units :=
      (v_requested_quantity * p_base_units_per_sale_unit)::bigint;

    select balance.*
    into v_balance
    from public.shared_inventory_balances balance
    where balance.group_id = p_group_id
      and balance.stock_location_id = v_stock.stock_location_id;
    v_previous_balance := v_balance.quantity_base_units;

    update public.warehouse_skus
    set stock_quantity = 0,
        updated_at = statement_timestamp()
    where id = v_stock.id;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      enterprise_id,
      shop_id
    ) values (
      v_stock.warehouse_id,
      p_sku_id,
      auth.uid(),
      v_stock.stock_quantity,
      0,
      -v_stock.stock_quantity,
      '加入共享库存组：' || btrim(coalesce(p_reason, '')),
      v_enterprise_id,
      v_shop_id
    );

    update public.shared_inventory_balances
    set quantity_base_units = quantity_base_units + v_quantity_base_units,
        updated_at = statement_timestamp()
    where id = v_balance.id;

    insert into public.shared_inventory_adjustments (
      enterprise_id,
      shop_id,
      group_id,
      group_member_id,
      balance_id,
      stock_location_id,
      sku_id,
      previous_quantity_base_units,
      next_quantity_base_units,
      change_quantity_base_units,
      source_kind,
      source_id,
      reason,
      request_key,
      actor_user_id
    ) values (
      v_enterprise_id,
      v_shop_id,
      p_group_id,
      v_member.id,
      v_balance.id,
      v_stock.stock_location_id,
      p_sku_id,
      v_previous_balance,
      v_previous_balance + v_quantity_base_units,
      v_quantity_base_units,
      'group_join',
      v_operation.id,
      btrim(coalesce(p_reason, '')),
      p_request_key,
      auth.uid()
    );

    insert into public.shared_inventory_membership_operation_lines (
      operation_id,
      warehouse_sku_id,
      stock_location_id,
      shared_balance_id,
      sku_quantity,
      quantity_base_units
    ) values (
      v_operation.id,
      v_stock.id,
      v_stock.stock_location_id,
      v_balance.id,
      v_requested_quantity,
      v_quantity_base_units
    );

    v_total_base_units := v_total_base_units + v_quantity_base_units;
  end loop;

  return jsonb_build_object(
    'operation_id', v_operation.id,
    'group_member_id', v_member.id,
    'transferred_base_units', v_total_base_units,
    'idempotent', false
  );
end
$function$;

create or replace function public.join_shared_inventory_group(
  p_group_id uuid,
  p_sku_id uuid,
  p_base_units_per_sale_unit numeric,
  p_transfers jsonb,
  p_request_key uuid,
  p_reason text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.join_shared_inventory_group(
    p_group_id,
    p_sku_id,
    p_base_units_per_sale_unit,
    p_transfers,
    p_request_key,
    p_reason
  )
$function$;

create or replace function private.leave_shared_inventory_group(
  p_group_member_id uuid,
  p_transfers jsonb,
  p_request_key uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_member public.shared_inventory_group_members%rowtype;
  v_group public.shared_inventory_groups%rowtype;
  v_operation public.shared_inventory_membership_operations%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_line record;
  v_line_count integer;
  v_distinct_line_count integer;
  v_quantity_base_units bigint;
  v_previous_balance bigint;
  v_previous_stock integer;
  v_other_active_members integer;
  v_total_base_units bigint := 0;
begin
  if p_group_member_id is null or p_request_key is null then
    raise exception using errcode = '22023', message = 'Missing leave identifiers.';
  end if;
  if p_transfers is null
    or jsonb_typeof(p_transfers) <> 'array'
    or jsonb_array_length(p_transfers) = 0
  then
    raise exception using errcode = '22023', message = 'Explicit transfer lines are required.';
  end if;

  select operation.*
  into v_operation
  from public.shared_inventory_membership_operations operation
  where operation.request_key = p_request_key;
  if found then
    if v_operation.operation_type <> 'leave'
      or v_operation.group_member_id <> p_group_member_id
      or v_operation.actor_user_id <> auth.uid()
    then
      raise exception using errcode = '23505', message = 'Request key conflict.';
    end if;
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'group_member_id', v_operation.group_member_id,
      'idempotent', true
    );
  end if;

  select member.*
  into v_member
  from public.shared_inventory_group_members member
  where member.id = p_group_member_id;
  if not found or v_member.left_at is not null then
    raise exception using errcode = '22023', message = 'Shared inventory member is not active.';
  end if;

  select group_row.*
  into v_group
  from public.shared_inventory_groups group_row
  where group_row.id = v_member.group_id
  for update;
  if not found or v_group.status <> 'active' then
    raise exception using errcode = '22023', message = 'Shared inventory group is not active.';
  end if;

  select operation.*
  into v_operation
  from public.shared_inventory_membership_operations operation
  where operation.request_key = p_request_key;
  if found then
    if v_operation.operation_type <> 'leave'
      or v_operation.group_member_id <> p_group_member_id
      or v_operation.actor_user_id <> auth.uid()
    then
      raise exception using errcode = '23505', message = 'Request key conflict.';
    end if;
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'group_member_id', v_operation.group_member_id,
      'idempotent', true
    );
  end if;

  select member.*
  into v_member
  from public.shared_inventory_group_members member
  where member.id = p_group_member_id
  for update;
  if v_member.left_at is not null then
    raise exception using errcode = '55000', message = 'Shared inventory member already left.';
  end if;
  if not private.current_user_has_shop_action(
    v_member.shop_id,
    'inventory',
    'adjust'
  ) then
    raise exception using errcode = '42501', message = 'Inventory access denied.';
  end if;

  perform reservation.id
  from public.temu_order_sku_inventory_reservations reservation
  where reservation.shared_inventory_group_member_id = v_member.id
    and reservation.released_at is null
  order by reservation.id
  for update of reservation;
  if found then
    raise exception using
      errcode = '55000',
      message = 'Release active order reservations before leaving a shared group.';
  end if;

  if exists (
    select 1
    from public.purchase_order_items item
    join public.purchase_orders purchase on purchase.id = item.order_id
    where item.sku_id = v_member.sku_id
      and purchase.status <> 'received'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Receive or cancel pending purchases before leaving a shared group.';
  end if;

  select count(*), count(distinct line.warehouse_sku_id)
  into v_line_count, v_distinct_line_count
  from jsonb_to_recordset(p_transfers)
    as line(warehouse_sku_id uuid, quantity integer);
  if v_line_count <> v_distinct_line_count then
    raise exception using errcode = '22023', message = 'Duplicate transfer warehouse SKU.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    where line.warehouse_sku_id is null
      or line.quantity is null
      or line.quantity < 0
  ) then
    raise exception using errcode = '22023', message = 'Invalid transfer quantity.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    left join public.warehouse_skus stock
      on stock.id = line.warehouse_sku_id
     and stock.sku_id = v_member.sku_id
     and stock.shop_id = v_member.shop_id
    left join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    where stock.id is null
      or warehouse.stock_location_id is null
  ) then
    raise exception using errcode = '23514', message = 'Transfer line is outside the SKU shop.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    where line.quantity * v_member.base_units_per_sale_unit
      <> trunc(line.quantity * v_member.base_units_per_sale_unit)
  ) then
    raise exception using
      errcode = '22023',
      message = 'Transfer does not convert to whole base units.';
  end if;

  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select line.warehouse_sku_id
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
  )
  order by stock.id
  for update of stock;

  perform balance.id
  from public.shared_inventory_balances balance
  where balance.group_id = v_member.group_id
    and balance.stock_location_id in (
      select warehouse.stock_location_id
      from jsonb_to_recordset(p_transfers)
        as line(warehouse_sku_id uuid, quantity integer)
      join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
      join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    )
  order by balance.stock_location_id, balance.id
  for update of balance;

  if exists (
    select 1 from (
      select
        warehouse.stock_location_id,
        sum(
          (line.quantity * v_member.base_units_per_sale_unit)::bigint
        ) as requested_base_units
      from jsonb_to_recordset(p_transfers)
        as line(warehouse_sku_id uuid, quantity integer)
      join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
      join public.warehouses warehouse on warehouse.id = stock.warehouse_id
      group by warehouse.stock_location_id
    ) requested
    left join public.shared_inventory_balances balance
      on balance.group_id = v_member.group_id
     and balance.stock_location_id = requested.stock_location_id
    where balance.id is null
      or balance.quantity_base_units
        < requested.requested_base_units
  ) then
    raise exception using errcode = '23514', message = 'Shared inventory is insufficient.';
  end if;

  insert into public.shared_inventory_membership_operations (
    request_key,
    operation_type,
    enterprise_id,
    shop_id,
    group_id,
    group_member_id,
    sku_id,
    base_units_per_sale_unit,
    reason,
    actor_user_id
  ) values (
    p_request_key,
    'leave',
    v_member.enterprise_id,
    v_member.shop_id,
    v_member.group_id,
    v_member.id,
    v_member.sku_id,
    v_member.base_units_per_sale_unit,
    btrim(coalesce(p_reason, '')),
    auth.uid()
  )
  returning * into v_operation;

  for v_line in
    select
      line.warehouse_sku_id,
      line.quantity,
      warehouse.stock_location_id
    from jsonb_to_recordset(p_transfers)
      as line(warehouse_sku_id uuid, quantity integer)
    join public.warehouse_skus stock on stock.id = line.warehouse_sku_id
    join public.warehouses warehouse on warehouse.id = stock.warehouse_id
    order by line.warehouse_sku_id
  loop
    select stock.*
    into v_stock
    from public.warehouse_skus stock
    where stock.id = v_line.warehouse_sku_id;
    select balance.*
    into v_balance
    from public.shared_inventory_balances balance
    where balance.group_id = v_member.group_id
      and balance.stock_location_id = v_line.stock_location_id;

    v_quantity_base_units :=
      (v_line.quantity * v_member.base_units_per_sale_unit)::bigint;
    v_previous_balance := v_balance.quantity_base_units;
    v_previous_stock := v_stock.stock_quantity;

    update public.shared_inventory_balances
    set quantity_base_units = quantity_base_units - v_quantity_base_units,
        updated_at = statement_timestamp()
    where id = v_balance.id;

    update public.warehouse_skus
    set stock_quantity = stock_quantity + v_line.quantity,
        updated_at = statement_timestamp()
    where id = v_stock.id;

    insert into public.shared_inventory_adjustments (
      enterprise_id,
      shop_id,
      group_id,
      group_member_id,
      balance_id,
      stock_location_id,
      sku_id,
      previous_quantity_base_units,
      next_quantity_base_units,
      change_quantity_base_units,
      source_kind,
      source_id,
      reason,
      request_key,
      actor_user_id
    ) values (
      v_member.enterprise_id,
      v_member.shop_id,
      v_member.group_id,
      v_member.id,
      v_balance.id,
      v_line.stock_location_id,
      v_member.sku_id,
      v_previous_balance,
      v_previous_balance - v_quantity_base_units,
      -v_quantity_base_units,
      'group_leave',
      v_operation.id,
      btrim(coalesce(p_reason, '')),
      p_request_key,
      auth.uid()
    );

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      enterprise_id,
      shop_id
    ) values (
      v_stock.warehouse_id,
      v_member.sku_id,
      auth.uid(),
      v_previous_stock,
      v_previous_stock + v_line.quantity,
      v_line.quantity,
      '退出共享库存组：' || btrim(coalesce(p_reason, '')),
      v_member.enterprise_id,
      v_member.shop_id
    );

    insert into public.shared_inventory_membership_operation_lines (
      operation_id,
      warehouse_sku_id,
      stock_location_id,
      shared_balance_id,
      sku_quantity,
      quantity_base_units
    ) values (
      v_operation.id,
      v_stock.id,
      v_line.stock_location_id,
      v_balance.id,
      v_line.quantity,
      v_quantity_base_units
    );

    v_total_base_units := v_total_base_units + v_quantity_base_units;
  end loop;

  select count(*)::integer
  into v_other_active_members
  from public.shared_inventory_group_members member
  where member.group_id = v_member.group_id
    and member.id <> v_member.id
    and member.left_at is null;

  if v_other_active_members = 0
    and exists (
      select 1
      from public.shared_inventory_balances balance
      where balance.group_id = v_member.group_id
        and balance.quantity_base_units <> 0
    )
  then
    raise exception using
      errcode = '23514',
      message = 'The last member must transfer all remaining shared inventory.';
  end if;

  update public.shared_inventory_group_members
  set left_at = statement_timestamp()
  where id = v_member.id;

  return jsonb_build_object(
    'operation_id', v_operation.id,
    'group_member_id', v_member.id,
    'transferred_base_units', v_total_base_units,
    'idempotent', false
  );
end
$function$;

create or replace function public.leave_shared_inventory_group(
  p_group_member_id uuid,
  p_transfers jsonb,
  p_request_key uuid,
  p_reason text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.leave_shared_inventory_group(
    p_group_member_id,
    p_transfers,
    p_request_key,
    p_reason
  )
$function$;

revoke all on function private.current_user_has_shop_action(uuid, text, text)
  from public, anon;
revoke all on function public.current_account_can(text, text, uuid)
  from public, anon;
revoke all on function private.create_shared_inventory_group(text, text, text)
  from public, anon;
revoke all on function public.create_shared_inventory_group(text, text, text)
  from public, anon;
revoke all on function private.join_shared_inventory_group(
  uuid,
  uuid,
  numeric,
  jsonb,
  uuid,
  text
) from public, anon;
revoke all on function public.join_shared_inventory_group(
  uuid,
  uuid,
  numeric,
  jsonb,
  uuid,
  text
) from public, anon;
revoke all on function private.leave_shared_inventory_group(
  uuid,
  jsonb,
  uuid,
  text
) from public, anon;
revoke all on function public.leave_shared_inventory_group(
  uuid,
  jsonb,
  uuid,
  text
) from public, anon;
grant execute on function private.current_user_has_shop_action(uuid, text, text)
  to authenticated;
grant execute on function public.current_account_can(text, text, uuid)
  to authenticated;
grant execute on function private.create_shared_inventory_group(text, text, text)
  to authenticated;
grant execute on function public.create_shared_inventory_group(text, text, text)
  to authenticated;
grant execute on function private.join_shared_inventory_group(
  uuid,
  uuid,
  numeric,
  jsonb,
  uuid,
  text
) to authenticated;
grant execute on function public.join_shared_inventory_group(
  uuid,
  uuid,
  numeric,
  jsonb,
  uuid,
  text
) to authenticated;
grant execute on function private.leave_shared_inventory_group(
  uuid,
  jsonb,
  uuid,
  text
) to authenticated;
grant execute on function public.leave_shared_inventory_group(
  uuid,
  jsonb,
  uuid,
  text
) to authenticated;
