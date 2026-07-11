import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuthenticatedClient,
  loadProjectEnv,
} from "./lib/authenticated-client.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = await loadProjectEnv(projectDir);
const { client } = await createAuthenticatedClient({
  supabaseUrl: env.VITE_SUPABASE_URL,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
  email: env.SUPABASE_SYNC_EMAIL || env.VITE_AUTO_LOGIN_EMAIL,
  password: env.SUPABASE_SYNC_PASSWORD || env.VITE_AUTO_LOGIN_PASSWORD,
  label: "订单分页 RPC 检查账号",
});

async function fetchPage(overrides = {}) {
  const { data, error } = await client.rpc("get_temu_orders_page", {
    p_page: 1,
    p_page_size: 20,
    p_search: "",
    p_stage: "all",
    p_warehouse_id: null,
    p_logistics_method: "",
    p_urgent_only: false,
    p_sort_key: "ship_deadline",
    p_sort_direction: "asc",
    p_now: new Date().toISOString(),
    ...overrides,
  });
  if (error) throw new Error(`订单分页 RPC 调用失败 ${error.code}: ${error.message}`);
  const row = data?.[0];
  if (!row || !Array.isArray(row.orders)) {
    throw new Error("订单分页 RPC 没有返回预期的 orders 数组。");
  }
  return row;
}

const firstPage = await fetchPage();
const counts = firstPage.stage_counts ?? {};
const stageTotal = [
  "pending_assignment",
  "new_order",
  "pending_shipping",
  "shipped",
  "uploaded_temu",
  "completed",
].reduce((total, stage) => total + Number(counts[stage] ?? 0), 0);

if (stageTotal !== Number(counts.all ?? 0)) {
  throw new Error(`阶段汇总不一致：各阶段 ${stageTotal}，全部 ${counts.all ?? 0}`);
}
const noMatch = await fetchPage({ p_search: `codex-no-match-${Date.now()}` });
if (Number(noMatch.total_count) !== 0 || noMatch.orders.length !== 0) {
  throw new Error("订单分页 RPC 的无匹配搜索仍返回了订单。");
}

if (Number(firstPage.total_count) > 20) {
  const secondPage = await fetchPage({ p_page: 2 });
  const firstOrderNos = new Set(firstPage.orders.map((order) => order.order_no));
  const duplicateGroup = secondPage.orders.find((order) => firstOrderNos.has(order.order_no));
  if (duplicateGroup) {
    throw new Error(`订单 ${duplicateGroup.order_no} 被拆分到了相邻分页。`);
  }
}

await client.auth.signOut();
console.log(
  `订单分页 RPC 检查通过：${firstPage.total_count} 行订单，${firstPage.total_line_count} 条明细。`,
);
