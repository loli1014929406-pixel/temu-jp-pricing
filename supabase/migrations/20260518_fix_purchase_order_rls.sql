alter table public.purchase_orders
alter column owner_id set default auth.uid();

alter table public.purchase_order_sources
alter column owner_id set default auth.uid();

alter table public.purchase_order_items
alter column owner_id set default auth.uid();

alter table public.purchase_packages
alter column owner_id set default auth.uid();

alter table public.purchase_package_items
alter column owner_id set default auth.uid();

drop policy if exists "purchase_order_items_insert_own" on public.purchase_order_items;
create policy "purchase_order_items_insert_own"
on public.purchase_order_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = purchase_order_items.order_id
      and purchase_orders.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.purchase_order_sources
    where purchase_order_sources.id = purchase_order_items.source_id
      and purchase_order_sources.order_id = purchase_order_items.order_id
      and purchase_order_sources.owner_id = auth.uid()
  )
);

drop policy if exists "purchase_packages_insert_own" on public.purchase_packages;
create policy "purchase_packages_insert_own"
on public.purchase_packages for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_orders
    where purchase_orders.id = purchase_packages.order_id
      and purchase_orders.owner_id = auth.uid()
  )
  and exists (
    select 1
    from public.purchase_order_sources
    where purchase_order_sources.id = purchase_packages.source_id
      and purchase_order_sources.order_id = purchase_packages.order_id
      and purchase_order_sources.owner_id = auth.uid()
  )
);
