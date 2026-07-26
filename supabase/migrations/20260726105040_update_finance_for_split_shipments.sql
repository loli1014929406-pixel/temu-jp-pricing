-- Split allocations keep product quantities and settlement revenue at their
-- original order-line totals. Tail shipping is charged once per shipment.

do $migration$
begin
  if to_regprocedure(
    'public.finance_dynamic_method_cost(jsonb,numeric,numeric,numeric)'
  ) is not null then
    execute $sql$
      create or replace function public.finance_split_method_cost(
        p_method jsonb,
        p_weight_g numeric,
        p_exchange_rate numeric,
        p_quantity numeric
      )
      returns numeric
      language sql
      immutable
      security invoker
      set search_path = ''
      as $body$
        select public.finance_dynamic_method_cost(
          p_method,
          p_weight_g,
          p_exchange_rate,
          p_quantity
        )
      $body$
    $sql$;
  else
    execute $sql$
      create or replace function public.finance_split_method_cost(
        p_method jsonb,
        p_weight_g numeric,
        p_exchange_rate numeric,
        p_quantity numeric
      )
      returns numeric
      language sql
      immutable
      security invoker
      set search_path = ''
      as $body$
        select public.finance_dynamic_method_cost(
          p_method,
          p_weight_g,
          p_exchange_rate
        )
      $body$
    $sql$;
  end if;
end
$migration$;

revoke all on function public.finance_split_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) from public;
grant execute on function public.finance_split_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) to authenticated;

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
set search_path = ''
as $$
  with settings as (
    select setting.*, to_jsonb(setting) as doc
    from public.pricing_settings setting
    limit 1
  ), first_configs as (
    select config
    from settings setting
    cross join lateral jsonb_array_elements(
      coalesce(setting.first_leg_methods, jsonb_build_array(
        jsonb_build_object('id','sf-first-leg','name','顺丰','type','first_leg','formula','sf','params',jsonb_build_object('firstWeight',1,'firstPrice',8,'extraPrice',2,'currency','RMB','billingUnit','kg'),'isActive',true),
        jsonb_build_object('id','huaian-air-first-leg','name','淮安空运 RMB/kg','type','first_leg','formula','flat_rmb','params',jsonb_build_object('price',25,'currency','RMB','billingUnit','kg'),'isActive',true),
        jsonb_build_object('id','ocs-first-leg','name','OCS RMB/kg','type','first_leg','formula','flat_rmb_tariff','params',jsonb_build_object('price',20,'tariffRate',0,'currency','RMB','billingUnit','kg'),'isActive',true)
      ))
    ) config
    where coalesce((config->>'isActive')::boolean, false)
  ), last_configs as (
    select config
    from settings setting
    cross join lateral jsonb_array_elements(
      coalesce(setting.last_leg_methods, jsonb_build_array(
        jsonb_build_object('id','ocs-yamato-last-leg','name','OCS Yamato','type','last_leg','formula','ocs_3cm','params',jsonb_build_object('firstPrice',16.5,'extraPrice',1.5,'currency','RMB','billingUnit','100g'),'isActive',true),
        jsonb_build_object('id','ocs-small-last-leg','name','OCS 小包','type','last_leg','formula','ocs_small','params',jsonb_build_object('firstPrice',36.5,'extraPrice',6,'currency','RMB','billingUnit','500g'),'isActive',true),
        jsonb_build_object('id','osaka-jp-last-leg','name','大阪Japan Post','type','last_leg','formula','flat_jpy','params',jsonb_build_object('price',260,'currency','JPY','billingUnit','ticket'),'isActive',true),
        jsonb_build_object('id','fukuoka-jp-last-leg','name','福冈Japan Post','type','last_leg','formula','flat_jpy','params',jsonb_build_object('price',220,'currency','JPY','billingUnit','ticket'),'isActive',true)
      ))
    ) config
    where coalesce((config->>'isActive')::boolean, false)
  ), sku_ranked as (
    select
      sku.*,
      row_number() over (
        partition by sku.product_id
        order by sku.created_at, sku.id
      ) as product_index,
      regexp_replace(
        lower(coalesce((
          select string_agg(entry.key || '：' || entry.value, ' / ' order by entry.key)
          from jsonb_each_text(sku.attributes) entry
        ), '无规格')),
        '\s+',
        '',
        'g'
      ) as sales_spec_key
    from public.product_skus sku
  ), sku_costs as (
    select
      ranked.id as sku_id,
      coalesce(sum(
        (item.purchase_price_rmb * relation.quantity)
        + (
          greatest(item.item_weight_g * relation.quantity, 0) / 1000
          * item.purchase_shipping_fee_per_500g_rmb
        )
      ), 0) as unit_cost
    from sku_ranked ranked
    left join public.product_sku_items relation on relation.sku_id = ranked.id
    left join public.product_items item on item.id = relation.item_id
    group by ranked.id
  ), settlements as (
    select
      record.po_number,
      round(sum(record.sales_revenue + record.sales_reversal), 2) as sales_revenue,
      round(sum(record.freight_revenue + record.freight_reversal), 2) as freight_revenue
    from public.finance_settlement_records record
    where record.user_id = auth.uid()
    group by record.po_number
  ), matched_base as (
    select
      fulfillment.*,
      matched.sku_id,
      matched.product_id,
      matched.unit_cost,
      product.product_code,
      product.product_name_cn,
      product.package_weight_g,
      to_jsonb(matched.sku_row) as sku_json,
      to_jsonb(product) as product_json,
      timezone('Asia/Tokyo', coalesce(
        public.try_parse_temu_order_time(fulfillment.actual_ship_time),
        public.try_parse_temu_order_time(fulfillment.label_printed_at),
        public.try_parse_temu_order_time(fulfillment.latest_ship_time),
        fulfillment.created_at
      ))::date as metric_date
    from public.temu_order_fulfillment_lines fulfillment
    left join lateral (
      select
        ranked.id as sku_id,
        ranked.product_id,
        cost.unit_cost,
        ranked as sku_row
      from sku_ranked ranked
      join sku_costs cost on cost.sku_id = ranked.id
      join public.products candidate_product
        on candidate_product.id = ranked.product_id
      where lower(btrim(ranked.sku_code)) = lower(btrim(fulfillment.sku_code))
        or (
          (btrim(ranked.sku_code) = '' or ranked.sku_code ~* '^SKU[0-9]+$')
          and lower(btrim(candidate_product.product_code || '-' || ranked.product_index))
            = lower(btrim(fulfillment.sku_code))
        )
        or ranked.sales_spec_key = regexp_replace(
          lower(fulfillment.product_attributes),
          '\s+',
          '',
          'g'
        )
      order by
        case
          when lower(btrim(ranked.sku_code)) = lower(btrim(fulfillment.sku_code))
            and btrim(fulfillment.sku_code) <> '' then 1
          when lower(btrim(candidate_product.product_code || '-' || ranked.product_index))
            = lower(btrim(fulfillment.sku_code)) then 2
          else 3
        end,
        ranked.created_at,
        ranked.id
      limit 1
    ) matched on true
    left join public.products product on product.id = matched.product_id
  ), matched_orders as (
    select
      base.*,
      row_number() over (
        partition by base.shipment_id
        order by base.created_at, base.id
      ) as shipping_row_number,
      row_number() over (
        partition by base.source_order_id
        order by base.package_sequence, base.created_at, base.id
      ) as source_revenue_row_number,
      sum(
        greatest(
          coalesce(base.package_weight_g, 0)
          * greatest(base.fulfillment_quantity, 0),
          0
        )
      ) over (partition by base.shipment_id) as shipment_weight_g,
      sum(greatest(coalesce(base.fulfillment_quantity, 0), 0))
        over (partition by base.shipment_id) as shipment_quantity,
      max(base.actual_shipping_fee_rmb)
        over (partition by base.shipment_id) as legacy_actual_shipping_fee_rmb
    from matched_base base
  ), with_logistics as (
    select
      order_row.*,
      coalesce(mapping.has_first, false) as has_first,
      coalesce(mapping.has_last, false) as has_last,
      coalesce(mapping.first_cost, 0) as first_cost,
      imported_fee.id is not null as has_imported_actual_shipping_fee,
      imported_fee.actual_shipping_fee_rmb as imported_actual_shipping_fee_rmb,
      coalesce(public.finance_split_method_cost(
        last_method.config,
        order_row.shipment_weight_g,
        setting.exchange_rate_rmb_per_jpy,
        order_row.shipment_quantity::numeric
      ), 0) as estimated_group_last_cost
    from matched_orders order_row
    cross join settings setting
    left join public.finance_actual_shipping_fees imported_fee
      on imported_fee.user_id = auth.uid()
     and imported_fee.logistics_tracking_no = btrim(order_row.logistics_tracking_no)
    left join lateral (
      select
        count(*) filter (where first_config.config is not null) > 0 as has_first,
        count(*) filter (where last_config.config is not null) > 0 as has_last,
        max(public.finance_dynamic_method_cost(
          first_config.config,
          greatest(
            coalesce(order_row.package_weight_g, 0)
            * greatest(order_row.fulfillment_quantity, 0),
            0
          ),
          setting.exchange_rate_rmb_per_jpy
        )) filter (where first_config.config is not null) as first_cost
      from public.warehouse_logistics_methods warehouse_method
      join public.logistics_methods database_method
        on database_method.id = warehouse_method.logistics_method_id
       and database_method.is_active
      left join first_configs first_config
        on nullif(first_config.config->>'db_method_id', '')::uuid = database_method.id
        or lower(regexp_replace(first_config.config->>'name', '\s+', ' ', 'g'))
          = lower(regexp_replace(database_method.name, '\s+', ' ', 'g'))
      left join last_configs last_config
        on nullif(last_config.config->>'db_method_id', '')::uuid = database_method.id
        or lower(regexp_replace(last_config.config->>'name', '\s+', ' ', 'g'))
          = lower(regexp_replace(database_method.name, '\s+', ' ', 'g'))
      where warehouse_method.warehouse_id = order_row.warehouse_id
    ) mapping on true
    left join lateral (
      select config
      from last_configs
      where config->>'db_method_id' = order_row.logistics_method_id::text
        or lower(regexp_replace(config->>'name', '\s+', ' ', 'g'))
          = lower(regexp_replace(btrim(order_row.logistics_method), '\s+', ' ', 'g'))
        or lower(config->>'name') like '%' || lower(btrim(order_row.logistics_method)) || '%'
        or lower(btrim(order_row.logistics_method)) like '%' || lower(config->>'name') || '%'
        or (
          (lower(order_row.logistics_method) like '%3cm%'
            or lower(order_row.logistics_method) like '%yamato%')
          and config->>'formula' = 'ocs_3cm'
        )
        or (
          (order_row.logistics_method like '%小包%'
            or lower(order_row.logistics_method) like '%small%')
          and config->>'formula' = 'ocs_small'
        )
        or (
          (order_row.logistics_method like '%福冈%'
            or lower(order_row.logistics_method) like '%fukuoka%'
            or lower(order_row.logistics_method) like '%post%')
          and (
            config->>'name' like '%福冈%'
            or config->>'id' like '%fukuoka%'
          )
        )
        or (
          (order_row.logistics_method like '%大阪%'
            or lower(order_row.logistics_method) like '%osaka%')
          and (
            config->>'name' like '%大阪%'
            or config->>'id' like '%osaka%'
          )
        )
      order by
        case
          when config->>'db_method_id' = order_row.logistics_method_id::text then 0
          when lower(regexp_replace(config->>'name', '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(order_row.logistics_method), '\s+', ' ', 'g')) then 1
          else 2
        end
      limit 1
    ) last_method on btrim(order_row.logistics_method) <> ''
  ), calculated as (
    select
      logistics.*,
      case
        when logistics.source_revenue_row_number = 1
          then coalesce(settlement.sales_revenue, 0)
        else 0
      end as sales_revenue,
      case
        when logistics.source_revenue_row_number = 1
          then coalesce(settlement.freight_revenue, 0)
        else 0
      end as freight_revenue,
      settlement.po_number is not null as settled,
      case
        when logistics.warehouse_id is null
          then '仓库物流配置不完整：缺少仓库'
        when not logistics.has_first and not logistics.has_last
          then '仓库物流配置不完整：缺少头程物流方式、尾程物流方式'
        when not logistics.has_first
          then '仓库物流配置不完整：缺少头程物流方式'
        when not logistics.has_last
          then '仓库物流配置不完整：缺少尾程物流方式'
        else ''
      end as logistics_issue,
      case
        when logistics.has_imported_actual_shipping_fee
          then logistics.imported_actual_shipping_fee_rmb
        when logistics.legacy_actual_shipping_fee_rmb > 0
          then logistics.legacy_actual_shipping_fee_rmb
        else null
      end as group_actual_shipping_fee_rmb
    from with_logistics logistics
    left join settlements settlement
      on settlement.po_number = btrim(logistics.order_no)
  ), costed as (
    select
      calculated.*,
      case
        when calculated.group_actual_shipping_fee_rmb is not null then 'actual'
        when calculated.estimated_group_last_cost > 0 then 'estimated'
        else 'missing'
      end as fee_source,
      case
        when calculated.shipping_row_number <> 1 then 0
        when calculated.group_actual_shipping_fee_rmb is not null
          then calculated.group_actual_shipping_fee_rmb
        else calculated.estimated_group_last_cost
      end as group_last_cost,
      case
        when calculated.shipping_row_number = 1
          then calculated.estimated_group_last_cost
        else 0
      end as estimated_last_cost
    from calculated
  )
  select
    jsonb_set(
      to_jsonb(costed) - array[
        'sku_json',
        'product_json',
        'metric_date',
        'sku_id',
        'product_id',
        'unit_cost',
        'product_code',
        'product_name_cn',
        'package_weight_g',
        'has_first',
        'has_last',
        'first_cost',
        'sales_revenue',
        'freight_revenue',
        'settled',
        'logistics_issue',
        'fee_source',
        'shipping_row_number',
        'source_revenue_row_number',
        'shipment_weight_g',
        'shipment_quantity',
        'legacy_actual_shipping_fee_rmb',
        'has_imported_actual_shipping_fee',
        'imported_actual_shipping_fee_rmb',
        'estimated_group_last_cost',
        'group_actual_shipping_fee_rmb',
        'group_last_cost'
      ],
      '{actual_shipping_fee_rmb}',
      to_jsonb(
        case
          when costed.shipping_row_number = 1
            then coalesce(costed.group_actual_shipping_fee_rmb, 0)
          else 0
        end
      ),
      true
    ),
    costed.sku_json,
    costed.product_json,
    costed.metric_date,
    greatest(costed.fulfillment_quantity, 0),
    round(
      coalesce(costed.unit_cost, 0)
      * greatest(costed.fulfillment_quantity, 0),
      2
    ),
    round(
      case when costed.logistics_issue = '' then costed.first_cost else 0 end,
      2
    ),
    round(costed.group_last_cost, 3),
    round(
      case when costed.logistics_issue = '' then costed.first_cost else 0 end
      + costed.group_last_cost,
      3
    ),
    costed.fee_source,
    costed.logistics_issue,
    costed.sales_revenue,
    costed.freight_revenue,
    round(costed.sales_revenue + costed.freight_revenue, 2),
    round(
      coalesce(costed.unit_cost, 0)
      * greatest(costed.fulfillment_quantity, 0)
      + case when costed.logistics_issue = '' then costed.first_cost else 0 end
      + costed.group_last_cost,
      3
    ),
    costed.settled,
    costed.sku_id is not null and costed.product_id is not null,
    not costed.settled
      and nullif(costed.actual_signed_time, '') is not null
      and now() > public.try_parse_temu_order_time(costed.actual_signed_time)
        + interval '1 month'
  from costed
$$;

revoke all on function public.get_finance_order_metrics() from public;
grant execute on function public.get_finance_order_metrics() to authenticated;

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
set search_path = ''
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
      fulfillment.*,
      coalesce(
        public.try_parse_temu_order_time(fulfillment.actual_ship_time),
        public.try_parse_temu_order_time(fulfillment.label_printed_at),
        public.try_parse_temu_order_time(fulfillment.latest_ship_time),
        fulfillment.created_at
      ) as finance_order_at
    from public.temu_order_fulfillment_lines fulfillment
  ), filtered as (
    select normalized.*
    from normalized
    where (
      p_date_start is null
      or timezone('Asia/Tokyo', finance_order_at)::date >= p_date_start
    )
      and (
        p_date_end is null
        or timezone('Asia/Tokyo', finance_order_at)::date <= p_date_end
      )
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(
          order_no || ' ' || sub_order_no || ' ' || sku_code || ' '
          || product_attributes || ' ' || logistics_tracking_no || ' '
          || recipient_name
        ) like '%' || lower(btrim(p_search)) || '%'
      )
      and (
        v_status = 'all'
        or (
          v_status = 'settled'
          and exists (
            select 1
            from public.finance_settlement_records settlement
            where settlement.po_number = normalized.order_no
          )
        )
        or (
          v_status = 'unsettled'
          and not exists (
            select 1
            from public.finance_settlement_records settlement
            where settlement.po_number = normalized.order_no
          )
        )
      )
  ), paged as (
    select filtered.*
    from filtered
    order by
      finance_order_at desc nulls last,
      order_no,
      package_sequence,
      sub_order_no,
      id
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select
    coalesce((
      select jsonb_agg(
        to_jsonb(paged) - 'finance_order_at'
        order by
          finance_order_at desc nulls last,
          order_no,
          package_sequence,
          sub_order_no,
          id
      )
      from paged
    ), '[]'::jsonb),
    (select count(*) from filtered);
end
$$;

revoke all on function public.get_finance_orders_page(
  integer,
  integer,
  text,
  date,
  date,
  text
) from public;
grant execute on function public.get_finance_orders_page(
  integer,
  integer,
  text,
  date,
  date,
  text
) to authenticated;

create or replace function public.sync_actual_shipping_fee_to_shipment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.temu_order_shipments shipment
  set actual_shipping_fee_rmb = new.actual_shipping_fee_rmb
  where btrim(shipment.logistics_tracking_no) = btrim(new.logistics_tracking_no);
  return new;
end
$$;

revoke all on function public.sync_actual_shipping_fee_to_shipment() from public;

drop trigger if exists finance_actual_shipping_fees_sync_shipment
  on public.finance_actual_shipping_fees;
create trigger finance_actual_shipping_fees_sync_shipment
  after insert or update of actual_shipping_fee_rmb
  on public.finance_actual_shipping_fees
  for each row execute function public.sync_actual_shipping_fee_to_shipment();

update public.temu_order_shipments shipment
set actual_shipping_fee_rmb = fee.actual_shipping_fee_rmb
from public.finance_actual_shipping_fees fee
where btrim(shipment.logistics_tracking_no) = btrim(fee.logistics_tracking_no)
  and btrim(shipment.logistics_tracking_no) <> '';

-- Preserve the existing import, reporting, and payment formulas verbatim; only
-- change their tracking-number source from commercial order lines to shipments.
do $patch$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
begin
  foreach v_signature in array array[
    'public.preview_actual_shipping_fee_import(jsonb)'::regprocedure,
    'public.import_actual_shipping_fees(text,text,jsonb)'::regprocedure,
    'public.record_logistics_payment(text,text,numeric,timestamptz,text,uuid)'::regprocedure,
    'public.get_finance_logistics_cash_summary()'::regprocedure,
    'public.get_actual_shipping_fee_report(integer,integer,text,text,text)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_rewritten := replace(
      v_definition,
      'from public.temu_orders order_row',
      'from public.temu_order_shipments order_row'
    );

    if v_rewritten = v_definition then
      raise exception 'Expected Temu order source was not found in function %',
        v_signature::text;
    end if;

    execute v_rewritten;
  end loop;
end
$patch$;

do $analysis_patch$
declare
  v_signature regprocedure :=
    'public.get_finance_order_analysis(integer,integer,text,date,date,text,text)'::regprocedure;
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := replace(
    v_definition,
    'count(distinct nullif(btrim(tracking_no), '''')) as shipment_count',
    'count(distinct coalesce(nullif(order_data->>''shipment_id'', ''''), nullif(btrim(tracking_no), ''''))) as shipment_count'
  );

  if v_rewritten = v_definition then
    raise exception 'Expected shipment count expression was not found in function %',
      v_signature::text;
  end if;

  execute v_rewritten;
end
$analysis_patch$;
