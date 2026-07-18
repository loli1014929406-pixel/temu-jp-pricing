-- Operating overview uses one cohort rule: the website order's actual ship date.
-- Revenue and costs are compared only for the same settled order rows.

create or replace function public.get_finance_operating_overview(
  p_date_start date default null,
  p_date_end date default null
)
returns table (
  summary jsonb,
  monthly jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select
      metrics.*,
      timezone(
        'Asia/Tokyo',
        public.try_parse_temu_order_time(metrics.order_data->>'actual_ship_time')
      )::date as actual_ship_date,
      (
        metrics.shipping_fee_source = 'missing'
        and (
          coalesce(metrics.order_data->>'actual_ship_time', '') <> ''
          or coalesce(metrics.order_data->>'logistics_tracking_no', '') <> ''
          or coalesce(metrics.order_data->>'logistics_method', '') <> ''
        )
      ) as missing_shipping_attention
    from public.get_finance_order_metrics() metrics
  ), filtered as (
    select *
    from base
    where actual_ship_date is not null
      and (p_date_start is null or actual_ship_date >= p_date_start)
      and (p_date_end is null or actual_ship_date <= p_date_end)
  ), monthly_rows as (
    select
      to_char(actual_ship_date, 'YYYY-MM') as month,
      count(*) as order_count,
      count(*) filter (where is_settled) as settled_count,
      round(sum(actual_revenue_rmb), 2) as actual_revenue,
      round(sum(product_cost_rmb) filter (where is_settled), 2) as settled_product_cost,
      round(sum(shipping_fee_rmb) filter (where is_settled), 2) as settled_shipping,
      round(sum(
        case when is_settled
          then actual_revenue_rmb - product_cost_rmb - shipping_fee_rmb
          else 0
        end
      ), 2) as settled_profit,
      round(sum(
        case when not is_settled
          then product_cost_rmb + shipping_fee_rmb
          else 0
        end
      ), 2) as unsettled_cost
    from base
    where actual_ship_date is not null
    group by to_char(actual_ship_date, 'YYYY-MM')
  )
  select
    coalesce((
      select jsonb_build_object(
        'orderCount', count(*),
        'settledCount', count(*) filter (where is_settled),
        'unsettledCount', count(*) filter (where not is_settled),
        'actualRevenue', round(coalesce(sum(actual_revenue_rmb), 0), 2),
        'settledProductCost', round(coalesce(sum(product_cost_rmb) filter (where is_settled), 0), 2),
        'settledShipping', round(coalesce(sum(shipping_fee_rmb) filter (where is_settled), 0), 2),
        'settledProfit', round(coalesce(sum(
          case when is_settled
            then actual_revenue_rmb - product_cost_rmb - shipping_fee_rmb
            else 0
          end
        ), 0), 2),
        'unsettledProductCost', round(coalesce(sum(product_cost_rmb) filter (where not is_settled), 0), 2),
        'unsettledShipping', round(coalesce(sum(shipping_fee_rmb) filter (where not is_settled), 0), 2),
        'unsettledCost', round(coalesce(sum(
          case when not is_settled
            then product_cost_rmb + shipping_fee_rmb
            else 0
          end
        ), 0), 2),
        'unmatchedCount', count(*) filter (where not matched),
        'missingShippingAttentionCount', count(*) filter (where missing_shipping_attention),
        'missingActualShipTimeCount', (select count(*) from base where actual_ship_date is null)
      )
      from filtered
    ), '{}'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(monthly_rows) order by month desc)
      from monthly_rows
    ), '[]'::jsonb);
$$;

revoke all on function public.get_finance_operating_overview(date, date) from public;
grant execute on function public.get_finance_operating_overview(date, date) to authenticated;
