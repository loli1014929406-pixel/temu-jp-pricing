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
  ), current_payable as (
    select coalesce(sum(fee.actual_shipping_fee_rmb), 0) as amount
    from public.finance_actual_shipping_fees fee
    join order_groups orders on orders.tracking_no = fee.logistics_tracking_no
    where fee.user_id = auth.uid()
      and public.try_parse_temu_order_time(orders.actual_ship_time) is not null
  ), active_payments as (
    select
      payment.paid_amount_rmb,
      settlement.shipping_month
    from public.finance_logistics_payments payment
    join public.finance_logistics_settlements settlement
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

comment on function public.get_finance_logistics_cash_summary() is
  'Returns logistics payment totals and attributes monthly profit-report costs to each settlement shipping month.';

revoke all on function public.get_finance_logistics_cash_summary() from public;
grant execute on function public.get_finance_logistics_cash_summary() to authenticated;
