drop policy if exists "purchase_packages_insert_own" on public.purchase_packages;
create policy "purchase_packages_insert_own"
on public.purchase_packages for insert
with check (auth.uid() = owner_id);

drop policy if exists "purchase_package_items_insert_own" on public.purchase_package_items;
create policy "purchase_package_items_insert_own"
on public.purchase_package_items for insert
with check (
  auth.uid() = owner_id
  and exists (
    select 1
    from public.purchase_packages
    where purchase_packages.id = purchase_package_items.package_id
      and purchase_packages.owner_id = auth.uid()
  )
);
