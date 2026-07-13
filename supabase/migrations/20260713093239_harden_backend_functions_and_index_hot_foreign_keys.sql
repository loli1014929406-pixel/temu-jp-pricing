-- Keep privileged permission lookups outside the exposed API schema. Public
-- wrappers remain available to existing RLS policies and frontend RPC calls,
-- but execute with the caller's privileges.
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.current_account_permission()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce((
    select permission_level
    from public.account_permissions
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    limit 1
  ), 'viewer')
$function$;

create or replace function private.current_account_has_permission()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null and exists (
    select 1
    from public.account_permissions
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$function$;

create or replace function private.current_account_can_edit()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select private.current_account_permission() in ('admin', 'editor')
$function$;

create or replace function private.current_account_can_delete()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select private.current_account_permission() = 'admin'
$function$;

revoke all on function private.current_account_permission() from public, anon;
revoke all on function private.current_account_has_permission() from public, anon;
revoke all on function private.current_account_can_edit() from public, anon;
revoke all on function private.current_account_can_delete() from public, anon;
grant execute on function private.current_account_permission() to authenticated;
grant execute on function private.current_account_has_permission() to authenticated;
grant execute on function private.current_account_can_edit() to authenticated;
grant execute on function private.current_account_can_delete() to authenticated;

create or replace function public.current_account_permission()
returns text
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.current_account_permission()
$function$;

create or replace function public.current_account_has_permission()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.current_account_has_permission()
$function$;

create or replace function public.current_account_can_edit()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.current_account_can_edit()
$function$;

create or replace function public.current_account_can_delete()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.current_account_can_delete()
$function$;

revoke all on function public.current_account_permission() from public, anon;
revoke all on function public.current_account_has_permission() from public, anon;
revoke all on function public.current_account_can_edit() from public, anon;
revoke all on function public.current_account_can_delete() from public, anon;
grant execute on function public.current_account_permission() to authenticated;
grant execute on function public.current_account_has_permission() to authenticated;
grant execute on function public.current_account_can_edit() to authenticated;
grant execute on function public.current_account_can_delete() to authenticated;

-- Event-trigger and trigger helpers are not application RPC endpoints.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
alter function public.set_updated_at() set search_path = pg_catalog;

-- Index the highest-activity business relationship foreign keys. Ownership
-- columns remain intentionally unindexed until real query plans require them.
create index if not exists idx_order_sku_reservations_warehouse_sku
  on public.temu_order_sku_inventory_reservations (warehouse_sku_id);
create index if not exists idx_warehouse_item_adjustments_warehouse
  on public.warehouse_item_stock_adjustments (warehouse_id);
create index if not exists idx_warehouse_item_adjustments_item
  on public.warehouse_item_stock_adjustments (item_id);
create index if not exists idx_purchase_order_items_source
  on public.purchase_order_items (source_id);
create index if not exists idx_product_sku_items_item
  on public.product_sku_items (item_id);
create index if not exists idx_pricing_results_product
  on public.pricing_results (product_id);
create index if not exists idx_pricing_results_sku
  on public.pricing_results (sku_id);
create index if not exists idx_warehouse_item_stocks_item
  on public.warehouse_item_stocks (item_id);
create index if not exists idx_product_items_product
  on public.product_items (product_id);
create index if not exists idx_purchase_packages_source
  on public.purchase_packages (source_id);
create index if not exists idx_warehouse_skus_product
  on public.warehouse_skus (product_id);
create index if not exists idx_warehouse_skus_sku
  on public.warehouse_skus (sku_id);
create index if not exists idx_product_skus_product
  on public.product_skus (product_id);
