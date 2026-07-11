import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(projectDir, relativePath), "utf8");
}

const [ordersSource, purchasesSource, migration] = await Promise.all([
  read("src/lib/orders.ts"),
  read("src/lib/purchases.ts"),
  read("supabase/migrations/20260711000001_share_team_operational_data.sql"),
]);

const errors = [];

if (/\.eq\(\s*["']owner_id["']/.test(ordersSource)) {
  errors.push("src/lib/orders.ts must not narrow team orders by owner_id");
}
if (/\.eq\(\s*["']owner_id["']/.test(purchasesSource)) {
  errors.push("src/lib/purchases.ts must not narrow team purchases by owner_id");
}
if (!ordersSource.includes('onConflict: "order_no,sub_order_no"')) {
  errors.push("Temu order imports must deduplicate across the team order line key");
}

for (const table of [
  "temu_orders",
  "purchase_orders",
  "purchase_order_sources",
  "purchase_order_items",
  "purchase_packages",
  "purchase_package_items",
]) {
  if (!migration.includes(`on public.${table} for select to authenticated`)) {
    errors.push(`${table} is missing its authenticated team select policy`);
  }
}

for (const financeTable of [
  "finance_expenses",
  "finance_settlement_files",
  "finance_settlement_records",
]) {
  if (new RegExp(`create\\s+policy[\\s\\S]*?on\\s+public\\.${financeTable}`, "i").test(migration)) {
    errors.push(`${financeTable} must remain outside the team-sharing migration`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `ERROR ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("团队运营数据口径检查通过：订单和采购共享，财务数据保持账号隔离。");
}
