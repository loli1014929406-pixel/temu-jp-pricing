-- Finance order settlement matching now runs inside get_finance_order_metrics().
-- The file-management query only needs file metadata and stored totals.
create or replace function public.get_finance_settlement_summary()
returns table (files jsonb, po_records jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((
      select jsonb_agg(to_jsonb(f) order by f.imported_at desc, f.id)
      from (
        select id, file_name, date_range_start, date_range_end, imported_at,
          total_sales_revenue, total_freight_revenue, record_count
        from public.finance_settlement_files
        where user_id = auth.uid()
      ) f
    ), '[]'::jsonb),
    '[]'::jsonb;
$$;

revoke all on function public.get_finance_settlement_summary() from public;
grant execute on function public.get_finance_settlement_summary() to authenticated;

