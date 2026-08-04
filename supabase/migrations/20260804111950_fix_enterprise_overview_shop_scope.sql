create or replace function private.get_enterprise_operating_overview(
  p_enterprise_id uuid,
  p_date_start date default null,
  p_date_end date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null
    or not (
      private.current_user_is_platform_owner()
      or private.current_user_is_enterprise_owner(p_enterprise_id)
    )
  then
    raise exception using errcode = '42501', message = 'Enterprise overview access denied.';
  end if;

  with metrics as (
    select
      source_order.shop_id,
      source_order.order_no,
      timezone(
        'Asia/Tokyo',
        public.try_parse_temu_order_time(metric.order_data ->> 'actual_ship_time')
      )::date as actual_ship_date,
      metric.is_settled,
      metric.actual_revenue_rmb,
      metric.product_cost_rmb,
      metric.shipping_fee_rmb
    from public.get_finance_order_metrics() metric
    join public.temu_orders source_order
      on source_order.id = nullif(metric.order_data ->> 'source_order_id', '')::uuid
    where source_order.enterprise_id = p_enterprise_id
  ), filtered as (
    select * from metrics
    where (p_date_start is null or actual_ship_date >= p_date_start)
      and (p_date_end is null or actual_ship_date <= p_date_end)
  ), shop_rows as (
    select
      shop.id as shop_id,
      shop.code as shop_code,
      shop.name as shop_name,
      count(distinct filtered.order_no)::bigint as order_count,
      count(distinct filtered.order_no) filter (
        where filtered.actual_ship_date is not null
      )::bigint as shipped_count,
      count(distinct filtered.order_no) filter (
        where filtered.is_settled
      )::bigint as settled_count,
      round(coalesce(sum(filtered.actual_revenue_rmb), 0), 2)
        as actual_revenue_rmb,
      round(coalesce(sum(
        case when filtered.is_settled then
          filtered.actual_revenue_rmb
            - filtered.product_cost_rmb
            - filtered.shipping_fee_rmb
        else 0 end
      ), 0), 2) as settled_profit_rmb
    from public.shops shop
    left join filtered on filtered.shop_id = shop.id
    where shop.enterprise_id = p_enterprise_id
      and shop.status = 'active'
    group by shop.id, shop.code, shop.name
  )
  select jsonb_build_object(
    'enterpriseId', p_enterprise_id,
    'summary', jsonb_build_object(
      'orderCount', coalesce(sum(shop_rows.order_count), 0),
      'shippedCount', coalesce(sum(shop_rows.shipped_count), 0),
      'settledCount', coalesce(sum(shop_rows.settled_count), 0),
      'actualRevenueRmb', round(coalesce(sum(shop_rows.actual_revenue_rmb), 0), 2),
      'settledProfitRmb', round(coalesce(sum(shop_rows.settled_profit_rmb), 0), 2)
    ),
    'shops', coalesce(
      jsonb_agg(to_jsonb(shop_rows) order by shop_rows.shop_name),
      '[]'::jsonb
    )
  ) into v_result
  from shop_rows;

  return coalesce(v_result, jsonb_build_object(
    'enterpriseId', p_enterprise_id,
    'summary', jsonb_build_object(
      'orderCount', 0,
      'shippedCount', 0,
      'settledCount', 0,
      'actualRevenueRmb', 0,
      'settledProfitRmb', 0
    ),
    'shops', '[]'::jsonb
  ));
end
$function$;

revoke all on function private.get_enterprise_operating_overview(uuid, date, date)
  from public, anon;
grant execute on function private.get_enterprise_operating_overview(uuid, date, date)
  to authenticated;
