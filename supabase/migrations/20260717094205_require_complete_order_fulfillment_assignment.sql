-- Keep server-side stage filters aligned with the client workflow: an order
-- remains pending assignment until both warehouse and shipping method exist.

create or replace function public.temu_order_stage(p_order public.temu_orders)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when btrim(p_order.actual_signed_time) <> '' then 'completed'
    when lower(btrim(p_order.order_status)) in ('上传temu', '已上传temu') then 'uploaded_temu'
    when btrim(p_order.actual_ship_time) <> ''
      or btrim(p_order.logistics_tracking_no) <> '' then 'shipped'
    when btrim(p_order.label_printed_at) <> '' then 'pending_shipping'
    when (
      p_order.warehouse_id is not null
      or btrim(p_order.warehouse_name) <> ''
    ) and (
      p_order.logistics_method_id is not null
      or btrim(p_order.logistics_method) <> ''
    ) then 'new_order'
    else 'pending_assignment'
  end;
$$;

revoke all on function public.temu_order_stage(public.temu_orders) from public;
grant execute on function public.temu_order_stage(public.temu_orders) to authenticated;
