-- Keep product and first-leg costs on their existing order lines, but calculate
-- last-leg shipping once for the main order/tracking-number group. Imported
-- actual fees take priority over the legacy per-row field.

create or replace function public.get_finance_order_metrics()
returns table (
  order_data jsonb,
  sku_data jsonb,
  product_data jsonb,
  finance_date date,
  quantity numeric,
  product_cost_rmb numeric,
  first_leg_shipping_rmb numeric,
  last_leg_shipping_rmb numeric,
  shipping_fee_rmb numeric,
  shipping_fee_source text,
  warehouse_logistics_issue text,
  actual_sales_revenue_rmb numeric,
  actual_freight_revenue_rmb numeric,
  actual_revenue_rmb numeric,
  bill_amount_rmb numeric,
  is_settled boolean,
  matched boolean,
  settlement_overdue boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with settings as (
    select s.*, to_jsonb(s) as doc
    from public.pricing_settings s
    limit 1
  ), first_configs as (
    select config
    from settings s
    cross join lateral jsonb_array_elements(
      coalesce(s.first_leg_methods, jsonb_build_array(
        jsonb_build_object('id','sf-first-leg','name','顺丰','type','first_leg','formula','sf','params',jsonb_build_object('firstWeight',1,'firstPrice',8,'extraPrice',2,'currency','RMB','billingUnit','kg'),'isActive',true),
        jsonb_build_object('id','huaian-air-first-leg','name','淮安空运 RMB/kg','type','first_leg','formula','flat_rmb','params',jsonb_build_object('price',25,'currency','RMB','billingUnit','kg'),'isActive',true),
        jsonb_build_object('id','ocs-first-leg','name','OCS RMB/kg','type','first_leg','formula','flat_rmb_tariff','params',jsonb_build_object('price',20,'tariffRate',0,'currency','RMB','billingUnit','kg'),'isActive',true)
      ))
    ) config
    where coalesce((config->>'isActive')::boolean, false)
  ), last_configs as (
    select config
    from settings s
    cross join lateral jsonb_array_elements(
      coalesce(s.last_leg_methods, jsonb_build_array(
        jsonb_build_object('id','ocs-yamato-last-leg','name','OCS Yamato','type','last_leg','formula','ocs_3cm','params',jsonb_build_object('firstPrice',16.5,'extraPrice',1.5,'currency','RMB','billingUnit','100g'),'isActive',true),
        jsonb_build_object('id','ocs-small-last-leg','name','OCS 小包','type','last_leg','formula','ocs_small','params',jsonb_build_object('firstPrice',36.5,'extraPrice',6,'currency','RMB','billingUnit','500g'),'isActive',true),
        jsonb_build_object('id','osaka-jp-last-leg','name','大阪Japan Post','type','last_leg','formula','flat_jpy','params',jsonb_build_object('price',260,'currency','JPY','billingUnit','ticket'),'isActive',true),
        jsonb_build_object('id','fukuoka-jp-last-leg','name','福冈Japan Post','type','last_leg','formula','flat_jpy','params',jsonb_build_object('price',220,'currency','JPY','billingUnit','ticket'),'isActive',true)
      ))
    ) config
    where coalesce((config->>'isActive')::boolean, false)
  ), sku_ranked as (
    select ps.*, row_number() over (partition by ps.product_id order by ps.created_at, ps.id) as product_index,
      regexp_replace(lower(coalesce((
        select string_agg(entry.key || '：' || entry.value, ' / ' order by entry.key)
        from jsonb_each_text(ps.attributes) entry
      ), '无规格')), '\s+', '', 'g') as sales_spec_key
    from public.product_skus ps
  ), sku_costs as (
    select sr.id as sku_id,
      coalesce(sum((pi.purchase_price_rmb * psi.quantity)
        + ((greatest(pi.item_weight_g * psi.quantity, 0) / 1000) * pi.purchase_shipping_fee_per_500g_rmb)), 0) as unit_cost
    from sku_ranked sr
    left join public.product_sku_items psi on psi.sku_id = sr.id
    left join public.product_items pi on pi.id = psi.item_id
    group by sr.id
  ), settlements as (
    select po_number,
      round(sum(sales_revenue + sales_reversal), 2) as sales_revenue,
      round(sum(freight_revenue + freight_reversal), 2) as freight_revenue
    from public.finance_settlement_records
    where user_id = auth.uid()
    group by po_number
  ), matched_base as (
    select o.*, m.sku_id, m.product_id, m.unit_cost, p.product_code, p.product_name_cn,
      p.package_weight_g, to_jsonb(m.sku_row) as sku_json, to_jsonb(p) as product_json,
      timezone('Asia/Tokyo', coalesce(
        public.try_parse_temu_order_time(o.actual_ship_time),
        public.try_parse_temu_order_time(o.label_printed_at),
        public.try_parse_temu_order_time(o.latest_ship_time),
        o.created_at
      ))::date as metric_date
    from public.temu_orders o
    left join lateral (
      select sr.id as sku_id, sr.product_id, sc.unit_cost, sr as sku_row
      from sku_ranked sr
      join sku_costs sc on sc.sku_id = sr.id
      join public.products px on px.id = sr.product_id
      where lower(btrim(sr.sku_code)) = lower(btrim(o.sku_code))
        or ((btrim(sr.sku_code) = '' or sr.sku_code ~* '^SKU[0-9]+$')
          and lower(btrim(px.product_code || '-' || sr.product_index)) = lower(btrim(o.sku_code)))
        or sr.sales_spec_key = regexp_replace(lower(o.product_attributes), '\s+', '', 'g')
      order by case
        when lower(btrim(sr.sku_code)) = lower(btrim(o.sku_code)) and btrim(o.sku_code) <> '' then 1
        when lower(btrim(px.product_code || '-' || sr.product_index)) = lower(btrim(o.sku_code)) then 2
        else 3 end, sr.created_at, sr.id
      limit 1
    ) m on true
    left join public.products p on p.id = m.product_id
  ), matched_orders as (
    select matched_base.*,
      row_number() over (
        partition by coalesce(
            nullif(btrim(matched_base.logistics_tracking_no), ''),
            'ORDER:' || coalesce(nullif(btrim(matched_base.order_no), ''), matched_base.id::text)
          )
        order by matched_base.created_at, matched_base.id
      ) as shipping_row_number,
      sum(greatest(coalesce(matched_base.package_weight_g, 0) * greatest(matched_base.fulfillment_quantity, 0), 0)) over (
        partition by coalesce(
            nullif(btrim(matched_base.logistics_tracking_no), ''),
            'ORDER:' || coalesce(nullif(btrim(matched_base.order_no), ''), matched_base.id::text)
          )
      ) as shipment_weight_g,
      max(matched_base.actual_shipping_fee_rmb) over (
        partition by coalesce(
            nullif(btrim(matched_base.logistics_tracking_no), ''),
            'ORDER:' || coalesce(nullif(btrim(matched_base.order_no), ''), matched_base.id::text)
          )
      ) as legacy_actual_shipping_fee_rmb
    from matched_base
  ), with_logistics as (
    select mo.*, coalesce(ws.has_first, false) as has_first, coalesce(ws.has_last, false) as has_last,
      coalesce(ws.first_cost, 0) as first_cost,
      imported_fee.id is not null as has_imported_actual_shipping_fee,
      imported_fee.actual_shipping_fee_rmb as imported_actual_shipping_fee_rmb,
      coalesce(public.finance_dynamic_method_cost(lm.config,
        mo.shipment_weight_g,
        s.exchange_rate_rmb_per_jpy), 0) as estimated_group_last_cost
    from matched_orders mo
    cross join settings s
    left join public.finance_actual_shipping_fees imported_fee
      on imported_fee.user_id = auth.uid()
      and imported_fee.logistics_tracking_no = btrim(mo.logistics_tracking_no)
    left join lateral (
      select
        count(*) filter (where fc.config is not null) > 0 as has_first,
        count(*) filter (where lc.config is not null) > 0 as has_last,
        max(public.finance_dynamic_method_cost(fc.config,
          greatest(coalesce(mo.package_weight_g,0) * greatest(mo.fulfillment_quantity,0),0),
          s.exchange_rate_rmb_per_jpy)) filter (where fc.config is not null) as first_cost
      from public.warehouse_logistics_methods wlm
      join public.logistics_methods dbm on dbm.id = wlm.logistics_method_id and dbm.is_active
      left join first_configs fc on
        (nullif(fc.config->>'db_method_id','')::uuid = dbm.id)
        or lower(regexp_replace(fc.config->>'name','\s+',' ','g')) = lower(regexp_replace(dbm.name,'\s+',' ','g'))
      left join last_configs lc on
        (nullif(lc.config->>'db_method_id','')::uuid = dbm.id)
        or lower(regexp_replace(lc.config->>'name','\s+',' ','g')) = lower(regexp_replace(dbm.name,'\s+',' ','g'))
      where wlm.warehouse_id = mo.warehouse_id
    ) ws on true
    left join lateral (
      select config
      from last_configs
      where lower(regexp_replace(config->>'name','\s+',' ','g')) = lower(regexp_replace(btrim(mo.logistics_method),'\s+',' ','g'))
        or lower(config->>'name') like '%' || lower(btrim(mo.logistics_method)) || '%'
        or lower(btrim(mo.logistics_method)) like '%' || lower(config->>'name') || '%'
        or ((lower(mo.logistics_method) like '%3cm%' or lower(mo.logistics_method) like '%yamato%') and config->>'formula' = 'ocs_3cm')
        or ((mo.logistics_method like '%小包%' or lower(mo.logistics_method) like '%small%') and config->>'formula' = 'ocs_small')
        or ((mo.logistics_method like '%福冈%' or lower(mo.logistics_method) like '%fukuoka%' or lower(mo.logistics_method) like '%post%') and ((config->>'name') like '%福冈%' or config->>'id' like '%fukuoka%'))
        or ((mo.logistics_method like '%大阪%' or lower(mo.logistics_method) like '%osaka%') and ((config->>'name') like '%大阪%' or config->>'id' like '%osaka%'))
      order by case when lower(regexp_replace(config->>'name','\s+',' ','g')) = lower(regexp_replace(btrim(mo.logistics_method),'\s+',' ','g')) then 1 else 2 end
      limit 1
    ) lm on btrim(mo.logistics_method) <> ''
  ), calculated as (
    select wl.*, coalesce(st.sales_revenue,0) as sales_revenue,
      coalesce(st.freight_revenue,0) as freight_revenue,
      st.po_number is not null as settled,
      case when wl.warehouse_id is null then '仓库物流配置不完整：缺少仓库'
        when not wl.has_first and not wl.has_last then '仓库物流配置不完整：缺少头程物流方式、尾程物流方式'
        when not wl.has_first then '仓库物流配置不完整：缺少头程物流方式'
        when not wl.has_last then '仓库物流配置不完整：缺少尾程物流方式'
        else '' end as logistics_issue,
      case
        when wl.has_imported_actual_shipping_fee then wl.imported_actual_shipping_fee_rmb
        when wl.legacy_actual_shipping_fee_rmb > 0 then wl.legacy_actual_shipping_fee_rmb
        else null
      end as group_actual_shipping_fee_rmb
    from with_logistics wl
    left join settlements st on st.po_number = btrim(wl.order_no)
  ), costed as (
    select calculated.*,
      case
        when calculated.group_actual_shipping_fee_rmb is not null then 'actual'
        when calculated.estimated_group_last_cost > 0 then 'estimated'
        else 'missing'
      end as fee_source,
      case
        when calculated.shipping_row_number <> 1 then 0
        when calculated.group_actual_shipping_fee_rmb is not null then calculated.group_actual_shipping_fee_rmb
        else calculated.estimated_group_last_cost
      end as group_last_cost,
      case
        when calculated.shipping_row_number = 1 then calculated.estimated_group_last_cost
        else 0
      end as estimated_last_cost
    from calculated
  )
  select
    jsonb_set(
      to_jsonb(c) - array[
        'sku_json','product_json','metric_date','sku_id','product_id','unit_cost','product_code','product_name_cn',
        'package_weight_g','has_first','has_last','first_cost','sales_revenue','freight_revenue','settled',
        'logistics_issue','fee_source','shipping_row_number','shipment_weight_g','legacy_actual_shipping_fee_rmb',
        'has_imported_actual_shipping_fee','imported_actual_shipping_fee_rmb','estimated_group_last_cost',
        'group_actual_shipping_fee_rmb','group_last_cost'
      ],
      '{actual_shipping_fee_rmb}',
      to_jsonb(case when c.shipping_row_number = 1 then coalesce(c.group_actual_shipping_fee_rmb, 0) else 0 end),
      true
    ),
    c.sku_json,
    c.product_json,
    c.metric_date,
    greatest(c.fulfillment_quantity,0),
    round(coalesce(c.unit_cost,0) * greatest(c.fulfillment_quantity,0),2),
    round(case when c.logistics_issue = '' then c.first_cost else 0 end,2),
    round(c.group_last_cost,3),
    round((case when c.logistics_issue = '' then c.first_cost else 0 end) + c.group_last_cost,3),
    c.fee_source,
    c.logistics_issue,
    c.sales_revenue,
    c.freight_revenue,
    round(c.sales_revenue + c.freight_revenue,2),
    round(coalesce(c.unit_cost,0) * greatest(c.fulfillment_quantity,0)
      + (case when c.logistics_issue = '' then c.first_cost else 0 end)
      + c.group_last_cost,3),
    c.settled,
    c.sku_id is not null and c.product_id is not null,
    not c.settled and nullif(c.actual_signed_time,'') is not null
      and now() > public.try_parse_temu_order_time(c.actual_signed_time) + interval '1 month'
  from costed c;
$$;

revoke all on function public.get_finance_order_metrics() from public;
grant execute on function public.get_finance_order_metrics() to authenticated;
