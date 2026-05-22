-- Product catalog data is shared across project accounts.
-- Account permissions control actions: authenticated users can read,
-- editors/admins can edit catalog details, and only admins can delete products.

drop policy if exists "products_select_own" on public.products;
drop policy if exists "products_insert_own" on public.products;
drop policy if exists "products_update_own" on public.products;
drop policy if exists "products_delete_own" on public.products;
drop policy if exists "products_account_insert_edit" on public.products;
drop policy if exists "products_account_update_edit" on public.products;
drop policy if exists "products_account_delete_admin" on public.products;
drop policy if exists "products_select_authenticated" on public.products;
drop policy if exists "products_insert_editor" on public.products;
drop policy if exists "products_update_editor" on public.products;
drop policy if exists "products_delete_admin" on public.products;
create policy "products_select_authenticated"
on public.products for select to authenticated
using (true);
create policy "products_insert_editor"
on public.products for insert to authenticated
with check (public.current_account_can_edit());
create policy "products_update_editor"
on public.products for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "products_delete_admin"
on public.products for delete to authenticated
using (public.current_account_can_delete());

drop policy if exists "product_items_select_own" on public.product_items;
drop policy if exists "product_items_insert_own" on public.product_items;
drop policy if exists "product_items_update_own" on public.product_items;
drop policy if exists "product_items_delete_own" on public.product_items;
drop policy if exists "product_items_account_insert_edit" on public.product_items;
drop policy if exists "product_items_account_update_edit" on public.product_items;
drop policy if exists "product_items_select_authenticated" on public.product_items;
drop policy if exists "product_items_insert_editor" on public.product_items;
drop policy if exists "product_items_update_editor" on public.product_items;
drop policy if exists "product_items_delete_editor" on public.product_items;
create policy "product_items_select_authenticated"
on public.product_items for select to authenticated
using (true);
create policy "product_items_insert_editor"
on public.product_items for insert to authenticated
with check (public.current_account_can_edit());
create policy "product_items_update_editor"
on public.product_items for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "product_items_delete_editor"
on public.product_items for delete to authenticated
using (public.current_account_can_edit());

drop policy if exists "product_skus_select_own" on public.product_skus;
drop policy if exists "product_skus_insert_own" on public.product_skus;
drop policy if exists "product_skus_update_own" on public.product_skus;
drop policy if exists "product_skus_delete_own" on public.product_skus;
drop policy if exists "product_skus_account_insert_edit" on public.product_skus;
drop policy if exists "product_skus_account_update_edit" on public.product_skus;
drop policy if exists "product_skus_select_authenticated" on public.product_skus;
drop policy if exists "product_skus_insert_editor" on public.product_skus;
drop policy if exists "product_skus_update_editor" on public.product_skus;
drop policy if exists "product_skus_delete_editor" on public.product_skus;
create policy "product_skus_select_authenticated"
on public.product_skus for select to authenticated
using (true);
create policy "product_skus_insert_editor"
on public.product_skus for insert to authenticated
with check (public.current_account_can_edit());
create policy "product_skus_update_editor"
on public.product_skus for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "product_skus_delete_editor"
on public.product_skus for delete to authenticated
using (public.current_account_can_edit());

drop policy if exists "product_sku_items_select_own" on public.product_sku_items;
drop policy if exists "product_sku_items_insert_own" on public.product_sku_items;
drop policy if exists "product_sku_items_update_own" on public.product_sku_items;
drop policy if exists "product_sku_items_delete_own" on public.product_sku_items;
drop policy if exists "product_sku_items_account_insert_edit" on public.product_sku_items;
drop policy if exists "product_sku_items_account_update_edit" on public.product_sku_items;
drop policy if exists "product_sku_items_select_authenticated" on public.product_sku_items;
drop policy if exists "product_sku_items_insert_editor" on public.product_sku_items;
drop policy if exists "product_sku_items_update_editor" on public.product_sku_items;
drop policy if exists "product_sku_items_delete_editor" on public.product_sku_items;
create policy "product_sku_items_select_authenticated"
on public.product_sku_items for select to authenticated
using (true);
create policy "product_sku_items_insert_editor"
on public.product_sku_items for insert to authenticated
with check (public.current_account_can_edit());
create policy "product_sku_items_update_editor"
on public.product_sku_items for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "product_sku_items_delete_editor"
on public.product_sku_items for delete to authenticated
using (public.current_account_can_edit());

drop policy if exists "pricing_results_select_own" on public.pricing_results;
drop policy if exists "pricing_results_insert_own" on public.pricing_results;
drop policy if exists "pricing_results_update_own" on public.pricing_results;
drop policy if exists "pricing_results_delete_own" on public.pricing_results;
drop policy if exists "pricing_results_account_insert_edit" on public.pricing_results;
drop policy if exists "pricing_results_account_update_edit" on public.pricing_results;
drop policy if exists "pricing_results_select_authenticated" on public.pricing_results;
drop policy if exists "pricing_results_insert_editor" on public.pricing_results;
drop policy if exists "pricing_results_update_editor" on public.pricing_results;
drop policy if exists "pricing_results_delete_editor" on public.pricing_results;
create policy "pricing_results_select_authenticated"
on public.pricing_results for select to authenticated
using (true);
create policy "pricing_results_insert_editor"
on public.pricing_results for insert to authenticated
with check (public.current_account_can_edit());
create policy "pricing_results_update_editor"
on public.pricing_results for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "pricing_results_delete_editor"
on public.pricing_results for delete to authenticated
using (public.current_account_can_edit());

drop policy if exists "profit_calculations_select_own" on public.profit_calculations;
drop policy if exists "profit_calculations_insert_own" on public.profit_calculations;
drop policy if exists "profit_calculations_update_own" on public.profit_calculations;
drop policy if exists "profit_calculations_delete_own" on public.profit_calculations;
drop policy if exists "profit_calculations_account_insert_edit" on public.profit_calculations;
drop policy if exists "profit_calculations_account_update_edit" on public.profit_calculations;
drop policy if exists "profit_calculations_select_authenticated" on public.profit_calculations;
drop policy if exists "profit_calculations_insert_editor" on public.profit_calculations;
drop policy if exists "profit_calculations_update_editor" on public.profit_calculations;
drop policy if exists "profit_calculations_delete_editor" on public.profit_calculations;
create policy "profit_calculations_select_authenticated"
on public.profit_calculations for select to authenticated
using (true);
create policy "profit_calculations_insert_editor"
on public.profit_calculations for insert to authenticated
with check (public.current_account_can_edit());
create policy "profit_calculations_update_editor"
on public.profit_calculations for update to authenticated
using (public.current_account_can_edit())
with check (public.current_account_can_edit());
create policy "profit_calculations_delete_editor"
on public.profit_calculations for delete to authenticated
using (public.current_account_can_edit());
