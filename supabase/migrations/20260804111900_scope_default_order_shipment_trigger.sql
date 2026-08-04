-- Keep the legacy automatic default-package trigger tenant-safe. A new order
-- must locate/create its package within the same shop and propagate scope to
-- both package and package-item rows in the same transaction.

create or replace function public.sync_new_temu_order_shipment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_shipment_id uuid;
begin
  if new.fulfillment_quantity <= 0 or btrim(new.order_no) = '' then
    return new;
  end if;

  select shipment.id
    into v_shipment_id
  from public.temu_order_shipments shipment
  where shipment.shop_id = new.shop_id
    and lower(btrim(shipment.order_no)) = lower(btrim(new.order_no))
  order by shipment.package_sequence, shipment.id
  limit 1;

  if v_shipment_id is null then
    insert into public.temu_order_shipments (
      owner_id,
      enterprise_id,
      shop_id,
      order_no,
      package_sequence,
      order_status,
      warehouse_id,
      warehouse_name,
      logistics_method_id,
      logistics_method,
      label_printed_at,
      logistics_tracking_no,
      logistics_status,
      logistics_status_detail,
      tracking_category,
      tracking_event_time,
      tracking_last_checked_at,
      tracking_last_query_error,
      tracking_last_query_error_at,
      tracking_is_exception,
      tracking_exception_reason,
      tracking_exception_fingerprint,
      tracking_exception_handled_at,
      tracking_exception_handled_by,
      actual_ship_time,
      actual_signed_time,
      actual_shipping_fee_rmb,
      created_at,
      updated_at
    )
    values (
      new.owner_id,
      new.enterprise_id,
      new.shop_id,
      new.order_no,
      1,
      new.order_status,
      new.warehouse_id,
      new.warehouse_name,
      new.logistics_method_id,
      new.logistics_method,
      new.label_printed_at,
      new.logistics_tracking_no,
      new.logistics_status,
      new.logistics_status_detail,
      new.tracking_category,
      new.tracking_event_time,
      new.tracking_last_checked_at,
      new.tracking_last_query_error,
      new.tracking_last_query_error_at,
      new.tracking_is_exception,
      new.tracking_exception_reason,
      new.tracking_exception_fingerprint,
      new.tracking_exception_handled_at,
      new.tracking_exception_handled_by,
      new.actual_ship_time,
      new.actual_signed_time,
      new.actual_shipping_fee_rmb,
      new.created_at,
      new.updated_at
    )
    returning id into v_shipment_id;
  end if;

  insert into public.temu_order_shipment_items (
    shipment_id,
    order_id,
    owner_id,
    enterprise_id,
    shop_id,
    quantity,
    created_at,
    updated_at
  )
  values (
    v_shipment_id,
    new.id,
    new.owner_id,
    new.enterprise_id,
    new.shop_id,
    new.fulfillment_quantity,
    new.created_at,
    new.updated_at
  );

  return new;
end
$function$;

revoke all on function public.sync_new_temu_order_shipment() from public, anon;
grant execute on function public.sync_new_temu_order_shipment() to authenticated;
