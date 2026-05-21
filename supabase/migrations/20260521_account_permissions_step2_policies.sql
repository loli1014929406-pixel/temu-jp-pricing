drop trigger if exists products_enforce_account_edit on public.products;
drop trigger if exists product_items_enforce_account_edit on public.product_items;
drop trigger if exists product_skus_enforce_account_edit on public.product_skus;
drop trigger if exists product_sku_items_enforce_account_edit on public.product_sku_items;
drop trigger if exists pricing_settings_enforce_account_edit on public.pricing_settings;
drop trigger if exists pricing_results_enforce_account_edit on public.pricing_results;
drop trigger if exists profit_calculations_enforce_account_edit on public.profit_calculations;
drop trigger if exists warehouses_enforce_account_edit on public.warehouses;
drop trigger if exists warehouse_skus_enforce_account_edit on public.warehouse_skus;
drop trigger if exists warehouse_item_stocks_enforce_account_edit on public.warehouse_item_stocks;
drop trigger if exists warehouse_item_stock_adjustments_enforce_account_edit on public.warehouse_item_stock_adjustments;
drop trigger if exists purchase_orders_enforce_account_edit on public.purchase_orders;
drop trigger if exists purchase_order_sources_enforce_account_edit on public.purchase_order_sources;
drop trigger if exists purchase_order_items_enforce_account_edit on public.purchase_order_items;
drop trigger if exists purchase_packages_enforce_account_edit on public.purchase_packages;
drop trigger if exists purchase_package_items_enforce_account_edit on public.purchase_package_items;
drop trigger if exists products_enforce_account_delete on public.products;
drop trigger if exists warehouses_enforce_account_delete on public.warehouses;
drop trigger if exists purchase_orders_enforce_account_delete on public.purchase_orders;
drop trigger if exists purchase_packages_enforce_account_delete on public.purchase_packages;

drop function if exists public.enforce_account_edit_permission();
drop function if exists public.enforce_account_delete_permission();

drop policy if exists "products_account_insert_edit" on public.products;
create policy "products_account_insert_edit" on public.products
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "products_account_update_edit" on public.products;
create policy "products_account_update_edit" on public.products
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "products_account_delete_admin" on public.products;
create policy "products_account_delete_admin" on public.products
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "product_items_account_insert_edit" on public.product_items;
create policy "product_items_account_insert_edit" on public.product_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_items_account_update_edit" on public.product_items;
create policy "product_items_account_update_edit" on public.product_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "product_skus_account_insert_edit" on public.product_skus;
create policy "product_skus_account_insert_edit" on public.product_skus
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_skus_account_update_edit" on public.product_skus;
create policy "product_skus_account_update_edit" on public.product_skus
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "product_sku_items_account_insert_edit" on public.product_sku_items;
create policy "product_sku_items_account_insert_edit" on public.product_sku_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "product_sku_items_account_update_edit" on public.product_sku_items;
create policy "product_sku_items_account_update_edit" on public.product_sku_items
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "pricing_settings_account_insert_edit" on public.pricing_settings;
create policy "pricing_settings_account_insert_edit" on public.pricing_settings
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "pricing_settings_account_update_edit" on public.pricing_settings;
create policy "pricing_settings_account_update_edit" on public.pricing_settings
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "pricing_results_account_insert_edit" on public.pricing_results;
create policy "pricing_results_account_insert_edit" on public.pricing_results
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "pricing_results_account_update_edit" on public.pricing_results;
create policy "pricing_results_account_update_edit" on public.pricing_results
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "profit_calculations_account_insert_edit" on public.profit_calculations;
create policy "profit_calculations_account_insert_edit" on public.profit_calculations
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "profit_calculations_account_update_edit" on public.profit_calculations;
create policy "profit_calculations_account_update_edit" on public.profit_calculations
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_insert_edit" on public.warehouses;
create policy "warehouses_account_insert_edit" on public.warehouses
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_update_edit" on public.warehouses;
create policy "warehouses_account_update_edit" on public.warehouses
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouses_account_delete_admin" on public.warehouses;
create policy "warehouses_account_delete_admin" on public.warehouses
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_skus_account_insert_edit" on public.warehouse_skus;
create policy "warehouse_skus_account_insert_edit" on public.warehouse_skus
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouse_skus_account_update_edit" on public.warehouse_skus;
create policy "warehouse_skus_account_update_edit" on public.warehouse_skus
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouse_skus_account_delete_admin" on public.warehouse_skus;
create policy "warehouse_skus_account_delete_admin" on public.warehouse_skus
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stocks_account_insert_edit" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_insert_edit" on public.warehouse_item_stocks
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "warehouse_item_stocks_account_update_edit" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_update_edit" on public.warehouse_item_stocks
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "warehouse_item_stocks_account_delete_admin" on public.warehouse_item_stocks;
create policy "warehouse_item_stocks_account_delete_admin" on public.warehouse_item_stocks
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "warehouse_item_stock_adjustments_account_insert_edit" on public.warehouse_item_stock_adjustments;
create policy "warehouse_item_stock_adjustments_account_insert_edit" on public.warehouse_item_stock_adjustments
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_insert_edit" on public.purchase_orders;
create policy "purchase_orders_account_insert_edit" on public.purchase_orders
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_update_edit" on public.purchase_orders;
create policy "purchase_orders_account_update_edit" on public.purchase_orders
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_orders_account_delete_admin" on public.purchase_orders;
create policy "purchase_orders_account_delete_admin" on public.purchase_orders
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_order_sources_account_insert_edit" on public.purchase_order_sources;
create policy "purchase_order_sources_account_insert_edit" on public.purchase_order_sources
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_order_sources_account_update_edit" on public.purchase_order_sources;
create policy "purchase_order_sources_account_update_edit" on public.purchase_order_sources
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_order_items_account_insert_edit" on public.purchase_order_items;
create policy "purchase_order_items_account_insert_edit" on public.purchase_order_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_insert_edit" on public.purchase_packages;
create policy "purchase_packages_account_insert_edit" on public.purchase_packages
as restrictive for insert to authenticated
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_update_edit" on public.purchase_packages;
create policy "purchase_packages_account_update_edit" on public.purchase_packages
as restrictive for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());

drop policy if exists "purchase_packages_account_delete_admin" on public.purchase_packages;
create policy "purchase_packages_account_delete_admin" on public.purchase_packages
as restrictive for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "purchase_package_items_account_insert_edit" on public.purchase_package_items;
create policy "purchase_package_items_account_insert_edit" on public.purchase_package_items
as restrictive for insert to authenticated
with check (public.current_account_can_edit());
