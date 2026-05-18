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
);
