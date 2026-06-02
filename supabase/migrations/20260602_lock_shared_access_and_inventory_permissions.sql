create or replace function public.current_account_has_permission()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select case
  when auth.uid() is null then false
  when not exists (select 1 from public.account_permissions) then true
  else exists (
    select 1
    from public.account_permissions
    where lower(account_permissions.email) =
      lower(coalesce(auth.jwt() ->> ''email'', ''''))
  )
end';

grant execute on function public.current_account_has_permission() to authenticated;

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
on public.products for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_items_select_authenticated" on public.product_items;
create policy "product_items_select_authenticated"
on public.product_items for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_skus_select_authenticated" on public.product_skus;
create policy "product_skus_select_authenticated"
on public.product_skus for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "product_sku_items_select_authenticated" on public.product_sku_items;
create policy "product_sku_items_select_authenticated"
on public.product_sku_items for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "pricing_results_select_authenticated" on public.pricing_results;
create policy "pricing_results_select_authenticated"
on public.pricing_results for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "profit_calculations_select_authenticated" on public.profit_calculations;
create policy "profit_calculations_select_authenticated"
on public.profit_calculations for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouses_select_authenticated" on public.warehouses;
create policy "warehouses_select_authenticated"
on public.warehouses for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_skus_select_authenticated" on public.warehouse_skus;
create policy "warehouse_skus_select_authenticated"
on public.warehouse_skus for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_item_stocks_select_authenticated" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_select_authenticated"
on public.warehouse_item_stocks for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouse_item_stock_adjustments_select_authenticated" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_select_authenticated"
on public.warehouse_item_stock_adjustments for select to authenticated
using (public.current_account_has_permission());

drop policy if exists "warehouses_insert_own" on public.warehouses;
drop policy if exists "warehouses_update_own" on public.warehouses;
drop policy if exists "warehouses_delete_own" on public.warehouses;
drop policy if exists "warehouses_insert_editor" on public.warehouses;
drop policy if exists "warehouses_update_editor" on public.warehouses;
drop policy if exists "warehouses_delete_admin" on public.warehouses;
create policy "warehouses_insert_editor"
on public.warehouses for insert to authenticated
with check (public.current_account_can_edit());
create policy "warehouses_update_editor"
on public.warehouses for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouses_delete_admin"
on public.warehouses for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_skus_insert_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_update_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_delete_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_insert_editor" on public.warehouse_skus;
drop policy if exists "warehouse_skus_update_editor" on public.warehouse_skus;
drop policy if exists "warehouse_skus_delete_admin" on public.warehouse_skus;
create policy "warehouse_skus_insert_editor"
on public.warehouse_skus for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_skus.warehouse_id
  )
  and exists (
    select 1 from public.products
    where products.id = warehouse_skus.product_id
  )
  and exists (
    select 1 from public.product_skus
    where product_skus.id = warehouse_skus.sku_id
      and product_skus.product_id = warehouse_skus.product_id
  )
);
create policy "warehouse_skus_update_editor"
on public.warehouse_skus for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouse_skus_delete_admin"
on public.warehouse_skus for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stocks_insert_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_update_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_delete_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_insert_editor" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_update_editor" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_delete_admin" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_insert_editor"
on public.warehouse_item_stocks for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_item_stocks.warehouse_id
  )
  and exists (
    select 1 from public.product_items
    where product_items.id = warehouse_item_stocks.item_id
  )
);
create policy "warehouse_item_stocks_update_editor"
on public.warehouse_item_stocks for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "warehouse_item_stocks_delete_admin"
on public.warehouse_item_stocks for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stock_adjustments_insert_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_delete_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_insert_editor" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_delete_admin" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_insert_editor"
on public.warehouse_item_stock_adjustments for insert to authenticated
with check (
  public.current_account_can_edit()
  and exists (
    select 1 from public.warehouses
    where warehouses.id = warehouse_item_stock_adjustments.warehouse_id
  )
  and exists (
    select 1 from public.product_items
    where product_items.id = warehouse_item_stock_adjustments.item_id
  )
);
create policy "warehouse_item_stock_adjustments_delete_admin"
on public.warehouse_item_stock_adjustments for delete to authenticated
using (public.current_account_can_delete());
