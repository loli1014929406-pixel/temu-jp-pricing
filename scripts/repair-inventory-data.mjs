import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");

const tables = [
  "warehouses",
  "warehouse_skus",
  "warehouse_item_stocks",
  "warehouse_item_stock_adjustments",
  "products",
  "product_skus",
  "product_items",
  "product_sku_items",
  "temu_orders",
  "purchase_orders",
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
  const contents = await readFile(path.join(projectDir, ".env"), "utf8");
  return parseEnv(contents);
}

async function fetchTable(supabase, table) {
  const pageSize = 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);

    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

async function loadTables(supabase) {
  const entries = await Promise.all(
    tables.map(async (table) => [table, await fetchTable(supabase, table)]),
  );
  return Object.fromEntries(entries);
}

function mapById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function itemIdentity(productId, itemName, itemSpec) {
  return `${productId}\u0000${(itemName ?? "").trim()}\u0000${(itemSpec ?? "").trim()}`;
}

function stockKey(warehouseId, itemId) {
  return `${warehouseId}:${itemId}`;
}

function skuStockKey(warehouseId, skuId) {
  return `${warehouseId}:${skuId}`;
}

function normalizeSkuCode(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSalesSpec(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function getOrderNoKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getOrderLineKey(order) {
  const orderNo = getOrderNoKey(order.order_no);
  if (!orderNo) return "";

  const subOrderNo = String(order.sub_order_no ?? "").trim().toLowerCase();
  if (subOrderNo) return `${orderNo}\u0000${subOrderNo}`;

  return [
    orderNo,
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function getOrderLineLabel(order) {
  const subOrderNo = String(order.sub_order_no ?? "").trim();
  return subOrderNo
    ? `${order.order_no} / ${subOrderNo}`
    : `${String(order.order_no ?? "").trim()} / ${order.id}`;
}

function getOrderStage(order) {
  if (String(order.actual_signed_time ?? "").trim()) return "completed";
  const status = String(order.order_status ?? "").trim().toLowerCase();
  if (status === "上传temu" || status === "已上传temu") return "uploaded_temu";
  if (
    String(order.actual_ship_time ?? "").trim() ||
    String(order.logistics_tracking_no ?? "").trim()
  ) {
    return "shipped";
  }
  if (String(order.label_printed_at ?? "").trim()) return "pending_shipping";
  if (order.warehouse_id || String(order.warehouse_name ?? "").trim()) return "new_order";
  return "pending_assignment";
}

function isAssignedOrder(order) {
  return [
    "new_order",
    "pending_shipping",
    "shipped",
    "uploaded_temu",
    "completed",
  ].includes(getOrderStage(order));
}

function parseOutboundOrderIdentity(reason) {
  const text = String(reason ?? "").trim();
  const label =
    text.match(/^订单出库：(.+)$/)?.[1]?.trim() ||
    text.match(/^删除订单冲回：(.+)$/)?.[1]?.trim() ||
    "";
  if (!label) return { orderNo: "", orderLineKey: "" };

  const [orderNoText, subOrderNoText] = label.split(" / ").map((part) => part.trim());
  const orderNo = orderNoText || label;
  return {
    orderNo,
    orderLineKey: subOrderNoText ? `${orderNo} / ${subOrderNoText}` : "",
  };
}

function createEventMap() {
  return new Map();
}

function addEvent(events, key, event) {
  const current = events.get(key);
  if (current) {
    current.quantity += event.quantity;
    return;
  }
  events.set(key, { ...event });
}

function chunk(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

async function upsertRows(supabase, table, rows, options) {
  if (rows.length === 0 || dryRun) return;

  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from(table).upsert(part, options);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function insertRows(supabase, table, rows) {
  if (rows.length === 0 || dryRun) return;

  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from(table).insert(part);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function updateStockRows(supabase, rows) {
  if (rows.length === 0 || dryRun) return;

  for (const row of rows) {
    const { error } = await supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: row.stock_quantity })
      .eq("id", row.id)
      .eq("owner_id", row.owner_id);
    if (error) throw new Error(`warehouse_item_stocks: ${error.message}`);
  }
}

function summarizeStockChanges(stockUpdates, stocksByKey, itemById, productById) {
  return stockUpdates
    .map((update) => {
      const item = itemById.get(update.item_id);
      const product = productById.get(item?.product_id);
      const current = stocksByKey.get(stockKey(update.warehouse_id, update.item_id));
      return {
        product: product?.product_code ?? "",
        item: item?.item_name ?? update.item_id,
        before: current?.stock_quantity ?? 0,
        after: update.stock_quantity,
        diff: update.stock_quantity - (current?.stock_quantity ?? 0),
      };
    })
    .filter((row) => row.diff !== 0)
    .sort((left, right) =>
      left.product.localeCompare(right.product, "zh-CN", { numeric: true }) ||
      left.item.localeCompare(right.item, "zh-CN", { numeric: true }),
    );
}

const env = await loadEnv();
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const email = env.SUPABASE_SYNC_EMAIL;
const password = env.SUPABASE_SYNC_PASSWORD;

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

let data = await loadTables(supabase);
const warehouseById = mapById(data.warehouses);
const productById = mapById(data.products);
const itemById = mapById(data.product_items);
const orderItemById = mapById(data.purchase_order_items);
const purchaseOrderById = mapById(data.purchase_orders);
const packageById = mapById(data.purchase_packages);
const itemByIdentity = new Map(
  data.product_items.map((item) => [
    itemIdentity(item.product_id, item.item_name, item.item_spec),
    item,
  ]),
);
const skuByCode = new Map(
  data.product_skus.map((sku) => [normalizeSkuCode(sku.sku_code), sku]),
);
const linksBySkuId = data.product_sku_items.reduce((groups, link) => {
  if (!groups.has(link.sku_id)) groups.set(link.sku_id, []);
  groups.get(link.sku_id).push(link);
  return groups;
}, new Map());
const requiredProductIdsByWarehouse = new Map();
const requiredItemIdsByWarehouse = new Map();
const inboundEvents = createEventMap();
const outboundEvents = createEventMap();
const unresolvedPurchases = [];
const unresolvedOrders = [];

for (const packageItem of data.purchase_package_items) {
  const pkg = packageById.get(packageItem.package_id);
  if (!pkg || pkg.status !== "received") continue;

  const purchaseOrder = purchaseOrderById.get(pkg.order_id);
  const orderItem = orderItemById.get(packageItem.order_item_id);
  if (!purchaseOrder?.warehouse_id || !orderItem?.product_id) continue;

  const productItem = orderItem.item_id
    ? itemById.get(orderItem.item_id)
    : itemByIdentity.get(
        itemIdentity(orderItem.product_id, orderItem.item_name, orderItem.item_spec),
      );

  if (!productItem) {
    unresolvedPurchases.push({
      package: pkg.tracking_no,
      item: orderItem.item_name,
      product: productById.get(orderItem.product_id)?.product_code ?? orderItem.product_id,
    });
    continue;
  }

  addToSetMap(requiredProductIdsByWarehouse, purchaseOrder.warehouse_id, orderItem.product_id);
  addToSetMap(requiredItemIdsByWarehouse, purchaseOrder.warehouse_id, productItem.id);
  addEvent(
    inboundEvents,
    `${purchaseOrder.warehouse_id}:${productItem.id}:${pkg.id}`,
    {
      warehouse_id: purchaseOrder.warehouse_id,
      item_id: productItem.id,
      owner_id: purchaseOrder.owner_id,
      quantity: Math.max(0, Math.trunc(Number(packageItem.quantity) || 0)),
      purchase_order_id: purchaseOrder.id,
      purchase_package_id: pkg.id,
      reason: "采购入库恢复",
    },
  );
}

// 页面只在“待分配 -> 新订单”实时扣库存；这里仅用于补齐这些已分配订单缺失的历史出库流水。
for (const order of data.temu_orders) {
  if (!isAssignedOrder(order) || !order.warehouse_id) continue;

  const sku = skuByCode.get(normalizeSkuCode(order.sku_code));
  if (!sku) {
    unresolvedOrders.push({ order: order.order_no, sku: order.sku_code });
    continue;
  }

  const links = linksBySkuId.get(sku.id) ?? [];
  if (links.length === 0) {
    unresolvedOrders.push({ order: order.order_no, sku: order.sku_code, reason: "SKU 未维护配件" });
    continue;
  }

  addToSetMap(requiredProductIdsByWarehouse, order.warehouse_id, sku.product_id);
  const orderQuantity = Math.max(1, Math.trunc(Number(order.fulfillment_quantity) || 0));
  const orderLineLabel = getOrderLineLabel(order);

  for (const link of links) {
    const item = itemById.get(link.item_id);
    if (!item) continue;

    addToSetMap(requiredItemIdsByWarehouse, order.warehouse_id, link.item_id);
    addEvent(
      outboundEvents,
      `${order.warehouse_id}:${link.item_id}:${orderLineLabel}`,
      {
        warehouse_id: order.warehouse_id,
        item_id: link.item_id,
        owner_id: order.owner_id,
        quantity: Math.max(0, Math.trunc(Number(link.quantity) || 0)) * orderQuantity,
        order_no: order.order_no,
        order_line_key: orderLineLabel,
        reason: `订单出库：${orderLineLabel}`,
      },
    );
  }
}

for (const stock of data.warehouse_item_stocks) {
  const item = itemById.get(stock.item_id);
  if (!item) continue;

  addToSetMap(requiredItemIdsByWarehouse, stock.warehouse_id, stock.item_id);
  addToSetMap(requiredProductIdsByWarehouse, stock.warehouse_id, item.product_id);
}

for (const row of data.warehouse_skus) {
  addToSetMap(requiredProductIdsByWarehouse, row.warehouse_id, row.product_id);
}

if (unresolvedPurchases.length > 0 || unresolvedOrders.length > 0) {
  console.warn("有数据无法匹配，已跳过：");
  if (unresolvedPurchases.length > 0) console.table(unresolvedPurchases);
  if (unresolvedOrders.length > 0) console.table(unresolvedOrders);
}

const existingWarehouseSkuKeys = new Set(
  data.warehouse_skus.map((row) => skuStockKey(row.warehouse_id, row.sku_id)),
);
const skuRowsToInsert = [];
for (const [warehouseId, productIds] of requiredProductIdsByWarehouse) {
  const warehouse = warehouseById.get(warehouseId);
  if (!warehouse) continue;

  for (const productId of productIds) {
    for (const sku of data.product_skus.filter((item) => item.product_id === productId)) {
      const key = skuStockKey(warehouseId, sku.id);
      if (existingWarehouseSkuKeys.has(key)) continue;
      existingWarehouseSkuKeys.add(key);
      skuRowsToInsert.push({
        warehouse_id: warehouseId,
        product_id: productId,
        sku_id: sku.id,
        owner_id: warehouse.owner_id,
      });
    }
  }
}

const existingStockKeys = new Set(
  data.warehouse_item_stocks.map((row) => stockKey(row.warehouse_id, row.item_id)),
);
const stockRowsToInsert = [];
for (const [warehouseId, itemIds] of requiredItemIdsByWarehouse) {
  const warehouse = warehouseById.get(warehouseId);
  if (!warehouse) continue;

  for (const itemId of itemIds) {
    const key = stockKey(warehouseId, itemId);
    if (existingStockKeys.has(key)) continue;
    existingStockKeys.add(key);
    stockRowsToInsert.push({
      warehouse_id: warehouseId,
      item_id: itemId,
      owner_id: warehouse.owner_id,
      stock_quantity: 0,
    });
  }
}

await upsertRows(
  supabase,
  "warehouse_skus",
  skuRowsToInsert,
  { onConflict: "warehouse_id,sku_id", ignoreDuplicates: true },
);
await upsertRows(
  supabase,
  "warehouse_item_stocks",
  stockRowsToInsert,
  { onConflict: "warehouse_id,item_id", ignoreDuplicates: true },
);

if (!dryRun && stockRowsToInsert.length > 0) {
  data = await loadTables(supabase);
}

const stockRowsForComputation = dryRun
  ? [
      ...data.warehouse_item_stocks,
      ...stockRowsToInsert.map((row) => ({
        id: `dry-run:${row.warehouse_id}:${row.item_id}`,
        created_at: "",
        updated_at: "",
        ...row,
      })),
    ]
  : data.warehouse_item_stocks;
const stocksByKey = new Map(
  stockRowsForComputation.map((row) => [stockKey(row.warehouse_id, row.item_id), row]),
);
const runningStockByKey = new Map(
  stockRowsForComputation.map((row) => [
    stockKey(row.warehouse_id, row.item_id),
    row.stock_quantity,
  ]),
);
const existingInboundKeys = new Set(
  data.warehouse_item_stock_adjustments.flatMap((adjustment) =>
    adjustment.purchase_package_id
      ? [`${adjustment.warehouse_id}:${adjustment.item_id}:${adjustment.purchase_package_id}`]
      : [],
  ),
);
const existingOutboundLineKeys = new Set();
const existingOutboundLegacyCounts = new Map();
for (const adjustment of data.warehouse_item_stock_adjustments) {
  const identity = parseOutboundOrderIdentity(adjustment.reason);
  if (!identity.orderNo) continue;

  if (identity.orderLineKey) {
    existingOutboundLineKeys.add(
      `${adjustment.warehouse_id}:${adjustment.item_id}:${identity.orderLineKey}`,
    );
  } else {
    const key = `${adjustment.warehouse_id}:${adjustment.item_id}:${identity.orderNo}`;
    existingOutboundLegacyCounts.set(key, (existingOutboundLegacyCounts.get(key) ?? 0) + 1);
  }
}
const adjustmentRows = [];
const stockUpdateDrafts = new Map();

function applyStockChange(change) {
  if (change.change_quantity === 0) return;

  const key = stockKey(change.warehouse_id, change.item_id);
  const stock = stocksByKey.get(key);
  if (!stock) {
    throw new Error(`缺少库存行：${key}`);
  }

  const previous = runningStockByKey.get(key) ?? 0;
  const next = previous + change.change_quantity;
  if (next < 0) {
    const item = itemById.get(change.item_id);
    const sku = change.order_no ? `，订单 ${change.order_no}` : "";
    throw new Error(`库存不足，无法校准：${item?.item_name ?? change.item_id}${sku}`);
  }

  runningStockByKey.set(key, next);
  stockUpdateDrafts.set(key, {
    id: stock.id,
    warehouse_id: change.warehouse_id,
    item_id: change.item_id,
    owner_id: stock.owner_id,
    stock_quantity: next,
  });
  adjustmentRows.push({
    warehouse_id: change.warehouse_id,
    item_id: change.item_id,
    owner_id: stock.owner_id,
    previous_quantity: previous,
    next_quantity: next,
    change_quantity: change.change_quantity,
    reason: change.reason,
    purchase_order_id: change.purchase_order_id ?? null,
    purchase_package_id: change.purchase_package_id ?? null,
  });
}

function applyAdjustmentEvent(event) {
  if (event.quantity <= 0) return;

  applyStockChange({
    ...event,
    change_quantity: event.direction === "in" ? event.quantity : -event.quantity,
  });
}

for (const event of Array.from(inboundEvents.values())) {
  const key = `${event.warehouse_id}:${event.item_id}:${event.purchase_package_id}`;
  if (existingInboundKeys.has(key)) continue;
  applyAdjustmentEvent({ ...event, direction: "in" });
}

for (const event of Array.from(outboundEvents.values())) {
  const lineKey = `${event.warehouse_id}:${event.item_id}:${event.order_line_key}`;
  const legacyKey = `${event.warehouse_id}:${event.item_id}:${event.order_no}`;
  if (existingOutboundLineKeys.has(lineKey)) {
    continue;
  }

  const legacyCount = existingOutboundLegacyCounts.get(legacyKey) ?? 0;
  if (legacyCount > 0) {
    existingOutboundLegacyCounts.set(legacyKey, legacyCount - 1);
    continue;
  }

  applyAdjustmentEvent({ ...event, direction: "out" });
}

const validPurchaseOrderIds = new Set(data.purchase_orders.map((order) => order.id));
const validPurchasePackageIds = new Set(data.purchase_packages.map((pkg) => pkg.id));
const validTemuOrderNos = new Set(
  data.temu_orders.map((order) => String(order.order_no ?? "").trim()).filter(Boolean),
);
const validTemuOrderLineKeys = new Set(
  data.temu_orders.map((order) => getOrderLineLabel(order)).filter(Boolean),
);

const stalePurchaseChanges = new Map();
for (const adjustment of data.warehouse_item_stock_adjustments) {
  const purchaseOrderId = adjustment.purchase_order_id ?? "";
  const purchasePackageId = adjustment.purchase_package_id ?? "";
  if (!purchaseOrderId && !purchasePackageId) continue;

  const orderMissing = purchaseOrderId && !validPurchaseOrderIds.has(purchaseOrderId);
  const packageMissing = purchasePackageId && !validPurchasePackageIds.has(purchasePackageId);
  if (!orderMissing && !packageMissing) continue;

  const key = [
    adjustment.warehouse_id,
    adjustment.item_id,
    adjustment.owner_id,
    purchaseOrderId,
    purchasePackageId,
  ].join("\u0000");
  const current = stalePurchaseChanges.get(key) ?? {
    warehouse_id: adjustment.warehouse_id,
    item_id: adjustment.item_id,
    owner_id: adjustment.owner_id,
    purchase_order_id: purchaseOrderId || null,
    purchase_package_id: purchasePackageId || null,
    change_quantity: 0,
  };
  current.change_quantity += Number(adjustment.change_quantity) || 0;
  stalePurchaseChanges.set(key, current);
}

for (const staleChange of stalePurchaseChanges.values()) {
  if (staleChange.change_quantity === 0) continue;

  applyStockChange({
    ...staleChange,
    change_quantity: -staleChange.change_quantity,
    reason: "删除采购单冲回：已删除采购单",
  });
}

const staleOutboundChanges = new Map();
for (const adjustment of data.warehouse_item_stock_adjustments) {
  const identity = parseOutboundOrderIdentity(adjustment.reason);
  if (!identity.orderNo) continue;
  const isCurrentOrderLine = identity.orderLineKey
    ? validTemuOrderLineKeys.has(identity.orderLineKey)
    : validTemuOrderNos.has(identity.orderNo);
  if (isCurrentOrderLine) continue;

  const key = [
    adjustment.warehouse_id,
    adjustment.item_id,
    adjustment.owner_id,
    identity.orderLineKey || identity.orderNo,
  ].join("\u0000");
  const current = staleOutboundChanges.get(key) ?? {
    warehouse_id: adjustment.warehouse_id,
    item_id: adjustment.item_id,
    owner_id: adjustment.owner_id,
    order_no: identity.orderNo,
    order_line_key: identity.orderLineKey,
    change_quantity: 0,
  };
  current.change_quantity += Number(adjustment.change_quantity) || 0;
  staleOutboundChanges.set(key, current);
}

for (const staleChange of staleOutboundChanges.values()) {
  if (staleChange.change_quantity === 0) continue;

  applyStockChange({
    ...staleChange,
    change_quantity: -staleChange.change_quantity,
    reason: `删除订单冲回：${staleChange.order_line_key || staleChange.order_no}`,
  });
}

const stockUpdates = Array.from(stockUpdateDrafts.values()).filter((update) => {
  const current = stocksByKey.get(stockKey(update.warehouse_id, update.item_id));
  return current && current.stock_quantity !== update.stock_quantity;
});
const stockChangeSummary = summarizeStockChanges(
  stockUpdates,
  stocksByKey,
  itemById,
  productById,
);

console.log(dryRun ? "库存校准预览：" : "开始库存校准：");
console.log(`补齐仓库 SKU：${skuRowsToInsert.length}`);
console.log(`补齐配件库存行：${stockRowsToInsert.length}`);
console.log(`补齐库存流水：${adjustmentRows.length}`);
console.log(`更新库存数量：${stockUpdates.length}`);
if (stockChangeSummary.length > 0) console.table(stockChangeSummary);

await insertRows(supabase, "warehouse_item_stock_adjustments", adjustmentRows);
await updateStockRows(supabase, stockUpdates);

if (!dryRun) {
  console.log("库存校准完成。");
}
