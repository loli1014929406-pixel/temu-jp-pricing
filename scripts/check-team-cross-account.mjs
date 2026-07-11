import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuthenticatedClient,
  loadProjectEnv,
} from "./lib/authenticated-client.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = await loadProjectEnv(projectDir);
const accountA = {
  email: env.TEAM_TEST_EMAIL_A || env.VITE_AUTO_LOGIN_EMAIL,
  password: env.TEAM_TEST_PASSWORD_A || env.VITE_AUTO_LOGIN_PASSWORD,
};
const accountB = {
  email: env.TEAM_TEST_EMAIL_B,
  password: env.TEAM_TEST_PASSWORD_B,
};

if (!accountA.email || !accountA.password || !accountB.email || !accountB.password) {
  const message =
    "跳过跨账号团队检查：请设置 TEAM_TEST_EMAIL_B 和 TEAM_TEST_PASSWORD_B（账号 A 默认使用本地登录账号）。";
  if (env.TEAM_TEST_REQUIRED === "1") throw new Error(message);
  console.log(message);
  process.exit(0);
}

const commonConfig = {
  supabaseUrl: env.VITE_SUPABASE_URL,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
};
const [a, b] = await Promise.all([
  createAuthenticatedClient({ ...commonConfig, ...accountA, label: "团队账号 A" }),
  createAuthenticatedClient({ ...commonConfig, ...accountB, label: "团队账号 B" }),
]);

if (a.user.id === b.user.id) {
  throw new Error("跨账号检查需要两个不同的登录账号。");
}

async function visibleIds(client, table) {
  const { data, error } = await client.from(table).select("id").order("id").limit(1000);
  if (error) throw new Error(`${table} 查询失败：${error.message}`);
  return new Set((data ?? []).map((row) => row.id));
}

for (const table of ["temu_orders", "purchase_orders", "purchase_packages"]) {
  const [idsA, idsB] = await Promise.all([
    visibleIds(a.client, table),
    visibleIds(b.client, table),
  ]);
  const shared = [...idsA].filter((id) => idsB.has(id));
  if (shared.length !== idsA.size || shared.length !== idsB.size) {
    throw new Error(
      `${table} 团队可见集合不一致：账号 A ${idsA.size} 条，账号 B ${idsB.size} 条，共同 ${shared.length} 条。`,
    );
  }
  console.log(`通过：${table}，共同可见 ${shared.length} 条。`);
}

for (const table of [
  "finance_expenses",
  "finance_settlement_files",
  "finance_settlement_records",
]) {
  const [idsA, idsB] = await Promise.all([
    visibleIds(a.client, table),
    visibleIds(b.client, table),
  ]);
  const leaked = [...idsA].filter((id) => idsB.has(id));
  if (leaked.length > 0) {
    throw new Error(`${table} 有 ${leaked.length} 条记录跨账号泄露。`);
  }
  console.log(`通过：${table} 保持账号隔离。`);
}

await Promise.all([a.client.auth.signOut(), b.client.auth.signOut()]);
console.log("跨账号团队数据检查完成（只读，未写入测试数据）。");
