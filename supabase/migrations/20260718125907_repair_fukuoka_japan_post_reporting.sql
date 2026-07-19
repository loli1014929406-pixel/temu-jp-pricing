-- Repair historical Fukuoka orders that still point at the logistics method
-- later renamed to Nagoya Japan Post. Resolve IDs by owner and current names
-- so the migration is idempotent and does not depend on generated UUIDs.
with repair_targets as (
  select o.id, fukuoka_method.id as logistics_method_id, fukuoka_method.name as logistics_method
  from public.temu_orders o
  join public.warehouses w
    on w.id = o.warehouse_id
   and w.owner_id = o.owner_id
  join public.logistics_methods old_method
    on old_method.id = o.logistics_method_id
   and old_method.owner_id = o.owner_id
  join public.logistics_methods fukuoka_method
    on fukuoka_method.owner_id = o.owner_id
   and regexp_replace(lower(btrim(fukuoka_method.name)), '\s+', '', 'g') = '福冈japanpost'
  where regexp_replace(lower(btrim(w.name)), '\s+', '', 'g') = '福冈'
    and regexp_replace(lower(btrim(old_method.name)), '\s+', '', 'g') = '名古屋japanpost'
)
update public.temu_orders o
set logistics_method_id = repair_targets.logistics_method_id,
    logistics_method = repair_targets.logistics_method,
    updated_at = now()
from repair_targets
where o.id = repair_targets.id;

-- Keep order-line counts for compatibility, but expose distinct shipment
-- tickets and warehouse identity for the finance shipping analysis.
create or replace function public.get_finance_order_analysis(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default '',
  p_date_start date default null,
  p_date_end date default null,
  p_status text default 'all',
  p_issue text default 'all'
)
returns table (
  rows jsonb,
  total_count bigint,
  summary jsonb,
  monthly jsonb,
  products jsonb,
  shipping_methods jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with metrics as (
    select m.*,
      coalesce(m.order_data->>'order_no','') as order_no,
      coalesce(m.order_data->>'sub_order_no','') as sub_order_no,
      coalesce(m.order_data->>'sku_code','') as order_sku_code,
      coalesce(m.order_data->>'product_attributes','') as product_attributes,
      coalesce(m.order_data->>'logistics_tracking_no','') as tracking_no,
      coalesce(m.order_data->>'recipient_name','') as recipient_name,
      coalesce(m.order_data->>'warehouse_name','') as warehouse_name,
      coalesce(m.order_data->>'logistics_method','') as logistics_method,
      coalesce(m.product_data->>'product_code','') as product_code,
      coalesce(m.product_data->>'product_name_cn','') as product_name,
      coalesce(m.sku_data->>'sku_code','') as matched_sku_code,
      (m.product_cost_rmb + m.shipping_fee_rmb) as computed_bill,
      case when m.is_settled then m.actual_revenue_rmb - (m.product_cost_rmb + m.shipping_fee_rmb) else 0 end as computed_profit,
      (m.shipping_fee_source = 'missing' and (
        coalesce(m.order_data->>'actual_ship_time','') <> '' or
        coalesce(m.order_data->>'label_printed_at','') <> '' or
        coalesce(m.order_data->>'logistics_tracking_no','') <> '' or
        coalesce(m.order_data->>'logistics_method','') <> ''
      )) as missing_shipping_attention
    from public.get_finance_order_metrics() m
  ), filtered as (
    select * from metrics
    where (p_date_start is null or finance_date >= p_date_start)
      and (p_date_end is null or finance_date <= p_date_end)
      and (coalesce(p_status,'all') = 'all'
        or (p_status = 'settled' and is_settled)
        or (p_status = 'unsettled' and not is_settled))
      and (coalesce(p_issue,'all') = 'all'
        or (p_issue = 'unmatched' and not matched)
        or (p_issue = 'missing-shipping' and shipping_fee_source = 'missing')
        or (p_issue = 'settlement-overdue' and settlement_overdue)
        or (p_issue = 'warehouse-logistics-incomplete' and warehouse_logistics_issue <> '')
        or (p_issue = 'reconciliation' and (
          not matched or warehouse_logistics_issue <> '' or settlement_overdue or missing_shipping_attention
        )))
      and (btrim(coalesce(p_search,'')) = '' or lower(
        order_no || ' ' || sub_order_no || ' ' || order_sku_code || ' ' || product_attributes || ' ' ||
        tracking_no || ' ' || recipient_name || ' ' || warehouse_name || ' ' || logistics_method || ' ' ||
        product_code || ' ' || product_name
      ) like '%' || lower(btrim(p_search)) || '%')
  ), paged as (
    select * from filtered
    order by finance_date desc nulls last, order_no, sub_order_no, order_data->>'id'
    offset (greatest(coalesce(p_page,1),1)-1) * least(greatest(coalesce(p_page_size,20),1),100)
    limit least(greatest(coalesce(p_page_size,20),1),100)
  ), monthly_rows as (
    select to_char(finance_date,'YYYY-MM') as month,
      count(*) as order_count, round(sum(quantity),2) as quantity,
      round(sum(product_cost_rmb),2) as product_cost,
      round(sum(first_leg_shipping_rmb),2) as first_leg_shipping,
      round(sum(last_leg_shipping_rmb),2) as last_leg_shipping,
      round(sum(shipping_fee_rmb),2) as shipping,
      round(sum(computed_bill),2) as bill,
      round(sum(actual_revenue_rmb),2) as actual_revenue,
      round(sum(case when is_settled then actual_revenue_rmb else computed_bill end),2) as estimated_income,
      round(sum(last_leg_shipping_rmb),2) as cash_shipping,
      round(sum(computed_profit),2) as profit,
      count(*) filter (where is_settled) as settled_count,
      count(*) filter (where missing_shipping_attention) as missing_shipping_count
    from filtered group by to_char(finance_date,'YYYY-MM')
  ), product_rows as (
    select case when product_code <> '' then product_code else order_sku_code end as product_code,
      case when product_name <> '' then product_name else product_attributes end as product_name,
      count(*) as order_count, round(sum(quantity),2) as quantity,
      round(sum(product_cost_rmb),2) as product_cost,
      round(sum(shipping_fee_rmb),2) as shipping,
      round(sum(computed_bill),2) as bill,
      round(sum(actual_revenue_rmb),2) as actual_revenue,
      round(sum(computed_profit),2) as profit,
      count(*) filter (where is_settled) as settled_count,
      count(*) filter (where missing_shipping_attention) as missing_shipping_count
    from filtered group by 1, 2
  ), shipping_rows as (
    select
      case when btrim(warehouse_name) = '' then '未填写仓库' else regexp_replace(btrim(warehouse_name),'\s+',' ','g') end as warehouse,
      case when btrim(logistics_method) = '' then '未填写发货方式' else regexp_replace(btrim(logistics_method),'\s+',' ','g') end as method,
      count(*) as order_count,
      count(distinct nullif(btrim(tracking_no), '')) as shipment_count,
      round(sum(quantity),2) as quantity,
      round(sum(case when shipping_fee_source='actual' then last_leg_shipping_rmb else 0 end),2) as actual_shipping,
      round(sum(case when shipping_fee_source='actual' then first_leg_shipping_rmb else shipping_fee_rmb end),2) as estimated_shipping,
      round(sum(shipping_fee_rmb),2) as total_shipping,
      count(*) filter (where shipping_fee_source='missing') as missing_shipping_count
    from filtered group by 1, 2
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'order',order_data,'sku',sku_data,'product',product_data,'quantity',quantity,
      'productCostRmb',product_cost_rmb,'firstLegShippingRmb',first_leg_shipping_rmb,
      'lastLegShippingRmb',last_leg_shipping_rmb,'cashShippingFeeRmb',last_leg_shipping_rmb,
      'estimatedShippingRmb',first_leg_shipping_rmb + coalesce((order_data->>'estimated_last_cost')::numeric,0),
      'shippingFeeRmb',shipping_fee_rmb,'shippingFeeSource',shipping_fee_source,
      'isShippingFeeEstimated',(first_leg_shipping_rmb > 0 or shipping_fee_source='estimated'),
      'warehouseLogisticsIssue',warehouse_logistics_issue,'billAmountRmb',computed_bill,
      'actualSalesRevenueRmb',actual_sales_revenue_rmb,'actualFreightRevenueRmb',actual_freight_revenue_rmb,
      'actualRevenueRmb',actual_revenue_rmb,'isSettled',is_settled,'matched',matched,
      'matchLabel',case when is_settled then 'PO单号' else '' end
    ) order by finance_date desc nulls last, order_no, sub_order_no, order_data->>'id') from paged),'[]'::jsonb),
    (select count(*) from filtered),
    coalesce((select jsonb_build_object(
      'orderCount',count(*),'quantity',round(sum(quantity),2),'productCost',round(sum(product_cost_rmb),2),
      'firstLegShipping',round(sum(first_leg_shipping_rmb),2),'lastLegShipping',round(sum(last_leg_shipping_rmb),2),
      'shipping',round(sum(shipping_fee_rmb),2),'cashShipping',round(sum(last_leg_shipping_rmb),2),
      'bill',round(sum(computed_bill),2),'actualRevenue',round(sum(actual_revenue_rmb),2),
      'profit',round(sum(computed_profit),2),'settledCount',count(*) filter(where is_settled),
      'unsettledCount',count(*) filter(where not is_settled),'unmatchedCount',count(*) filter(where not matched),
      'missingShippingCount',count(*) filter(where shipping_fee_source='missing'),
      'missingShippingAttentionCount',count(*) filter(where missing_shipping_attention)
    ) from filtered),'{}'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(monthly_rows) order by month desc) from monthly_rows),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(product_rows) order by profit desc, product_code) from product_rows),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(shipping_rows) order by total_shipping desc, shipment_count desc) from shipping_rows),'[]'::jsonb);
$$;

revoke all on function public.get_finance_order_analysis(integer, integer, text, date, date, text, text) from public;
revoke all on function public.get_finance_order_analysis(integer, integer, text, date, date, text, text) from anon;
grant execute on function public.get_finance_order_analysis(integer, integer, text, date, date, text, text) to authenticated;
