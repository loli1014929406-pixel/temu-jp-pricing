-- Separate logistics cost recognition from actual carrier cash payments.
-- Shipping cost remains attributed by actual ship month, while payments enter
-- the cash ledger on their real paid_at date.

create table public.finance_logistics_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  carrier text not null check (carrier in ('japan_post', 'ocs_yamato')),
  shipping_month date not null,
  shipment_count_snapshot integer not null default 0 check (shipment_count_snapshot >= 0),
  payable_amount_snapshot_rmb numeric not null default 0 check (payable_amount_snapshot_rmb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_logistics_settlements_month_start
    check (shipping_month = date_trunc('month', shipping_month)::date),
  constraint finance_logistics_settlements_user_carrier_month_unique
    unique (user_id, carrier, shipping_month)
);

create table public.finance_logistics_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  settlement_id uuid not null references public.finance_logistics_settlements(id) on delete restrict,
  paid_amount_rmb numeric not null check (paid_amount_rmb > 0),
  paid_at timestamptz not null,
  remark text not null default '',
  request_key uuid not null,
  voided_at timestamptz,
  void_reason text not null default '',
  created_at timestamptz not null default now(),
  constraint finance_logistics_payments_void_reason_required
    check (voided_at is null or btrim(void_reason) <> ''),
  constraint finance_logistics_payments_user_request_unique
    unique (user_id, request_key)
);

create index idx_finance_logistics_settlements_user_month_carrier
on public.finance_logistics_settlements(user_id, shipping_month, carrier);

create index idx_finance_logistics_payments_user_paid_at
on public.finance_logistics_payments(user_id, paid_at desc)
where voided_at is null;

create index idx_finance_logistics_payments_settlement_active
on public.finance_logistics_payments(settlement_id, created_at)
where voided_at is null;

create trigger finance_logistics_settlements_set_updated_at
before update on public.finance_logistics_settlements
for each row execute function public.set_updated_at();

alter table public.finance_logistics_settlements enable row level security;
alter table public.finance_logistics_payments enable row level security;

create policy "finance_logistics_settlements_select_own"
on public.finance_logistics_settlements for select to authenticated
using ((select auth.uid()) = user_id);

create policy "finance_logistics_settlements_insert_own"
on public.finance_logistics_settlements for insert to authenticated
with check ((select auth.uid()) = user_id and public.current_account_can_edit());

create policy "finance_logistics_settlements_update_own"
on public.finance_logistics_settlements for update to authenticated
using ((select auth.uid()) = user_id and public.current_account_can_edit())
with check ((select auth.uid()) = user_id and public.current_account_can_edit());

create policy "finance_logistics_payments_select_own"
on public.finance_logistics_payments for select to authenticated
using ((select auth.uid()) = user_id);

create policy "finance_logistics_payments_insert_own"
on public.finance_logistics_payments for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
  and exists (
    select 1 from public.finance_logistics_settlements settlement
    where settlement.id = settlement_id and settlement.user_id = (select auth.uid())
  )
);

create policy "finance_logistics_payments_update_own"
on public.finance_logistics_payments for update to authenticated
using ((select auth.uid()) = user_id and public.current_account_can_edit())
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
  and exists (
    select 1 from public.finance_logistics_settlements settlement
    where settlement.id = settlement_id and settlement.user_id = (select auth.uid())
  )
);

grant select, insert, update on table public.finance_logistics_settlements to authenticated;
grant select, insert, update on table public.finance_logistics_payments to authenticated;

create or replace function public.record_logistics_payment(
  p_carrier text,
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

  select payment.id into v_payment_id
  from public.finance_logistics_payments payment
  where payment.user_id = v_user_id and payment.request_key = p_request_key;
  if v_payment_id is not null then
    return jsonb_build_object('paymentId', v_payment_id, 'duplicate', true);
  end if;

  v_shipping_month := to_date(p_shipping_month || '-01', 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':' || p_carrier || ':' || p_shipping_month,
    0
  ));

  select payment.id into v_payment_id
  from public.finance_logistics_payments payment
  where payment.user_id = v_user_id and payment.request_key = p_request_key;
  if v_payment_id is not null then
    return jsonb_build_object('paymentId', v_payment_id, 'duplicate', true);
  end if;

  with order_groups as (
    select
      btrim(order_row.logistics_tracking_no) as tracking_no,
      min(nullif(btrim(order_row.actual_ship_time), '')) as actual_ship_time
    from public.temu_orders order_row
    where btrim(order_row.logistics_tracking_no) <> ''
    group by btrim(order_row.logistics_tracking_no)
  )
  select
    count(*)::integer,
    coalesce(sum(fee.actual_shipping_fee_rmb), 0)
  into v_shipment_count, v_payable
  from public.finance_actual_shipping_fees fee
  join order_groups orders on orders.tracking_no = fee.logistics_tracking_no
  where fee.user_id = v_user_id
    and fee.carrier = p_carrier
    and to_char(
      timezone('Asia/Tokyo', public.try_parse_temu_order_time(orders.actual_ship_time)),
      'YYYY-MM'
    ) = p_shipping_month;

  if v_shipment_count = 0 or v_payable <= 0 then
    raise exception 'No payable actual shipping fees found for this carrier and month'
      using errcode = '22023';
  end if;

  insert into public.finance_logistics_settlements (
    user_id, carrier, shipping_month, shipment_count_snapshot, payable_amount_snapshot_rmb
  ) values (
    v_user_id, p_carrier, v_shipping_month, v_shipment_count, v_payable
  )
  on conflict (user_id, carrier, shipping_month) do update set
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
    user_id, settlement_id, paid_amount_rmb, paid_at, remark, request_key
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
    'outstandingAmountRmb', greatest(v_payable - v_paid_before - p_paid_amount_rmb, 0),
    'duplicate', false
  );
end;
$$;

create or replace function public.get_logistics_payment_records(
  p_carrier text,
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
  join public.finance_logistics_settlements settlement on settlement.id = payment.settlement_id
  where payment.user_id = auth.uid()
    and settlement.user_id = auth.uid()
    and settlement.carrier = p_carrier
    and to_char(settlement.shipping_month, 'YYYY-MM') = p_shipping_month;
$$;

create or replace function public.void_logistics_payment(
  p_payment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.finance_logistics_payments%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Void reason is required' using errcode = '22023';
  end if;

  select * into v_payment
  from public.finance_logistics_payments
  where id = p_payment_id and user_id = v_user_id
  for update;

  if v_payment.id is null then
    raise exception 'Payment record not found' using errcode = '22023';
  end if;
  if v_payment.voided_at is not null then
    return jsonb_build_object('paymentId', v_payment.id, 'alreadyVoided', true);
  end if;

  update public.finance_logistics_payments
  set voided_at = now(), void_reason = btrim(p_reason)
  where id = v_payment.id;

  return jsonb_build_object('paymentId', v_payment.id, 'alreadyVoided', false);
end;
$$;

create or replace function public.get_finance_logistics_cash_summary()
returns table (summary jsonb, monthly jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  with order_groups as (
    select
      btrim(order_row.logistics_tracking_no) as tracking_no,
      min(nullif(btrim(order_row.actual_ship_time), '')) as actual_ship_time
    from public.temu_orders order_row
    where btrim(order_row.logistics_tracking_no) <> ''
    group by btrim(order_row.logistics_tracking_no)
  ), current_payable as (
    select coalesce(sum(fee.actual_shipping_fee_rmb), 0) as amount
    from public.finance_actual_shipping_fees fee
    join order_groups orders on orders.tracking_no = fee.logistics_tracking_no
    where fee.user_id = auth.uid()
      and public.try_parse_temu_order_time(orders.actual_ship_time) is not null
  ), active_payments as (
    select payment.paid_amount_rmb, payment.paid_at
    from public.finance_logistics_payments payment
    where payment.user_id = auth.uid() and payment.voided_at is null
  ), monthly_rows as (
    select
      to_char(timezone('Asia/Tokyo', paid_at), 'YYYY-MM') as month,
      sum(paid_amount_rmb) as paid_amount_rmb
    from active_payments
    group by to_char(timezone('Asia/Tokyo', paid_at), 'YYYY-MM')
  ), totals as (
    select
      payable.amount as payable_amount,
      coalesce((select sum(paid_amount_rmb) from active_payments), 0) as paid_amount
    from current_payable payable
  )
  select
    jsonb_build_object(
      'payableAmountRmb', totals.payable_amount,
      'paidAmountRmb', totals.paid_amount,
      'outstandingAmountRmb', greatest(totals.payable_amount - totals.paid_amount, 0)
    ),
    coalesce((select jsonb_agg(jsonb_build_object(
      'month', month,
      'paidAmountRmb', paid_amount_rmb
    ) order by month desc) from monthly_rows), '[]'::jsonb)
  from totals;
$$;

-- Extend the existing actual-fee report with carrier-month payment status.
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
  ), scope_base as (
    select * from base
    where (
        btrim(coalesce(p_month, '')) = ''
        or (p_month = '__missing__' and settlement_month = '')
        or settlement_month = p_month
      )
      and (coalesce(p_carrier, 'all') = 'all' or carrier = p_carrier)
  ), filtered as (
    select * from scope_base
    where btrim(coalesce(p_search, '')) = ''
      or lower(logistics_tracking_no || ' ' || order_no || ' ' || source_file_name)
        like '%' || lower(btrim(p_search)) || '%'
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
  ), scope_groups as (
    select carrier, settlement_month, count(*)::integer as shipment_count,
      sum(actual_shipping_fee_rmb) as payable_amount_rmb
    from scope_base
    where settlement_month <> ''
    group by carrier, settlement_month
  ), payment_totals as (
    select settlement.id as settlement_id,
      coalesce(sum(payment.paid_amount_rmb) filter (where payment.voided_at is null), 0) as paid_amount_rmb,
      max(payment.paid_at) filter (where payment.voided_at is null) as last_paid_at
    from public.finance_logistics_settlements settlement
    left join public.finance_logistics_payments payment
      on payment.settlement_id = settlement.id and payment.user_id = auth.uid()
    where settlement.user_id = auth.uid()
    group by settlement.id
  ), settlement_rows as (
    select
      grouped.carrier,
      grouped.settlement_month,
      grouped.shipment_count,
      grouped.payable_amount_rmb,
      coalesce(payments.paid_amount_rmb, 0) as paid_amount_rmb,
      greatest(grouped.payable_amount_rmb - coalesce(payments.paid_amount_rmb, 0), 0) as outstanding_amount_rmb,
      payments.last_paid_at
    from scope_groups grouped
    left join public.finance_logistics_settlements settlement
      on settlement.user_id = auth.uid()
      and settlement.carrier = grouped.carrier
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
      'shipmentCount', (select count(*) from filtered),
      'totalAmountRmb', coalesce((select sum(actual_shipping_fee_rmb) from filtered), 0),
      'missingActualShipTimeCount', (select count(*) from filtered where settlement_month = ''),
      'payableAmountRmb', payable_amount_rmb,
      'paidAmountRmb', paid_amount_rmb,
      'outstandingAmountRmb', outstanding_amount_rmb,
      'settlements', coalesce((select jsonb_agg(jsonb_build_object(
        'carrier', carrier,
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
      ) order by carrier) from settlement_rows
      where btrim(coalesce(p_month, '')) <> '' and p_month <> '__missing__'), '[]'::jsonb)
    ) from scope_totals), '{}'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'month', month,
      'shipmentCount', shipment_count,
      'totalAmountRmb', total_amount_rmb
    ) order by month desc) from month_rows), '[]'::jsonb);
$$;

-- Add actual logistics payments to the central cash ledger.
create or replace function public.get_finance_ledger_page(
  p_page integer default 1,
  p_page_size integer default 20,
  p_type text default 'all',
  p_month text default 'all'
)
returns table (
  rows jsonb,
  total_count bigint,
  total_income numeric,
  total_expense numeric,
  months jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with settlement_by_po as (
    select
      po_number,
      round(sum(sales_revenue + sales_reversal), 2) as sales_revenue,
      round(sum(freight_revenue + freight_reversal), 2) as freight_revenue
    from public.finance_settlement_records
    where user_id = auth.uid()
    group by po_number
  ), ledger as (
    select
      timezone('Asia/Tokyo', coalesce(
        public.try_parse_temu_order_time(o.actual_ship_time),
        public.try_parse_temu_order_time(o.label_printed_at),
        public.try_parse_temu_order_time(o.latest_ship_time),
        o.created_at
      ))::date as entry_date,
      '订单回款'::text as entry_type,
      '收入'::text as direction,
      o.order_no as subject,
      round(s.sales_revenue + s.freight_revenue, 2) as amount_rmb,
      format('销售回款 ¥%s / 运费回款 ¥%s',
        to_char(s.sales_revenue, 'FM999999999990.00'),
        to_char(s.freight_revenue, 'FM999999999990.00')) as remark,
      o.id::text as stable_id
    from public.temu_orders o
    join settlement_by_po s on s.po_number = btrim(o.order_no)
    where round(s.sales_revenue + s.freight_revenue, 2) > 0

    union all

    select
      p.purchased_at,
      '采购付款',
      '支出',
      p.order_code,
      -round(p.total_cost_rmb, 2),
      p.warehouse_name,
      p.id::text
    from public.purchase_orders p

    union all

    select
      e.expense_date,
      '其他费用',
      '支出',
      case e.category
        when 'ad' then '广告推广'
        when 'customs' then '关税头程'
        when 'packaging' then '包装耗材'
        when 'platform_commission' then '平台佣金'
        when 'refund_loss' then '退款损失'
        when 'other' then '其他杂费'
        else e.category
      end,
      -round(e.amount_rmb, 2),
      case
        when btrim(coalesce(e.remark, '')) like '广告费支付%' then '广告费支付'
        else btrim(coalesce(e.remark, ''))
      end,
      e.id::text
    from public.finance_expenses e
    where e.user_id = auth.uid()

    union all

    select
      timezone('Asia/Tokyo', payment.paid_at)::date,
      '物流付款',
      '支出',
      case settlement.carrier
        when 'japan_post' then '福冈仓日本邮便'
        when 'ocs_yamato' then '苏州仓 OCS Yamato'
        else settlement.carrier
      end,
      -round(payment.paid_amount_rmb, 2),
      format('%s 发货月月结%s',
        to_char(settlement.shipping_month, 'YYYY-MM'),
        case when btrim(payment.remark) = '' then '' else ' · ' || btrim(payment.remark) end),
      payment.id::text
    from public.finance_logistics_payments payment
    join public.finance_logistics_settlements settlement on settlement.id = payment.settlement_id
    where payment.user_id = auth.uid()
      and settlement.user_id = auth.uid()
      and payment.voided_at is null
  ), filtered as (
    select *
    from ledger
    where (coalesce(p_type, 'all') = 'all' or entry_type = p_type)
      and (coalesce(p_month, 'all') = 'all' or to_char(entry_date, 'YYYY-MM') = p_month)
  ), paged as (
    select entry_date, entry_type, direction, subject, amount_rmb, remark, stable_id
    from filtered
    order by entry_date desc, stable_id
    offset (greatest(coalesce(p_page, 1), 1) - 1)
      * least(greatest(coalesce(p_page_size, 20), 1), 100)
    limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  )
  select
    coalesce((select jsonb_agg(to_jsonb(paged) order by entry_date desc, stable_id) from paged), '[]'::jsonb),
    (select count(*) from filtered),
    coalesce((select round(sum(amount_rmb), 2) from filtered where direction = '收入'), 0),
    coalesce((select round(sum(abs(amount_rmb)), 2) from filtered where direction = '支出'), 0),
    coalesce((
      select jsonb_agg(month_key order by month_key desc)
      from (select distinct to_char(entry_date, 'YYYY-MM') as month_key from ledger) m
    ), '[]'::jsonb);
$$;

revoke all on function public.record_logistics_payment(text, text, numeric, timestamptz, text, uuid) from public;
revoke all on function public.get_logistics_payment_records(text, text) from public;
revoke all on function public.void_logistics_payment(uuid, text) from public;
revoke all on function public.get_finance_logistics_cash_summary() from public;
revoke all on function public.get_actual_shipping_fee_report(integer, integer, text, text, text) from public;
revoke all on function public.get_finance_ledger_page(integer, integer, text, text) from public;

grant execute on function public.record_logistics_payment(text, text, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.get_logistics_payment_records(text, text) to authenticated;
grant execute on function public.void_logistics_payment(uuid, text) to authenticated;
grant execute on function public.get_finance_logistics_cash_summary() to authenticated;
grant execute on function public.get_actual_shipping_fee_report(integer, integer, text, text, text) to authenticated;
grant execute on function public.get_finance_ledger_page(integer, integer, text, text) to authenticated;
