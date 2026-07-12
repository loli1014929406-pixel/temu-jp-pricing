-- Finance order detail pagination. Date precedence matches finance getOrderDate():
-- actual_ship_time -> label_printed_at -> latest_ship_time -> created_at.
create or replace function public.get_finance_orders_page(
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default '',
  p_date_start date default null,
  p_date_end date default null,
  p_settlement_status text default 'all'
)
returns table (orders jsonb, total_count bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
  v_status text := lower(btrim(coalesce(p_settlement_status, 'all')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if v_status not in ('all', 'settled', 'unsettled') then
    raise exception 'Invalid settlement status' using errcode = '22023';
  end if;

  return query
  with normalized as (
    select
      order_row.*,
      coalesce(
        public.try_parse_temu_order_time(order_row.actual_ship_time),
        public.try_parse_temu_order_time(order_row.label_printed_at),
        public.try_parse_temu_order_time(order_row.latest_ship_time),
        order_row.created_at
      ) as finance_order_at
    from public.temu_orders order_row
  ), filtered as (
    select normalized.*
    from normalized
    where (p_date_start is null or timezone('Asia/Tokyo', finance_order_at)::date >= p_date_start)
      and (p_date_end is null or timezone('Asia/Tokyo', finance_order_at)::date <= p_date_end)
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(
          order_no || ' ' || sub_order_no || ' ' || sku_code || ' ' ||
          product_attributes || ' ' || logistics_tracking_no || ' ' || recipient_name
        ) like '%' || lower(btrim(p_search)) || '%'
      )
      and (
        v_status = 'all'
        or (v_status = 'settled' and exists (
          select 1 from public.finance_settlement_records settlement
          where settlement.po_number = normalized.order_no
        ))
        or (v_status = 'unsettled' and not exists (
          select 1 from public.finance_settlement_records settlement
          where settlement.po_number = normalized.order_no
        ))
      )
  ), paged as (
    select filtered.*
    from filtered
    order by finance_order_at desc nulls last, order_no, sub_order_no, id
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select
    coalesce((
      select jsonb_agg(to_jsonb(paged) - 'finance_order_at' order by finance_order_at desc nulls last, order_no, sub_order_no, id)
      from paged
    ), '[]'::jsonb),
    (select count(*) from filtered);
end;
$$;

revoke all on function public.get_finance_orders_page(integer, integer, text, date, date, text) from public;
grant execute on function public.get_finance_orders_page(integer, integer, text, date, date, text) to authenticated;

create index if not exists idx_temu_orders_finance_dates
on public.temu_orders(actual_ship_time, label_printed_at, latest_ship_time, created_at desc);
