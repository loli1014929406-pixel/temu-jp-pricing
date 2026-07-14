-- Actual last-leg shipping fees belong to a logistics tracking number, not to
-- Temu-generated child order rows. Amount precision is intentionally not fixed
-- to two decimals because Japan Post exports can contain three decimals.

create table if not exists public.finance_actual_shipping_fees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  logistics_tracking_no text not null,
  actual_shipping_fee_rmb numeric not null check (actual_shipping_fee_rmb >= 0),
  carrier text not null check (carrier in ('japan_post', 'ocs_yamato')),
  source_file_name text not null default '',
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint finance_actual_shipping_fees_tracking_not_blank
    check (btrim(logistics_tracking_no) <> ''),
  constraint finance_actual_shipping_fees_user_tracking_unique
    unique (user_id, logistics_tracking_no)
);

create index if not exists idx_finance_actual_shipping_fees_user_imported
on public.finance_actual_shipping_fees(user_id, imported_at desc);

alter table public.finance_actual_shipping_fees enable row level security;

drop policy if exists "finance_actual_shipping_fees_select_own" on public.finance_actual_shipping_fees;
create policy "finance_actual_shipping_fees_select_own"
on public.finance_actual_shipping_fees for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "finance_actual_shipping_fees_insert_own" on public.finance_actual_shipping_fees;
create policy "finance_actual_shipping_fees_insert_own"
on public.finance_actual_shipping_fees for insert to authenticated
with check ((select auth.uid()) = user_id and public.current_account_can_edit());

grant select, insert on table public.finance_actual_shipping_fees to authenticated;

create or replace function public.preview_actual_shipping_fee_import(p_records jsonb)
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

  with input_rows as (
    select
      btrim(record.tracking_no) as tracking_no,
      record.amount_rmb,
      record.source_row_number
    from jsonb_to_recordset(p_records) as record(
      tracking_no text,
      amount_rmb numeric,
      source_row_number integer
    )
    where btrim(coalesce(record.tracking_no, '')) <> ''
      and record.amount_rmb is not null
      and record.amount_rmb >= 0
  ), order_groups as (
    select
      btrim(order_row.logistics_tracking_no) as tracking_no,
      count(distinct btrim(order_row.order_no)) as order_count,
      min(btrim(order_row.order_no)) as order_no,
      min(nullif(btrim(order_row.actual_ship_time), '')) as actual_ship_time,
      max(order_row.actual_shipping_fee_rmb) as legacy_actual_shipping_fee_rmb
    from public.temu_orders order_row
    join input_rows input on input.tracking_no = btrim(order_row.logistics_tracking_no)
    group by btrim(order_row.logistics_tracking_no)
  ), evaluated as (
    select
      input.tracking_no,
      input.amount_rmb,
      input.source_row_number,
      orders.order_no,
      orders.actual_ship_time,
      case
        when orders.actual_ship_time is null then ''
        else coalesce(to_char(
          timezone('Asia/Tokyo', public.try_parse_temu_order_time(orders.actual_ship_time)),
          'YYYY-MM'
        ), '')
      end as settlement_month,
      case
        when coalesce(orders.order_count, 0) = 0 then 'unmatched'
        when orders.order_count > 1 then 'conflict'
        when existing.id is not null or coalesce(orders.legacy_actual_shipping_fee_rmb, 0) > 0 then 'existing'
        else 'importable'
      end as status
    from input_rows input
    left join order_groups orders on orders.tracking_no = input.tracking_no
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
      case status when 'importable' then 1 when 'existing' then 2 when 'unmatched' then 3 else 4 end,
      source_row_number
    limit 200
  )
  select jsonb_build_object(
    'parsedRecordCount', (select count(*) from evaluated),
    'matchedRecordCount', (select count(*) from evaluated where status in ('importable', 'existing')),
    'importableRecordCount', (select count(*) from evaluated where status = 'importable'),
    'existingRecordCount', (select count(*) from evaluated where status = 'existing'),
    'unmatchedRecordCount', (select count(*) from evaluated where status = 'unmatched'),
    'conflictRecordCount', (select count(*) from evaluated where status = 'conflict'),
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

create or replace function public.import_actual_shipping_fees(
  p_file_name text,
  p_carrier text,
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
  if p_carrier not in ('japan_post', 'ocs_yamato') then
    raise exception 'Unsupported shipping carrier' using errcode = '22023';
  end if;
  if btrim(coalesce(p_file_name, '')) = '' then
    raise exception 'Source file name is required' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_records), 'null') <> 'array' then
    raise exception 'Shipping fee records must be an array' using errcode = '22023';
  end if;

  with input_rows as (
    select
      btrim(record.tracking_no) as tracking_no,
      record.amount_rmb,
      record.source_row_number
    from jsonb_to_recordset(p_records) as record(
      tracking_no text,
      amount_rmb numeric,
      source_row_number integer
    )
    where btrim(coalesce(record.tracking_no, '')) <> ''
      and record.amount_rmb is not null
      and record.amount_rmb >= 0
  ), order_groups as (
    select
      btrim(order_row.logistics_tracking_no) as tracking_no,
      count(distinct btrim(order_row.order_no)) as order_count,
      min(nullif(btrim(order_row.actual_ship_time), '')) as actual_ship_time,
      max(order_row.actual_shipping_fee_rmb) as legacy_actual_shipping_fee_rmb
    from public.temu_orders order_row
    join input_rows input on input.tracking_no = btrim(order_row.logistics_tracking_no)
    group by btrim(order_row.logistics_tracking_no)
  ), evaluated as (
    select
      input.*,
      coalesce(orders.order_count, 0) as order_count,
      orders.actual_ship_time,
      existing.id as existing_id,
      coalesce(orders.legacy_actual_shipping_fee_rmb, 0) as legacy_actual_shipping_fee_rmb
    from input_rows input
    left join order_groups orders on orders.tracking_no = input.tracking_no
    left join public.finance_actual_shipping_fees existing
      on existing.user_id = v_user_id
      and existing.logistics_tracking_no = input.tracking_no
  ), inserted as (
    insert into public.finance_actual_shipping_fees (
      user_id,
      logistics_tracking_no,
      actual_shipping_fee_rmb,
      carrier,
      source_file_name
    )
    select
      v_user_id,
      evaluated.tracking_no,
      evaluated.amount_rmb,
      p_carrier,
      btrim(p_file_name)
    from evaluated
    where evaluated.order_count = 1
      and evaluated.existing_id is null
      and evaluated.legacy_actual_shipping_fee_rmb <= 0
    on conflict (user_id, logistics_tracking_no) do nothing
    returning logistics_tracking_no, actual_shipping_fee_rmb
  )
  select jsonb_build_object(
    'parsedRecordCount', (select count(*) from evaluated),
    'importedRecordCount', (select count(*) from inserted),
    'importedTotalAmountRmb', coalesce((select sum(actual_shipping_fee_rmb) from inserted), 0),
    'existingRecordCount', (
      select count(*) from evaluated
      where existing_id is not null or legacy_actual_shipping_fee_rmb > 0
    ),
    'unmatchedRecordCount', (select count(*) from evaluated where order_count = 0),
    'conflictRecordCount', (select count(*) from evaluated where order_count > 1),
    'missingActualShipTimeCount', (
      select count(*) from evaluated
      where order_count = 1
        and existing_id is null
        and legacy_actual_shipping_fee_rmb <= 0
        and actual_ship_time is null
    )
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.get_actual_shipping_fee_report(
  p_page integer default 1,
  p_page_size integer default 20,
  p_month text default '',
  p_carrier text default 'all',
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
  with order_groups as (
    select
      btrim(order_row.logistics_tracking_no) as tracking_no,
      min(btrim(order_row.order_no)) as order_no,
      min(nullif(btrim(order_row.actual_ship_time), '')) as actual_ship_time
    from public.temu_orders order_row
    where btrim(order_row.logistics_tracking_no) <> ''
    group by btrim(order_row.logistics_tracking_no)
  ), base as (
    select
      fee.id,
      fee.logistics_tracking_no,
      fee.actual_shipping_fee_rmb,
      fee.carrier,
      fee.source_file_name,
      fee.imported_at,
      coalesce(orders.order_no, '') as order_no,
      coalesce(orders.actual_ship_time, '') as actual_ship_time,
      case
        when orders.actual_ship_time is null then ''
        else coalesce(to_char(
          timezone('Asia/Tokyo', public.try_parse_temu_order_time(orders.actual_ship_time)),
          'YYYY-MM'
        ), '')
      end as settlement_month
    from public.finance_actual_shipping_fees fee
    left join order_groups orders on orders.tracking_no = fee.logistics_tracking_no
    where fee.user_id = auth.uid()
  ), filtered as (
    select * from base
    where (
        btrim(coalesce(p_month, '')) = ''
        or (p_month = '__missing__' and settlement_month = '')
        or settlement_month = p_month
      )
      and (coalesce(p_carrier, 'all') = 'all' or carrier = p_carrier)
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(logistics_tracking_no || ' ' || order_no || ' ' || source_file_name)
          like '%' || lower(btrim(p_search)) || '%'
      )
  ), paged as (
    select * from filtered
    order by settlement_month desc, actual_ship_time desc, logistics_tracking_no
    offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 20), 1), 100)
    limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  ), month_rows as (
    select settlement_month as month, count(*) as shipment_count,
      sum(actual_shipping_fee_rmb) as total_amount_rmb
    from base
    group by settlement_month
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'trackingNo', logistics_tracking_no,
      'amountRmb', actual_shipping_fee_rmb,
      'carrier', carrier,
      'sourceFileName', source_file_name,
      'importedAt', imported_at,
      'orderNo', order_no,
      'actualShipTime', actual_ship_time,
      'settlementMonth', settlement_month
    ) order by settlement_month desc, actual_ship_time desc, logistics_tracking_no) from paged), '[]'::jsonb),
    (select count(*) from filtered),
    coalesce((select jsonb_build_object(
      'shipmentCount', count(*),
      'totalAmountRmb', coalesce(sum(actual_shipping_fee_rmb), 0),
      'missingActualShipTimeCount', count(*) filter (where settlement_month = '')
    ) from filtered), '{}'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'month', month,
      'shipmentCount', shipment_count,
      'totalAmountRmb', total_amount_rmb
    ) order by month desc) from month_rows), '[]'::jsonb);
$$;

revoke all on function public.preview_actual_shipping_fee_import(jsonb) from public;
revoke all on function public.import_actual_shipping_fees(text, text, jsonb) from public;
revoke all on function public.get_actual_shipping_fee_report(integer, integer, text, text, text) from public;
grant execute on function public.preview_actual_shipping_fee_import(jsonb) to authenticated;
grant execute on function public.import_actual_shipping_fees(text, text, jsonb) to authenticated;
grant execute on function public.get_actual_shipping_fee_report(integer, integer, text, text, text) to authenticated;
