import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "local-data");
const outputFile = path.join(outputDir, "codex-supabase-data.json");

const tables = [
  "products",
  "product_skus",
  "product_items",
  "product_sku_items",
  "pricing_settings",
  "pricing_results",
  "profit_calculations",
  "warehouses",
  "warehouse_skus",
  "warehouse_item_stocks",
  "warehouse_item_stock_adjustments",
  "purchase_orders",
  "purchase_order_sources",
  "purchase_order_items",
  "purchase_packages",
  "purchase_package_items",
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
      throw new Error(`${table}: ${error.message}`);
    }

    rows.push(...data);

    if (data.length < pageSize) {
      return rows;
    }
  }
}

function buildSummary(data) {
  return Object.fromEntries(
    Object.entries(data.tables).map(([table, rows]) => [table, rows.length]),
  );
}

const env = await loadEnv();
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;
const email = env.VITE_AUTO_LOGIN_EMAIL;
const password = env.VITE_AUTO_LOGIN_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY。");
}

if (!email || !password) {
  throw new Error("缺少 VITE_AUTO_LOGIN_EMAIL 或 VITE_AUTO_LOGIN_PASSWORD。");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);
const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
  email,
  password,
});

if (authError) {
  throw new Error(`登录失败：${authError.message}`);
}

const snapshot = {
  exported_at: new Date().toISOString(),
  user: {
    id: authData.user.id,
    email: authData.user.email,
  },
  tables: {},
};

for (const table of tables) {
  snapshot.tables[table] = await fetchTable(supabase, table);
}

snapshot.summary = buildSummary(snapshot);

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(`已同步到 ${outputFile}`);
console.table(snapshot.summary);
