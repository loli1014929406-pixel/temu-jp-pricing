create or replace function private.receive_purchase_package_atomic(
  p_package_id uuid,
  p_received_at timestamptz,
  p_sku_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_package public.purchase_packages%rowtype;
  v_order public.purchase_orders%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_line record;
  v_product_id uuid;
  v_current public.warehouse_skus%rowtype;
  v_updated public.warehouse_skus%rowtype;
  v_member public.shared_inventory_group_members%rowtype;
  v_balance public.shared_inventory_balances%rowtype;
  v_updated_balance public.shared_inventory_balances%rowtype;
  v_base_units numeric;
  v_inventory jsonb := '[]'::jsonb;
  v_status text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if coalesce(jsonb_typeof(p_sku_changes), 'null') <> 'array'
    or jsonb_array_length(p_sku_changes) = 0
  then
    raise exception using errcode = '22023', message = 'SKU changes must be a non-empty array.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    where line.sku_id is null or line.quantity is null or line.quantity <= 0
  ) or exists (
    select 1
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    group by line.sku_id having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Every SKU needs one positive receipt quantity.';
  end if;

  select * into v_package
  from public.purchase_packages package
  where package.id = p_package_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Purchase package not found.';
  end if;
  if v_package.status <> 'pending' then
    raise exception using errcode = '40001', message = 'Purchase package status has changed.';
  end if;

  select * into v_order
  from public.purchase_orders purchase
  where purchase.id = v_package.order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Purchase order not found.';
  end if;
  if not private.current_user_has_shop_action(v_order.shop_id, 'purchases', 'update') then
    raise exception using errcode = '42501', message = 'Purchase receipt access denied.';
  end if;

  select * into v_warehouse
  from public.warehouses warehouse
  where warehouse.id = v_order.warehouse_id
    and warehouse.shop_id = v_order.shop_id
    and warehouse.enterprise_id = v_order.enterprise_id;
  if not found or v_warehouse.stock_location_id is null then
    raise exception using errcode = '23514', message = 'Purchase warehouse scope or stock location is invalid.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    left join public.product_skus sku
      on sku.id = line.sku_id
     and sku.shop_id = v_order.shop_id
     and sku.enterprise_id = v_order.enterprise_id
    where sku.id is null
  ) then
    raise exception using errcode = '23514', message = 'A purchase SKU is outside this shop.';
  end if;

  -- Create zero-balance independent rows first; a shared SKU keeps this row at
  -- zero so it can later leave the group into the selected warehouse.
  for v_line in
    select line.sku_id, line.quantity
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    order by line.sku_id
  loop
    select sku.product_id into strict v_product_id
    from public.product_skus sku where sku.id = v_line.sku_id;

    insert into public.warehouse_skus (
      warehouse_id,
      product_id,
      sku_id,
      owner_id,
      enterprise_id,
      shop_id
    ) values (
      v_order.warehouse_id,
      v_product_id,
      v_line.sku_id,
      auth.uid(),
      v_order.enterprise_id,
      v_order.shop_id
    ) on conflict (warehouse_id, sku_id) do nothing;
  end loop;

  perform member.id
  from public.shared_inventory_group_members member
  where member.sku_id in (
    select line.sku_id
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
  )
    and member.shop_id = v_order.shop_id
    and member.left_at is null
  order by member.id
  for key share;

  perform stock.id
  from public.warehouse_skus stock
  where stock.warehouse_id = v_order.warehouse_id
    and stock.sku_id in (
      select line.sku_id
      from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    )
  order by stock.id
  for update;

  perform balance.id
  from public.shared_inventory_balances balance
  where balance.stock_location_id = v_warehouse.stock_location_id
    and balance.group_id in (
      select member.group_id
      from public.shared_inventory_group_members member
      where member.sku_id in (
        select line.sku_id
        from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
      )
        and member.shop_id = v_order.shop_id
        and member.left_at is null
    )
  order by balance.id
  for update;

  for v_line in
    select line.sku_id, line.quantity
    from jsonb_to_recordset(p_sku_changes) line(sku_id uuid, quantity integer)
    order by line.sku_id
  loop
    select * into strict v_current
    from public.warehouse_skus stock
    where stock.warehouse_id = v_order.warehouse_id
      and stock.sku_id = v_line.sku_id;

    select member.* into v_member
    from public.shared_inventory_group_members member
    where member.sku_id = v_line.sku_id
      and member.shop_id = v_order.shop_id
      and member.left_at is null;

    if found then
      select * into v_balance
      from public.shared_inventory_balances balance
      where balance.group_id = v_member.group_id
        and balance.stock_location_id = v_warehouse.stock_location_id;
      if not found then
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
        perform balance.id
        from public.shared_inventory_balances balance
        where balance.id = v_balance.id
        for update;
      end if;

      v_base_units := v_line.quantity * v_member.base_units_per_sale_unit;
      if v_base_units <> trunc(v_base_units) then
        raise exception using errcode = '23514', message = 'Purchase quantity does not convert to whole shared base units.';
      end if;

      update public.shared_inventory_balances
      set quantity_base_units = quantity_base_units + v_base_units::bigint,
          updated_at = statement_timestamp()
      where id = v_balance.id
      returning * into v_updated_balance;

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
        v_order.enterprise_id,
        v_order.shop_id,
        v_member.group_id,
        v_member.id,
        v_balance.id,
        v_warehouse.stock_location_id,
        v_line.sku_id,
        v_balance.quantity_base_units,
        v_updated_balance.quantity_base_units,
        v_base_units::bigint,
        'purchase_receive',
        v_package.id,
        v_order.order_code,
        '采购入库：' || v_order.order_code,
        auth.uid()
      );

      v_inventory := v_inventory || jsonb_build_array(jsonb_build_object(
        'inventoryKind', 'shared',
        'skuId', v_line.sku_id,
        'previousQuantityBaseUnits', v_balance.quantity_base_units,
        'nextQuantityBaseUnits', v_updated_balance.quantity_base_units,
        'changeQuantityBaseUnits', v_base_units::bigint
      ));
    else
      update public.warehouse_skus
      set stock_quantity = v_current.stock_quantity + v_line.quantity,
          updated_at = statement_timestamp()
      where id = v_current.id
      returning * into v_updated;

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
        v_order.warehouse_id,
        v_line.sku_id,
        auth.uid(),
        v_order.enterprise_id,
        v_order.shop_id,
        v_current.stock_quantity,
        v_updated.stock_quantity,
        v_line.quantity,
        '采购入库：' || v_order.order_code,
        v_order.id,
        v_package.id
      );

      v_inventory := v_inventory || jsonb_build_array(jsonb_build_object(
        'inventoryKind', 'independent',
        'skuId', v_line.sku_id,
        'previousQuantity', v_current.stock_quantity,
        'nextQuantity', v_updated.stock_quantity,
        'changeQuantity', v_line.quantity
      ));
    end if;
  end loop;

  update public.purchase_packages
  set status = 'received',
      received_at = coalesce(p_received_at, statement_timestamp())
  where id = v_package.id
  returning * into v_package;

  select case
    when not exists (
      select 1
      from public.purchase_packages package
      join public.purchase_package_items item on item.package_id = package.id
      where package.order_id = v_order.id
        and package.status = 'received'
        and item.quantity > 0
    ) then 'pending'
    when not exists (
      select 1
      from public.purchase_order_items order_item
      where order_item.order_id = v_order.id
        and coalesce((
          select sum(package_item.quantity)
          from public.purchase_package_items package_item
          join public.purchase_packages package on package.id = package_item.package_id
          where package_item.order_item_id = order_item.id
            and package.status = 'received'
        ), 0) < order_item.quantity
    ) then 'received'
    else 'partially_received'
  end into v_status;

  update public.purchase_orders
  set status = v_status,
      received_at = case
        when v_status = 'received'
          then coalesce(p_received_at, statement_timestamp())
        else null
      end
  where id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'package', to_jsonb(v_package),
    'order', to_jsonb(v_order),
    'inventory', v_inventory
  );
end
$function$;

create or replace function public.receive_purchase_package_atomic(
  p_package_id uuid,
  p_received_at timestamptz,
  p_sku_changes jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select private.receive_purchase_package_atomic(
    p_package_id,
    p_received_at,
    p_sku_changes
  )
$function$;

revoke all on function private.receive_purchase_package_atomic(uuid, timestamptz, jsonb)
  from public, anon;
revoke all on function public.receive_purchase_package_atomic(uuid, timestamptz, jsonb)
  from public, anon;
grant execute on function private.receive_purchase_package_atomic(uuid, timestamptz, jsonb)
  to authenticated;
grant execute on function public.receive_purchase_package_atomic(uuid, timestamptz, jsonb)
  to authenticated;
