-- Keep SKU stock balances and the inventory adjustment ledger in sync for
-- order reservation, reservation moves, and reservation releases.

create or replace function public.reserve_order_sku_inventory(
  p_order_id uuid,
  p_warehouse_sku_id uuid,
  p_quantity integer,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.temu_orders%rowtype;
  v_existing public.temu_order_sku_inventory_reservations%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_existing_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
  v_reason text := coalesce(nullif(trim(p_reason), ''), '订单库存占用');
  v_release_reason text;
begin
  if not public.current_account_can_edit() then
    raise exception '权限不足，无法占用订单库存';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception '订单库存占用数量必须大于 0';
  end if;

  select *
  into v_order
  from public.temu_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '订单不存在，无法占用库存';
  end if;

  select *
  into v_existing
  from public.temu_order_sku_inventory_reservations
  where order_id = p_order_id
    and released_at is null
  for update;

  if found and v_existing.warehouse_sku_id = p_warehouse_sku_id and v_existing.quantity = p_quantity then
    return jsonb_build_object('changes', v_changes, 'status', 'already_reserved');
  end if;

  if found then
    perform id
    from public.warehouse_skus
    where id in (v_existing.warehouse_sku_id, p_warehouse_sku_id)
    order by id
    for update;

    select *
    into v_existing_stock
    from public.warehouse_skus
    where id = v_existing.warehouse_sku_id;

    if not found then
      raise exception '原订单 SKU 库存不存在，无法调整库存占用';
    end if;

    update public.warehouse_skus
    set stock_quantity = stock_quantity + v_existing.quantity,
        updated_at = now()
    where id = v_existing_stock.id
    returning * into v_next_stock;

    v_release_reason := '订单库存占用变更回补：' || coalesce(nullif(trim(v_order.order_no), ''), v_order.id::text);

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      owner_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    ) values (
      v_existing_stock.warehouse_id,
      v_existing_stock.sku_id,
      v_order.owner_id,
      v_existing_stock.stock_quantity,
      v_next_stock.stock_quantity,
      v_existing.quantity,
      v_release_reason,
      null,
      null
    );

    update public.temu_order_sku_inventory_reservations
    set released_at = now(),
        released_reason = '订单库存占用变更'
    where id = v_existing.id;

    v_changes := v_changes || jsonb_build_object(
      'sku', to_jsonb(v_next_stock),
      'previous_quantity', v_existing_stock.stock_quantity,
      'change_quantity', v_existing.quantity
    );
  else
    perform id
    from public.warehouse_skus
    where id = p_warehouse_sku_id
    for update;
  end if;

  select *
  into v_stock
  from public.warehouse_skus
  where id = p_warehouse_sku_id;

  if not found then
    raise exception '仓库 SKU 库存不存在，无法占用库存';
  end if;

  if v_stock.stock_quantity < p_quantity then
    raise exception '仓库 SKU 库存不足：当前 %，需要 %', v_stock.stock_quantity, p_quantity;
  end if;

  update public.warehouse_skus
  set stock_quantity = stock_quantity - p_quantity,
      updated_at = now()
  where id = v_stock.id
  returning * into v_next_stock;

  insert into public.temu_order_sku_inventory_reservations (
    order_id,
    warehouse_sku_id,
    owner_id,
    quantity,
    reason
  )
  values (
    p_order_id,
    p_warehouse_sku_id,
    v_order.owner_id,
    p_quantity,
    v_reason
  );

  insert into public.warehouse_sku_stock_adjustments (
    warehouse_id,
    sku_id,
    owner_id,
    previous_quantity,
    next_quantity,
    change_quantity,
    reason,
    purchase_order_id,
    purchase_package_id
  ) values (
    v_stock.warehouse_id,
    v_stock.sku_id,
    v_order.owner_id,
    v_stock.stock_quantity,
    v_next_stock.stock_quantity,
    -p_quantity,
    v_reason,
    null,
    null
  );

  v_changes := v_changes || jsonb_build_object(
    'sku', to_jsonb(v_next_stock),
    'previous_quantity', v_stock.stock_quantity,
    'change_quantity', -p_quantity
  );

  return jsonb_build_object('changes', v_changes, 'status', 'reserved');
end;
$$;

revoke all on function public.reserve_order_sku_inventory(uuid, uuid, integer, text) from public;
grant execute on function public.reserve_order_sku_inventory(uuid, uuid, integer, text) to authenticated;

create or replace function public.release_order_sku_inventory(
  p_order_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.temu_orders%rowtype;
  v_existing public.temu_order_sku_inventory_reservations%rowtype;
  v_stock public.warehouse_skus%rowtype;
  v_next_stock public.warehouse_skus%rowtype;
  v_changes jsonb := '[]'::jsonb;
  v_reason text := coalesce(nullif(trim(p_reason), ''), '订单库存释放');
begin
  if not public.current_account_can_edit() then
    raise exception '权限不足，无法释放订单库存';
  end if;

  select *
  into v_order
  from public.temu_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '订单不存在，无法释放库存';
  end if;

  select *
  into v_existing
  from public.temu_order_sku_inventory_reservations
  where order_id = p_order_id
    and released_at is null
  for update;

  if not found then
    return jsonb_build_object('changes', v_changes, 'status', 'not_reserved');
  end if;

  select *
  into v_stock
  from public.warehouse_skus
  where id = v_existing.warehouse_sku_id
  for update;

  if not found then
    raise exception '仓库 SKU 库存不存在，无法释放库存';
  end if;

  update public.warehouse_skus
  set stock_quantity = stock_quantity + v_existing.quantity,
      updated_at = now()
  where id = v_stock.id
  returning * into v_next_stock;

  insert into public.warehouse_sku_stock_adjustments (
    warehouse_id,
    sku_id,
    owner_id,
    previous_quantity,
    next_quantity,
    change_quantity,
    reason,
    purchase_order_id,
    purchase_package_id
  ) values (
    v_stock.warehouse_id,
    v_stock.sku_id,
    v_order.owner_id,
    v_stock.stock_quantity,
    v_next_stock.stock_quantity,
    v_existing.quantity,
    v_reason,
    null,
    null
  );

  update public.temu_order_sku_inventory_reservations
  set released_at = now(),
      released_reason = v_reason
  where id = v_existing.id;

  v_changes := v_changes || jsonb_build_object(
    'sku', to_jsonb(v_next_stock),
    'previous_quantity', v_stock.stock_quantity,
    'change_quantity', v_existing.quantity
  );

  return jsonb_build_object('changes', v_changes, 'status', 'released');
end;
$$;

revoke all on function public.release_order_sku_inventory(uuid, text) from public;
grant execute on function public.release_order_sku_inventory(uuid, text) to authenticated;
