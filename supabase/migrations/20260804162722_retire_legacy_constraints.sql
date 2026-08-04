-- Apply only after the tenant-mode cutover has remained stable and all
-- production smoke, isolation, inventory, finance, and RPC checks pass.

do $retirement_preflight$
begin
  if not exists (
    select 1
    from private.multitenant_runtime_state state
    where state.id = true
      and state.permission_mode = 'tenant'
  ) then
    raise exception 'legacy constraints cannot be retired before tenant cutover';
  end if;
end
$retirement_preflight$;

drop index if exists public.idx_temu_orders_team_order_line;
drop index if exists public.logistics_methods_name_unique;
alter table public.purchase_orders
  drop constraint if exists purchase_orders_order_code_key;
drop index if exists public.temu_order_shipments_order_package_uidx;
drop index if exists public.temu_order_combined_shipments_no_key;
drop index if exists public.warehouses_auto_match_priority_unique;
drop index if exists public.warehouses_name_exact_unique;
drop index if exists public.finance_actual_shipping_fee_templates_user_name_uidx;
drop index if exists public.finance_actual_shipping_fee_templates_user_system_uidx;
drop index if exists public.temu_order_file_import_templates_user_name_uidx;
drop index if exists public.temu_order_file_import_templates_user_system_uidx;

alter table public.finance_actual_shipping_fees
  drop constraint if exists finance_actual_shipping_fees_user_method_tracking_unique;
alter table public.finance_first_leg_monthly_settlements
  drop constraint if exists finance_first_leg_monthly_settlements_user_month_unique;
alter table public.finance_first_leg_payments
  drop constraint if exists finance_first_leg_payments_user_request_unique;
alter table public.finance_logistics_payments
  drop constraint if exists finance_logistics_payments_user_request_unique;
alter table public.finance_logistics_settlements
  drop constraint if exists finance_logistics_settlements_user_carrier_month_unique;
alter table public.finance_logistics_settlements
  drop constraint if exists finance_logistics_settlements_user_method_month_unique;
alter table public.pricing_settings
  drop constraint if exists pricing_settings_owner_unique;
alter table public.product_strategy_states
  drop constraint if exists product_strategy_states_owner_id_product_id_key;
alter table public.products
  drop constraint if exists products_owner_code_unique;
alter table public.shipping_batches
  drop constraint if exists shipping_batches_owner_code_unique;
alter table public.strategy_rule_settings
  drop constraint if exists strategy_rule_settings_owner_id_phase_key;
alter table public.temu_orders
  drop constraint if exists temu_orders_owner_id_order_no_sub_order_no_key;
alter table public.temu_order_combined_shipments
  drop constraint if exists temu_order_combined_shipments_combined_no_key;
