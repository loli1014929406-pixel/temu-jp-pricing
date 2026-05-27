-- Share warehouse and inventory data across project accounts.
-- Account permissions still control write/delete operations.

drop policy if exists "warehouses_select_own" on public.warehouses;
drop policy if exists "warehouses_select_authenticated" on public.warehouses;
create policy "warehouses_select_authenticated"
on public.warehouses for select to authenticated
using (true);

drop policy if exists "warehouse_skus_select_own" on public.warehouse_skus;
drop policy if exists "warehouse_skus_select_authenticated" on public.warehouse_skus;
create policy "warehouse_skus_select_authenticated"
on public.warehouse_skus for select to authenticated
using (true);

drop policy if exists "warehouse_item_stocks_select_own" on public.warehouse_item_stocks;
drop policy if exists "warehouse_item_stocks_select_authenticated" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_select_authenticated"
on public.warehouse_item_stocks for select to authenticated
using (true);

drop policy if exists "warehouse_item_stock_adjustments_select_own" on public.warehouse_item_stock_adjustments;
drop policy if exists "warehouse_item_stock_adjustments_select_authenticated" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_select_authenticated"
on public.warehouse_item_stock_adjustments for select to authenticated
using (true);
