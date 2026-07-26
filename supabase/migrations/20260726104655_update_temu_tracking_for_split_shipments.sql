drop function if exists public.get_temu_tracking_alerts();

create or replace function public.get_temu_tracking_alerts()
returns table (
  order_no text,
  package_sequence integer,
  package_count integer,
  stage text,
  logistics_tracking_no text,
  logistics_method text,
  logistics_status text,
  logistics_status_detail text,
  tracking_category text,
  tracking_exception_reason text,
  tracking_exception_fingerprint text,
  tracking_exception_handled_at timestamptz,
  tracking_last_checked_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    shipment.order_no,
    shipment.package_sequence,
    package_summary.package_count,
    public.temu_order_shipment_stage(shipment) as stage,
    shipment.logistics_tracking_no,
    shipment.logistics_method,
    shipment.logistics_status,
    shipment.logistics_status_detail,
    shipment.tracking_category,
    shipment.tracking_exception_reason,
    shipment.tracking_exception_fingerprint,
    shipment.tracking_exception_handled_at,
    shipment.tracking_last_checked_at
  from public.temu_order_shipments shipment
  join lateral (
    select count(*)::integer as package_count
    from public.temu_order_shipments sibling
    where lower(btrim(sibling.order_no)) = lower(btrim(shipment.order_no))
  ) package_summary on true
  where shipment.tracking_is_exception = true
    and public.temu_order_shipment_stage(shipment) in ('shipped', 'uploaded_temu')
  order by
    lower(btrim(shipment.order_no)),
    shipment.package_sequence,
    shipment.tracking_last_checked_at desc nulls last,
    shipment.id
$$;

revoke all on function public.get_temu_tracking_alerts() from public;
grant execute on function public.get_temu_tracking_alerts() to authenticated;

create or replace function public.mark_temu_tracking_exception_handled(
  p_order_no text,
  p_fingerprint text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_count integer := 0;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能处理物流异常。'
      using errcode = '42501';
  end if;

  if btrim(coalesce(p_order_no, '')) = ''
     or btrim(coalesce(p_fingerprint, '')) = '' then
    raise exception '订单号和异常指纹不能为空。'
      using errcode = '22023';
  end if;

  update public.temu_order_shipments shipment
  set
    tracking_exception_handled_at = now(),
    tracking_exception_handled_by = auth.uid()
  where lower(btrim(shipment.order_no)) = lower(btrim(p_order_no))
    and shipment.tracking_is_exception = true
    and shipment.tracking_exception_fingerprint = p_fingerprint;

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end
$$;

revoke all on function public.mark_temu_tracking_exception_handled(text, text) from public;
grant execute on function public.mark_temu_tracking_exception_handled(text, text) to authenticated;

create or replace function public.get_temu_tracking_candidates(
  p_order_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', shipment.id,
        'order_no', shipment.order_no,
        'order_status', shipment.order_status,
        'warehouse_name', shipment.warehouse_name,
        'logistics_method', shipment.logistics_method,
        'logistics_tracking_no', shipment.logistics_tracking_no,
        'actual_ship_time', shipment.actual_ship_time,
        'actual_signed_time', shipment.actual_signed_time,
        'tracking_exception_fingerprint', shipment.tracking_exception_fingerprint,
        'tracking_exception_handled_at', shipment.tracking_exception_handled_at
      )
      order by shipment.order_no, shipment.package_sequence, shipment.id
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
$$;

revoke all on function public.get_temu_tracking_candidates(uuid[]) from public;
revoke all on function public.get_temu_tracking_candidates(uuid[]) from anon;
revoke all on function public.get_temu_tracking_candidates(uuid[]) from authenticated;
grant execute on function public.get_temu_tracking_candidates(uuid[]) to service_role;

create or replace function public.save_temu_tracking_result(
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
security definer
set search_path = ''
as $$
declare
  v_updated_count integer := 0;
begin
  if btrim(coalesce(p_order_no, '')) = ''
     or btrim(coalesce(p_tracking_no, '')) = '' then
    raise exception '订单号和物流单号不能为空。'
      using errcode = '22023';
  end if;

  if btrim(coalesce(p_query_error, '')) <> '' then
    update public.temu_order_shipments shipment
    set
      tracking_last_checked_at = p_checked_at,
      tracking_last_query_error = left(p_query_error, 500),
      tracking_last_query_error_at = p_checked_at
    where shipment.order_no = p_order_no
      and shipment.logistics_tracking_no = p_tracking_no;
  else
    if p_tracking_category not in (
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'available_for_pickup',
      'failed_attempt',
      'exception'
    ) then
      raise exception '未知物流分类：%', p_tracking_category
        using errcode = '22023';
    end if;

    update public.temu_order_shipments shipment
    set
      logistics_status = coalesce(p_logistics_status, ''),
      logistics_status_detail = coalesce(p_logistics_status_detail, ''),
      tracking_category = p_tracking_category,
      tracking_event_time = p_tracking_event_time,
      tracking_last_checked_at = p_checked_at,
      tracking_last_query_error = '',
      tracking_last_query_error_at = null,
      tracking_is_exception = p_tracking_is_exception,
      tracking_exception_reason = coalesce(p_tracking_exception_reason, ''),
      tracking_exception_fingerprint = coalesce(
        p_tracking_exception_fingerprint,
        ''
      ),
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
    where shipment.order_no = p_order_no
      and shipment.logistics_tracking_no = p_tracking_no;
  end if;

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end
$$;

revoke all on function public.save_temu_tracking_result(
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  timestamptz,
  boolean,
  text,
  text,
  boolean,
  boolean,
  text
) from public, anon, authenticated;

grant execute on function public.save_temu_tracking_result(
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  timestamptz,
  boolean,
  text,
  text,
  boolean,
  boolean,
  text
) to service_role;
