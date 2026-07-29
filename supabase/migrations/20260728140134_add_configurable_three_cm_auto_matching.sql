-- Configurable, exact-ID warehouse routing for single-SKU 3cm auto matching.
-- The global switch remains disabled after deployment until logistics methods are classified.

alter table public.warehouses
  add column if not exists auto_match_enabled boolean not null default false,
  add column if not exists auto_match_priority integer;

alter table public.warehouses
  drop constraint if exists warehouses_auto_match_priority_check;

alter table public.warehouses
  add constraint warehouses_auto_match_priority_check
  check (
    (not auto_match_enabled and auto_match_priority is null)
    or (auto_match_enabled and auto_match_priority is not null and auto_match_priority > 0)
  );

create unique index if not exists warehouses_name_exact_unique
  on public.warehouses (lower(btrim(name)));

create unique index if not exists warehouses_auto_match_priority_unique
  on public.warehouses (auto_match_priority)
  where auto_match_enabled;

alter table public.logistics_methods
  add column if not exists leg_type text,
  add column if not exists parcel_type text;

alter table public.logistics_methods
  drop constraint if exists logistics_methods_leg_type_check;

alter table public.logistics_methods
  add constraint logistics_methods_leg_type_check
  check (leg_type is null or leg_type in ('first_leg', 'last_leg'));

alter table public.logistics_methods
  drop constraint if exists logistics_methods_parcel_type_check;

alter table public.logistics_methods
  add constraint logistics_methods_parcel_type_check
  check (parcel_type is null or parcel_type in ('three_cm_only', 'standard'));

-- Backfill method type from exact master IDs already stored in pricing settings.
update public.logistics_methods method
set leg_type = 'first_leg'
where exists (
  select 1
  from public.pricing_settings setting
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(setting.first_leg_methods) = 'array'
        then setting.first_leg_methods
      else '[]'::jsonb
    end
  ) configured
  where configured ->> 'db_method_id' = method.id::text
);

update public.logistics_methods method
set leg_type = 'last_leg'
where exists (
  select 1
  from public.pricing_settings setting
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(setting.last_leg_methods) = 'array'
        then setting.last_leg_methods
      else '[]'::jsonb
    end
  ) configured
  where configured ->> 'db_method_id' = method.id::text
);

alter table public.products
  drop constraint if exists products_max_units_per_parcel_check;

alter table public.products
  add constraint products_max_units_per_parcel_check
  check (max_units_per_parcel >= 0);

alter table public.product_warehouse_shipping_limits
  drop constraint if exists product_warehouse_shipping_limits_max_units_per_parcel_check;

alter table public.product_warehouse_shipping_limits
  add constraint product_warehouse_shipping_limits_max_units_per_parcel_check
  check (max_units_per_parcel >= 0);

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
as $function$
declare
  v_item record;
  v_sku record;
  v_link record;
  v_limit record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
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
    values (
      v_sku.id,
      p_product_id,
      v_sku.sku_code,
      v_sku.temu_image_url,
      v_sku.attributes,
      v_sku.notes
    )
    on conflict (id) do update set
      sku_code = excluded.sku_code,
      temu_image_url = excluded.temu_image_url,
      attributes = excluded.attributes,
      notes = excluded.notes;
  end loop;

  delete from public.product_sku_items
  where sku_id in (select id from public.product_skus where product_id = p_product_id);
  for v_sku in select * from jsonb_to_recordset(p_skus) as sku(id uuid, links jsonb) loop
    for v_link in
      select *
      from jsonb_to_recordset(v_sku.links) as link(item_id uuid, quantity integer)
    loop
      if v_link.item_id is null
        or v_link.quantity is null
        or v_link.quantity <= 0
        or not exists (
          select 1
          from public.product_items
          where id = v_link.item_id
            and product_id = p_product_id
        ) then
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

  for v_limit in
    select *
    from jsonb_to_recordset(p_limits)
      as lim(warehouse_id uuid, max_units_per_parcel integer)
  loop
    insert into public.product_warehouse_shipping_limits (
      owner_id,
      product_id,
      warehouse_id,
      max_units_per_parcel
    ) values (
      auth.uid(),
      p_product_id,
      v_limit.warehouse_id,
      greatest(coalesce(v_limit.max_units_per_parcel, 1), 0)
    )
    on conflict (product_id, warehouse_id) do update
      set max_units_per_parcel = excluded.max_units_per_parcel;
  end loop;
end;
$function$;

revoke all on function public.update_product_structure_atomic(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon;
grant execute on function public.update_product_structure_atomic(uuid, jsonb, jsonb, jsonb, jsonb)
  to authenticated, service_role;

-- Warehouse and tail identities must both be selected by exact stable IDs.
create or replace function public.temu_order_shipment_stage(
  p_shipment public.temu_order_shipments
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when btrim(p_shipment.actual_signed_time) <> '' then 'completed'
    when lower(btrim(p_shipment.order_status)) in ('上传temu', '已上传temu') then 'uploaded_temu'
    when btrim(p_shipment.actual_ship_time) <> ''
      or btrim(p_shipment.logistics_tracking_no) <> '' then 'shipped'
    when btrim(p_shipment.label_printed_at) <> '' then 'pending_shipping'
    when p_shipment.warehouse_id is not null
      and p_shipment.logistics_method_id is not null then 'new_order'
    else 'pending_assignment'
  end
$function$;

revoke all on function public.temu_order_shipment_stage(public.temu_order_shipments)
  from public, anon;
grant execute on function public.temu_order_shipment_stage(public.temu_order_shipments)
  to authenticated, service_role;

create table if not exists public.order_auto_match_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.order_auto_match_settings (id, enabled)
values (true, false)
on conflict (id) do nothing;

alter table public.order_auto_match_settings enable row level security;

drop policy if exists order_auto_match_settings_select_authenticated
  on public.order_auto_match_settings;
create policy order_auto_match_settings_select_authenticated
  on public.order_auto_match_settings
  for select
  to authenticated
  using ((select public.current_account_has_permission()));

drop policy if exists order_auto_match_settings_insert_editor
  on public.order_auto_match_settings;
create policy order_auto_match_settings_insert_editor
  on public.order_auto_match_settings
  for insert
  to authenticated
  with check ((select public.current_account_can_edit()));

drop policy if exists order_auto_match_settings_update_editor
  on public.order_auto_match_settings;
create policy order_auto_match_settings_update_editor
  on public.order_auto_match_settings
  for update
  to authenticated
  using ((select public.current_account_can_edit()))
  with check ((select public.current_account_can_edit()));

revoke all on table public.order_auto_match_settings from public, anon;
grant select, insert, update on table public.order_auto_match_settings to authenticated;
grant all on table public.order_auto_match_settings to service_role;

create or replace function public.touch_order_auto_match_settings_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$function$;

revoke all on function public.touch_order_auto_match_settings_updated_at()
  from public, anon;

drop trigger if exists order_auto_match_settings_touch_updated_at
  on public.order_auto_match_settings;
create trigger order_auto_match_settings_touch_updated_at
before update on public.order_auto_match_settings
for each row
execute function public.touch_order_auto_match_settings_updated_at();

create or replace function public.save_warehouse_auto_match_rules(p_rules jsonb)
returns setof public.warehouses
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_rule record;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能修改自动匹配仓库规则。'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_rules) <> 'array' then
    raise exception '仓库自动匹配规则格式不正确。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rules)
      as rule(warehouse_id uuid, auto_match_enabled boolean, auto_match_priority integer)
    where rule.warehouse_id is null
       or (
         coalesce(rule.auto_match_enabled, false)
         and (rule.auto_match_priority is null or rule.auto_match_priority <= 0)
       )
       or (
         not coalesce(rule.auto_match_enabled, false)
         and rule.auto_match_priority is not null
       )
  ) then
    raise exception '参与自动匹配的仓库必须设置大于 0 的优先级，未参与仓库不能保留优先级。'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select rule.warehouse_id
      from jsonb_to_recordset(p_rules)
        as rule(warehouse_id uuid, auto_match_enabled boolean, auto_match_priority integer)
      group by rule.warehouse_id
      having count(*) > 1
    ) duplicate
  ) then
    raise exception '同一仓库不能重复出现在自动匹配规则中。'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select rule.auto_match_priority
      from jsonb_to_recordset(p_rules)
        as rule(warehouse_id uuid, auto_match_enabled boolean, auto_match_priority integer)
      where coalesce(rule.auto_match_enabled, false)
      group by rule.auto_match_priority
      having count(*) > 1
    ) duplicate
  ) then
    raise exception '自动匹配仓库优先级不能重复。'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rules)
      as rule(warehouse_id uuid, auto_match_enabled boolean, auto_match_priority integer)
    left join public.warehouses warehouse on warehouse.id = rule.warehouse_id
    where warehouse.id is null
  ) then
    raise exception '自动匹配规则包含不存在的仓库。' using errcode = '23503';
  end if;

  -- Clear first so swapping two unique priorities remains atomic.
  update public.warehouses
  set
    auto_match_enabled = false,
    auto_match_priority = null,
    updated_at = now()
  where auto_match_enabled or auto_match_priority is not null;

  for v_rule in
    select *
    from jsonb_to_recordset(p_rules)
      as rule(warehouse_id uuid, auto_match_enabled boolean, auto_match_priority integer)
  loop
    update public.warehouses
    set
      auto_match_enabled = coalesce(v_rule.auto_match_enabled, false),
      auto_match_priority = case
        when coalesce(v_rule.auto_match_enabled, false)
          then v_rule.auto_match_priority
        else null
      end,
      updated_at = now()
    where id = v_rule.warehouse_id;
  end loop;

  return query
  select warehouse.*
  from public.warehouses warehouse
  order by
    warehouse.auto_match_enabled desc,
    warehouse.auto_match_priority nulls last,
    warehouse.created_at,
    warehouse.id;
end;
$function$;

revoke all on function public.save_warehouse_auto_match_rules(jsonb) from public, anon;
grant execute on function public.save_warehouse_auto_match_rules(jsonb) to authenticated, service_role;

create or replace function public.replace_warehouse_logistics_methods_atomic(
  p_warehouse_id uuid,
  p_logistics_method_ids jsonb
)
returns setof public.warehouse_logistics_methods
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能修改仓库发货方式。'
      using errcode = '42501';
  end if;

  if p_warehouse_id is null or not exists (
    select 1 from public.warehouses warehouse where warehouse.id = p_warehouse_id
  ) then
    raise exception '仓库不存在。' using errcode = '23503';
  end if;

  if jsonb_typeof(p_logistics_method_ids) <> 'array' then
    raise exception '仓库发货方式格式不正确。' using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select value
      from jsonb_array_elements_text(p_logistics_method_ids)
      group by value
      having count(*) > 1
    ) duplicate
  ) then
    raise exception '同一发货方式不能重复绑定到仓库。' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(p_logistics_method_ids) requested(value)
    left join public.logistics_methods method on method.id = requested.value::uuid
    where method.id is null
  ) then
    raise exception '仓库发货方式包含不存在的物流方式。' using errcode = '23503';
  end if;

  delete from public.warehouse_logistics_methods mapping
  where mapping.warehouse_id = p_warehouse_id;

  insert into public.warehouse_logistics_methods (
    warehouse_id,
    logistics_method_id,
    owner_id,
    is_default,
    sort_order
  )
  select
    p_warehouse_id,
    requested.value::uuid,
    auth.uid(),
    requested.ordinality = 1,
    requested.ordinality - 1
  from jsonb_array_elements_text(p_logistics_method_ids)
    with ordinality as requested(value, ordinality);

  return query
  select mapping.*
  from public.warehouse_logistics_methods mapping
  where mapping.warehouse_id = p_warehouse_id
  order by mapping.sort_order, mapping.created_at, mapping.id;
end;
$function$;

revoke all on function public.replace_warehouse_logistics_methods_atomic(uuid, jsonb)
  from public, anon;
grant execute on function public.replace_warehouse_logistics_methods_atomic(uuid, jsonb)
  to authenticated, service_role;

create or replace function public.auto_assign_temu_order_shipment(
  p_shipment_id uuid,
  p_warehouse_id uuid,
  p_logistics_method_id uuid,
  p_reservations jsonb,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_distinct_sku_count integer;
  v_product_id uuid;
  v_quantity integer;
  v_max_units integer;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能自动匹配包裹。'
      using errcode = '42501';
  end if;

  if not coalesce(
    (select setting.enabled
     from public.order_auto_match_settings setting
     where setting.id = true),
    false
  ) then
    raise exception '自动匹配当前处于暂停状态。' using errcode = '55000';
  end if;

  if not exists (
    select 1
    from public.warehouses warehouse
    where warehouse.id = p_warehouse_id
      and warehouse.auto_match_enabled
      and warehouse.auto_match_priority is not null
  ) then
    raise exception '所选仓库未参与自动匹配或未设置优先级。'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.logistics_methods method
    join public.warehouse_logistics_methods mapping
      on mapping.logistics_method_id = method.id
     and mapping.warehouse_id = p_warehouse_id
    where method.id = p_logistics_method_id
      and method.is_active
      and method.leg_type = 'last_leg'
      and method.parcel_type = 'three_cm_only'
  ) then
    raise exception '所选尾程不是该仓库已绑定的可用 3cm 尾程。'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.pricing_settings setting
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(setting.last_leg_methods) = 'array'
          then setting.last_leg_methods
        else '[]'::jsonb
      end
    ) configured
    where lower(coalesce(configured ->> 'type', 'last_leg')) = 'last_leg'
      and lower(coalesce(configured ->> 'isActive', 'true')) <> 'false'
      and configured ->> 'db_method_id' = p_logistics_method_id::text
  ) then
    raise exception '所选物流方式不是当前启用的尾程发货方式。'
      using errcode = '23514';
  end if;

  if jsonb_typeof(p_reservations) <> 'array' then
    raise exception '库存分配数据格式不正确。' using errcode = '22023';
  end if;

  select
    count(distinct stock.sku_id),
    min(stock.product_id),
    coalesce(sum(item.quantity), 0)::integer
  into
    v_distinct_sku_count,
    v_product_id,
    v_quantity
  from jsonb_array_elements(p_reservations) allocation
  join public.temu_order_shipment_items item
    on item.id = (allocation ->> 'shipment_item_id')::uuid
   and item.shipment_id = p_shipment_id
  join public.warehouse_skus stock
    on stock.id = (allocation ->> 'warehouse_sku_id')::uuid
   and stock.warehouse_id = p_warehouse_id;

  if v_distinct_sku_count <> 1 or v_product_id is null or v_quantity <= 0 then
    raise exception '自动匹配只允许包含一个 SKU 的有效包裹。'
      using errcode = '23514';
  end if;

  select coalesce(limit_row.max_units_per_parcel, 1)
  into v_max_units
  from (select 1) seed
  left join public.product_warehouse_shipping_limits limit_row
    on limit_row.product_id = v_product_id
   and limit_row.warehouse_id = p_warehouse_id;

  if coalesce(v_max_units, 1) <= 0 or v_quantity > coalesce(v_max_units, 1) then
    raise exception '订单数量超过该商品在所选仓库的 3cm 最大数。'
      using errcode = '23514';
  end if;

  return public.assign_temu_order_shipment(
    p_shipment_id,
    p_warehouse_id,
    p_logistics_method_id,
    p_reservations,
    p_reason
  );
end;
$function$;

revoke all on function public.auto_assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  from public, anon;
grant execute on function public.auto_assign_temu_order_shipment(uuid, uuid, uuid, jsonb, text)
  to authenticated, service_role;

-- Exact-name one-time seed requested by the user. No aliases or partial matching.
update public.warehouses
set
  auto_match_enabled = true,
  auto_match_priority = case name
    when '神户' then 1
    when '福冈' then 2
    when '名古屋' then 3
    when '苏州' then 4
  end,
  updated_at = now()
where name in ('神户', '福冈', '名古屋', '苏州');

-- Explicitly keep the global switch paused after seeding warehouse priorities.
update public.order_auto_match_settings
set enabled = false
where id = true;
