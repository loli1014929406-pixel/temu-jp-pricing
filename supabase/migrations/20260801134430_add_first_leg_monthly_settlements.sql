create table public.finance_first_leg_monthly_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shipping_month date not null,
  estimated_amount_snapshot_rmb numeric not null default 0
    check (estimated_amount_snapshot_rmb >= 0),
  actual_amount_rmb numeric not null check (actual_amount_rmb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_first_leg_monthly_settlements_month_start
    check (shipping_month = date_trunc('month', shipping_month)::date),
  constraint finance_first_leg_monthly_settlements_user_month_unique
    unique (user_id, shipping_month)
);

create table public.finance_first_leg_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  settlement_id uuid not null
    references public.finance_first_leg_monthly_settlements(id) on delete restrict,
  paid_amount_rmb numeric not null check (paid_amount_rmb > 0),
  paid_at timestamptz not null,
  remark text not null default '',
  request_key uuid not null,
  voided_at timestamptz,
  void_reason text not null default '',
  created_at timestamptz not null default now(),
  constraint finance_first_leg_payments_void_reason_required
    check (voided_at is null or btrim(void_reason) <> ''),
  constraint finance_first_leg_payments_user_request_unique
    unique (user_id, request_key)
);

create index idx_finance_first_leg_settlements_user_month
on public.finance_first_leg_monthly_settlements(user_id, shipping_month desc);

create index idx_finance_first_leg_payments_settlement_active
on public.finance_first_leg_payments(settlement_id, created_at)
where voided_at is null;

create index idx_finance_first_leg_payments_user_paid_at
on public.finance_first_leg_payments(user_id, paid_at desc)
where voided_at is null;

create trigger finance_first_leg_monthly_settlements_set_updated_at
before update on public.finance_first_leg_monthly_settlements
for each row execute function public.set_updated_at();

alter table public.finance_first_leg_monthly_settlements enable row level security;
alter table public.finance_first_leg_payments enable row level security;

create policy "finance_first_leg_settlements_select_own"
on public.finance_first_leg_monthly_settlements for select to authenticated
using ((select auth.uid()) = user_id);

create policy "finance_first_leg_settlements_insert_own"
on public.finance_first_leg_monthly_settlements for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
);

create policy "finance_first_leg_settlements_update_own"
on public.finance_first_leg_monthly_settlements for update to authenticated
using (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
)
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
);

create policy "finance_first_leg_payments_select_own"
on public.finance_first_leg_payments for select to authenticated
using ((select auth.uid()) = user_id);

create policy "finance_first_leg_payments_insert_own"
on public.finance_first_leg_payments for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
);

create policy "finance_first_leg_payments_update_own"
on public.finance_first_leg_payments for update to authenticated
using (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
)
with check (
  (select auth.uid()) = user_id
  and public.current_account_can_edit()
);

grant select, insert, update on table public.finance_first_leg_monthly_settlements to authenticated;
grant select, insert, update on table public.finance_first_leg_payments to authenticated;

create or replace function public.get_first_leg_monthly_settlements()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with payment_totals as (
    select
      payment.settlement_id,
      coalesce(sum(payment.paid_amount_rmb) filter (where payment.voided_at is null), 0)
        as paid_amount_rmb,
      max(payment.paid_at) filter (where payment.voided_at is null) as last_paid_at
    from public.finance_first_leg_payments payment
    where payment.user_id = auth.uid()
    group by payment.settlement_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shippingMonth', to_char(settlement.shipping_month, 'YYYY-MM'),
    'estimatedAmountSnapshotRmb', settlement.estimated_amount_snapshot_rmb,
    'actualAmountRmb', settlement.actual_amount_rmb,
    'paidAmountRmb', coalesce(payment.paid_amount_rmb, 0),
    'outstandingAmountRmb', greatest(
      settlement.actual_amount_rmb - coalesce(payment.paid_amount_rmb, 0),
      0
    ),
    'lastPaidAt', payment.last_paid_at,
    'status', case
      when greatest(settlement.actual_amount_rmb - coalesce(payment.paid_amount_rmb, 0), 0) <= 0
        then 'paid'
      when coalesce(payment.paid_amount_rmb, 0) > 0 then 'partial'
      else 'unpaid'
    end
  ) order by settlement.shipping_month desc), '[]'::jsonb)
  from public.finance_first_leg_monthly_settlements settlement
  left join payment_totals payment on payment.settlement_id = settlement.id
  where settlement.user_id = auth.uid();
$$;

create or replace function public.save_first_leg_monthly_actual(
  p_shipping_month text,
  p_estimated_amount_rmb numeric,
  p_actual_amount_rmb numeric
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
  v_settlement_id uuid;
  v_paid_amount numeric := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
  end if;
  if coalesce(p_shipping_month, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Shipping month must use YYYY-MM' using errcode = '22023';
  end if;
  if p_estimated_amount_rmb is null or p_estimated_amount_rmb < 0 then
    raise exception 'Estimated amount must be zero or greater' using errcode = '22023';
  end if;
  if p_actual_amount_rmb is null or p_actual_amount_rmb < 0 then
    raise exception 'Actual amount must be zero or greater' using errcode = '22023';
  end if;

  v_shipping_month := to_date(p_shipping_month || '-01', 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':first-leg:' || p_shipping_month,
    0
  ));

  select settlement.id
  into v_settlement_id
  from public.finance_first_leg_monthly_settlements settlement
  where settlement.user_id = v_user_id
    and settlement.shipping_month = v_shipping_month
  for update;

  if v_settlement_id is not null then
    select coalesce(sum(payment.paid_amount_rmb), 0)
    into v_paid_amount
    from public.finance_first_leg_payments payment
    where payment.user_id = v_user_id
      and payment.settlement_id = v_settlement_id
      and payment.voided_at is null;

    if p_actual_amount_rmb < v_paid_amount then
      raise exception 'Actual amount cannot be lower than the active paid amount'
        using errcode = '22023';
    end if;
  end if;

  insert into public.finance_first_leg_monthly_settlements (
    user_id,
    shipping_month,
    estimated_amount_snapshot_rmb,
    actual_amount_rmb
  ) values (
    v_user_id,
    v_shipping_month,
    p_estimated_amount_rmb,
    p_actual_amount_rmb
  )
  on conflict (user_id, shipping_month) do update set
    estimated_amount_snapshot_rmb = excluded.estimated_amount_snapshot_rmb,
    actual_amount_rmb = excluded.actual_amount_rmb,
    updated_at = now()
  returning id into v_settlement_id;

  return jsonb_build_object(
    'settlementId', v_settlement_id,
    'shippingMonth', p_shipping_month,
    'estimatedAmountRmb', p_estimated_amount_rmb,
    'actualAmountRmb', p_actual_amount_rmb,
    'paidAmountRmb', v_paid_amount,
    'outstandingAmountRmb', greatest(p_actual_amount_rmb - v_paid_amount, 0)
  );
end;
$$;

create or replace function public.record_first_leg_payment(
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
  v_settlement public.finance_first_leg_monthly_settlements%rowtype;
  v_paid_before numeric := 0;
  v_payment_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.current_account_can_edit() then
    raise exception 'Edit permission required' using errcode = '42501';
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
  from public.finance_first_leg_payments payment
  where payment.user_id = v_user_id and payment.request_key = p_request_key;
  if v_payment_id is not null then
    return jsonb_build_object('paymentId', v_payment_id, 'duplicate', true);
  end if;

  v_shipping_month := to_date(p_shipping_month || '-01', 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':first-leg:' || p_shipping_month,
    0
  ));

  select * into v_settlement
  from public.finance_first_leg_monthly_settlements settlement
  where settlement.user_id = v_user_id
    and settlement.shipping_month = v_shipping_month
  for update;

  if v_settlement.id is null then
    raise exception 'Confirm the actual first-leg amount before payment'
      using errcode = '22023';
  end if;
  if v_settlement.actual_amount_rmb <= 0 then
    raise exception 'No payable actual first-leg amount found for this month'
      using errcode = '22023';
  end if;

  select coalesce(sum(payment.paid_amount_rmb), 0)
  into v_paid_before
  from public.finance_first_leg_payments payment
  where payment.user_id = v_user_id
    and payment.settlement_id = v_settlement.id
    and payment.voided_at is null;

  if p_paid_amount_rmb > greatest(v_settlement.actual_amount_rmb - v_paid_before, 0) then
    raise exception 'Paid amount exceeds the current outstanding amount'
      using errcode = '22023';
  end if;

  insert into public.finance_first_leg_payments (
    user_id,
    settlement_id,
    paid_amount_rmb,
    paid_at,
    remark,
    request_key
  ) values (
    v_user_id,
    v_settlement.id,
    p_paid_amount_rmb,
    p_paid_at,
    btrim(coalesce(p_remark, '')),
    p_request_key
  )
  returning id into v_payment_id;

  return jsonb_build_object(
    'paymentId', v_payment_id,
    'paidAmountRmb', v_paid_before + p_paid_amount_rmb,
    'outstandingAmountRmb', greatest(
      v_settlement.actual_amount_rmb - v_paid_before - p_paid_amount_rmb,
      0
    ),
    'duplicate', false
  );
end;
$$;

create or replace function public.get_first_leg_payment_records(p_shipping_month text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
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
  from public.finance_first_leg_payments payment
  join public.finance_first_leg_monthly_settlements settlement
    on settlement.id = payment.settlement_id
  where payment.user_id = auth.uid()
    and settlement.user_id = auth.uid()
    and to_char(settlement.shipping_month, 'YYYY-MM') = p_shipping_month;
$$;

create or replace function public.void_first_leg_payment(
  p_payment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.finance_first_leg_payments%rowtype;
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
  from public.finance_first_leg_payments payment
  where payment.id = p_payment_id and payment.user_id = v_user_id
  for update;

  if v_payment.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if v_payment.voided_at is not null then
    return jsonb_build_object('paymentId', v_payment.id, 'alreadyVoided', true);
  end if;

  update public.finance_first_leg_payments
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
    from public.temu_order_shipments order_row
    where btrim(order_row.logistics_tracking_no) <> ''
    group by btrim(order_row.logistics_tracking_no)
  ), current_last_leg_payable as (
    select coalesce(sum(fee.actual_shipping_fee_rmb), 0) as amount
    from public.finance_actual_shipping_fees fee
    join order_groups orders on orders.tracking_no = fee.logistics_tracking_no
    where fee.user_id = auth.uid()
      and public.try_parse_temu_order_time(orders.actual_ship_time) is not null
  ), current_first_leg_payable as (
    select coalesce(sum(settlement.actual_amount_rmb), 0) as amount
    from public.finance_first_leg_monthly_settlements settlement
    where settlement.user_id = auth.uid()
  ), active_payments as (
    select payment.paid_amount_rmb, settlement.shipping_month
    from public.finance_logistics_payments payment
    join public.finance_logistics_settlements settlement
      on settlement.id = payment.settlement_id
      and settlement.user_id = payment.user_id
    where payment.user_id = auth.uid()
      and settlement.user_id = auth.uid()
      and payment.voided_at is null

    union all

    select payment.paid_amount_rmb, settlement.shipping_month
    from public.finance_first_leg_payments payment
    join public.finance_first_leg_monthly_settlements settlement
      on settlement.id = payment.settlement_id
      and settlement.user_id = payment.user_id
    where payment.user_id = auth.uid()
      and settlement.user_id = auth.uid()
      and payment.voided_at is null
  ), monthly_rows as (
    select
      to_char(shipping_month, 'YYYY-MM') as month,
      sum(paid_amount_rmb) as paid_amount_rmb
    from active_payments
    group by shipping_month
  ), totals as (
    select
      last_leg.amount + first_leg.amount as payable_amount,
      coalesce((select sum(paid_amount_rmb) from active_payments), 0) as paid_amount
    from current_last_leg_payable last_leg
    cross join current_first_leg_payable first_leg
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

    select p.purchased_at, '采购付款', '支出', p.order_code,
      -round(p.total_cost_rmb, 2), p.warehouse_name, p.id::text
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

    union all

    select
      timezone('Asia/Tokyo', payment.paid_at)::date,
      '物流付款',
      '支出',
      '头程运费',
      -round(payment.paid_amount_rmb, 2),
      format('%s 发货月头程月结%s',
        to_char(settlement.shipping_month, 'YYYY-MM'),
        case when btrim(payment.remark) = '' then '' else ' · ' || btrim(payment.remark) end),
      payment.id::text
    from public.finance_first_leg_payments payment
    join public.finance_first_leg_monthly_settlements settlement
      on settlement.id = payment.settlement_id
    where payment.user_id = auth.uid()
      and settlement.user_id = auth.uid()
      and payment.voided_at is null
  ), filtered as (
    select * from ledger
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

comment on table public.finance_first_leg_monthly_settlements is
  'One manually confirmed actual first-leg total per user and actual shipping month.';
comment on table public.finance_first_leg_payments is
  'Append-only first-leg payment records; voiding preserves the audit trail.';

revoke all on function public.get_first_leg_monthly_settlements() from public;
revoke all on function public.save_first_leg_monthly_actual(text, numeric, numeric) from public;
revoke all on function public.record_first_leg_payment(text, numeric, timestamptz, text, uuid) from public;
revoke all on function public.get_first_leg_payment_records(text) from public;
revoke all on function public.void_first_leg_payment(uuid, text) from public;
revoke all on function public.get_finance_logistics_cash_summary() from public;
revoke all on function public.get_finance_ledger_page(integer, integer, text, text) from public;

grant execute on function public.get_first_leg_monthly_settlements() to authenticated;
grant execute on function public.save_first_leg_monthly_actual(text, numeric, numeric) to authenticated;
grant execute on function public.record_first_leg_payment(text, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.get_first_leg_payment_records(text) to authenticated;
grant execute on function public.void_first_leg_payment(uuid, text) to authenticated;
grant execute on function public.get_finance_logistics_cash_summary() to authenticated;
grant execute on function public.get_finance_ledger_page(integer, integer, text, text) to authenticated;
