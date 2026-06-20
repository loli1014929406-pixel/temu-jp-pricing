import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");

const orderNos = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);

if (orderNos.length === 0) {
  throw new Error("请传入要修复的订单号，例如：node scripts/repair-half-matched-orders.mjs PO-100-xxx");
}

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
  return { ...parseEnv(contents), ...process.env };
}

function getOrderLineLabel(order) {
  const subOrderNo = String(order.sub_order_no ?? "").trim();
  return subOrderNo ? `${order.order_no} / ${subOrderNo}` : `${order.order_no} / ${order.id}`;
}

async function restoreOrderLineInventory(supabase, order) {
  const label = getOrderLineLabel(order);
  const outboundReasons = [`订单出库：${label}`, `出库：${label}`];
  const reversalReason = `删除订单冲回：${label}`;
  const reasons = [...outboundReasons, reversalReason];

  const { data: adjustments, error: adjustmentError } = await supabase
    .from("warehouse_item_stock_adjustments")
    .select("warehouse_id, item_id, change_quantity, reason")
    .in("reason", reasons);

  if (adjustmentError) throw adjustmentError;

  const netChangesByStock = new Map();
  for (const adjustment of adjustments ?? []) {
    const changeQuantity = Math.trunc(Number(adjustment.change_quantity) || 0);
    if (changeQuantity === 0) continue;

    const key = `${adjustment.warehouse_id}\u0000${adjustment.item_id}`;
    const current = netChangesByStock.get(key) ?? {
      warehouseId: adjustment.warehouse_id,
      itemId: adjustment.item_id,
      netChange: 0,
    };
    current.netChange += changeQuantity;
    netChangesByStock.set(key, current);
  }

  const restored = [];
  for (const stockChange of netChangesByStock.values()) {
    if (stockChange.netChange >= 0) continue;

    const restoreQuantity = -stockChange.netChange;
    const { data: currentData, error: currentError } = await supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .eq("warehouse_id", stockChange.warehouseId)
      .eq("item_id", stockChange.itemId)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!currentData) {
      throw new Error(`找不到仓库配件库存：warehouse=${stockChange.warehouseId}, item=${stockChange.itemId}`);
    }

    const nextQuantity = currentData.stock_quantity + restoreQuantity;
    const { data: nextData, error: nextError } = await supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: nextQuantity })
      .eq("id", currentData.id)
      .eq("stock_quantity", currentData.stock_quantity)
      .select("id, warehouse_id, item_id, stock_quantity")
      .maybeSingle();

    if (nextError) throw nextError;
    if (!nextData) throw new Error("库存已被其他操作更新，请重新运行修复。");

    const { error: insertError } = await supabase
      .from("warehouse_item_stock_adjustments")
      .insert({
        warehouse_id: currentData.warehouse_id,
        item_id: currentData.item_id,
        previous_quantity: currentData.stock_quantity,
        next_quantity: nextData.stock_quantity,
        change_quantity: restoreQuantity,
        reason: reversalReason,
        purchase_order_id: null,
        purchase_package_id: null,
      });

    if (insertError) throw insertError;

    restored.push({
      label,
      warehouseId: currentData.warehouse_id,
      itemId: currentData.item_id,
      quantity: restoreQuantity,
    });
  }

  return restored;
}

const env = await loadEnv();
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

if (!supabaseServiceRoleKey) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`登录失败：${error.message}`);
}

const { data: orders, error: orderError } = await supabase
  .from("temu_orders")
  .select("*")
  .in("order_no", orderNos);

if (orderError) throw orderError;

const ordersByNo = new Map();
for (const order of orders ?? []) {
  const group = ordersByNo.get(order.order_no) ?? [];
  group.push(order);
  ordersByNo.set(order.order_no, group);
}

for (const orderNo of orderNos) {
  const group = ordersByNo.get(orderNo) ?? [];
  if (group.length === 0) {
    console.log(`未找到订单：${orderNo}`);
    continue;
  }

  const assignedOrders = group.filter(
    (order) => order.warehouse_id || String(order.warehouse_name ?? "").trim(),
  );
  const unassignedOrders = group.filter(
    (order) => !order.warehouse_id && !String(order.warehouse_name ?? "").trim(),
  );
  const stagedOrders = group.filter(
    (order) =>
      String(order.label_printed_at ?? "").trim() ||
      String(order.logistics_tracking_no ?? "").trim() ||
      String(order.logistics_status ?? "").trim() ||
      String(order.actual_ship_time ?? "").trim() ||
      String(order.actual_signed_time ?? "").trim(),
  );

  if (assignedOrders.length === 0 && stagedOrders.length === 0) {
    console.log(`订单 ${orderNo} 已经是待分配，无需修复。`);
    continue;
  }

  if (assignedOrders.length > 0 && unassignedOrders.length === 0) {
    console.log(`订单 ${orderNo} 整单已分配，不属于半匹配，跳过。`);
    continue;
  }

  const restored = [];
  for (const order of assignedOrders) {
    restored.push(...await restoreOrderLineInventory(supabase, order));
  }

  const { data: updatedOrders, error: updateError } = await supabase
    .from("temu_orders")
    .update({
      order_status: "待发货",
      warehouse_id: null,
      warehouse_name: "",
      logistics_method: "",
      label_printed_at: "",
      logistics_tracking_no: "",
      logistics_status: "",
      actual_ship_time: "",
      actual_signed_time: "",
    })
    .in("id", group.map((order) => order.id))
    .select("id, order_no, sub_order_no, sku_code, product_attributes, warehouse_id, warehouse_name, logistics_method, order_status, label_printed_at, logistics_tracking_no, logistics_status, actual_ship_time, actual_signed_time");

  if (updateError) throw updateError;

  console.log(`订单 ${orderNo} 已退回待分配：${updatedOrders.length} 条明细。`);
  if (restored.length === 0) {
    console.log("  没有找到需要回补的库存流水。");
  } else {
    for (const item of restored) {
      console.log(`  回补库存 +${item.quantity}: ${item.label}`);
    }
  }
}
