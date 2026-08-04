-- Materialize the readable shop set once per statement so large
-- security-invoker views do not repeat membership lookups for every row.
create or replace function private.current_user_readable_shop_ids(
  p_resource text
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce(array_agg(shop.id order by shop.id), array[]::uuid[])
  from public.shops shop
  where shop.status = 'active'
    and private.current_user_can_read_shop(shop.id, p_resource)
$function$;

revoke all on function private.current_user_readable_shop_ids(text)
  from public, anon;
grant execute on function private.current_user_readable_shop_ids(text)
  to authenticated;

do $policies$
declare
  v_rule record;
begin
  for v_rule in
    select * from (values
      ('products', 'products'),
      ('product_items', 'products'),
      ('product_skus', 'products'),
      ('product_sku_items', 'products'),
      ('product_warehouse_shipping_limits', 'products'),
      ('pricing_results', 'pricing'),
      ('profit_calculations', 'pricing'),
      ('product_strategy_states', 'pricing'),
      ('warehouses', 'inventory'),
      ('warehouse_products', 'inventory'),
      ('warehouse_skus', 'inventory'),
      ('warehouse_sku_stock_adjustments', 'inventory'),
      ('warehouse_item_stocks', 'inventory'),
      ('warehouse_item_stock_adjustments', 'inventory'),
      ('purchase_orders', 'purchases'),
      ('purchase_order_items', 'purchases'),
      ('purchase_order_sources', 'purchases'),
      ('purchase_packages', 'purchases'),
      ('purchase_package_items', 'purchases'),
      ('temu_orders', 'orders'),
      ('temu_order_shipments', 'orders'),
      ('temu_order_shipment_items', 'orders'),
      ('temu_order_sku_inventory_reservations', 'orders'),
      ('temu_order_split_events', 'orders'),
      ('temu_order_combined_shipments', 'orders'),
      ('temu_order_combined_shipment_members', 'orders'),
      ('temu_order_file_import_templates', 'orders'),
      ('shipping_batches', 'orders'),
      ('shipping_batch_items', 'orders'),
      ('finance_actual_shipping_fee_import_templates', 'finance'),
      ('finance_actual_shipping_fees', 'finance'),
      ('finance_expenses', 'finance'),
      ('finance_first_leg_monthly_settlements', 'finance'),
      ('finance_first_leg_payments', 'finance'),
      ('finance_logistics_payments', 'finance'),
      ('finance_logistics_settlements', 'finance'),
      ('finance_settlement_files', 'finance'),
      ('finance_settlement_records', 'finance'),
      ('pricing_settings', 'settings'),
      ('logistics_methods', 'settings'),
      ('warehouse_logistics_methods', 'settings'),
      ('strategy_rule_settings', 'settings')
    ) as rules(table_name, resource)
  loop
    execute format('drop policy if exists mt_select on public.%I', v_rule.table_name);
    execute format(
      'create policy mt_select on public.%I for select to authenticated using (shop_id = any (((select private.current_user_readable_shop_ids(%L)))::uuid[]))',
      v_rule.table_name,
      v_rule.resource
    );
  end loop;
end
$policies$;
