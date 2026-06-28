import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "local-data");
const outputFile = path.join(outputDir, "codex-supabase-data.json");

const tables = [
  "account_permissions",
  "profiles",
  "products",
  "product_skus",
  "product_items",
  "product_sku_items",
  "product_strategy_states",
  "pricing_settings",
  "pricing_results",
  "profit_calculations",
  "strategy_rule_settings",
  "warehouses",
  "logistics_methods",
  "warehouse_logistics_methods",
  "warehouse_skus",
  "warehouse_item_stocks",
  "warehouse_item_stock_adjustments",
  "temu_orders",
  "purchase_orders",
  "purchase_order_sources",
  "purchase_order_items",
  "purchase_packages",
  "purchase_package_items",
  "finance_settlement_files",
  "finance_settlement_records",
];

function parseEnv(contents) {
  const env = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

async function loadEnv() {
  const envPath = path.join(projectDir, ".env");
  const contents = await readFile(envPath, "utf8");
  return parseEnv(contents);
}

async function fetchTable(supabase, table) {
  const pageSize = 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, to);

    if (error) {
      if (
        error.code === "42P01" ||
        error.code === "42501" ||
        error.code === "PGRST205" ||
        error.message.toLowerCase().includes("does not exist") ||
        error.message.toLowerCase().includes("permission denied")
      ) {
        return {
          rows,
          skipped: {
            table,
            reason: error.message,
          },
        };
      }

      throw new Error(`${table}: ${error.message}`);
    }

    rows.push(...data);

    if (data.length < pageSize) {
      return { rows, skipped: null };
    }
  }
}

function buildSummary(data) {
  return Object.fromEntries(
    Object.entries(data.tables).map(([table, rows]) => [table, rows.length]),
  );
}

const env = { ...(await loadEnv()), ...process.env };
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const email = env.SUPABASE_SYNC_EMAIL || env.VITE_AUTO_LOGIN_EMAIL;
const password = env.SUPABASE_SYNC_PASSWORD || env.VITE_AUTO_LOGIN_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY。");
}

if (!supabaseServiceRoleKey && (!email || !password)) {
  throw new Error("缺少 SUPABASE_SYNC_EMAIL 或 SUPABASE_SYNC_PASSWORD。");
}

const authMode = supabaseServiceRoleKey ? "service_role" : "authenticated_user";
const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey || supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

let signedInUser = null;

if (!supabaseServiceRoleKey) {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError) {
    throw new Error(`登录失败：${authError.message}`);
  }

  signedInUser = {
    id: authData.user.id,
    email: authData.user.email,
  };
}

const snapshot = {
  exported_at: new Date().toISOString(),
  auth_mode: authMode,
  user: signedInUser,
  tables: {},
  skipped_tables: [],
};

for (const table of tables) {
  const { rows, skipped } = await fetchTable(supabase, table);
  snapshot.tables[table] = rows;
  if (skipped) {
    snapshot.skipped_tables.push(skipped);
  }
}

snapshot.summary = buildSummary(snapshot);

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(`已同步到 ${outputFile}`);
console.log(`同步模式：${authMode}`);
console.table(snapshot.summary);
if (snapshot.skipped_tables.length > 0) {
  console.warn("以下表不存在或当前项目未启用，已跳过：");
  console.table(snapshot.skipped_tables);
}
