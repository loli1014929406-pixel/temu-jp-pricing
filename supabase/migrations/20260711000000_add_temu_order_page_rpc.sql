-- Server-side Temu order pagination, filtering, search, and stage summaries.
-- The function is security invoker so the existing team-scoped RLS policies
-- continue to define which rows each authenticated account can read.

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
    when p_order.warehouse_id is not null
      or btrim(p_order.warehouse_name) <> '' then 'new_order'
    else 'pending_assignment'
  end;
$$;

create or replace function public.try_parse_temu_order_time(p_value text)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_value text := btrim(coalesce(p_value, ''));
begin
  if v_value = '' then
    return null;
  end if;

  begin
    if v_value ~ '^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{1,2}(:\d{1,2})?)?$' then
      return replace(v_value, '/', '-')::timestamp at time zone 'Asia/Tokyo';
    end if;
    return v_value::timestamptz;
  exception
    when others then
      return null;
  end;
end;
$$;

create or replace function public.get_temu_orders_page(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default '',
  p_stage text default 'all',
  p_warehouse_id uuid default null,
  p_logistics_method text default '',
  p_urgent_only boolean default false,
  p_sort_key text default 'ship_deadline',
  p_sort_direction text default 'asc',
  p_now timestamptz default now()
)
returns table (
  orders jsonb,
  total_count bigint,
  total_line_count bigint,
  stage_counts jsonb,
  urgent_unuploaded_count bigint
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_stage text := lower(btrim(coalesce(p_stage, 'all')));
  v_sort_key text := lower(btrim(coalesce(p_sort_key, 'ship_deadline')));
  v_sort_direction text := lower(btrim(coalesce(p_sort_direction, 'asc')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if v_stage not in (
    'all',
    'pending_assignment',
    'new_order',
    'pending_shipping',
    'shipped',
    'uploaded_temu',
    'completed'
  ) then
    raise exception 'Invalid order stage' using errcode = '22023';
  end if;

  if v_sort_key not in (
    'ship_deadline',
    'delivery_deadline',
    'product',
    'logistics_status'
  ) then
    raise exception 'Invalid order sort key' using errcode = '22023';
  end if;

  if v_sort_direction not in ('asc', 'desc') then
    raise exception 'Invalid order sort direction' using errcode = '22023';
  end if;

  return query
  with base_lines as (
    select
      order_row.*,
      coalesce(nullif(lower(btrim(order_row.order_no)), ''), order_row.id::text) as group_key,
      public.temu_order_stage(order_row) as computed_stage,
      public.try_parse_temu_order_time(order_row.latest_ship_time) as ship_deadline_at,
      public.try_parse_temu_order_time(order_row.estimated_delivery_time) as delivery_deadline_at
    from public.temu_orders order_row
  ),
  fulfillment_lines as (
    select line.*
    from base_lines line
    where (
      p_warehouse_id is null
      or line.warehouse_id = p_warehouse_id
      or exists (
        select 1
        from public.warehouses warehouse
        where warehouse.id = p_warehouse_id
          and lower(btrim(line.warehouse_name)) = lower(btrim(warehouse.name))
      )
    )
      and (
        btrim(coalesce(p_logistics_method, '')) = ''
        or lower(btrim(line.logistics_method)) = lower(btrim(p_logistics_method))
      )
  ),
  stage_primary as (
    select distinct on (line.group_key)
      line.group_key,
      line.computed_stage
    from fulfillment_lines line
    order by
      line.group_key,
      lower(btrim(line.sku_code)),
      lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
      lower(btrim(line.sub_order_no)),
      line.id
  ),
  stage_summary as (
    select jsonb_build_object(
      'all', count(*)::bigint,
      'pending_assignment', count(*) filter (where primary_row.computed_stage = 'pending_assignment')::bigint,
      'new_order', count(*) filter (where primary_row.computed_stage = 'new_order')::bigint,
      'pending_shipping', count(*) filter (where primary_row.computed_stage = 'pending_shipping')::bigint,
      'shipped', count(*) filter (where primary_row.computed_stage = 'shipped')::bigint,
      'uploaded_temu', count(*) filter (where primary_row.computed_stage = 'uploaded_temu')::bigint,
      'completed', count(*) filter (where primary_row.computed_stage = 'completed')::bigint
    ) as counts
    from stage_primary primary_row
  ),
  query_lines as (
    select line.*
    from fulfillment_lines line
    where (v_stage = 'all' or line.computed_stage = v_stage)
      and (
        not coalesce(p_urgent_only, false)
        or (
          line.computed_stage not in ('uploaded_temu', 'completed')
          and line.ship_deadline_at is not null
          and line.ship_deadline_at >= p_now
          and line.ship_deadline_at <= p_now + interval '12 hours'
        )
      )
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(
          line.order_no || ' ' ||
          line.sub_order_no || ' ' ||
          line.order_status || ' ' ||
          line.sku_code || ' ' ||
          line.warehouse_name || ' ' ||
          line.logistics_method || ' ' ||
          line.logistics_tracking_no || ' ' ||
          line.logistics_status || ' ' ||
          line.product_attributes || ' ' ||
          line.recipient_name || ' ' ||
          line.recipient_phone || ' ' ||
          line.email || ' ' ||
          line.province || ' ' ||
          line.city || ' ' ||
          line.district || ' ' ||
          line.address_line1 || ' ' ||
          line.address_line2 || ' ' ||
          line.postal_code
        ) like '%' || lower(btrim(p_search)) || '%'
      )
  ),
  query_primary as (
    select distinct on (line.group_key)
      line.group_key,
      line.ship_deadline_at,
      line.delivery_deadline_at,
      line.logistics_status,
      line.sku_code,
      coalesce(
        (
          select product.product_code
          from public.product_skus sku
          join public.products product on product.id = sku.product_id
          where lower(btrim(sku.sku_code)) = lower(btrim(line.sku_code))
          order by product.product_code, sku.id
          limit 1
        ),
        nullif(line.sku_code, ''),
        '\uffff'
      ) as product_sort_value,
      case
        when btrim(line.logistics_status) = ''
          or line.logistics_status like '%待查询%' then 0
        when line.logistics_status like '%暂无轨迹%'
          or line.logistics_status like '%伝票番号未登録%' then 1
        when line.logistics_status like '%查询失败%' then 2
        when line.logistics_status like '%引受%' then 10
        when line.logistics_status like '%発送%' then 20
        when line.logistics_status like '%通過%' then 30
        when line.logistics_status like '%到着%' then 40
        when line.logistics_status like '%保管%' then 45
        when line.logistics_status like '%ご不在%' then 50
        when line.logistics_status like '%持ち出し中%'
          or line.logistics_status like '%配達中%' then 60
        when line.logistics_status like '%お届け済み%'
          or line.logistics_status like '%配達完了%'
          or line.logistics_status like '%配達済み%'
          or lower(line.logistics_status) like '%delivered%' then 70
        else 80
      end as logistics_status_rank,
      line.order_no
    from query_lines line
    order by
      line.group_key,
      lower(btrim(line.sku_code)),
      lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
      lower(btrim(line.sub_order_no)),
      line.id
  ),
  ranked_groups as (
    select
      primary_row.*,
      row_number() over (
        order by
          case when v_sort_key = 'ship_deadline' and v_sort_direction = 'asc' then primary_row.ship_deadline_at end asc nulls last,
          case when v_sort_key = 'ship_deadline' and v_sort_direction = 'desc' then primary_row.ship_deadline_at end desc nulls last,
          case when v_sort_key = 'delivery_deadline' and v_sort_direction = 'asc' then primary_row.delivery_deadline_at end asc nulls last,
          case when v_sort_key = 'delivery_deadline' and v_sort_direction = 'desc' then primary_row.delivery_deadline_at end desc nulls last,
          case when v_sort_key = 'product' and v_sort_direction = 'asc' then lower(primary_row.product_sort_value) end asc nulls last,
          case when v_sort_key = 'product' and v_sort_direction = 'desc' then lower(primary_row.product_sort_value) end desc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'asc' then primary_row.logistics_status_rank end asc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'desc' then primary_row.logistics_status_rank end desc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'asc' then lower(primary_row.logistics_status) end asc nulls last,
          case when v_sort_key = 'logistics_status' and v_sort_direction = 'desc' then lower(primary_row.logistics_status) end desc nulls last,
          lower(primary_row.order_no),
          primary_row.group_key
      ) as page_position
    from query_primary primary_row
  ),
  paged_groups as (
    select ranked.*
    from ranked_groups ranked
    where ranked.page_position > (v_page - 1) * v_page_size
      and ranked.page_position <= v_page * v_page_size
  ),
  page_payload as (
    select coalesce(
      jsonb_agg(
        to_jsonb(line)
          - 'group_key'
          - 'computed_stage'
          - 'ship_deadline_at'
          - 'delivery_deadline_at'
        order by
          page_group.page_position,
          lower(btrim(line.sku_code)),
          lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
          lower(btrim(line.sub_order_no)),
          line.id
      ),
      '[]'::jsonb
    ) as rows
    from paged_groups page_group
    join query_lines line on line.group_key = page_group.group_key
  ),
  urgent_summary as (
    select count(*)::bigint as urgent_count
    from base_lines line
    where line.computed_stage not in ('uploaded_temu', 'completed')
      and line.ship_deadline_at is not null
      and line.ship_deadline_at >= p_now
      and line.ship_deadline_at <= p_now + interval '12 hours'
  )
  select
    page_payload.rows,
    (select count(*)::bigint from query_primary),
    (select count(*)::bigint from query_lines),
    stage_summary.counts,
    urgent_summary.urgent_count
  from page_payload
  cross join stage_summary
  cross join urgent_summary;
end;
$$;

revoke all on function public.temu_order_stage(public.temu_orders) from public;
revoke all on function public.try_parse_temu_order_time(text) from public;
revoke all on function public.get_temu_orders_page(integer, integer, text, text, uuid, text, boolean, text, text, timestamptz) from public;

grant execute on function public.temu_order_stage(public.temu_orders) to authenticated;
grant execute on function public.try_parse_temu_order_time(text) to authenticated;
grant execute on function public.get_temu_orders_page(integer, integer, text, text, uuid, text, boolean, text, text, timestamptz) to authenticated;

create index if not exists idx_temu_orders_team_group_key
on public.temu_orders ((lower(btrim(order_no))), id);

create index if not exists idx_temu_orders_team_warehouse_method
on public.temu_orders (warehouse_id, logistics_method, id);
