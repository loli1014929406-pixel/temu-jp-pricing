-- Read-only settlement query contracts. Existing RLS remains authoritative.
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
    coalesce((
      select jsonb_agg(to_jsonb(p) order by p.po_number)
      from (
        select
          min(file_id::text)::uuid as file_id,
          po_number,
          sum(quantity)::integer as quantity,
          round(sum(sales_revenue + sales_reversal), 2) as sales_revenue,
          round(sum(freight_revenue + freight_reversal), 2) as freight_revenue,
          count(*)::integer as record_count
        from public.finance_settlement_records
        where user_id = auth.uid()
        group by po_number
      ) p
    ), '[]'::jsonb);
$$;

create or replace function public.get_finance_settlement_records_page(
  p_file_id uuid default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default ''
)
returns table (records jsonb, total_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with filtered as (
    select r.*
    from public.finance_settlement_records r
    where r.user_id = auth.uid()
      and (p_file_id is null or r.file_id = p_file_id)
      and (
        btrim(coalesce(p_search, '')) = ''
        or lower(r.po_number || ' ' || r.sku_code || ' ' || r.sku_name)
          like '%' || lower(btrim(p_search)) || '%'
      )
  ), paged as (
    select id, file_id, po_number, sku_id, sku_name, sku_code, quantity,
      declared_price, is_promotion_price, currency, sales_revenue,
      sales_discount_deducted, sales_reversal, freight_revenue,
      freight_discount_deducted, freight_reversal, total_revenue
    from filtered
    order by id
    offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 50), 1), 100)
    limit least(greatest(coalesce(p_page_size, 50), 1), 100)
  )
  select
    coalesce((select jsonb_agg(to_jsonb(paged) order by id) from paged), '[]'::jsonb),
    (select count(*) from filtered);
$$;

revoke all on function public.get_finance_settlement_summary() from public;
revoke all on function public.get_finance_settlement_records_page(uuid, integer, integer, text) from public;
grant execute on function public.get_finance_settlement_summary() to authenticated;
grant execute on function public.get_finance_settlement_records_page(uuid, integer, integer, text) to authenticated;

create index if not exists idx_finance_settlement_records_user_po
on public.finance_settlement_records(user_id, po_number);

create index if not exists idx_finance_settlement_records_user_file_id
on public.finance_settlement_records(user_id, file_id, id);
