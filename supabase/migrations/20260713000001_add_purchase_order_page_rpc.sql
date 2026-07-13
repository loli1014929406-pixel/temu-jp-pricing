-- Server-side purchase record pagination, search, receipt status, and summaries.

create or replace function public.get_purchase_orders_page(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default ''
)
returns table (
  orders jsonb,
  total_count bigint,
  summary jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with received_by_item as (
    select package_item.order_item_id, sum(package_item.quantity)::bigint as received_quantity
    from public.purchase_package_items package_item
    join public.purchase_packages package on package.id = package_item.package_id
    where package.status = 'received'
    group by package_item.order_item_id
  ), order_metrics as (
    select
      purchase_order.*,
      case
        when not exists (
          select 1 from public.purchase_order_items item
          where item.order_id = purchase_order.id
        ) then 'pending'
        when not exists (
          select 1
          from public.purchase_order_items item
          join received_by_item received on received.order_item_id = item.id
          where item.order_id = purchase_order.id and received.received_quantity > 0
        ) then 'pending'
        when not exists (
          select 1
          from public.purchase_order_items item
          left join received_by_item received on received.order_item_id = item.id
          where item.order_id = purchase_order.id
            and coalesce(received.received_quantity, 0) < item.quantity
        ) then 'received'
        else 'partially_received'
      end as computed_status,
      (
        select count(*)::bigint from public.purchase_packages package
        where package.order_id = purchase_order.id
      ) as package_count,
      (
        select count(*)::bigint from public.purchase_packages package
        where package.order_id = purchase_order.id and package.status = 'received'
      ) as received_package_count
    from public.purchase_orders purchase_order
  ), filtered as (
    select metrics.*
    from order_metrics metrics
    where btrim(coalesce(p_search, '')) = ''
      or lower(metrics.order_code) like '%' || lower(btrim(p_search)) || '%'
      or exists (
        select 1 from public.purchase_order_sources source
        where source.order_id = metrics.id
          and lower(source.alibaba_order_no) like '%' || lower(btrim(p_search)) || '%'
      )
      or exists (
        select 1 from public.purchase_order_items item
        where item.order_id = metrics.id
          and lower(item.product_code || ' ' || item.product_name_cn) like '%' || lower(btrim(p_search)) || '%'
      )
  ), paged as (
    select filtered.*
    from filtered
    order by
      case when filtered.computed_status in ('pending', 'partially_received') then 0 else 1 end,
      filtered.purchased_at desc,
      filtered.created_at desc,
      filtered.id
    offset (greatest(coalesce(p_page, 1), 1) - 1)
      * least(greatest(coalesce(p_page_size, 20), 1), 100)
    limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  )
  select
    coalesce((
      select jsonb_agg(
        (to_jsonb(page_order) - 'computed_status' - 'package_count' - 'received_package_count')
        || jsonb_build_object(
          'status', page_order.computed_status,
          'received_at', case when page_order.computed_status = 'received' then page_order.received_at else null end,
          'sources', coalesce((
            select jsonb_agg(to_jsonb(source) order by source.id)
            from public.purchase_order_sources source
            where source.order_id = page_order.id
          ), '[]'::jsonb),
          'items', coalesce((
            select jsonb_agg(to_jsonb(item) order by item.id)
            from public.purchase_order_items item
            where item.order_id = page_order.id
          ), '[]'::jsonb),
          'packages', coalesce((
            select jsonb_agg(
              to_jsonb(package) || jsonb_build_object(
                'items', coalesce((
                  select jsonb_agg(to_jsonb(package_item) order by package_item.order_item_id)
                  from public.purchase_package_items package_item
                  where package_item.package_id = package.id
                ), '[]'::jsonb)
              )
              order by package.id
            )
            from public.purchase_packages package
            where package.order_id = page_order.id
          ), '[]'::jsonb)
        )
        order by
          case when page_order.computed_status in ('pending', 'partially_received') then 0 else 1 end,
          page_order.purchased_at desc,
          page_order.created_at desc,
          page_order.id
      )
      from paged page_order
    ), '[]'::jsonb),
    (select count(*)::bigint from filtered),
    coalesce((
      select jsonb_build_object(
        'pendingOrderCount', count(*) filter (where computed_status = 'pending'),
        'partiallyReceivedOrderCount', count(*) filter (where computed_status = 'partially_received'),
        'receivedOrderCount', count(*) filter (where computed_status = 'received'),
        'packageCount', coalesce(sum(package_count), 0),
        'receivedPackageCount', coalesce(sum(received_package_count), 0),
        'totalCostRmb', coalesce(sum(total_cost_rmb), 0)
      )
      from filtered
    ), jsonb_build_object(
      'pendingOrderCount', 0,
      'partiallyReceivedOrderCount', 0,
      'receivedOrderCount', 0,
      'packageCount', 0,
      'receivedPackageCount', 0,
      'totalCostRmb', 0
    ));
$$;

revoke all on function public.get_purchase_orders_page(integer, integer, text) from public;
grant execute on function public.get_purchase_orders_page(integer, integer, text) to authenticated;

create index if not exists idx_purchase_order_items_order
on public.purchase_order_items(order_id, id);

create index if not exists idx_purchase_packages_order
on public.purchase_packages(order_id, status, id);

create index if not exists idx_purchase_package_items_order_item
on public.purchase_package_items(order_item_id, package_id);
