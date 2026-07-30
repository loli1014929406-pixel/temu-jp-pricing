-- Make actual-shipping-fee imports template driven while preserving all
-- existing package matching and financial attribution rules.

create table public.finance_actual_shipping_fee_import_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  worksheet_name text not null default '',
  start_row integer not null default 2 check (start_row > 0),
  tracking_source_type text not null default 'column'
    check (tracking_source_type in ('column', 'fixed')),
  tracking_column integer,
  tracking_fixed_value text not null default '',
  amount_source_type text not null default 'column'
    check (amount_source_type in ('column', 'fixed')),
  amount_column integer,
  amount_fixed_value numeric,
  logistics_method_source_type text not null default 'fixed'
    check (logistics_method_source_type in ('column', 'fixed')),
  logistics_method_column integer,
  logistics_method_fixed_id uuid references public.logistics_methods(id) on delete restrict,
  is_system boolean not null default false,
  system_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_actual_shipping_fee_templates_name_not_blank
    check (btrim(name) <> ''),
  constraint finance_actual_shipping_fee_templates_tracking_source
    check (
      (tracking_source_type = 'column' and tracking_column > 0)
      or (tracking_source_type = 'fixed' and btrim(tracking_fixed_value) <> '')
    ),
  constraint finance_actual_shipping_fee_templates_amount_source
    check (
      (amount_source_type = 'column' and amount_column > 0)
      or (amount_source_type = 'fixed' and amount_fixed_value is not null and amount_fixed_value >= 0)
    ),
  constraint finance_actual_shipping_fee_templates_method_source
    check (
      (logistics_method_source_type = 'column' and logistics_method_column > 0)
      or (logistics_method_source_type = 'fixed' and logistics_method_fixed_id is not null)
    )
);

create unique index finance_actual_shipping_fee_templates_user_name_uidx
  on public.finance_actual_shipping_fee_import_templates (user_id, lower(btrim(name)));

create unique index finance_actual_shipping_fee_templates_user_system_uidx
  on public.finance_actual_shipping_fee_import_templates (user_id, system_key)
  where btrim(system_key) <> '';

create index finance_actual_shipping_fee_templates_user_updated_idx
  on public.finance_actual_shipping_fee_import_templates (user_id, updated_at desc);

alter table public.finance_actual_shipping_fee_import_templates enable row level security;

create policy "finance_actual_shipping_fee_templates_select_own"
  on public.finance_actual_shipping_fee_import_templates for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "finance_actual_shipping_fee_templates_insert_own"
  on public.finance_actual_shipping_fee_import_templates for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

create policy "finance_actual_shipping_fee_templates_update_own"
  on public.finance_actual_shipping_fee_import_templates for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  )
  with check (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

create policy "finance_actual_shipping_fee_templates_delete_own"
  on public.finance_actual_shipping_fee_import_templates for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (select public.current_account_can_edit())
  );

grant select, insert, update, delete
  on table public.finance_actual_shipping_fee_import_templates
  to authenticated;

create trigger finance_actual_shipping_fee_import_templates_set_updated_at
  before update on public.finance_actual_shipping_fee_import_templates
  for each row execute function public.set_updated_at();

alter table public.finance_actual_shipping_fees
  add column logistics_method_id uuid references public.logistics_methods(id) on delete set null,
  add column source_template_id uuid
    references public.finance_actual_shipping_fee_import_templates(id) on delete set null;

create index finance_actual_shipping_fees_method_idx
  on public.finance_actual_shipping_fees(user_id, logistics_method_id, imported_at desc);

create index finance_actual_shipping_fees_template_idx
  on public.finance_actual_shipping_fees(source_template_id)
  where source_template_id is not null;

alter table public.finance_actual_shipping_fees
  drop constraint if exists finance_actual_shipping_fees_carrier_check;

alter table public.finance_actual_shipping_fees
  add constraint finance_actual_shipping_fees_carrier_not_blank
  check (btrim(carrier) <> '');

alter table public.finance_logistics_settlements
  add column logistics_method_id uuid references public.logistics_methods(id) on delete set null;

alter table public.finance_logistics_settlements
  drop constraint if exists finance_logistics_settlements_carrier_check;

alter table public.finance_logistics_settlements
  add constraint finance_logistics_settlements_carrier_not_blank
  check (btrim(carrier) <> '');

-- Existing fees are tied to the package only when one tracking number resolves
-- to exactly one shipment. Ambiguous historical rows remain nullable and keep
-- their legacy carrier value.
with shipment_groups as (
  select
    btrim(shipment.logistics_tracking_no) as tracking_no,
    count(distinct shipment.id) as shipment_count,
    (array_agg(shipment.logistics_method_id order by shipment.id))[1] as logistics_method_id
  from public.temu_order_shipments shipment
  where btrim(shipment.logistics_tracking_no) <> ''
  group by btrim(shipment.logistics_tracking_no)
)
update public.finance_actual_shipping_fees fee
set logistics_method_id = grouped.logistics_method_id
from shipment_groups grouped
where fee.logistics_method_id is null
  and fee.logistics_tracking_no = grouped.tracking_no
  and grouped.shipment_count = 1
  and grouped.logistics_method_id is not null;

-- Backfill the two legacy settlement keys from the configured logistics
-- methods. Future settlements always use the stable method UUID.
with method_candidates as (
  select
    legacy.carrier,
    method.id,
    row_number() over (
      partition by legacy.carrier
      order by
        case
          when lower(regexp_replace(btrim(method.name), '\s+', '', 'g'))
            in ('福冈japanpost', 'ocsyamato') then 1
          else 2
        end,
        method.sort_order,
        method.id
    ) as priority
  from (values ('japan_post'), ('ocs_yamato')) as legacy(carrier)
  join public.logistics_methods method
    on method.is_active
    and (
      (
        legacy.carrier = 'japan_post'
        and lower(regexp_replace(btrim(method.name), '\s+', '', 'g'))
          in ('福冈japanpost', '福冈尾程')
      )
      or (
        legacy.carrier = 'ocs_yamato'
        and lower(regexp_replace(btrim(method.name), '\s+', '', 'g'))
          in ('ocsyamato', 'ocs3cm', 'ocs昆山3cm')
      )
    )
)
update public.finance_logistics_settlements settlement
set logistics_method_id = candidate.id
from method_candidates candidate
where settlement.logistics_method_id is null
  and settlement.carrier = candidate.carrier
  and candidate.priority = 1;

-- If a legacy name did not match, infer it only when all imported rows for the
-- same user/carrier point to one configured method.
with inferred as (
  select
    fee.user_id,
    fee.carrier,
    (array_agg(distinct fee.logistics_method_id))[1] as logistics_method_id
  from public.finance_actual_shipping_fees fee
  where fee.logistics_method_id is not null
  group by fee.user_id, fee.carrier
  having count(distinct fee.logistics_method_id) = 1
)
update public.finance_logistics_settlements settlement
set logistics_method_id = inferred.logistics_method_id
from inferred
where settlement.logistics_method_id is null
  and settlement.user_id = inferred.user_id
  and settlement.carrier = inferred.carrier;

alter table public.finance_logistics_settlements
  add constraint finance_logistics_settlements_user_method_month_unique
  unique (user_id, logistics_method_id, shipping_month);

create index finance_logistics_settlements_user_method_month_idx
  on public.finance_logistics_settlements(user_id, logistics_method_id, shipping_month);

create or replace function public.ensure_actual_shipping_fee_default_templates()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_japan_post_method_id uuid;
  v_ocs_method_id uuid;
  v_inserted_count integer := 0;
  v_row_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    return jsonb_build_object('insertedCount', 0);
  end if;

  select method.id
  into v_japan_post_method_id
  from public.logistics_methods method
  where method.is_active
    and lower(regexp_replace(btrim(method.name), '\s+', '', 'g'))
      in ('福冈japanpost', '福冈尾程')
    and exists (
      select 1
      from public.warehouse_logistics_methods link
      where link.logistics_method_id = method.id
    )
  order by
    case when lower(regexp_replace(btrim(method.name), '\s+', '', 'g')) = '福冈japanpost' then 1 else 2 end,
    method.sort_order,
    method.id
  limit 1;

  if v_japan_post_method_id is not null then
    insert into public.finance_actual_shipping_fee_import_templates (
      user_id,
      name,
      worksheet_name,
      start_row,
      tracking_source_type,
      tracking_column,
      amount_source_type,
      amount_column,
      logistics_method_source_type,
      logistics_method_fixed_id,
      is_system,
      system_key
    ) values (
      v_user_id,
      '日本邮政默认模板',
      '已完成订单',
      2,
      'column',
      8,
      'column',
      25,
      'fixed',
      v_japan_post_method_id,
      true,
      'legacy_japan_post'
    )
    on conflict do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted_count := v_inserted_count + v_row_count;
  end if;

  select method.id
  into v_ocs_method_id
  from public.logistics_methods method
  where method.is_active
    and lower(regexp_replace(btrim(method.name), '\s+', '', 'g'))
      in ('ocsyamato', 'ocs3cm', 'ocs昆山3cm')
    and exists (
      select 1
      from public.warehouse_logistics_methods link
      where link.logistics_method_id = method.id
    )
  order by
    case when lower(regexp_replace(btrim(method.name), '\s+', '', 'g')) = 'ocsyamato' then 1 else 2 end,
    method.sort_order,
    method.id
  limit 1;

  if v_ocs_method_id is not null then
    insert into public.finance_actual_shipping_fee_import_templates (
      user_id,
      name,
      worksheet_name,
      start_row,
      tracking_source_type,
      tracking_column,
      amount_source_type,
      amount_column,
      logistics_method_source_type,
      logistics_method_fixed_id,
      is_system,
      system_key
    ) values (
      v_user_id,
      'OCS 默认模板',
      'Sheet1',
      2,
      'column',
      3,
      'column',
      55,
      'fixed',
      v_ocs_method_id,
      true,
      'legacy_ocs_yamato'
    )
    on conflict do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted_count := v_inserted_count + v_row_count;
  end if;

  return jsonb_build_object('insertedCount', v_inserted_count);
end;
$$;

create or replace function public.preview_actual_shipping_fee_import_v2(p_records jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
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
      count(*) over (partition by input_raw.tracking_no) as input_tracking_count
    from input_raw
  ), shipment_groups as (
    select
      input.tracking_no,
      count(distinct shipment.id) as shipment_count,
      (array_agg(shipment.id order by shipment.id))[1] as shipment_id,
      (array_agg(shipment.order_no order by shipment.id))[1] as order_no,
      (array_agg(nullif(btrim(shipment.actual_ship_time), '') order by shipment.id))[1] as actual_ship_time,
      (array_agg(shipment.logistics_method_id order by shipment.id))[1] as logistics_method_id,
      max(shipment.actual_shipping_fee_rmb) as shipment_actual_shipping_fee_rmb
    from input_rows input
    left join public.temu_order_shipments shipment
      on btrim(shipment.logistics_tracking_no) = input.tracking_no
    group by input.tracking_no
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
    left join shipment_groups shipments on shipments.tracking_no = input.tracking_no
    left join public.logistics_methods method on method.id = input.logistics_method_id
    left join public.finance_actual_shipping_fees existing
      on existing.user_id = v_user_id
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
set search_path = public
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
      count(*) over (partition by input_raw.tracking_no) as input_tracking_count
    from input_raw
  ), shipment_groups as (
    select
      input.tracking_no,
      count(distinct shipment.id) as shipment_count,
      (array_agg(shipment.id order by shipment.id))[1] as shipment_id,
      (array_agg(nullif(btrim(shipment.actual_ship_time), '') order by shipment.id))[1] as actual_ship_time,
      (array_agg(shipment.logistics_method_id order by shipment.id))[1] as logistics_method_id,
      max(shipment.actual_shipping_fee_rmb) as shipment_actual_shipping_fee_rmb
    from input_rows input
    left join public.temu_order_shipments shipment
      on btrim(shipment.logistics_tracking_no) = input.tracking_no
    group by input.tracking_no
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
    left join shipment_groups shipments on shipments.tracking_no = input.tracking_no
    left join public.logistics_methods method on method.id = input.logistics_method_id
    left join public.finance_actual_shipping_fees existing
      on existing.user_id = v_user_id
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
    on conflict (user_id, logistics_tracking_no) do nothing
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
set search_path = public
as $$
  with shipment_groups as (
    select
      btrim(shipment.logistics_tracking_no) as tracking_no,
      min(shipment.order_no) as order_no,
      min(nullif(btrim(shipment.actual_ship_time), '')) as actual_ship_time,
      count(distinct shipment.id) as shipment_count
    from public.temu_order_shipments shipment
    where btrim(shipment.logistics_tracking_no) <> ''
    group by btrim(shipment.logistics_tracking_no)
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
    left join shipment_groups shipments on shipments.tracking_no = fee.logistics_tracking_no
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
set search_path = public
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
      min(nullif(btrim(shipment.actual_ship_time), '')) as actual_ship_time
    from public.temu_order_shipments shipment
    where btrim(shipment.logistics_tracking_no) <> ''
    group by btrim(shipment.logistics_tracking_no)
  )
  select
    count(*)::integer,
    coalesce(sum(fee.actual_shipping_fee_rmb), 0)
  into v_shipment_count, v_payable
  from public.finance_actual_shipping_fees fee
  join shipment_groups shipments on shipments.tracking_no = fee.logistics_tracking_no
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

create or replace function public.get_logistics_payment_records_v2(
  p_logistics_method_id uuid,
  p_shipping_month text
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', payment.id,
    'amountRmb', payment.paid_amount_rmb,
    'paidAt', payment.paid_at,
    'remark', payment.remark,
    'voidedAt', payment.voided_at,
    'voidReason', payment.void_reason,
    'createdAt', payment.created_at
  ) order by payment.created_at desc), '[]'::jsonb)
  from public.finance_logistics_payments payment
  join public.finance_logistics_settlements settlement
    on settlement.id = payment.settlement_id
  where payment.user_id = auth.uid()
    and settlement.user_id = auth.uid()
    and settlement.logistics_method_id = p_logistics_method_id
    and to_char(settlement.shipping_month, 'YYYY-MM') = p_shipping_month;
$$;

revoke all on function public.ensure_actual_shipping_fee_default_templates() from public;
revoke all on function public.preview_actual_shipping_fee_import_v2(jsonb) from public;
revoke all on function public.import_actual_shipping_fees_v2(text, uuid, jsonb) from public;
revoke all on function public.get_actual_shipping_fee_report_v2(integer, integer, text, uuid, text) from public;
revoke all on function public.record_logistics_payment_v2(uuid, text, numeric, timestamptz, text, uuid) from public;
revoke all on function public.get_logistics_payment_records_v2(uuid, text) from public;

grant execute on function public.ensure_actual_shipping_fee_default_templates() to authenticated;
grant execute on function public.preview_actual_shipping_fee_import_v2(jsonb) to authenticated;
grant execute on function public.import_actual_shipping_fees_v2(text, uuid, jsonb) to authenticated;
grant execute on function public.get_actual_shipping_fee_report_v2(integer, integer, text, uuid, text) to authenticated;
grant execute on function public.record_logistics_payment_v2(uuid, text, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.get_logistics_payment_records_v2(uuid, text) to authenticated;
