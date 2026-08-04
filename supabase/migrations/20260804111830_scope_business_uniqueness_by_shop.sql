-- Add tenant-aware replacements before the final cutover removes legacy
-- team-wide uniqueness. Keeping both sets active in expansion mode preserves
-- current production behavior until the controlled switch.

create unique index if not exists logistics_methods_shop_name_unique
  on public.logistics_methods (shop_id, lower(btrim(name)));
create unique index if not exists purchase_orders_shop_order_code_unique
  on public.purchase_orders (shop_id, order_code);
create unique index if not exists temu_order_shipments_shop_order_package_uidx
  on public.temu_order_shipments (shop_id, lower(btrim(order_no)), package_sequence);
create unique index if not exists warehouses_shop_auto_match_priority_unique
  on public.warehouses (shop_id, auto_match_priority)
  where auto_match_enabled;
create unique index if not exists warehouses_shop_name_exact_unique
  on public.warehouses (shop_id, lower(btrim(name)));
create unique index if not exists temu_order_combined_shipments_shop_no_unique
  on public.temu_order_combined_shipments (shop_id, lower(btrim(combined_no)));

create or replace function public.validate_temu_order_tracking_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_combined_shipment_id uuid;
begin
  if btrim(new.logistics_tracking_no) = '' then
    return new;
  end if;

  select member.combined_shipment_id
    into v_combined_shipment_id
  from public.temu_order_combined_shipment_members member
  where member.shipment_id = new.id
    and member.shop_id = new.shop_id;

  if exists (
    select 1
    from public.temu_order_shipments other
    left join public.temu_order_combined_shipment_members other_member
      on other_member.shipment_id = other.id
     and other_member.shop_id = other.shop_id
    where other.id <> new.id
      and other.shop_id = new.shop_id
      and lower(btrim(other.logistics_tracking_no)) =
        lower(btrim(new.logistics_tracking_no))
      and (
        v_combined_shipment_id is null
        or other_member.combined_shipment_id is distinct from v_combined_shipment_id
      )
  ) then
    raise exception '相同物流单号只能属于同一店铺内的一个普通包裹或一个已确认的合并包裹。'
      using errcode = '23505';
  end if;

  return new;
end
$function$;

revoke all on function public.validate_temu_order_tracking_identity() from public, anon;
