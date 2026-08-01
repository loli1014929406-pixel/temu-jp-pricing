-- Actual freight belongs to a logistics method + tracking number identity.
-- Combined parcels may have several logical member shipments, but only the
-- persisted primary shipment carries the amount.

alter table public.finance_actual_shipping_fees
  drop constraint if exists finance_actual_shipping_fees_user_tracking_unique;

alter table public.finance_actual_shipping_fees
  add constraint finance_actual_shipping_fees_user_method_tracking_unique
  unique (user_id, logistics_method_id, logistics_tracking_no);

create index if not exists finance_actual_shipping_fees_method_tracking_idx
  on public.finance_actual_shipping_fees (
    logistics_method_id,
    logistics_tracking_no
  );

create or replace function public.sync_actual_shipping_fee_to_shipment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_physical_group_count integer;
begin
  if new.logistics_method_id is null or btrim(new.logistics_tracking_no) = '' then
    return new;
  end if;

  select count(distinct coalesce(member.combined_shipment_id, shipment.id))
    into v_physical_group_count
  from public.temu_order_shipments shipment
  left join public.temu_order_combined_shipment_members member
    on member.shipment_id = shipment.id
  where shipment.logistics_method_id = new.logistics_method_id
    and lower(btrim(shipment.logistics_tracking_no)) =
      lower(btrim(new.logistics_tracking_no));

  if v_physical_group_count > 1 then
    raise exception '相同物流方式和物流单号对应多个未合并包裹，不能写入实际运费。'
      using errcode = '23505';
  end if;

  update public.temu_order_shipments shipment
  set actual_shipping_fee_rmb = case
    when member.combined_shipment_id is null or member.is_primary
      then new.actual_shipping_fee_rmb
    else 0
  end
  from public.temu_order_combined_shipment_members member
  where shipment.id = member.shipment_id
    and shipment.logistics_method_id = new.logistics_method_id
    and lower(btrim(shipment.logistics_tracking_no)) =
      lower(btrim(new.logistics_tracking_no));

  update public.temu_order_shipments shipment
  set actual_shipping_fee_rmb = new.actual_shipping_fee_rmb
  where not exists (
      select 1
      from public.temu_order_combined_shipment_members member
      where member.shipment_id = shipment.id
    )
    and shipment.logistics_method_id = new.logistics_method_id
    and lower(btrim(shipment.logistics_tracking_no)) =
      lower(btrim(new.logistics_tracking_no));

  return new;
end
$$;

revoke all on function public.sync_actual_shipping_fee_to_shipment() from public;

drop trigger if exists finance_actual_shipping_fees_sync_shipment
  on public.finance_actual_shipping_fees;
create trigger finance_actual_shipping_fees_sync_shipment
  after insert or update of actual_shipping_fee_rmb, logistics_method_id
  on public.finance_actual_shipping_fees
  for each row execute function public.sync_actual_shipping_fee_to_shipment();

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
        partition by coalesce(base.combined_shipment_id, base.shipment_id)
        order by base.combined_is_primary desc, base.created_at, base.id
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
      ) over (partition by coalesce(base.combined_shipment_id, base.shipment_id)) as shipment_weight_g,
      sum(greatest(coalesce(base.fulfillment_quantity, 0), 0))
        over (partition by coalesce(base.combined_shipment_id, base.shipment_id)) as shipment_quantity,
      max(base.actual_shipping_fee_rmb)
        over (partition by coalesce(base.combined_shipment_id, base.shipment_id)) as legacy_actual_shipping_fee_rmb
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
     and imported_fee.logistics_method_id = order_row.logistics_method_id
     and imported_fee.logistics_tracking_no = btrim(order_row.logistics_tracking_no)
    left join lateral (
      select
        count(*) filter (where first_config.config is not null) > 0 as has_first,
        count(*) filter (where last_config.config is not null) > 0 as has_last,
        max(public.finance_dynamic_method_cost(
          first_config.config,
          case
            when order_row.combined_shipment_id is not null
              then order_row.shipment_weight_g
            else greatest(
              coalesce(order_row.package_weight_g, 0)
              * greatest(order_row.fulfillment_quantity, 0),
              0
            )
          end,
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
        when calculated.combined_shipment_id is not null
          and calculated.shipping_row_number <> 1 then 'estimated'
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
      case
        when costed.logistics_issue = ''
          and (costed.combined_shipment_id is null or costed.shipping_row_number = 1)
          then costed.first_cost
        else 0
      end,
      2
    ),
    round(costed.group_last_cost, 3),
    round(
      case
        when costed.logistics_issue = ''
          and (costed.combined_shipment_id is null or costed.shipping_row_number = 1)
          then costed.first_cost
        else 0
      end
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
      + case
          when costed.logistics_issue = ''
            and (costed.combined_shipment_id is null or costed.shipping_row_number = 1)
            then costed.first_cost
          else 0
        end
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

create or replace function public.preview_actual_shipping_fee_import_v2(p_records jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if coalesce(jsonb_typeof(p_records), 'null') <> 'array' then
    raise exception 'Shipping fee records must be an array' using errcode = '22023';
  end if;

  with input_raw as (
    select
      btrim(record.tracking_no) as tracking_no,
      record.amount_rmb,
      record.logistics_method_id,
      record.source_row_number
    from jsonb_to_recordset(p_records) as record(
      tracking_no text,
      amount_rmb numeric,
      logistics_method_id uuid,
      source_row_number integer
    )
    where btrim(coalesce(record.tracking_no, '')) <> ''
      and record.amount_rmb is not null
      and record.amount_rmb >= 0
      and record.logistics_method_id is not null
  ), input_rows as (
    select
      input_raw.*,
      count(*) over (partition by input_raw.logistics_method_id, input_raw.tracking_no) as input_tracking_count
    from input_raw
  ), shipment_groups as (
    select
      input.tracking_no,
      count(distinct coalesce(combined_member.combined_shipment_id, shipment.id)) as shipment_count,
      (array_agg(shipment.id order by coalesce(combined_member.is_primary, false) desc, shipment.id))[1] as shipment_id,
      (array_agg(shipment.order_no order by coalesce(combined_member.is_primary, false) desc, shipment.id))[1] as order_no,
      (array_agg(nullif(btrim(shipment.actual_ship_time), '') order by shipment.id))[1] as actual_ship_time,
      (array_agg(shipment.logistics_method_id order by shipment.id))[1] as logistics_method_id,
      max(shipment.actual_shipping_fee_rmb) as shipment_actual_shipping_fee_rmb
    from input_rows input
    left join public.temu_order_shipments shipment
      on shipment.logistics_method_id = input.logistics_method_id
     and btrim(shipment.logistics_tracking_no) = input.tracking_no
    left join public.temu_order_combined_shipment_members combined_member
      on combined_member.shipment_id = shipment.id
    group by input.logistics_method_id, input.tracking_no
  ), evaluated as (
    select
      input.tracking_no,
      input.amount_rmb,
      input.logistics_method_id,
      method.name as logistics_method_name,
      input.source_row_number,
      shipments.order_no,
      shipments.actual_ship_time,
      case
        when shipments.actual_ship_time is null then ''
        else coalesce(to_char(
          timezone('Asia/Tokyo', public.try_parse_temu_order_time(shipments.actual_ship_time)),
          'YYYY-MM'
        ), '')
      end as settlement_month,
      case
        when input.input_tracking_count > 1 then 'duplicate'
        when coalesce(shipments.shipment_count, 0) = 0 then 'unmatched'
        when shipments.shipment_count > 1 then 'conflict'
        when not coalesce(method.is_active, false)
          or not exists (
            select 1
            from public.warehouse_logistics_methods link
            where link.logistics_method_id = input.logistics_method_id
          ) then 'method_mismatch'
        when shipments.logistics_method_id is distinct from input.logistics_method_id then 'method_mismatch'
        when existing.id is not null or coalesce(shipments.shipment_actual_shipping_fee_rmb, 0) > 0 then 'existing'
        else 'importable'
      end as status
    from input_rows input
    left join shipment_groups shipments
      on shipments.logistics_method_id = input.logistics_method_id
     and shipments.tracking_no = input.tracking_no
    left join public.logistics_methods method on method.id = input.logistics_method_id
    left join public.finance_actual_shipping_fees existing
      on existing.user_id = v_user_id
      and existing.logistics_method_id = input.logistics_method_id
      and existing.logistics_tracking_no = input.tracking_no
  ), month_rows as (
    select
      settlement_month as month,
      count(*) as shipment_count,
      sum(amount_rmb) as total_amount_rmb
    from evaluated
    where status = 'importable'
    group by settlement_month
  ), preview_rows as (
    select *
    from evaluated
    order by
      case status
        when 'importable' then 1
        when 'existing' then 2
        when 'method_mismatch' then 3
        when 'unmatched' then 4
        when 'duplicate' then 5
        else 6
      end,
      source_row_number
    limit 200
  )
  select jsonb_build_object(
    'parsedRecordCount', (select count(*) from evaluated),
    'matchedRecordCount', (
      select count(*) from evaluated
      where status in ('importable', 'existing', 'method_mismatch')
    ),
    'importableRecordCount', (select count(*) from evaluated where status = 'importable'),
    'existingRecordCount', (select count(*) from evaluated where status = 'existing'),
    'unmatchedRecordCount', (select count(*) from evaluated where status = 'unmatched'),
    'conflictRecordCount', (select count(*) from evaluated where status = 'conflict'),
    'duplicateRecordCount', (select count(*) from evaluated where status = 'duplicate'),
    'methodMismatchRecordCount', (select count(*) from evaluated where status = 'method_mismatch'),
    'missingActualShipTimeCount', (
      select count(*) from evaluated where status = 'importable' and settlement_month = ''
    ),
    'importableTotalAmountRmb', coalesce((
      select sum(amount_rmb) from evaluated where status = 'importable'
    ), 0),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', month,
        'shipmentCount', shipment_count,
        'totalAmountRmb', total_amount_rmb
      ) order by month desc)
      from month_rows
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'trackingNo', tracking_no,
        'amountRmb', amount_rmb,
        'logisticsMethodId', logistics_method_id,
        'logisticsMethodName', coalesce(logistics_method_name, ''),
        'sourceRowNumber', source_row_number,
        'orderNo', coalesce(order_no, ''),
        'actualShipTime', coalesce(actual_ship_time, ''),
        'settlementMonth', settlement_month,
        'status', status
      ) order by source_row_number)
      from preview_rows
    ), '[]'::jsonb)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.import_actual_shipping_fees_v2(
  p_file_name text,
  p_template_id uuid,
  p_records jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_file_name, '')) = '' then
    raise exception 'Source file name is required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_records), 'null') <> 'array' then
    raise exception 'Shipping fee records must be an array' using errcode = '22023';
  end if;
  if p_template_id is null or not exists (
    select 1
    from public.finance_actual_shipping_fee_import_templates template
    where template.id = p_template_id
      and template.user_id = v_user_id
  ) then
    raise exception 'Import template not found' using errcode = '22023';
  end if;

  with input_raw as (
    select
      btrim(record.tracking_no) as tracking_no,
      record.amount_rmb,
      record.logistics_method_id,
      record.source_row_number
    from jsonb_to_recordset(p_records) as record(
      tracking_no text,
      amount_rmb numeric,
      logistics_method_id uuid,
      source_row_number integer
    )
    where btrim(coalesce(record.tracking_no, '')) <> ''
      and record.amount_rmb is not null
      and record.amount_rmb >= 0
      and record.logistics_method_id is not null
  ), input_rows as (
    select
      input_raw.*,
      count(*) over (partition by input_raw.logistics_method_id, input_raw.tracking_no) as input_tracking_count
    from input_raw
  ), shipment_groups as (
    select
      input.tracking_no,
      count(distinct coalesce(combined_member.combined_shipment_id, shipment.id)) as shipment_count,
      (array_agg(shipment.id order by coalesce(combined_member.is_primary, false) desc, shipment.id))[1] as shipment_id,
      (array_agg(nullif(btrim(shipment.actual_ship_time), '') order by shipment.id))[1] as actual_ship_time,
      (array_agg(shipment.logistics_method_id order by shipment.id))[1] as logistics_method_id,
      max(shipment.actual_shipping_fee_rmb) as shipment_actual_shipping_fee_rmb
    from input_rows input
    left join public.temu_order_shipments shipment
      on shipment.logistics_method_id = input.logistics_method_id
     and btrim(shipment.logistics_tracking_no) = input.tracking_no
    left join public.temu_order_combined_shipment_members combined_member
      on combined_member.shipment_id = shipment.id
    group by input.logistics_method_id, input.tracking_no
  ), evaluated as (
    select
      input.*,
      coalesce(shipments.shipment_count, 0) as shipment_count,
      shipments.actual_ship_time,
      shipments.logistics_method_id as shipment_logistics_method_id,
      coalesce(shipments.shipment_actual_shipping_fee_rmb, 0) as shipment_actual_shipping_fee_rmb,
      existing.id as existing_id,
      method.name as logistics_method_name,
      coalesce(method.is_active, false)
        and exists (
          select 1
          from public.warehouse_logistics_methods link
          where link.logistics_method_id = input.logistics_method_id
        ) as method_is_allowed
    from input_rows input
    left join shipment_groups shipments
      on shipments.logistics_method_id = input.logistics_method_id
     and shipments.tracking_no = input.tracking_no
    left join public.logistics_methods method on method.id = input.logistics_method_id
    left join public.finance_actual_shipping_fees existing
      on existing.user_id = v_user_id
      and existing.logistics_method_id = input.logistics_method_id
      and existing.logistics_tracking_no = input.tracking_no
  ), inserted as (
    insert into public.finance_actual_shipping_fees (
      user_id,
      logistics_tracking_no,
      actual_shipping_fee_rmb,
      carrier,
      logistics_method_id,
      source_template_id,
      source_file_name
    )
    select
      v_user_id,
      evaluated.tracking_no,
      evaluated.amount_rmb,
      evaluated.logistics_method_name,
      evaluated.logistics_method_id,
      p_template_id,
      btrim(p_file_name)
    from evaluated
    where evaluated.input_tracking_count = 1
      and evaluated.method_is_allowed
      and evaluated.shipment_count = 1
      and evaluated.shipment_logistics_method_id = evaluated.logistics_method_id
      and evaluated.existing_id is null
      and evaluated.shipment_actual_shipping_fee_rmb <= 0
    on conflict (user_id, logistics_method_id, logistics_tracking_no) do nothing
    returning logistics_tracking_no, actual_shipping_fee_rmb
  )
  select jsonb_build_object(
    'parsedRecordCount', (select count(*) from evaluated),
    'importedRecordCount', (select count(*) from inserted),
    'importedTotalAmountRmb', coalesce((select sum(actual_shipping_fee_rmb) from inserted), 0),
    'existingRecordCount', (
      select count(*) from evaluated
      where existing_id is not null or shipment_actual_shipping_fee_rmb > 0
    ),
    'unmatchedRecordCount', (select count(*) from evaluated where shipment_count = 0),
    'conflictRecordCount', (select count(*) from evaluated where shipment_count > 1),
    'duplicateRecordCount', (select count(*) from evaluated where input_tracking_count > 1),
    'methodMismatchRecordCount', (
      select count(*) from evaluated
      where input_tracking_count = 1
        and shipment_count = 1
        and (
          not method_is_allowed
          or shipment_logistics_method_id is distinct from logistics_method_id
        )
    ),
    'missingActualShipTimeCount', (
      select count(*) from evaluated
      where input_tracking_count = 1
        and method_is_allowed
        and shipment_count = 1
        and shipment_logistics_method_id = logistics_method_id
        and existing_id is null
        and shipment_actual_shipping_fee_rmb <= 0
        and actual_ship_time is null
    )
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.get_actual_shipping_fee_report_v2(
  p_page integer default 1,
  p_page_size integer default 20,
  p_month text default '',
  p_logistics_method_id uuid default null,
  p_search text default ''
)
returns table (
  rows jsonb,
  total_count bigint,
  summary jsonb,
  months jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with shipment_groups as (
    select
      btrim(shipment.logistics_tracking_no) as tracking_no,
      shipment.logistics_method_id,
      (array_agg(shipment.order_no order by coalesce(combined_member.is_primary, false) desc, shipment.id))[1] as order_no,
      min(nullif(btrim(shipment.actual_ship_time), '')) as actual_ship_time,
      count(distinct coalesce(combined_member.combined_shipment_id, shipment.id)) as shipment_count
    from public.temu_order_shipments shipment
    left join public.temu_order_combined_shipment_members combined_member
      on combined_member.shipment_id = shipment.id
    where btrim(shipment.logistics_tracking_no) <> ''
    group by shipment.logistics_method_id, btrim(shipment.logistics_tracking_no)
  ), base as (
    select
      fee.id,
      fee.logistics_tracking_no,
      fee.actual_shipping_fee_rmb,
      fee.logistics_method_id,
      coalesce(
        method.name,
        case fee.carrier
          when 'japan_post' then '福冈 Japan Post'
          when 'ocs_yamato' then 'OCS Yamato'
          else fee.carrier
        end
      ) as logistics_method_name,
      fee.source_file_name,
      fee.imported_at,
      coalesce(shipments.order_no, '') as order_no,
      coalesce(shipments.actual_ship_time, '') as actual_ship_time,
      case
        when shipments.actual_ship_time is null then ''
        else coalesce(to_char(
          timezone('Asia/Tokyo', public.try_parse_temu_order_time(shipments.actual_ship_time)),
          'YYYY-MM'
        ), '')
      end as settlement_month
    from public.finance_actual_shipping_fees fee
    left join shipment_groups shipments
      on shipments.logistics_method_id = fee.logistics_method_id
     and shipments.tracking_no = fee.logistics_tracking_no
    left join public.logistics_methods method on method.id = fee.logistics_method_id
    where fee.user_id = auth.uid()
  ), scope_base as (
    select *
    from base
    where (
        btrim(coalesce(p_month, '')) = ''
        or (p_month = '__missing__' and settlement_month = '')
        or settlement_month = p_month
      )
      and (
        p_logistics_method_id is null
        or logistics_method_id = p_logistics_method_id
      )
  ), filtered as (
    select *
    from scope_base
    where btrim(coalesce(p_search, '')) = ''
      or lower(
        logistics_tracking_no || ' ' ||
        order_no || ' ' ||
        logistics_method_name || ' ' ||
        source_file_name
      ) like '%' || lower(btrim(p_search)) || '%'
  ), paged as (
    select *
    from filtered
    order by settlement_month desc, actual_ship_time desc, logistics_tracking_no
    offset (greatest(coalesce(p_page, 1), 1) - 1)
      * least(greatest(coalesce(p_page_size, 20), 1), 100)
    limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  ), month_rows as (
    select
      settlement_month as month,
      count(*) as shipment_count,
      sum(actual_shipping_fee_rmb) as total_amount_rmb
    from base
    group by settlement_month
  ), scope_groups as (
    select
      logistics_method_id,
      logistics_method_name,
      settlement_month,
      count(*)::integer as shipment_count,
      sum(actual_shipping_fee_rmb) as payable_amount_rmb
    from scope_base
    where settlement_month <> ''
      and logistics_method_id is not null
    group by logistics_method_id, logistics_method_name, settlement_month
  ), payment_totals as (
    select
      settlement.id as settlement_id,
      coalesce(sum(payment.paid_amount_rmb) filter (where payment.voided_at is null), 0)
        as paid_amount_rmb,
      max(payment.paid_at) filter (where payment.voided_at is null) as last_paid_at
    from public.finance_logistics_settlements settlement
    left join public.finance_logistics_payments payment
      on payment.settlement_id = settlement.id
      and payment.user_id = auth.uid()
    where settlement.user_id = auth.uid()
    group by settlement.id
  ), settlement_rows as (
    select
      grouped.logistics_method_id,
      grouped.logistics_method_name,
      grouped.settlement_month,
      grouped.shipment_count,
      grouped.payable_amount_rmb,
      coalesce(payments.paid_amount_rmb, 0) as paid_amount_rmb,
      greatest(
        grouped.payable_amount_rmb - coalesce(payments.paid_amount_rmb, 0),
        0
      ) as outstanding_amount_rmb,
      payments.last_paid_at
    from scope_groups grouped
    left join public.finance_logistics_settlements settlement
      on settlement.user_id = auth.uid()
      and settlement.logistics_method_id = grouped.logistics_method_id
      and to_char(settlement.shipping_month, 'YYYY-MM') = grouped.settlement_month
    left join payment_totals payments on payments.settlement_id = settlement.id
  ), scope_totals as (
    select
      coalesce(sum(payable_amount_rmb), 0) as payable_amount_rmb,
      coalesce(sum(paid_amount_rmb), 0) as paid_amount_rmb,
      coalesce(sum(outstanding_amount_rmb), 0) as outstanding_amount_rmb
    from settlement_rows
  )
  select
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'trackingNo', logistics_tracking_no,
        'amountRmb', actual_shipping_fee_rmb,
        'logisticsMethodId', logistics_method_id,
        'logisticsMethodName', logistics_method_name,
        'sourceFileName', source_file_name,
        'importedAt', imported_at,
        'orderNo', order_no,
        'actualShipTime', actual_ship_time,
        'settlementMonth', settlement_month
      ) order by settlement_month desc, actual_ship_time desc, logistics_tracking_no)
      from paged
    ), '[]'::jsonb),
    (select count(*) from filtered),
    coalesce((
      select jsonb_build_object(
        'shipmentCount', (select count(*) from filtered),
        'totalAmountRmb', coalesce((select sum(actual_shipping_fee_rmb) from filtered), 0),
        'missingActualShipTimeCount', (
          select count(*) from filtered where settlement_month = ''
        ),
        'payableAmountRmb', payable_amount_rmb,
        'paidAmountRmb', paid_amount_rmb,
        'outstandingAmountRmb', outstanding_amount_rmb,
        'settlements', coalesce((
          select jsonb_agg(jsonb_build_object(
            'logisticsMethodId', logistics_method_id,
            'logisticsMethodName', logistics_method_name,
            'shippingMonth', settlement_month,
            'shipmentCount', shipment_count,
            'payableAmountRmb', payable_amount_rmb,
            'paidAmountRmb', paid_amount_rmb,
            'outstandingAmountRmb', outstanding_amount_rmb,
            'lastPaidAt', last_paid_at,
            'status', case
              when outstanding_amount_rmb <= 0 then 'paid'
              when paid_amount_rmb > 0 then 'partial'
              else 'unpaid'
            end
          ) order by logistics_method_name)
          from settlement_rows
          where btrim(coalesce(p_month, '')) <> ''
            and p_month <> '__missing__'
        ), '[]'::jsonb)
      )
      from scope_totals
    ), '{}'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', month,
        'shipmentCount', shipment_count,
        'totalAmountRmb', total_amount_rmb
      ) order by month desc)
      from month_rows
    ), '[]'::jsonb);
$$;

create or replace function public.record_logistics_payment_v2(
  p_logistics_method_id uuid,
  p_shipping_month text,
  p_paid_amount_rmb numeric,
  p_paid_at timestamptz,
  p_remark text default '',
  p_request_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_shipping_month date;
  v_shipment_count integer;
  v_payable numeric;
  v_paid_before numeric;
  v_settlement_id uuid;
  v_payment_id uuid;
  v_logistics_method_name text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  select method.name
  into v_logistics_method_name
  from public.logistics_methods method
  where method.id = p_logistics_method_id
    and method.is_active
    and exists (
      select 1
      from public.warehouse_logistics_methods link
      where link.logistics_method_id = method.id
    );

  if p_logistics_method_id is null or v_logistics_method_name is null then
    raise exception 'Unsupported logistics method' using errcode = '22023';
  end if;
  if coalesce(p_shipping_month, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Shipping month must use YYYY-MM' using errcode = '22023';
  end if;
  if p_paid_amount_rmb is null or p_paid_amount_rmb <= 0 then
    raise exception 'Paid amount must be greater than zero' using errcode = '22023';
  end if;
  if p_paid_at is null then
    raise exception 'Paid time is required' using errcode = '22023';
  end if;
  if p_request_key is null then
    raise exception 'Request key is required' using errcode = '22023';
  end if;

  select payment.id
  into v_payment_id
  from public.finance_logistics_payments payment
  where payment.user_id = v_user_id
    and payment.request_key = p_request_key;

  if v_payment_id is not null then
    return jsonb_build_object('paymentId', v_payment_id, 'duplicate', true);
  end if;

  v_shipping_month := to_date(p_shipping_month || '-01', 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':' || p_logistics_method_id::text || ':' || p_shipping_month,
    0
  ));

  select payment.id
  into v_payment_id
  from public.finance_logistics_payments payment
  where payment.user_id = v_user_id
    and payment.request_key = p_request_key;

  if v_payment_id is not null then
    return jsonb_build_object('paymentId', v_payment_id, 'duplicate', true);
  end if;

  with shipment_groups as (
    select
      btrim(shipment.logistics_tracking_no) as tracking_no,
      shipment.logistics_method_id,
      min(nullif(btrim(shipment.actual_ship_time), '')) as actual_ship_time
    from public.temu_order_shipments shipment
    where btrim(shipment.logistics_tracking_no) <> ''
    group by shipment.logistics_method_id, btrim(shipment.logistics_tracking_no)
  )
  select
    count(*)::integer,
    coalesce(sum(fee.actual_shipping_fee_rmb), 0)
  into v_shipment_count, v_payable
  from public.finance_actual_shipping_fees fee
  join shipment_groups shipments
    on shipments.logistics_method_id = fee.logistics_method_id
   and shipments.tracking_no = fee.logistics_tracking_no
  where fee.user_id = v_user_id
    and fee.logistics_method_id = p_logistics_method_id
    and to_char(
      timezone('Asia/Tokyo', public.try_parse_temu_order_time(shipments.actual_ship_time)),
      'YYYY-MM'
    ) = p_shipping_month;

  if v_shipment_count = 0 or v_payable <= 0 then
    raise exception 'No payable actual shipping fees found for this method and month'
      using errcode = '22023';
  end if;

  insert into public.finance_logistics_settlements (
    user_id,
    carrier,
    logistics_method_id,
    shipping_month,
    shipment_count_snapshot,
    payable_amount_snapshot_rmb
  ) values (
    v_user_id,
    v_logistics_method_name,
    p_logistics_method_id,
    v_shipping_month,
    v_shipment_count,
    v_payable
  )
  on conflict (user_id, logistics_method_id, shipping_month) do update set
    carrier = excluded.carrier,
    shipment_count_snapshot = excluded.shipment_count_snapshot,
    payable_amount_snapshot_rmb = excluded.payable_amount_snapshot_rmb,
    updated_at = now()
  returning id into v_settlement_id;

  select coalesce(sum(payment.paid_amount_rmb), 0)
  into v_paid_before
  from public.finance_logistics_payments payment
  where payment.settlement_id = v_settlement_id
    and payment.user_id = v_user_id
    and payment.voided_at is null;

  if p_paid_amount_rmb > greatest(v_payable - v_paid_before, 0) then
    raise exception 'Paid amount exceeds the current outstanding amount'
      using errcode = '22023';
  end if;

  insert into public.finance_logistics_payments (
    user_id,
    settlement_id,
    paid_amount_rmb,
    paid_at,
    remark,
    request_key
  ) values (
    v_user_id,
    v_settlement_id,
    p_paid_amount_rmb,
    p_paid_at,
    btrim(coalesce(p_remark, '')),
    p_request_key
  )
  returning id into v_payment_id;

  return jsonb_build_object(
    'paymentId', v_payment_id,
    'shipmentCount', v_shipment_count,
    'payableAmountRmb', v_payable,
    'paidAmountRmb', v_paid_before + p_paid_amount_rmb,
    'outstandingAmountRmb', greatest(
      v_payable - v_paid_before - p_paid_amount_rmb,
      0
    ),
    'duplicate', false
  );
end;
$$;

revoke all on function public.preview_actual_shipping_fee_import_v2(jsonb) from public;
revoke all on function public.import_actual_shipping_fees_v2(text, uuid, jsonb) from public;
revoke all on function public.get_actual_shipping_fee_report_v2(integer, integer, text, uuid, text) from public;
revoke all on function public.record_logistics_payment_v2(uuid, text, numeric, timestamptz, text, uuid) from public;

grant execute on function public.preview_actual_shipping_fee_import_v2(jsonb) to authenticated;
grant execute on function public.import_actual_shipping_fees_v2(text, uuid, jsonb) to authenticated;
grant execute on function public.get_actual_shipping_fee_report_v2(integer, integer, text, uuid, text) to authenticated;
grant execute on function public.record_logistics_payment_v2(uuid, text, numeric, timestamptz, text, uuid) to authenticated;
