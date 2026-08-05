import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(projectDir, "supabase", "migrations");
const cutoverName = "20260804112000_activate_multitenant_rls_cutover.sql";
const allowedPostCutoverNames = new Set([
  "20260805024500_optimize_multitenant_read_policies.sql",
  "20260805031018_restore_temu_tracking_worker_privileges.sql",
  "20260805034958_assign_enterprise_members_without_shop.sql",
]);
const requiredBusinessTables = [
  "products", "product_items", "product_skus", "product_sku_items",
  "product_warehouse_shipping_limits", "pricing_results", "profit_calculations",
  "product_strategy_states", "warehouses", "warehouse_products", "warehouse_skus",
  "warehouse_sku_stock_adjustments", "warehouse_item_stocks",
  "warehouse_item_stock_adjustments", "purchase_orders", "purchase_order_items",
  "purchase_order_sources", "purchase_packages", "purchase_package_items",
  "temu_orders", "temu_order_shipments", "temu_order_shipment_items",
  "temu_order_sku_inventory_reservations", "temu_order_split_events",
  "temu_order_combined_shipments", "temu_order_combined_shipment_members",
  "temu_order_file_import_templates", "shipping_batches", "shipping_batch_items",
  "finance_actual_shipping_fee_import_templates", "finance_actual_shipping_fees",
  "finance_expenses", "finance_first_leg_monthly_settlements",
  "finance_first_leg_payments", "finance_logistics_payments",
  "finance_logistics_settlements", "finance_settlement_files",
  "finance_settlement_records", "pricing_settings", "logistics_methods",
  "warehouse_logistics_methods", "strategy_rule_settings",
];
const requiredSharedTables = [
  "stock_locations", "shared_inventory_groups", "shared_inventory_group_members",
  "shared_inventory_balances", "shared_inventory_adjustments",
  "shared_inventory_membership_operations",
  "shared_inventory_membership_operation_lines",
];

function fail(message) {
  throw new Error(`多租户静态检查失败：${message}`);
}

const migrationNames = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const multitenantNames = migrationNames.filter((name) => name.includes("multitenant") ||
  /shared_inventory|enterprise_|scope_tracking/.test(name));
const cutoverPosition = multitenantNames.indexOf(cutoverName);
if (cutoverPosition < 0) fail("缺少最终权限切换迁移");
const unexpectedPostCutover = multitenantNames
  .slice(cutoverPosition + 1)
  .filter((name) => !allowedPostCutoverNames.has(name));
if (unexpectedPostCutover.length > 0) {
  fail(`最终权限切换之后存在未经确认的多租户迁移：${unexpectedPostCutover.join(", ")}`);
}

const cutover = await readFile(path.join(migrationsDir, cutoverName), "utf8");
const readPolicyOptimization = await readFile(
  path.join(migrationsDir, "20260805024500_optimize_multitenant_read_policies.sql"),
  "utf8",
);
for (const marker of [
  "current_user_readable_shop_ids",
  "shop_id = any",
  "current_user_can_read_shop",
]) {
  if (!readPolicyOptimization.includes(marker)) {
    fail(`读权限提速迁移缺少安全标记 ${marker}`);
  }
}
for (const table of requiredBusinessTables) {
  if (!cutover.includes(`('${table}',`)) fail(`权限矩阵遗漏业务表 ${table}`);
}
for (const table of requiredSharedTables) {
  if (!cutover.includes(`public.${table}`)) fail(`共享库存读取策略遗漏 ${table}`);
}
for (const marker of [
  "current_user_can_read_shop",
  "current_user_has_shop_action",
  "public.current_account_can_edit()",
  "public.current_account_can_delete()",
  "public.current_account_permission()",
  "$security_manifest$",
  "security_invoker=true",
  "permission_mode = 'tenant'",
]) {
  if (!cutover.includes(marker)) fail(`最终切换缺少安全标记 ${marker}`);
}

const orders = await readFile(path.join(projectDir, "src", "lib", "orders.ts"), "utf8");
if (/onConflict:\s*["']order_no,sub_order_no["']/.test(orders)) {
  fail("订单导入仍使用跨店铺全局唯一键");
}
if (!orders.includes('onConflict: "shop_id,order_no,sub_order_no"')) {
  fail("订单导入没有使用店铺维度唯一键");
}

const pageShell = await readFile(
  path.join(projectDir, "src", "components", "page-shell.tsx"),
  "utf8",
);
if (!pageShell.includes('<Outlet key={tenant.currentShop?.id ?? "platform-all-shops"}')) {
  fail("店铺切换不会强制卸载旧页面请求与状态");
}

const syncSource = await readFile(
  path.join(projectDir, "scripts", "sync-codex-data.mjs"),
  "utf8",
);
for (const table of [
  ...requiredBusinessTables,
  ...requiredSharedTables,
  "enterprises", "shops", "platform_members", "enterprise_members",
  "shop_operator_assignments", "permission_catalog", "shop_operator_permissions",
]) {
  if (!syncSource.includes(`"${table}"`)) fail(`离线快照清单遗漏 ${table}`);
}

console.log(
  `多租户静态检查通过：${requiredBusinessTables.length} 张业务表、` +
    `${requiredSharedTables.length} 张共享库存表及前端店铺作用域均已覆盖。`,
);
