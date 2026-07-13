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
  label: "采购分页 RPC 检查账号",
});

async function fetchPage(overrides = {}) {
  const { data, error } = await client.rpc("get_purchase_orders_page", {
    p_page: 1,
    p_page_size: 20,
    p_search: "",
    ...overrides,
  });
  if (error) throw new Error(`采购分页 RPC 调用失败 ${error.code}: ${error.message}`);
  const row = data?.[0];
  if (!row || !Array.isArray(row.orders) || typeof row.summary !== "object") {
    throw new Error("采购分页 RPC 没有返回预期的 orders 和 summary。");
  }
  return row;
}

const firstPage = await fetchPage();
const summary = firstPage.summary ?? {};
const statusTotal = Number(summary.pendingOrderCount ?? 0)
  + Number(summary.partiallyReceivedOrderCount ?? 0)
  + Number(summary.receivedOrderCount ?? 0);
if (statusTotal !== Number(firstPage.total_count ?? 0)) {
  throw new Error(`采购状态汇总 ${statusTotal} 与总数 ${firstPage.total_count ?? 0} 不一致。`);
}
if (Number(summary.receivedPackageCount ?? 0) > Number(summary.packageCount ?? 0)) {
  throw new Error("已签收包裹数大于包裹总数。");
}

const noMatch = await fetchPage({ p_search: `codex-no-match-${Date.now()}` });
if (Number(noMatch.total_count) !== 0 || noMatch.orders.length !== 0) {
  throw new Error("采购分页 RPC 的无匹配搜索仍返回了记录。");
}

await client.auth.signOut();
console.log(`采购分页 RPC 检查通过：${firstPage.total_count} 张采购单。`);
