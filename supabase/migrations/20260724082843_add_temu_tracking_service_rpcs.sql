-- The project intentionally does not grant service_role direct temu_orders access.
-- These narrowly scoped functions expose only the fields required by the tracking worker.
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
        'id', orders.id,
        'order_no', orders.order_no,
        'order_status', orders.order_status,
        'warehouse_name', orders.warehouse_name,
        'logistics_method', orders.logistics_method,
        'logistics_tracking_no', orders.logistics_tracking_no,
        'actual_ship_time', orders.actual_ship_time,
        'actual_signed_time', orders.actual_signed_time,
        'tracking_exception_fingerprint', orders.tracking_exception_fingerprint,
        'tracking_exception_handled_at', orders.tracking_exception_handled_at
      )
      order by orders.id
    ),
    '[]'::jsonb
  )
  from public.temu_orders as orders
  where btrim(orders.logistics_tracking_no) <> ''
    and btrim(orders.actual_signed_time) = ''
    and public.temu_order_stage(orders) in ('shipped', 'uploaded_temu')
    and (p_order_ids is null or orders.id = any(p_order_ids))
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
    update public.temu_orders
    set
      tracking_last_checked_at = p_checked_at,
      tracking_last_query_error = left(p_query_error, 500),
      tracking_last_query_error_at = p_checked_at
    where temu_orders.order_no = p_order_no
      and temu_orders.logistics_tracking_no = p_tracking_no;
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

    update public.temu_orders
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
        when p_preserve_handled then temu_orders.tracking_exception_handled_at
        else null
      end,
      tracking_exception_handled_by = case
        when p_preserve_handled then temu_orders.tracking_exception_handled_by
        else null
      end,
      order_status = case
        when p_complete_uploaded_temu
          and public.temu_order_stage(temu_orders) = 'uploaded_temu'
          then '已完成'
        else temu_orders.order_status
      end,
      actual_signed_time = case
        when p_complete_uploaded_temu
          and public.temu_order_stage(temu_orders) = 'uploaded_temu'
          then coalesce(nullif(btrim(p_actual_signed_time), ''), temu_orders.actual_signed_time)
        else temu_orders.actual_signed_time
      end
    where temu_orders.order_no = p_order_no
      and temu_orders.logistics_tracking_no = p_tracking_no;
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
) from public;
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
) from anon;
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
) from authenticated;
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
