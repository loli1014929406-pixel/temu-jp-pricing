create or replace function public.create_purchase_order_atomic(
  p_warehouse_id uuid,
  p_warehouse_name text,
  p_purchased_at date,
  p_notes text,
  p_sources jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.purchase_orders%rowtype;
  v_sources jsonb;
  v_items jsonb;
  v_items_total numeric;
  v_freight_total numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_warehouse_id is null or btrim(coalesce(p_warehouse_name, '')) = '' then
    raise exception 'Warehouse is required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_sources), 'null') <> 'array' or jsonb_array_length(p_sources) = 0 then
    raise exception 'At least one purchase source is required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one purchase item is required' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(purchase_url text)
    where not exists (
      select 1
      from jsonb_to_recordset(p_sources) as source(purchase_url text)
      where source.purchase_url = item.purchase_url
    )
  ) then
    raise exception 'Every purchase item must match a purchase source' using errcode = '23503';
  end if;

  select coalesce(sum(item.quantity * item.unit_price_rmb), 0)
  into v_items_total
  from jsonb_to_recordset(p_items) as item(quantity integer, unit_price_rmb numeric);

  select coalesce(sum(source.freight_rmb), 0)
  into v_freight_total
  from jsonb_to_recordset(p_sources) as source(freight_rmb numeric);

  insert into public.purchase_orders (
    owner_id,
    warehouse_id,
    warehouse_name,
    purchased_at,
    items_total_rmb,
    total_cost_rmb,
    notes
  )
  values (
    v_user_id,
    p_warehouse_id,
    btrim(p_warehouse_name),
    coalesce(p_purchased_at, current_date),
    v_items_total,
    v_items_total + v_freight_total,
    coalesce(p_notes, '')
  )
  returning * into v_order;

  with inserted_sources as (
    insert into public.purchase_order_sources (
      order_id,
      owner_id,
      purchase_url,
      alibaba_order_no,
      freight_rmb
    )
    select
      v_order.id,
      v_user_id,
      btrim(source.purchase_url),
      coalesce(source.alibaba_order_no, ''),
      coalesce(source.freight_rmb, 0)
    from jsonb_to_recordset(p_sources) as source(
      purchase_url text,
      alibaba_order_no text,
      freight_rmb numeric
    )
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted_sources)), '[]'::jsonb)
  into v_sources
  from inserted_sources;

  with inserted_items as (
    insert into public.purchase_order_items (
      order_id,
      owner_id,
      product_id,
      item_id,
      sku_id,
      sku_quantity,
      source_id,
      product_code,
      product_name_cn,
      item_name,
      item_spec,
      purchase_url,
      quantity,
      unit_price_rmb
    )
    select
      v_order.id,
      v_user_id,
      item.product_id,
      item.item_id,
      item.sku_id,
      item.sku_quantity,
      source.id,
      coalesce(item.product_code, ''),
      coalesce(item.product_name_cn, ''),
      coalesce(item.item_name, ''),
      coalesce(item.item_spec, ''),
      coalesce(item.purchase_url, ''),
      item.quantity,
      coalesce(item.unit_price_rmb, 0)
    from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      item_id uuid,
      sku_id uuid,
      sku_quantity integer,
      product_code text,
      product_name_cn text,
      item_name text,
      item_spec text,
      purchase_url text,
      quantity integer,
      unit_price_rmb numeric
    )
    join public.purchase_order_sources source
      on source.order_id = v_order.id
     and source.owner_id = v_user_id
     and source.purchase_url = item.purchase_url
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted_items)), '[]'::jsonb)
  into v_items
  from inserted_items;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'sources', v_sources,
    'items', v_items
  );
end;
$$;

revoke all on function public.create_purchase_order_atomic(uuid, text, date, text, jsonb, jsonb) from public;
grant execute on function public.create_purchase_order_atomic(uuid, text, date, text, jsonb, jsonb) to authenticated;

create or replace function public.update_purchase_source_atomic(
  p_source_id uuid,
  p_alibaba_order_no text,
  p_freight_rmb numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_source public.purchase_order_sources%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_freight_rmb is null or p_freight_rmb < 0 then
    raise exception 'Freight must be zero or greater' using errcode = '22023';
  end if;

  update public.purchase_order_sources
  set
    alibaba_order_no = coalesce(p_alibaba_order_no, ''),
    freight_rmb = p_freight_rmb
  where id = p_source_id
    and owner_id = v_user_id
  returning * into v_source;

  if not found then
    raise exception 'Purchase source not found' using errcode = 'P0002';
  end if;

  update public.purchase_orders purchase_order
  set total_cost_rmb = purchase_order.items_total_rmb + (
    select coalesce(sum(source.freight_rmb), 0)
    from public.purchase_order_sources source
    where source.order_id = v_source.order_id
      and source.owner_id = v_user_id
  )
  where purchase_order.id = v_source.order_id
    and purchase_order.owner_id = v_user_id;

  return to_jsonb(v_source);
end;
$$;

revoke all on function public.update_purchase_source_atomic(uuid, text, numeric) from public;
grant execute on function public.update_purchase_source_atomic(uuid, text, numeric) to authenticated;

create or replace function public.transfer_warehouse_sku_inventory_atomic(
  p_source_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_line record;
  v_current public.warehouse_skus%rowtype;
  v_updated public.warehouse_skus%rowtype;
  v_adjustment public.warehouse_sku_stock_adjustments%rowtype;
  v_stocks jsonb := '[]'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_source_warehouse_id is null or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Source warehouse and reason are required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_lines), 'null') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one transfer line is required' using errcode = '22023';
  end if;

  for v_line in
    select line.product_id, line.sku_id, line.quantity
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      sku_id uuid,
      quantity integer
    )
    order by line.sku_id
  loop
    if v_line.sku_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception 'Transfer SKU and positive quantity are required' using errcode = '22023';
    end if;

    select *
    into v_current
    from public.warehouse_skus
    where warehouse_id = p_source_warehouse_id
      and sku_id = v_line.sku_id
    for update;

    if not found then
      raise exception 'Source warehouse SKU stock is missing' using errcode = 'P0002';
    end if;
    if v_current.stock_quantity < v_line.quantity then
      raise exception 'Source warehouse SKU stock is insufficient' using errcode = 'P0001';
    end if;

    update public.warehouse_skus
    set stock_quantity = v_current.stock_quantity - v_line.quantity
    where id = v_current.id
    returning * into v_updated;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id,
      sku_id,
      previous_quantity,
      next_quantity,
      change_quantity,
      reason,
      purchase_order_id,
      purchase_package_id
    )
    values (
      v_current.warehouse_id,
      v_current.sku_id,
      v_current.stock_quantity,
      v_updated.stock_quantity,
      -v_line.quantity,
      p_reason,
      null,
      null
    )
    returning * into v_adjustment;

    v_stocks := v_stocks || jsonb_build_array(to_jsonb(v_updated));
    v_adjustments := v_adjustments || jsonb_build_array(to_jsonb(v_adjustment));
  end loop;

  return jsonb_build_object(
    'warehouseSkus', v_stocks,
    'adjustments', v_adjustments
  );
end;
$$;

revoke all on function public.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb) from public;
grant execute on function public.transfer_warehouse_sku_inventory_atomic(uuid, text, jsonb) to authenticated;

create or replace function public.receive_warehouse_sku_transfer_atomic(
  p_destination_warehouse_id uuid,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_line record;
  v_current public.warehouse_skus%rowtype;
  v_updated public.warehouse_skus%rowtype;
  v_adjustment public.warehouse_sku_stock_adjustments%rowtype;
  v_received_quantity integer;
  v_receive_quantity integer;
  v_stocks jsonb := '[]'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_destination_warehouse_id is null or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Destination warehouse and reason are required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_lines), 'null') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one transfer line is required' using errcode = '22023';
  end if;

  for v_line in
    select line.product_id, line.sku_id, line.quantity
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      sku_id uuid,
      quantity integer
    )
    order by line.sku_id
  loop
    if v_line.product_id is null or v_line.sku_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception 'Transfer product, SKU and positive quantity are required' using errcode = '22023';
    end if;

    insert into public.warehouse_skus (
      warehouse_id,
      product_id,
      sku_id,
      owner_id
    )
    values (
      p_destination_warehouse_id,
      v_line.product_id,
      v_line.sku_id,
      v_user_id
    )
    on conflict (warehouse_id, sku_id) do nothing;

    select *
    into v_current
    from public.warehouse_skus
    where warehouse_id = p_destination_warehouse_id
      and sku_id = v_line.sku_id
    for update;

    if not found then
      raise exception 'Destination warehouse SKU stock is missing' using errcode = 'P0002';
    end if;

    select greatest(0, coalesce(sum(change_quantity), 0))::integer
    into v_received_quantity
    from public.warehouse_sku_stock_adjustments
    where warehouse_id = p_destination_warehouse_id
      and sku_id = v_line.sku_id
      and reason = p_reason;

    v_receive_quantity := v_line.quantity - v_received_quantity;
    if v_receive_quantity > 0 then
      update public.warehouse_skus
      set stock_quantity = v_current.stock_quantity + v_receive_quantity
      where id = v_current.id
      returning * into v_updated;

      insert into public.warehouse_sku_stock_adjustments (
        warehouse_id,
        sku_id,
        previous_quantity,
        next_quantity,
        change_quantity,
        reason,
        purchase_order_id,
        purchase_package_id
      )
      values (
        p_destination_warehouse_id,
        v_current.sku_id,
        v_current.stock_quantity,
        v_updated.stock_quantity,
        v_receive_quantity,
        p_reason,
        null,
        null
      )
      returning * into v_adjustment;

      v_stocks := v_stocks || jsonb_build_array(to_jsonb(v_updated));
      v_adjustments := v_adjustments || jsonb_build_array(to_jsonb(v_adjustment));
    else
      v_stocks := v_stocks || jsonb_build_array(to_jsonb(v_current));
    end if;
  end loop;

  return jsonb_build_object(
    'warehouseSkus', v_stocks,
    'adjustments', v_adjustments
  );
end;
$$;

revoke all on function public.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb) from public;
grant execute on function public.receive_warehouse_sku_transfer_atomic(uuid, text, jsonb) to authenticated;

revoke all on table public.finance_expenses from anon;
revoke all on table public.finance_settlement_files from anon;
revoke all on table public.finance_settlement_records from anon;

alter function public.deduct_inventory_atomic(jsonb) set search_path = public;
alter function public.reserve_order_sku_inventory(uuid, uuid, integer, text) set search_path = public;
alter function public.release_order_sku_inventory(uuid, text) set search_path = public;

revoke all on function public.deduct_inventory_atomic(jsonb) from public;
revoke all on function public.reserve_order_sku_inventory(uuid, uuid, integer, text) from public;
revoke all on function public.release_order_sku_inventory(uuid, text) from public;

grant execute on function public.deduct_inventory_atomic(jsonb) to authenticated;
grant execute on function public.reserve_order_sku_inventory(uuid, uuid, integer, text) to authenticated;
grant execute on function public.release_order_sku_inventory(uuid, text) to authenticated;

create index if not exists idx_temu_orders_owner_ship_created
on public.temu_orders(owner_id, latest_ship_time, created_at desc);

create index if not exists idx_temu_orders_owner_status_created
on public.temu_orders(owner_id, order_status, created_at desc);

create index if not exists idx_purchase_order_items_owner_order
on public.purchase_order_items(owner_id, order_id);

create index if not exists idx_purchase_packages_owner_order
on public.purchase_packages(owner_id, order_id);

create index if not exists idx_purchase_package_items_owner_package
on public.purchase_package_items(owner_id, package_id);

create index if not exists idx_warehouse_sku_adjustments_lookup
on public.warehouse_sku_stock_adjustments(warehouse_id, sku_id, reason);

create index if not exists idx_order_sku_reservations_owner_order
on public.temu_order_sku_inventory_reservations(owner_id, order_id);
