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

async function fetchAllOrderLines() {
  const first = await fetchPage({ p_page: 1, p_page_size: 100 });
  const pages = Math.max(1, Math.ceil(Number(first.total_count ?? 0) / 100));
  const rows = [...first.orders];
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchPage({ p_page: page, p_page_size: 100 });
    rows.push(...next.orders);
  }
  return rows;
}

async function fetchAllSettlementRows() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from("finance_settlement_records")
      .select("po_number,sales_reversal,freight_reversal")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`读取结算冲回记录失败 ${error.code}: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return rows;
}

function orderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizedPhone(value) {
  let digits = String(value ?? "").normalize("NFKC").replace(/[^0-9]/g, "");
  if (digits.startsWith("0081")) digits = digits.slice(4);
  else if (digits.startsWith("81")) digits = digits.slice(2);
  if (digits && !digits.startsWith("0")) digits = `0${digits}`;
  return digits;
}

function normalizedAddress(order) {
  return [
    order.province,
    order.city,
    order.district,
    order.address_line1,
    order.address_line2,
  ]
    .map((value) => String(value ?? ""))
    .join("")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Punctuation}]+/gu, "");
}

function buildExpectedCustomerStatuses(orderLines, settlementRows) {
  const orders = new Map();
  for (const order of orderLines) {
    const key = orderKey(order.order_no) || String(order.id ?? "");
    if (key && !orders.has(key)) orders.set(key, order);
  }

  const refundOrderKeys = new Set(
    settlementRows
      .filter(
        (row) =>
          Number(row.sales_reversal ?? 0) !== 0 ||
          Number(row.freight_reversal ?? 0) !== 0,
      )
      .map((row) => orderKey(row.po_number))
      .filter(Boolean),
  );

  const parent = new Map([...orders.keys()].map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = key;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const identityOwner = new Map();
  for (const [key, order] of orders) {
    const identities = [
      normalizedPhone(order.recipient_phone),
      normalizedAddress(order),
    ].filter(Boolean);
    identities.forEach((identity, index) => {
      const identityKey = `${index === 0 ? "phone" : "address"}:${identity}`;
      const existing = identityOwner.get(identityKey);
      if (existing) union(key, existing);
      else identityOwner.set(identityKey, key);
    });
  }

  const membersByRoot = new Map();
  for (const key of orders.keys()) {
    const root = find(key);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), key]);
  }

  const expected = new Map();
  for (const members of membersByRoot.values()) {
    const hasRefund = members.some((key) => refundOrderKeys.has(key));
    for (const key of members) {
      expected.set(
        key,
        refundOrderKeys.has(key)
          ? "refund_order"
          : hasRefund
            ? "refund_customer"
            : members.length > 1
              ? "repeat_customer"
              : "normal",
      );
    }
  }
  return expected;
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

const [allOrderLines, settlementRows] = await Promise.all([
  fetchAllOrderLines(),
  fetchAllSettlementRows(),
]);
const validCustomerStatuses = new Set([
  "normal",
  "repeat_customer",
  "refund_order",
  "refund_customer",
]);
const expectedCustomerStatuses = buildExpectedCustomerStatuses(
  allOrderLines,
  settlementRows,
);
const actualByOrder = new Map();
for (const order of allOrderLines) {
  const key = orderKey(order.order_no) || String(order.id ?? "");
  const status = String(order.customer_history_status ?? "");
  if (!validCustomerStatuses.has(status)) {
    throw new Error(`订单 ${order.order_no} 返回未知客户状态：${status || "空"}`);
  }
  const previous = actualByOrder.get(key);
  if (previous && previous !== status) {
    throw new Error(`订单 ${order.order_no} 的不同明细返回了不一致的客户状态。`);
  }
  actualByOrder.set(key, status);
  if (
    status === "refund_order" &&
    Number(order.customer_sales_reversal ?? 0) === 0 &&
    Number(order.customer_freight_reversal ?? 0) === 0
  ) {
    throw new Error(`退款订单 ${order.order_no} 没有返回销售或运费冲回金额。`);
  }
}

const customerStatusMismatches = [...expectedCustomerStatuses.entries()].filter(
  ([key, expected]) => actualByOrder.get(key) !== expected,
);
if (customerStatusMismatches.length > 0) {
  const sample = customerStatusMismatches
    .slice(0, 5)
    .map(([key, expected]) => `${key}: 期望 ${expected}，实际 ${actualByOrder.get(key)}`)
    .join("；");
  throw new Error(
    `客户历史状态与独立重算不一致，共 ${customerStatusMismatches.length} 单：${sample}`,
  );
}

const customerStatusCounts = [...actualByOrder.values()].reduce((counts, status) => {
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, {});

await client.auth.signOut();
console.log(
  `订单分页 RPC 检查通过：${firstPage.total_count} 行订单，${firstPage.total_line_count} 条明细；客户状态 ${JSON.stringify(customerStatusCounts)}。`,
);
