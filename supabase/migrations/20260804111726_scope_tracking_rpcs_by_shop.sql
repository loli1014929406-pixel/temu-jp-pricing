create or replace function public.get_temu_tracking_candidates(
  p_order_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', shipment.id,
        'enterprise_id', shipment.enterprise_id,
        'shop_id', shipment.shop_id,
        'order_no', shipment.order_no,
        'order_status', shipment.order_status,
        'warehouse_name', shipment.warehouse_name,
        'logistics_method_id', shipment.logistics_method_id,
        'logistics_method', shipment.logistics_method,
        'combined_shipment_id', (
          select member.combined_shipment_id
          from public.temu_order_combined_shipment_members member
          where member.shipment_id = shipment.id
        ),
        'logistics_tracking_no', shipment.logistics_tracking_no,
        'actual_ship_time', shipment.actual_ship_time,
        'actual_signed_time', shipment.actual_signed_time,
        'tracking_exception_fingerprint', shipment.tracking_exception_fingerprint,
        'tracking_exception_handled_at', shipment.tracking_exception_handled_at
      )
      order by shipment.shop_id, shipment.order_no,
        shipment.package_sequence, shipment.id
    ),
    '[]'::jsonb
  )
  from public.temu_order_shipments shipment
  where btrim(shipment.logistics_tracking_no) <> ''
    and btrim(shipment.actual_signed_time) = ''
    and public.temu_order_shipment_stage(shipment) in ('shipped', 'uploaded_temu')
    and (
      p_order_ids is null
      or exists (
        select 1
        from public.temu_order_shipment_items item
        where item.shipment_id = shipment.id
          and item.id = any(p_order_ids)
      )
    )
$function$;

create or replace function public.save_temu_tracking_result(
  p_shop_id uuid,
  p_order_no text,
  p_tracking_no text,
  p_checked_at timestamptz,
  p_query_error text,
  p_logistics_status text,
  p_logistics_status_detail text,
  p_tracking_category text,
  p_tracking_event_time timestamptz,
  p_tracking_is_exception boolean,
  p_tracking_exception_reason text,
  p_tracking_exception_fingerprint text,
  p_preserve_handled boolean,
  p_complete_uploaded_temu boolean,
  p_actual_signed_time text
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_updated_count integer := 0;
begin
  if p_shop_id is null
    or btrim(coalesce(p_order_no, '')) = ''
    or btrim(coalesce(p_tracking_no, '')) = ''
  then
    raise exception using errcode = '22023', message = 'Shop, order and tracking number are required.';
  end if;

  if btrim(coalesce(p_query_error, '')) <> '' then
    update public.temu_order_shipments shipment
    set tracking_last_checked_at = p_checked_at,
        tracking_last_query_error = left(p_query_error, 500),
        tracking_last_query_error_at = p_checked_at
    where shipment.shop_id = p_shop_id
      and shipment.order_no = p_order_no
      and shipment.logistics_tracking_no = p_tracking_no;
  else
    if p_tracking_category not in (
      'pending', 'in_transit', 'out_for_delivery', 'delivered',
      'available_for_pickup', 'failed_attempt', 'exception'
    ) then
      raise exception using errcode = '22023', message = 'Unknown tracking category.';
    end if;

    update public.temu_order_shipments shipment
    set logistics_status = coalesce(p_logistics_status, ''),
        logistics_status_detail = coalesce(p_logistics_status_detail, ''),
        tracking_category = p_tracking_category,
        tracking_event_time = p_tracking_event_time,
        tracking_last_checked_at = p_checked_at,
        tracking_last_query_error = '',
        tracking_last_query_error_at = null,
        tracking_is_exception = p_tracking_is_exception,
        tracking_exception_reason = coalesce(p_tracking_exception_reason, ''),
        tracking_exception_fingerprint = coalesce(p_tracking_exception_fingerprint, ''),
        tracking_exception_handled_at = case
          when p_preserve_handled then shipment.tracking_exception_handled_at
          else null
        end,
        tracking_exception_handled_by = case
          when p_preserve_handled then shipment.tracking_exception_handled_by
          else null
        end,
        order_status = case
          when p_complete_uploaded_temu
            and public.temu_order_shipment_stage(shipment) = 'uploaded_temu'
            then '已完成'
          else shipment.order_status
        end,
        actual_signed_time = case
          when p_complete_uploaded_temu
            and public.temu_order_shipment_stage(shipment) = 'uploaded_temu'
            then coalesce(
              nullif(btrim(p_actual_signed_time), ''),
              shipment.actual_signed_time
            )
          else shipment.actual_signed_time
        end
    where shipment.shop_id = p_shop_id
      and shipment.order_no = p_order_no
      and shipment.logistics_tracking_no = p_tracking_no;
  end if;

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end
$function$;

revoke all on function public.get_temu_tracking_candidates(uuid[]) from public, anon;
revoke all on function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) from public, anon;
grant execute on function public.get_temu_tracking_candidates(uuid[])
  to authenticated, service_role;
grant execute on function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) to authenticated, service_role;
