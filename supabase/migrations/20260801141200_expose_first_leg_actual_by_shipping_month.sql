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
  ), payment_monthly as (
    select shipping_month, sum(paid_amount_rmb) as paid_amount_rmb
    from active_payments
    group by shipping_month
  ), month_keys as (
    select shipping_month from payment_monthly
    union
    select settlement.shipping_month
    from public.finance_first_leg_monthly_settlements settlement
    where settlement.user_id = auth.uid()
  ), monthly_rows as (
    select
      month_key.shipping_month,
      coalesce(payment.paid_amount_rmb, 0) as paid_amount_rmb,
      coalesce(first_leg.actual_amount_rmb, 0) as first_leg_actual_amount_rmb,
      (first_leg.id is not null) as has_first_leg_actual
    from month_keys month_key
    left join payment_monthly payment
      on payment.shipping_month = month_key.shipping_month
    left join public.finance_first_leg_monthly_settlements first_leg
      on first_leg.user_id = auth.uid()
      and first_leg.shipping_month = month_key.shipping_month
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
      'month', to_char(shipping_month, 'YYYY-MM'),
      'paidAmountRmb', paid_amount_rmb,
      'firstLegActualAmountRmb', first_leg_actual_amount_rmb,
      'hasFirstLegActual', has_first_leg_actual
    ) order by shipping_month desc) from monthly_rows), '[]'::jsonb)
  from totals;
$$;

revoke all on function public.get_finance_logistics_cash_summary() from public;
grant execute on function public.get_finance_logistics_cash_summary() to authenticated;

comment on function public.get_finance_logistics_cash_summary() is
  'Returns logistics payable and paid totals by shipping month, including confirmed monthly first-leg actual totals without allocating them to orders.';
