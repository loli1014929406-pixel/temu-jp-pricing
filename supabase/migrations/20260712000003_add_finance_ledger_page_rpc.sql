-- Server-side finance ledger pagination and aggregation. Existing RLS remains authoritative.
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

revoke all on function public.get_finance_ledger_page(integer, integer, text, text) from public;
grant execute on function public.get_finance_ledger_page(integer, integer, text, text) to authenticated;

