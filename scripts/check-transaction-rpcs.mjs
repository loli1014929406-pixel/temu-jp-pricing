import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fileEnv = parseEnv(await readFile(path.join(projectDir, ".env"), "utf8"));
const env = { ...fileEnv, ...process.env };
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;
const email = env.SUPABASE_SYNC_EMAIL || env.VITE_AUTO_LOGIN_EMAIL;
const password = env.SUPABASE_SYNC_PASSWORD || env.VITE_AUTO_LOGIN_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey || !email || !password) {
  throw new Error("缺少 Supabase URL、anon key 或同步账号配置。");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
if (authError) throw new Error(`RPC 检查登录失败：${authError.message}`);

const checks = [
  {
    name: "create_purchase_order_atomic",
    args: {
      p_warehouse_id: null,
      p_warehouse_name: "",
      p_purchased_at: null,
      p_notes: "",
      p_sources: [],
      p_items: [],
    },
  },
  {
    name: "create_purchase_package",
    args: {
      p_order_id: null,
      p_source_id: null,
      p_tracking_no: "",
      p_items: [],
    },
  },
  {
    name: "update_purchase_source_atomic",
    args: {
      p_source_id: null,
      p_alibaba_order_no: "",
      p_freight_rmb: -1,
    },
  },
  {
    name: "transfer_warehouse_sku_inventory_atomic",
    args: {
      p_source_warehouse_id: null,
      p_reason: "",
      p_lines: [],
    },
  },
  {
    name: "receive_warehouse_sku_transfer_atomic",
    args: {
      p_destination_warehouse_id: null,
      p_reason: "",
      p_lines: [],
    },
  },
];

for (const check of checks) {
  const { error } = await supabase.rpc(check.name, check.args);
  if (!error) {
    throw new Error(`${check.name} 未拒绝无效参数，检查已停止。`);
  }
  if (error.code === "PGRST202" || error.code === "42883") {
    throw new Error(`${check.name} 未在 PostgREST 中找到：${error.message}`);
  }
  if (error.code !== "22023") {
    throw new Error(`${check.name} 返回了非预期错误 ${error.code}: ${error.message}`);
  }
  console.log(`通过：${check.name}`);
}

await supabase.auth.signOut();
console.log("事务 RPC 健康检查完成（未写入业务数据）。");
