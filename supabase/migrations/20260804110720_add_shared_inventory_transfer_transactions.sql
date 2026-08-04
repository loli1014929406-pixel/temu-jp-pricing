create or replace function private.change_sku_inventory_at_warehouse(
  p_warehouse_id uuid,
  p_sku_id uuid,
  p_change_sale_units integer,
  p_source_kind text,
  p_source_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_warehouse public.warehouses%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_next_balance public.shared_inventory_balances%rowtype;
  v_change_base_units numeric;
  v_adjustment public.warehouse_sku_stock_adjustments%rowtype;
begin
  if p_change_sale_units = 0 then
    raise exception using errcode = '22023', message = 'Inventory change cannot be zero.';
  end if;
  if p_source_kind not in ('transfer_out', 'transfer_in', 'manual_adjustment') then
    raise exception using errcode = '22023', message = 'Unsupported inventory source kind.';
  end if;

  select * into strict v_warehouse
  from public.warehouses warehouse
  where warehouse.id = p_warehouse_id;
  if v_warehouse.stock_location_id is null then
    raise exception using errcode = '23514', message = 'Warehouse has no physical stock location.';
  end if;
  if not private.current_user_has_shop_action(
    v_warehouse.shop_id,
    'inventory',
    case
      when p_source_kind in ('transfer_out', 'transfer_in') then 'transfer'
      else 'adjust'
    end
  ) then
    raise exception using errcode = '42501', message = 'Inventory access denied.';
  end if;

  select * into strict v_stock
  from public.warehouse_skus stock
  where stock.warehouse_id = p_warehouse_id and stock.sku_id = p_sku_id
  for update;

  select member.* into v_member
  from public.shared_inventory_group_members member
  where member.sku_id = p_sku_id
    and member.shop_id = v_warehouse.shop_id
    and member.left_at is null
  for key share;

  if found then
    select * into v_balance
    from public.shared_inventory_balances balance
    where balance.group_id = v_member.group_id
      and balance.stock_location_id = v_warehouse.stock_location_id
    for update;
    if not found then
      if p_change_sale_units < 0 then
        raise exception using errcode = '23514', message = 'Shared inventory balance is missing.';
      end if;
      insert into public.shared_inventory_balances (
        group_id,
        enterprise_id,
        stock_location_id,
        quantity_base_units
      ) values (
        v_member.group_id,
        v_member.enterprise_id,
        v_warehouse.stock_location_id,
        0
      )
      on conflict (group_id, stock_location_id) do update
        set group_id = excluded.group_id
      returning * into v_balance;
    end if;

    v_change_base_units := p_change_sale_units * v_member.base_units_per_sale_unit;
    if v_change_base_units <> trunc(v_change_base_units) then
      raise exception using errcode = '23514', message = 'Inventory change does not convert to whole shared base units.';
    end if;
    if v_balance.quantity_base_units + v_change_base_units::bigint < 0 then
      raise exception using errcode = '23514', message = 'Shared inventory is insufficient.';
    end if;

    update public.shared_inventory_balances
    set quantity_base_units = quantity_base_units + v_change_base_units::bigint,
        updated_at = statement_timestamp()
    where id = v_balance.id
    returning * into v_next_balance;

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
      source_ref,
      reason,
      actor_user_id
    ) values (
      v_member.enterprise_id,
      v_member.shop_id,
      v_member.group_id,
      v_member.id,
      v_balance.id,
      v_warehouse.stock_location_id,
      p_sku_id,
      v_balance.quantity_base_units,
      v_next_balance.quantity_base_units,
      v_change_base_units::bigint,
      p_source_kind,
      coalesce(p_source_ref, ''),
      coalesce(p_reason, ''),
      auth.uid()
    );

    return jsonb_build_object(
      'inventoryKind', 'shared',
      'warehouseSku', to_jsonb(v_stock),
      'sharedInventoryBalanceId', v_balance.id,
      'previousQuantityBaseUnits', v_balance.quantity_base_units,
      'nextQuantityBaseUnits', v_next_balance.quantity_base_units,
      'changeQuantityBaseUnits', v_change_base_units::bigint,
      'baseUnitsPerSaleUnit', v_member.base_units_per_sale_unit
    );
  end if;

  if v_stock.stock_quantity + p_change_sale_units < 0 then
    raise exception using errcode = '23514', message = 'Independent inventory is insufficient.';
  end if;
  update public.warehouse_skus
  set stock_quantity = stock_quantity + p_change_sale_units,
      updated_at = statement_timestamp()
  where id = v_stock.id
  returning * into v_next_stock;

  insert into public.warehouse_sku_stock_adjustments (
    warehouse_id,
    sku_id,
    owner_id,
    enterprise_id,
    shop_id,
    previous_quantity,
    next_quantity,
    change_quantity,
    reason,
    purchase_order_id,
    purchase_package_id
  ) values (
    v_stock.warehouse_id,
    v_stock.sku_id,
    v_stock.owner_id,
    v_stock.enterprise_id,
    v_stock.shop_id,
    v_stock.stock_quantity,
    v_next_stock.stock_quantity,
    p_change_sale_units,
    p_reason,
    null,
    null
  ) returning * into v_adjustment;

  return jsonb_build_object(
    'inventoryKind', 'independent',
    'warehouseSku', to_jsonb(v_next_stock),
    'adjustment', to_jsonb(v_adjustment)
  );
end
$function$;

create or replace function private.set_sku_inventory_quantity_atomic(
  p_warehouse_sku_id uuid,
  p_quantity_sale_units integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_stock public.warehouse_skus%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_current_sale_units numeric;
  v_change integer;
begin
  if p_quantity_sale_units < 0 or btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = '22023', message = 'A nonnegative quantity and reason are required.';
  end if;

  select * into strict v_stock
  from public.warehouse_skus stock
  where stock.id = p_warehouse_sku_id;
  select * into strict v_warehouse
  from public.warehouses warehouse
  where warehouse.id = v_stock.warehouse_id;

  select member.* into v_member
  from public.shared_inventory_group_members member
  where member.sku_id = v_stock.sku_id
    and member.shop_id = v_stock.shop_id
    and member.left_at is null;
  if found then
    select * into v_balance
    from public.shared_inventory_balances balance
    where balance.group_id = v_member.group_id
      and balance.stock_location_id = v_warehouse.stock_location_id;
    v_current_sale_units := coalesce(v_balance.quantity_base_units, 0)
      / v_member.base_units_per_sale_unit;
    if v_current_sale_units <> trunc(v_current_sale_units) then
      raise exception using
        errcode = '23514',
        message = 'Shared balance is not an exact sale-unit quantity for this SKU; adjust in base units from the shared inventory page.';
    end if;
    v_change := p_quantity_sale_units - v_current_sale_units::integer;
  else
    v_change := p_quantity_sale_units - v_stock.stock_quantity;
  end if;

  if v_change = 0 then
    return jsonb_build_object(
      'inventoryKind', case when v_member.id is null then 'independent' else 'shared' end,
      'warehouseSku', to_jsonb(v_stock),
      'unchanged', true
    );
  end if;
  return private.change_sku_inventory_at_warehouse(
    v_stock.warehouse_id,
    v_stock.sku_id,
    v_change,
    'manual_adjustment',
    p_warehouse_sku_id::text,
    p_reason
  );
end
$function$;

create or replace function public.set_sku_inventory_quantity_atomic(
  p_warehouse_sku_id uuid,
  p_quantity_sale_units integer,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.set_sku_inventory_quantity_atomic(
    p_warehouse_sku_id,
    p_quantity_sale_units,
    p_reason
  )
$function$;

create or replace function private.transfer_warehouse_sku_inventory_atomic(
  p_source_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_warehouse public.warehouses%rowtype;
  v_line record;
  v_result jsonb;
  v_stocks jsonb := '[]'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_source_warehouse_id is null or btrim(coalesce(p_reason, '')) = ''
    or coalesce(jsonb_typeof(p_lines), 'null') <> 'array'
    or jsonb_array_length(p_lines) = 0
  then
    raise exception using errcode = '22023', message = 'Source warehouse, reason and transfer lines are required.';
  end if;
  select * into strict v_warehouse
  from public.warehouses warehouse where warehouse.id = p_source_warehouse_id;
  if not private.current_user_has_shop_action(v_warehouse.shop_id, 'inventory', 'transfer') then
    raise exception using errcode = '42501', message = 'Inventory transfer access denied.';
  end if;

  for v_line in
    select line.sku_id, line.quantity
    from jsonb_to_recordset(p_lines) line(product_id uuid, sku_id uuid, quantity integer)
    order by line.sku_id
  loop
    if v_line.sku_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception using errcode = '22023', message = 'Transfer SKU and positive quantity are required.';
    end if;
    v_result := private.change_sku_inventory_at_warehouse(
      p_source_warehouse_id,
      v_line.sku_id,
      -v_line.quantity,
      'transfer_out',
      p_reason,
      p_reason
    );
    v_stocks := v_stocks || jsonb_build_array(v_result -> 'warehouseSku');
    if v_result ? 'adjustment' then
      v_adjustments := v_adjustments || jsonb_build_array(v_result -> 'adjustment');
    else
      v_adjustments := v_adjustments || jsonb_build_array(v_result);
    end if;
  end loop;
  return jsonb_build_object('warehouseSkus', v_stocks, 'adjustments', v_adjustments);
end
$function$;

create or replace function private.receive_warehouse_sku_transfer_atomic(
  p_destination_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_warehouse public.warehouses%rowtype;
  v_line record;
  v_product public.product_skus%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_received integer;
  v_receive integer;
  v_result jsonb;
  v_stocks jsonb := '[]'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_destination_warehouse_id is null or btrim(coalesce(p_reason, '')) = ''
    or coalesce(jsonb_typeof(p_lines), 'null') <> 'array'
    or jsonb_array_length(p_lines) = 0
  then
    raise exception using errcode = '22023', message = 'Destination warehouse, reason and transfer lines are required.';
  end if;
  select * into strict v_warehouse
  from public.warehouses warehouse where warehouse.id = p_destination_warehouse_id;
  if not private.current_user_has_shop_action(v_warehouse.shop_id, 'inventory', 'transfer') then
    raise exception using errcode = '42501', message = 'Inventory transfer access denied.';
  end if;

  for v_line in
    select line.product_id, line.sku_id, line.quantity
    from jsonb_to_recordset(p_lines) line(product_id uuid, sku_id uuid, quantity integer)
    order by line.sku_id
  loop
    if v_line.product_id is null or v_line.sku_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception using errcode = '22023', message = 'Transfer product, SKU and positive quantity are required.';
    end if;
    select * into strict v_product
    from public.product_skus sku
    where sku.id = v_line.sku_id and sku.shop_id = v_warehouse.shop_id;

    insert into public.warehouse_skus (
      warehouse_id, product_id, sku_id, owner_id, enterprise_id, shop_id
    ) values (
      p_destination_warehouse_id,
      v_line.product_id,
      v_line.sku_id,
      auth.uid(),
      v_warehouse.enterprise_id,
      v_warehouse.shop_id
    ) on conflict (warehouse_id, sku_id) do nothing;

    select member.* into v_member
    from public.shared_inventory_group_members member
    where member.sku_id = v_line.sku_id
      and member.shop_id = v_warehouse.shop_id
      and member.left_at is null;

    if found then
      select coalesce(sum(adjustment.change_quantity_base_units), 0)
        / v_member.base_units_per_sale_unit
      into v_received
      from public.shared_inventory_adjustments adjustment
      join public.shared_inventory_balances balance
        on balance.id = adjustment.balance_id
      where adjustment.source_kind = 'transfer_in'
        and adjustment.source_ref = p_reason
        and adjustment.group_member_id = v_member.id
        and balance.stock_location_id = v_warehouse.stock_location_id;
    else
      select greatest(0, coalesce(sum(change_quantity), 0))::integer
      into v_received
      from public.warehouse_sku_stock_adjustments adjustment
      where adjustment.warehouse_id = p_destination_warehouse_id
        and adjustment.sku_id = v_line.sku_id
        and adjustment.reason = p_reason;
    end if;

    v_receive := v_line.quantity - coalesce(v_received, 0);
    if v_receive > 0 then
      v_result := private.change_sku_inventory_at_warehouse(
        p_destination_warehouse_id,
        v_line.sku_id,
        v_receive,
        'transfer_in',
        p_reason,
        p_reason
      );
      v_stocks := v_stocks || jsonb_build_array(v_result -> 'warehouseSku');
      if v_result ? 'adjustment' then
        v_adjustments := v_adjustments || jsonb_build_array(v_result -> 'adjustment');
      else
        v_adjustments := v_adjustments || jsonb_build_array(v_result);
      end if;
    end if;
  end loop;
  return jsonb_build_object('warehouseSkus', v_stocks, 'adjustments', v_adjustments);
end
$function$;

create or replace function public.transfer_warehouse_sku_inventory_atomic(
  p_source_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $function$
  select private.transfer_warehouse_sku_inventory_atomic(
    p_source_warehouse_id, p_reason, p_lines
  )
$function$;

create or replace function public.receive_warehouse_sku_transfer_atomic(
  p_destination_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $function$
  select private.receive_warehouse_sku_transfer_atomic(
    p_destination_warehouse_id, p_reason, p_lines
  )
$function$;

revoke all on function private.change_sku_inventory_at_warehouse(uuid, uuid, integer, text, text, text)
  from public, anon;
revoke all on function private.set_sku_inventory_quantity_atomic(uuid, integer, text)
  from public, anon;
revoke all on function private.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb)
  from public, anon;
revoke all on function private.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb)
  from public, anon;
revoke all on function public.set_sku_inventory_quantity_atomic(uuid, integer, text)
  from public, anon;
revoke all on function public.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb)
  from public, anon;
revoke all on function public.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb)
  from public, anon;

grant execute on function private.set_sku_inventory_quantity_atomic(uuid, integer, text)
  to authenticated;
grant execute on function private.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb)
  to authenticated;
grant execute on function private.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb)
  to authenticated;
grant execute on function public.set_sku_inventory_quantity_atomic(uuid, integer, text)
  to authenticated;
grant execute on function public.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb)
  to authenticated;
grant execute on function public.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb)
  to authenticated;
