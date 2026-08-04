create or replace function private.release_shipment_inventory_reservations(
  p_shipment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_release record;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_next_balance public.shared_inventory_balances%rowtype;
  v_changes jsonb := '[]'::jsonb;
begin
  -- Membership rows are locked before balances so join/leave and order
  -- allocation use the same lock order.
  perform member.id
  from public.shared_inventory_group_members member
  where member.id in (
    select reservation.shared_inventory_group_member_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
      and reservation.shared_inventory_group_member_id is not null
  )
  order by member.id
  for key share;

  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select reservation.warehouse_sku_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
      and reservation.warehouse_sku_id is not null
  )
  order by stock.id
  for update;

  perform balance.id
  from public.shared_inventory_balances balance
  where balance.id in (
    select reservation.shared_inventory_balance_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
      and reservation.shared_inventory_balance_id is not null
  )
  order by balance.id
  for update;

  for v_release in
    select
      reservation.*,
      stock.warehouse_id,
      stock.sku_id as independent_sku_id,
      member.sku_id as shared_sku_id,
      member.shop_id as shared_shop_id,
      member.group_id,
      balance.stock_location_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item
      on item.id = reservation.shipment_item_id
    left join public.warehouse_skus stock
      on stock.id = reservation.warehouse_sku_id
    left join public.shared_inventory_group_members member
      on member.id = reservation.shared_inventory_group_member_id
    left join public.shared_inventory_balances balance
      on balance.id = reservation.shared_inventory_balance_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
    order by reservation.id
  loop
    if v_release.warehouse_sku_id is not null then
      select * into strict v_stock
      from public.warehouse_skus stock
      where stock.id = v_release.warehouse_sku_id;

      update public.warehouse_skus
      set stock_quantity = stock_quantity + v_release.quantity,
          updated_at = statement_timestamp()
      where id = v_release.warehouse_sku_id
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
        v_release.warehouse_id,
        v_release.independent_sku_id,
        v_release.owner_id,
        v_release.enterprise_id,
        v_release.shop_id,
        v_stock.stock_quantity,
        v_next_stock.stock_quantity,
        v_release.quantity,
        p_reason,
        null,
        null
      );

      v_changes := v_changes || jsonb_build_object(
        'inventory_kind', 'independent',
        'sku', to_jsonb(v_next_stock),
        'previous_quantity', v_stock.stock_quantity,
        'change_quantity', v_release.quantity
      );
    else
      select * into strict v_balance
      from public.shared_inventory_balances balance
      where balance.id = v_release.shared_inventory_balance_id;

      update public.shared_inventory_balances
      set quantity_base_units = quantity_base_units + v_release.quantity_base_units,
          updated_at = statement_timestamp()
      where id = v_release.shared_inventory_balance_id
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
        source_id,
        source_ref,
        reason,
        actor_user_id
      ) values (
        v_release.enterprise_id,
        v_release.shared_shop_id,
        v_release.group_id,
        v_release.shared_inventory_group_member_id,
        v_release.shared_inventory_balance_id,
        v_release.stock_location_id,
        v_release.shared_sku_id,
        v_balance.quantity_base_units,
        v_next_balance.quantity_base_units,
        v_release.quantity_base_units,
        'order_release',
        v_release.id,
        p_shipment_id::text,
        p_reason,
        auth.uid()
      );

      v_changes := v_changes || jsonb_build_object(
        'inventory_kind', 'shared',
        'shared_inventory_balance_id', v_next_balance.id,
        'previous_quantity_base_units', v_balance.quantity_base_units,
        'change_quantity_base_units', v_release.quantity_base_units,
        'next_quantity_base_units', v_next_balance.quantity_base_units
      );
    end if;

    update public.temu_order_sku_inventory_reservations
    set released_at = statement_timestamp(),
        released_reason = p_reason
    where id = v_release.id;
  end loop;

  return v_changes;
end
$function$;

create or replace function private.assign_temu_order_shipment(
  p_shipment_id uuid,
  p_warehouse_id uuid,
  p_logistics_method_id uuid,
  p_reservations jsonb,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_shipment public.temu_order_shipments%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_method public.logistics_methods%rowtype;
  v_item_count integer;
  v_reason text;
  v_allocation record;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_next_balance public.shared_inventory_balances%rowtype;
  v_base_units numeric;
  v_reservation_id uuid;
  v_changes jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_warehouse_id is null or p_logistics_method_id is null then
    raise exception using errcode = '22023', message = 'Warehouse and logistics method are required.';
  end if;
  if jsonb_typeof(p_reservations) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid inventory allocation payload.';
  end if;

  select * into v_shipment
  from public.temu_order_shipments shipment
  where shipment.id = p_shipment_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Shipment not found.';
  end if;
  if not private.current_user_has_shop_action(v_shipment.shop_id, 'orders', 'fulfill') then
    raise exception using errcode = '42501', message = 'Order fulfillment access denied.';
  end if;
  if public.temu_order_shipment_stage(v_shipment) not in ('pending_assignment', 'new_order')
     or btrim(v_shipment.label_printed_at) <> ''
     or btrim(v_shipment.logistics_tracking_no) <> ''
     or btrim(v_shipment.actual_ship_time) <> ''
     or btrim(v_shipment.actual_signed_time) <> '' then
    raise exception using errcode = '55000', message = 'This shipment can no longer be reassigned.';
  end if;

  select * into v_warehouse
  from public.warehouses warehouse
  where warehouse.id = p_warehouse_id
    and warehouse.shop_id = v_shipment.shop_id
    and warehouse.enterprise_id = v_shipment.enterprise_id;
  if not found or v_warehouse.stock_location_id is null then
    raise exception using errcode = '23503', message = 'The warehouse is outside this shop or has no stock location.';
  end if;

  select * into v_method
  from public.logistics_methods method
  where method.id = p_logistics_method_id
    and method.shop_id = v_shipment.shop_id
    and method.is_active = true;
  if not found then
    raise exception using errcode = '23503', message = 'The logistics method is outside this shop or inactive.';
  end if;
  if not exists (
    select 1 from public.warehouse_logistics_methods mapping
    where mapping.warehouse_id = p_warehouse_id
      and mapping.logistics_method_id = p_logistics_method_id
      and mapping.shop_id = v_shipment.shop_id
  ) then
    raise exception using errcode = '23514', message = 'The logistics method is not linked to this warehouse.';
  end if;
  if not exists (
    select 1
    from public.pricing_settings setting
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(setting.last_leg_methods) = 'array'
        then setting.last_leg_methods else '[]'::jsonb end
    ) configured
    where setting.shop_id = v_shipment.shop_id
      and lower(coalesce(configured ->> 'type', 'last_leg')) = 'last_leg'
      and lower(coalesce(configured ->> 'isActive', 'true')) <> 'false'
      and (
        configured ->> 'db_method_id' = p_logistics_method_id::text
        or public.logistics_method_match_key(configured ->> 'name')
          = public.logistics_method_match_key(v_method.name)
      )
  ) then
    raise exception using errcode = '23514', message = 'The logistics method is not enabled as a last-leg method for this shop.';
  end if;

  select count(*) into v_item_count
  from public.temu_order_shipment_items item
  where item.shipment_id = p_shipment_id;
  if v_item_count = 0 or jsonb_array_length(p_reservations) <> v_item_count then
    raise exception using errcode = '22023', message = 'Every shipment item must have exactly one inventory allocation.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_reservations) allocation
    where jsonb_typeof(allocation) <> 'object'
       or coalesce(allocation ->> 'shipment_item_id', '') = ''
       or coalesce(allocation ->> 'warehouse_sku_id', '') = ''
  ) or exists (
    select 1
    from (
      select allocation ->> 'shipment_item_id'
      from jsonb_array_elements(p_reservations) allocation
      group by allocation ->> 'shipment_item_id'
      having count(*) > 1
    ) duplicate
  ) then
    raise exception using errcode = '22023', message = 'Inventory allocations are incomplete or duplicated.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_reservations) allocation
    left join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
     and item.shipment_id = p_shipment_id
    left join public.warehouse_skus stock
      on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
     and stock.warehouse_id = p_warehouse_id
     and stock.shop_id = v_shipment.shop_id
    where item.id is null or stock.id is null
  ) or exists (
    select 1
    from public.temu_order_shipment_items item
    left join jsonb_array_elements(p_reservations) allocation
      on allocation ->> 'shipment_item_id' = item.id::text
    where item.shipment_id = p_shipment_id and allocation is null
  ) then
    raise exception using errcode = '23514', message = 'An inventory allocation does not match this shipment and warehouse.';
  end if;

  -- A leave operation takes an UPDATE lock on these member rows. Holding a key
  -- share lock through reservation insert prevents a SKU leaving a group in the
  -- middle of an order allocation.
  perform member.id
  from public.shared_inventory_group_members member
  join public.warehouse_skus stock on stock.sku_id = member.sku_id
  where stock.id in (
    select (allocation ->> 'warehouse_sku_id')::uuid
    from jsonb_array_elements(p_reservations) allocation
  )
    and member.shop_id = v_shipment.shop_id
    and member.left_at is null
  order by member.id
  for key share;

  perform stock.id
  from public.warehouse_skus stock
  where stock.id in (
    select reservation.warehouse_sku_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
      and reservation.warehouse_sku_id is not null
    union
    select (allocation ->> 'warehouse_sku_id')::uuid
    from jsonb_array_elements(p_reservations) allocation
  )
  order by stock.id
  for update;

  perform balance.id
  from public.shared_inventory_balances balance
  where balance.id in (
    select reservation.shared_inventory_balance_id
    from public.temu_order_sku_inventory_reservations reservation
    join public.temu_order_shipment_items item on item.id = reservation.shipment_item_id
    where item.shipment_id = p_shipment_id
      and reservation.released_at is null
      and reservation.shared_inventory_balance_id is not null
    union
    select balance_candidate.id
    from jsonb_array_elements(p_reservations) allocation
    join public.warehouse_skus stock
      on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
    join public.shared_inventory_group_members member
      on member.sku_id = stock.sku_id
     and member.shop_id = v_shipment.shop_id
     and member.left_at is null
    join public.shared_inventory_balances balance_candidate
      on balance_candidate.group_id = member.group_id
     and balance_candidate.stock_location_id = v_warehouse.stock_location_id
  )
  order by balance.id
  for update;

  v_reason := coalesce(nullif(btrim(p_reason), ''), '订单包裹库存占用：' || v_shipment.order_no);
  v_changes := private.release_shipment_inventory_reservations(
    p_shipment_id,
    '订单包裹库存占用变更回补：' || v_shipment.order_no
  );

  -- Validate independent and shared demand after previous reservations have
  -- been returned. Shared quantities must convert to an exact whole number of
  -- base units.
  if exists (
    with demand as (
      select
        stock.id as stock_id,
        stock.stock_quantity,
        member.id as member_id,
        balance.id as balance_id,
        balance.quantity_base_units,
        sum(item.quantity) as sale_units,
        sum(item.quantity * member.base_units_per_sale_unit) as base_units
      from jsonb_array_elements(p_reservations) allocation
      join public.temu_order_shipment_items item
        on item.id = (allocation ->> 'shipment_item_id')::uuid
      join public.warehouse_skus stock
        on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
      left join public.shared_inventory_group_members member
        on member.sku_id = stock.sku_id
       and member.shop_id = v_shipment.shop_id
       and member.left_at is null
      left join public.shared_inventory_balances balance
        on balance.group_id = member.group_id
       and balance.stock_location_id = v_warehouse.stock_location_id
      group by stock.id, stock.stock_quantity, member.id, balance.id,
        balance.quantity_base_units
    )
    select 1 from demand
    where (member_id is null and stock_quantity < sale_units)
       or (member_id is not null and (
         balance_id is null
         or base_units <> trunc(base_units)
         or quantity_base_units < base_units
       ))
  ) then
    raise exception using errcode = '23514', message = 'Inventory is insufficient or the shared-unit conversion is not a whole base-unit quantity.';
  end if;

  for v_allocation in
    select
      item.id as shipment_item_id,
      item.order_id,
      item.quantity,
      source.owner_id,
      source.enterprise_id,
      source.shop_id,
      (allocation ->> 'warehouse_sku_id')::uuid as warehouse_sku_id
    from jsonb_array_elements(p_reservations) allocation
    join public.temu_order_shipment_items item
      on item.id = (allocation ->> 'shipment_item_id')::uuid
    join public.temu_orders source on source.id = item.order_id
    order by item.id
  loop
    select * into strict v_stock
    from public.warehouse_skus stock
    where stock.id = v_allocation.warehouse_sku_id;

    select member.* into v_member
    from public.shared_inventory_group_members member
    where member.sku_id = v_stock.sku_id
      and member.shop_id = v_allocation.shop_id
      and member.left_at is null;

    if found then
      select * into strict v_balance
      from public.shared_inventory_balances balance
      where balance.group_id = v_member.group_id
        and balance.stock_location_id = v_warehouse.stock_location_id;

      v_base_units := v_allocation.quantity * v_member.base_units_per_sale_unit;
      if v_base_units <> trunc(v_base_units) then
        raise exception using errcode = '23514', message = 'Shared-unit conversion must produce whole base units.';
      end if;

      update public.shared_inventory_balances
      set quantity_base_units = quantity_base_units - v_base_units::bigint,
          updated_at = statement_timestamp()
      where id = v_balance.id
      returning * into v_next_balance;

      insert into public.temu_order_sku_inventory_reservations (
        order_id,
        shipment_item_id,
        warehouse_sku_id,
        shared_inventory_balance_id,
        shared_inventory_group_member_id,
        quantity_base_units,
        owner_id,
        enterprise_id,
        shop_id,
        quantity,
        reason
      ) values (
        v_allocation.order_id,
        v_allocation.shipment_item_id,
        null,
        v_balance.id,
        v_member.id,
        v_base_units::bigint,
        v_allocation.owner_id,
        v_allocation.enterprise_id,
        v_allocation.shop_id,
        v_allocation.quantity,
        v_reason
      ) returning id into v_reservation_id;

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
        source_ref,
        reason,
        actor_user_id
      ) values (
        v_allocation.enterprise_id,
        v_allocation.shop_id,
        v_member.group_id,
        v_member.id,
        v_balance.id,
        v_warehouse.stock_location_id,
        v_stock.sku_id,
        v_balance.quantity_base_units,
        v_next_balance.quantity_base_units,
        -v_base_units::bigint,
        'order_reserve',
        v_reservation_id,
        v_shipment.order_no,
        v_reason,
        auth.uid()
      );

      v_changes := v_changes || jsonb_build_object(
        'inventory_kind', 'shared',
        'shared_inventory_balance_id', v_next_balance.id,
        'previous_quantity_base_units', v_balance.quantity_base_units,
        'change_quantity_base_units', -v_base_units::bigint,
        'next_quantity_base_units', v_next_balance.quantity_base_units
      );
    else
      update public.warehouse_skus
      set stock_quantity = stock_quantity - v_allocation.quantity,
          updated_at = statement_timestamp()
      where id = v_allocation.warehouse_sku_id
      returning * into v_next_stock;

      insert into public.temu_order_sku_inventory_reservations (
        order_id,
        shipment_item_id,
        warehouse_sku_id,
        owner_id,
        enterprise_id,
        shop_id,
        quantity,
        reason
      ) values (
        v_allocation.order_id,
        v_allocation.shipment_item_id,
        v_allocation.warehouse_sku_id,
        v_allocation.owner_id,
        v_allocation.enterprise_id,
        v_allocation.shop_id,
        v_allocation.quantity,
        v_reason
      );

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
        v_allocation.owner_id,
        v_allocation.enterprise_id,
        v_allocation.shop_id,
        v_stock.stock_quantity,
        v_next_stock.stock_quantity,
        -v_allocation.quantity,
        v_reason,
        null,
        null
      );

      v_changes := v_changes || jsonb_build_object(
        'inventory_kind', 'independent',
        'sku', to_jsonb(v_next_stock),
        'previous_quantity', v_stock.stock_quantity,
        'change_quantity', -v_allocation.quantity
      );
    end if;
  end loop;

  update public.temu_order_shipments shipment
  set warehouse_id = p_warehouse_id,
      warehouse_name = v_warehouse.name,
      logistics_method_id = p_logistics_method_id,
      logistics_method = v_method.name,
      order_status = case when btrim(shipment.order_status) = '' then '新订单' else shipment.order_status end
  where shipment.id = p_shipment_id;

  return jsonb_build_object('shipment_id', p_shipment_id, 'status', 'assigned', 'changes', v_changes);
end
$function$;

create or replace function private.release_temu_order_shipment_inventory(
  p_shipment_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_shipment public.temu_order_shipments%rowtype;
  v_reason text;
  v_changes jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  select * into v_shipment
  from public.temu_order_shipments shipment
  where shipment.id = p_shipment_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Shipment not found.';
  end if;
  if not private.current_user_has_shop_action(v_shipment.shop_id, 'orders', 'fulfill') then
    raise exception using errcode = '42501', message = 'Order fulfillment access denied.';
  end if;
  if btrim(v_shipment.label_printed_at) <> ''
     or btrim(v_shipment.logistics_tracking_no) <> ''
     or btrim(v_shipment.actual_ship_time) <> ''
     or btrim(v_shipment.actual_signed_time) <> '' then
    raise exception using errcode = '55000', message = 'A labelled or shipped package cannot return to pending allocation.';
  end if;

  v_reason := coalesce(nullif(btrim(p_reason), ''), '订单包裹退回待分配：' || v_shipment.order_no);
  v_changes := private.release_shipment_inventory_reservations(p_shipment_id, v_reason);

  update public.temu_order_shipments
  set warehouse_id = null,
      warehouse_name = '',
      logistics_method_id = null,
      logistics_method = ''
  where id = p_shipment_id;

  return jsonb_build_object('shipment_id', p_shipment_id, 'status', 'released', 'changes', v_changes);
end
$function$;

create or replace function public.assign_temu_order_shipment(
  p_shipment_id uuid,
  p_warehouse_id uuid,
  p_logistics_method_id uuid,
  p_reservations jsonb,
  p_reason text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.assign_temu_order_shipment(
    p_shipment_id,
    p_warehouse_id,
    p_logistics_method_id,
    p_reservations,
    p_reason
  )
$function$;

create or replace function public.release_temu_order_shipment_inventory(
  p_shipment_id uuid,
  p_reason text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.release_temu_order_shipment_inventory(p_shipment_id, p_reason)
$function$;

revoke all on function private.release_shipment_inventory_reservations(uuid, text)
  from public, anon;
revoke all on function private.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  from public, anon;
revoke all on function private.release_temu_order_shipment_inventory(uuid, text)
  from public, anon;
revoke all on function public.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  from public, anon;
revoke all on function public.release_temu_order_shipment_inventory(uuid, text)
  from public, anon;

grant execute on function private.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  to authenticated;
grant execute on function private.release_temu_order_shipment_inventory(uuid, text)
  to authenticated;
grant execute on function public.assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  to authenticated;
grant execute on function public.release_temu_order_shipment_inventory(uuid, text)
  to authenticated;
