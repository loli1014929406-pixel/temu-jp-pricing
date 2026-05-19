alter table public.purchase_packages
alter column owner_id set default auth.uid();

alter table public.purchase_package_items
alter column owner_id set default auth.uid();

grant select, insert, update, delete on table public.purchase_packages to authenticated;
grant select, insert, update, delete on table public.purchase_package_items to authenticated;

drop policy if exists "purchase_packages_select_own" on public.purchase_packages;
create policy "purchase_packages_select_own"
on public.purchase_packages for select
using (auth.uid() = owner_id);

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

drop policy if exists "purchase_packages_update_own" on public.purchase_packages;
create policy "purchase_packages_update_own"
on public.purchase_packages for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

drop policy if exists "purchase_packages_delete_own" on public.purchase_packages;
create policy "purchase_packages_delete_own"
on public.purchase_packages for delete
using (auth.uid() = owner_id and status = 'pending');

drop policy if exists "purchase_package_items_select_own" on public.purchase_package_items;
create policy "purchase_package_items_select_own"
on public.purchase_package_items for select
using (auth.uid() = owner_id);

drop policy if exists "purchase_package_items_insert_own" on public.purchase_package_items;
create policy "purchase_package_items_insert_own"
on public.purchase_package_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_packages
    join public.purchase_order_items
      on purchase_order_items.id = purchase_package_items.order_item_id
    where purchase_packages.id = purchase_package_items.package_id
      and purchase_packages.order_id = purchase_order_items.order_id
      and purchase_packages.owner_id = auth.uid()
      and purchase_order_items.owner_id = auth.uid()
  )
);

grant execute on function public.create_purchase_package(uuid, uuid, text, jsonb) to authenticated;
