-- PostgreSQL does not provide min(uuid). The shipment is already required to
-- contain one distinct SKU, so the first aggregated product id is the same for
-- every valid reservation row.
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
    (array_agg(stock.product_id))[1],
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
