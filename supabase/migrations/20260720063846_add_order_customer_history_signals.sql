-- Add derived customer-history signals to the existing order-page payload.
--
-- Customer identity is a connected component of distinct Temu orders linked by
-- either the same normalized phone number or the same normalized full address.
-- A component containing a settlement reversal propagates the refund-customer
-- signal to every related order, while the actual reversed PO remains distinct.
-- The function stays SECURITY INVOKER so order and finance RLS remain the
-- authorization boundary.

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
  with recursive
  customer_order_lines as (
    select
      order_row.*,
      coalesce(nullif(lower(btrim(order_row.order_no)), ''), order_row.id::text) as group_key,
      case
        when phone.phone_digits like '0081%' then
          case
            when substring(phone.phone_digits from 5 for 1) = '0'
              then substring(phone.phone_digits from 5)
            else '0' || substring(phone.phone_digits from 5)
          end
        when phone.phone_digits like '81%' then
          case
            when substring(phone.phone_digits from 3 for 1) = '0'
              then substring(phone.phone_digits from 3)
            else '0' || substring(phone.phone_digits from 3)
          end
        else phone.phone_digits
      end as normalized_phone,
      lower(
        regexp_replace(
          translate(
            concat_ws(
              '',
              order_row.province,
              order_row.city,
              order_row.district,
              order_row.address_line1,
              order_row.address_line2
            ),
            '０１２３４５６７８９',
            '0123456789'
          ),
          '[[:space:][:punct:]]+',
          '',
          'g'
        )
      ) as normalized_address
    from public.temu_orders order_row
    cross join lateral (
      select regexp_replace(
        translate(coalesce(order_row.recipient_phone, ''), '０１２３４５６７８９', '0123456789'),
        '[^0-9]',
        '',
        'g'
      ) as phone_digits
    ) phone
  ),
  customer_orders as (
    select distinct on (line.group_key)
      line.group_key,
      lower(btrim(line.order_no)) as order_key,
      line.normalized_phone,
      line.normalized_address
    from customer_order_lines line
    order by
      line.group_key,
      lower(btrim(line.sku_code)),
      lower(regexp_replace(line.product_attributes, '\s+', '', 'g')),
      lower(btrim(line.sub_order_no)),
      line.id
  ),
  customer_identities as (
    select customer.group_key, 'phone:' || customer.normalized_phone as identity_key
    from customer_orders customer
    where customer.normalized_phone <> ''

    union all

    select customer.group_key, 'address:' || customer.normalized_address as identity_key
    from customer_orders customer
    where customer.normalized_address <> ''
  ),
  customer_edges as (
    select distinct
      source.group_key as source_key,
      target.group_key as target_key
    from customer_identities source
    join customer_identities target
      on target.identity_key = source.identity_key
     and target.group_key <> source.group_key
  ),
  customer_reach (root_key, member_key) as (
    select customer.group_key, customer.group_key
    from customer_orders customer

    union

    select reach.root_key, edge.target_key
    from customer_reach reach
    join customer_edges edge on edge.source_key = reach.member_key
  ),
  customer_components as (
    select
      reach.member_key as group_key,
      min(reach.root_key) as customer_key
    from customer_reach reach
    group by reach.member_key
  ),
  refund_orders as (
    select
      lower(btrim(record.po_number)) as order_key,
      round(sum(coalesce(record.sales_reversal, 0)), 2) as sales_reversal,
      round(sum(coalesce(record.freight_reversal, 0)), 2) as freight_reversal
    from public.finance_settlement_records record
    where btrim(record.po_number) <> ''
      and (
        coalesce(record.sales_reversal, 0) <> 0
        or coalesce(record.freight_reversal, 0) <> 0
      )
    group by lower(btrim(record.po_number))
  ),
  customer_component_summary as (
    select
      component.customer_key,
      count(*)::bigint as order_count,
      bool_or(refund.order_key is not null) as has_refund_order
    from customer_components component
    join customer_orders customer on customer.group_key = component.group_key
    left join refund_orders refund on refund.order_key = customer.order_key
    group by component.customer_key
  ),
  customer_order_signals as (
    select
      customer.group_key,
      case
        when refund.order_key is not null then 'refund_order'
        when summary.has_refund_order then 'refund_customer'
        when summary.order_count > 1 then 'repeat_customer'
        else 'normal'
      end as customer_history_status,
      coalesce(refund.sales_reversal, 0) as customer_sales_reversal,
      coalesce(refund.freight_reversal, 0) as customer_freight_reversal
    from customer_orders customer
    join customer_components component on component.group_key = customer.group_key
    join customer_component_summary summary on summary.customer_key = component.customer_key
    left join refund_orders refund on refund.order_key = customer.order_key
  ),
  base_lines as (
    select
      order_row.*,
      coalesce(signal.customer_history_status, 'normal') as customer_history_status,
      coalesce(signal.customer_sales_reversal, 0) as customer_sales_reversal,
      coalesce(signal.customer_freight_reversal, 0) as customer_freight_reversal,
      coalesce(nullif(lower(btrim(order_row.order_no)), ''), order_row.id::text) as group_key,
      public.temu_order_stage(order_row) as computed_stage,
      public.try_parse_temu_order_time(order_row.latest_ship_time) as ship_deadline_at,
      public.try_parse_temu_order_time(order_row.estimated_delivery_time) as delivery_deadline_at
    from public.temu_orders order_row
    left join customer_order_signals signal
      on signal.group_key = coalesce(
        nullif(lower(btrim(order_row.order_no)), ''),
        order_row.id::text
      )
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

revoke all on function public.get_temu_orders_page(
  integer,
  integer,
  text,
  text,
  uuid,
  text,
  boolean,
  text,
  text,
  timestamptz
) from public;

grant execute on function public.get_temu_orders_page(
  integer,
  integer,
  text,
  text,
  uuid,
  text,
  boolean,
  text,
  text,
  timestamptz
) to authenticated;
