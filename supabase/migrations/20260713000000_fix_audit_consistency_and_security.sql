-- Fix consistency and security findings from the 2026-07-13 application audit.

create or replace function public.receive_purchase_package_atomic(
  p_package_id uuid,
  p_received_at timestamptz,
  p_sku_changes jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_package public.purchase_packages%rowtype;
  v_order public.purchase_orders%rowtype;
  v_line record;
  v_product_id uuid;
  v_current public.warehouse_skus%rowtype;
  v_updated public.warehouse_skus%rowtype;
  v_inventory jsonb := '[]'::jsonb;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_sku_changes), 'null') <> 'array' then
    raise exception 'SKU changes must be an array' using errcode = '22023';
  end if;

  select * into v_package
  from public.purchase_packages
  where id = p_package_id
  for update;
  if not found then
    raise exception 'Purchase package not found' using errcode = 'P0002';
  end if;
  if v_package.status <> 'pending' then
    raise exception 'Purchase package status has changed' using errcode = '40001';
  end if;

  select * into v_order
  from public.purchase_orders
  where id = v_package.order_id
  for update;
  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;

  for v_line in
    select line.sku_id, line.quantity
    from jsonb_to_recordset(p_sku_changes) as line(sku_id uuid, quantity integer)
    order by line.sku_id
  loop
    if v_line.sku_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception 'SKU and positive quantity are required' using errcode = '22023';
    end if;
    select product_id into v_product_id
    from public.product_skus
    where id = v_line.sku_id;
    if v_product_id is null then
      raise exception 'Purchase SKU not found' using errcode = 'P0002';
    end if;

    insert into public.warehouse_skus (warehouse_id, product_id, sku_id, owner_id)
    values (v_order.warehouse_id, v_product_id, v_line.sku_id, v_user_id)
    on conflict (warehouse_id, sku_id) do nothing;

    select * into v_current
    from public.warehouse_skus
    where warehouse_id = v_order.warehouse_id and sku_id = v_line.sku_id
    for update;

    update public.warehouse_skus
    set stock_quantity = v_current.stock_quantity + v_line.quantity
    where id = v_current.id
    returning * into v_updated;

    insert into public.warehouse_sku_stock_adjustments (
      warehouse_id, sku_id, previous_quantity, next_quantity, change_quantity,
      reason, purchase_order_id, purchase_package_id
    ) values (
      v_order.warehouse_id, v_line.sku_id, v_current.stock_quantity,
      v_updated.stock_quantity, v_line.quantity,
      '采购入库：' || v_order.order_code, v_order.id, v_package.id
    );

    v_inventory := v_inventory || jsonb_build_array(jsonb_build_object(
      'skuId', v_line.sku_id,
      'previousQuantity', v_current.stock_quantity,
      'nextQuantity', v_updated.stock_quantity,
      'changeQuantity', v_line.quantity
    ));
  end loop;

  update public.purchase_packages
  set status = 'received', received_at = coalesce(p_received_at, now())
  where id = v_package.id
  returning * into v_package;

  select case
    when not exists (
      select 1 from public.purchase_packages p
      join public.purchase_package_items pi on pi.package_id = p.id
      where p.order_id = v_order.id and p.status = 'received' and pi.quantity > 0
    ) then 'pending'
    when not exists (
      select 1
      from public.purchase_order_items oi
      where oi.order_id = v_order.id
        and coalesce((
          select sum(pi.quantity)
          from public.purchase_package_items pi
          join public.purchase_packages p on p.id = pi.package_id
          where pi.order_item_id = oi.id and p.status = 'received'
        ), 0) < oi.quantity
    ) then 'received'
    else 'partially_received'
  end into v_status;

  update public.purchase_orders
  set status = v_status,
      received_at = case when v_status = 'received' then coalesce(p_received_at, now()) else null end
  where id = v_order.id
  returning * into v_order;

  return jsonb_build_object('package', to_jsonb(v_package), 'order', to_jsonb(v_order), 'inventory', v_inventory);
end;
$$;

revoke all on function public.receive_purchase_package_atomic(uuid, timestamptz, jsonb) from public;
grant execute on function public.receive_purchase_package_atomic(uuid, timestamptz, jsonb) to authenticated;

create or replace function public.import_finance_settlement_atomic(
  p_file_name text,
  p_imported_at timestamptz,
  p_total_sales_revenue numeric,
  p_total_freight_revenue numeric,
  p_total_revenue numeric,
  p_records jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_file public.finance_settlement_files%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_file_name, '')) = '' or coalesce(jsonb_typeof(p_records), 'null') <> 'array'
     or jsonb_array_length(p_records) = 0 then
    raise exception 'File name and settlement records are required' using errcode = '22023';
  end if;

  insert into public.finance_settlement_files (
    user_id, file_name, date_range_start, date_range_end,
    total_sales_revenue, total_freight_revenue, total_revenue, record_count, imported_at
  ) values (
    v_user_id, btrim(p_file_name), to_char(p_imported_at at time zone 'UTC', 'YYYYMMDD'),
    to_char(p_imported_at at time zone 'UTC', 'YYYYMMDD'),
    p_total_sales_revenue, p_total_freight_revenue, p_total_revenue,
    jsonb_array_length(p_records), p_imported_at
  ) returning * into v_file;

  insert into public.finance_settlement_records (
    user_id, file_id, po_number, sku_id, sku_name, sku_code, quantity,
    declared_price, is_promotion_price, currency, sales_revenue,
    sales_discount_deducted, sales_reversal, freight_revenue,
    freight_discount_deducted, freight_reversal, total_revenue
  )
  select v_user_id, v_file.id, r.po_number, r.sku_id, r.sku_name, r.sku_code,
    r.quantity, r.declared_price, r.is_promotion_price, r.currency,
    r.sales_revenue, r.sales_discount_deducted, r.sales_reversal,
    r.freight_revenue, r.freight_discount_deducted, r.freight_reversal, r.total_revenue
  from jsonb_to_recordset(p_records) as r(
    po_number text, sku_id text, sku_name text, sku_code text, quantity integer,
    declared_price numeric, is_promotion_price boolean, currency text,
    sales_revenue numeric, sales_discount_deducted numeric, sales_reversal numeric,
    freight_revenue numeric, freight_discount_deducted numeric, freight_reversal numeric,
    total_revenue numeric
  );

  return to_jsonb(v_file);
end;
$$;

revoke all on function public.import_finance_settlement_atomic(text, timestamptz, numeric, numeric, numeric, jsonb) from public;
grant execute on function public.import_finance_settlement_atomic(text, timestamptz, numeric, numeric, numeric, jsonb) to authenticated;

create or replace function public.update_product_structure_atomic(
  p_product_id uuid,
  p_product jsonb,
  p_items jsonb,
  p_skus jsonb,
  p_limits jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item record;
  v_sku record;
  v_link record;
  v_limit record;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not public.current_account_can_edit() then raise exception 'Edit permission required' using errcode = '42501'; end if;
  if coalesce(jsonb_typeof(p_items), 'null') <> 'array'
    or coalesce(jsonb_typeof(p_skus), 'null') <> 'array'
    or coalesce(jsonb_typeof(p_limits), 'null') <> 'array' then
    raise exception 'Product structure arrays are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as item(id uuid)
    join public.product_items existing on existing.id = item.id
    where existing.product_id <> p_product_id
  ) or exists (
    select 1 from jsonb_to_recordset(p_skus) as sku(id uuid)
    join public.product_skus existing on existing.id = sku.id
    where existing.product_id <> p_product_id
  ) then
    raise exception 'Product child row belongs to another product' using errcode = '42501';
  end if;

  update public.products set
    product_code = p_product->>'product_code',
    product_name_cn = p_product->>'product_name_cn',
    product_name_en = p_product->>'product_name_en',
    material_en = p_product->>'material_en',
    material_cn = p_product->>'material_cn',
    combo_name = p_product->>'combo_name',
    combo_description = p_product->>'combo_description',
    title_jp = p_product->>'title_jp',
    package_length_cm = (p_product->>'package_length_cm')::numeric,
    package_width_cm = (p_product->>'package_width_cm')::numeric,
    package_height_cm = (p_product->>'package_height_cm')::numeric,
    package_weight_g = (p_product->>'package_weight_g')::numeric,
    max_units_per_parcel = (p_product->>'max_units_per_parcel')::integer,
    is_selling = (p_product->>'is_selling')::boolean,
    notes = p_product->>'notes'
  where id = p_product_id;

  for v_item in select * from jsonb_to_recordset(p_items) as item(
    id uuid, item_name text, item_spec text, quantity integer,
    item_length_cm numeric, item_width_cm numeric, item_height_cm numeric,
    item_weight_g numeric, purchase_price_rmb numeric,
    purchase_shipping_fee_per_500g_rmb numeric, purchase_url text
  ) loop
    insert into public.product_items (
      id, product_id, item_name, item_spec, quantity, item_length_cm,
      item_width_cm, item_height_cm, item_weight_g, purchase_price_rmb,
      purchase_shipping_fee_per_500g_rmb, purchase_url
    ) values (
      v_item.id, p_product_id, v_item.item_name, v_item.item_spec, v_item.quantity,
      v_item.item_length_cm, v_item.item_width_cm, v_item.item_height_cm,
      v_item.item_weight_g, v_item.purchase_price_rmb,
      v_item.purchase_shipping_fee_per_500g_rmb, v_item.purchase_url
    ) on conflict (id) do update set
      item_name = excluded.item_name, item_spec = excluded.item_spec,
      quantity = excluded.quantity, item_length_cm = excluded.item_length_cm,
      item_width_cm = excluded.item_width_cm, item_height_cm = excluded.item_height_cm,
      item_weight_g = excluded.item_weight_g, purchase_price_rmb = excluded.purchase_price_rmb,
      purchase_shipping_fee_per_500g_rmb = excluded.purchase_shipping_fee_per_500g_rmb,
      purchase_url = excluded.purchase_url;
  end loop;

  for v_sku in select * from jsonb_to_recordset(p_skus) as sku(
    id uuid, sku_code text, temu_image_url text, attributes jsonb, notes text, links jsonb
  ) loop
    insert into public.product_skus (id, product_id, sku_code, temu_image_url, attributes, notes)
    values (v_sku.id, p_product_id, v_sku.sku_code, v_sku.temu_image_url, v_sku.attributes, v_sku.notes)
    on conflict (id) do update set sku_code = excluded.sku_code,
      temu_image_url = excluded.temu_image_url, attributes = excluded.attributes, notes = excluded.notes;
  end loop;

  delete from public.product_sku_items
  where sku_id in (select id from public.product_skus where product_id = p_product_id);
  for v_sku in select * from jsonb_to_recordset(p_skus) as sku(id uuid, links jsonb) loop
    for v_link in select * from jsonb_to_recordset(v_sku.links) as link(item_id uuid, quantity integer) loop
      if v_link.item_id is null or v_link.quantity is null or v_link.quantity <= 0
        or not exists (select 1 from public.product_items where id = v_link.item_id and product_id = p_product_id) then
        raise exception 'Invalid SKU component link' using errcode = '22023';
      end if;
      insert into public.product_sku_items (sku_id, item_id, quantity)
      values (v_sku.id, v_link.item_id, v_link.quantity);
    end loop;
  end loop;

  delete from public.product_skus
  where product_id = p_product_id
    and id not in (select id from jsonb_to_recordset(p_skus) as desired(id uuid));
  delete from public.product_items
  where product_id = p_product_id
    and id not in (select id from jsonb_to_recordset(p_items) as desired(id uuid));

  for v_limit in select * from jsonb_to_recordset(p_limits) as lim(warehouse_id uuid, max_units_per_parcel integer) loop
    insert into public.product_warehouse_shipping_limits (
      owner_id, product_id, warehouse_id, max_units_per_parcel
    ) values (auth.uid(), p_product_id, v_limit.warehouse_id, greatest(v_limit.max_units_per_parcel, 1))
    on conflict (product_id, warehouse_id) do update
      set max_units_per_parcel = excluded.max_units_per_parcel;
  end loop;
end;
$$;

revoke all on function public.update_product_structure_atomic(uuid, jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.update_product_structure_atomic(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- Permission bootstrap is fail-closed. Initial admins are created explicitly in
-- the Supabase dashboard/SQL editor with elevated credentials.
create or replace function public.current_account_permission()
returns text language sql stable security definer set search_path = public
as $$
  select coalesce((
    select permission_level from public.account_permissions
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1
  ), 'viewer')
$$;

create or replace function public.current_account_has_permission()
returns boolean language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.account_permissions
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

revoke all on function public.current_account_permission() from public;
revoke all on function public.current_account_has_permission() from public;
grant execute on function public.current_account_permission() to authenticated;
grant execute on function public.current_account_has_permission() to authenticated;
