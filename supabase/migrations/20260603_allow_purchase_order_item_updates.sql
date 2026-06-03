grant select, insert, update, delete
on table public.purchase_order_items
to authenticated;

drop policy if exists "purchase_order_items_update_own" on public.purchase_order_items;
create policy "purchase_order_items_update_own"
on public.purchase_order_items for update
using (auth.uid() = owner_id)
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

drop policy if exists "purchase_order_items_account_update_edit" on public.purchase_order_items;
create policy "purchase_order_items_account_update_edit" on public.purchase_order_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
