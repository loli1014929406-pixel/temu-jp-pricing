import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
const dryRun = process.argv.includes("--dry-run");

if (showHelp) {
  console.log("用法：node scripts/repair-inventory-data.mjs [--dry-run]");
  console.log("--dry-run  只预览库存校准，不写入 Supabase");
  process.exit(0);
}

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
    text.match(/^出库：(.+)$/)?.[1]?.trim() ||
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

async function updateWarehouseSkuRows(supabase, rows) {
  if (rows.length === 0 || dryRun) return;

  for (const row of rows) {
    const { error } = await supabase
      .from("warehouse_skus")
      .update({ stock_quantity: row.stock_quantity })
      .eq("id", row.id)
      .eq("owner_id", row.owner_id);
    if (error) throw new Error(`warehouse_skus: ${error.message}`);
  }
}

async function updatePurchaseOrderItemRows(supabase, rows) {
  if (rows.length === 0 || dryRun) return;

  for (const row of rows) {
    const { data, error } = await supabase
      .from("purchase_order_items")
      .update({ item_id: row.item_id })
      .eq("id", row.id)
      .eq("owner_id", row.owner_id)
      .is("item_id", null)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`purchase_order_items: ${error.message}`);
    if (!data) throw new Error(`purchase_order_items: 未能回写采购明细 ${row.id}`);
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
const purchaseItemIdUpdates = new Map();
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
  if (!orderItem.item_id) {
    purchaseItemIdUpdates.set(orderItem.id, {
      id: orderItem.id,
      owner_id: orderItem.owner_id,
      item_id: productItem.id,
    });
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

if (!dryRun && (stockRowsToInsert.length > 0 || skuRowsToInsert.length > 0)) {
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
const runningLedgerByKey = new Map(
  stockRowsForComputation.map((row) => [stockKey(row.warehouse_id, row.item_id), 0]),
);
for (const adjustment of data.warehouse_item_stock_adjustments) {
  const key = stockKey(adjustment.warehouse_id, adjustment.item_id);
  runningLedgerByKey.set(
    key,
    (runningLedgerByKey.get(key) ?? 0) + Math.trunc(Number(adjustment.change_quantity) || 0),
  );
}
const existingInboundQuantities = new Map();
const existingInboundLegacyQuantities = new Map();
const existingOutboundLineKeys = new Set();
const existingOutboundLegacyCounts = new Map();
const assignedTemuOrders = data.temu_orders.filter(
  (order) => isAssignedOrder(order) && order.warehouse_id,
);
const validTemuOrderNos = new Set(
  assignedTemuOrders.map((order) => String(order.order_no ?? "").trim()).filter(Boolean),
);
const validTemuOrderLineKeys = new Set(
  assignedTemuOrders.map((order) => getOrderLineLabel(order)).filter(Boolean),
);
for (const adjustment of data.warehouse_item_stock_adjustments) {
  const reason = String(adjustment.reason ?? "").trim();
  const purchaseOrderId = adjustment.purchase_order_id ?? "";
  const purchasePackageId = adjustment.purchase_package_id ?? "";
  const changeQuantity = Math.trunc(Number(adjustment.change_quantity) || 0);

  if (purchasePackageId && reason.startsWith("采购入库") && changeQuantity > 0) {
    const key = `${adjustment.warehouse_id}:${adjustment.item_id}:${purchasePackageId}`;
    existingInboundQuantities.set(
      key,
      (existingInboundQuantities.get(key) ?? 0) + changeQuantity,
    );
  }

  if (
    purchaseOrderId &&
    !purchasePackageId &&
    reason.startsWith("采购入库") &&
    changeQuantity > 0
  ) {
    const key = `${adjustment.warehouse_id}:${adjustment.item_id}:${purchaseOrderId}`;
    existingInboundLegacyQuantities.set(
      key,
      (existingInboundLegacyQuantities.get(key) ?? 0) + changeQuantity,
    );
  }

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
const statsByStockKey = new Map();

function getStockStats(warehouseId, itemId) {
  const key = stockKey(warehouseId, itemId);
  if (!statsByStockKey.has(key)) {
    const stockRow = stocksByKey.get(key);
    statsByStockKey.set(key, {
      warehouseId,
      itemId,
      current: stockRow?.stock_quantity ?? 0,
      expected: 0,
      diff: 0,
      purchaseInbound: 0,
      orderOutbound: 0,
      transferIn: 0,
      transferOut: 0,
      manualAdjustment: 0,
    });
  }
  return statsByStockKey.get(key);
}

for (const event of inboundEvents.values()) {
  getStockStats(event.warehouse_id, event.item_id).purchaseInbound += event.quantity;
}

for (const event of outboundEvents.values()) {
  getStockStats(event.warehouse_id, event.item_id).orderOutbound += event.quantity;
}

for (const adjustment of data.warehouse_item_stock_adjustments) {
  const reason = String(adjustment.reason ?? "").trim();
  const quantity = Number(adjustment.change_quantity) || 0;
  const stats = getStockStats(adjustment.warehouse_id, adjustment.item_id);

  if (reason.startsWith("库存调拨入库：")) {
    stats.transferIn += quantity;
  } else if (reason.startsWith("库存调拨出库：")) {
    stats.transferOut += quantity;
  } else {
    let isAuto = false;

    if (adjustment.purchase_order_id || adjustment.purchase_package_id) {
      isAuto = true;
    } else if (
      reason.startsWith("删除订单冲回：") || 
      reason.startsWith("删除采购单冲回：") || 
      reason.startsWith("库存重算校准") || 
      reason.startsWith("库存校准：按有效采购和订单重算")
    ) {
      isAuto = true;
    } else {
      const identity = parseOutboundOrderIdentity(reason);
      if (identity.orderNo) {
        const isCurrentOrderLine = identity.orderLineKey
          ? validTemuOrderLineKeys.has(identity.orderLineKey)
          : validTemuOrderNos.has(identity.orderNo);
        
        if (isCurrentOrderLine) {
          isAuto = true;
        } else if (identity.orderNo.toLowerCase().startsWith("po-")) {
          isAuto = true;
        }
      }
    }

    if (!isAuto) {
      stats.manualAdjustment += quantity;
    }
  }
}

const adjustmentRows = [];
const stockUpdateDrafts = new Map();

for (const stats of statsByStockKey.values()) {
  stats.expected =
    stats.purchaseInbound -
    stats.orderOutbound +
    stats.transferIn +
    stats.transferOut +
    stats.manualAdjustment;
  stats.diff = stats.expected - stats.current;

  if (stats.expected < 0) {
    const item = itemById.get(stats.itemId);
    const warehouse = warehouseById.get(stats.warehouseId);
    console.error(`\n🚨 致命错误: 库存重算结果为负数！无法继续执行。`);
    console.table([{
      warehouse: warehouse?.name ?? stats.warehouseId,
      item: item?.item_name ?? stats.itemId,
      current: stats.current,
      expected: stats.expected,
      diff: stats.diff,
      purchaseInbound: stats.purchaseInbound,
      orderOutbound: stats.orderOutbound,
      transferIn: stats.transferIn,
      transferOut: stats.transferOut,
      manualAdjustment: stats.manualAdjustment,
    }]);
    throw new Error(
      `库存重算结果为负数，请先检查超卖订单或缺失的采购记录：${item?.item_name ?? stats.itemId}`,
    );
  }

  if (stats.diff !== 0) {
    const stockRow = stocksByKey.get(stockKey(stats.warehouseId, stats.itemId));
    const ownerId = stockRow?.owner_id || warehouseById.get(stats.warehouseId)?.owner_id || null;
    
    // 防御性校验，防范 current < 0 导致 previous_quantity < 0
    const previousQty = Math.max(0, stats.current);
    const nextQty = stats.expected; // 上面已拦截负数，必 >= 0
    const changeQty = nextQty - previousQty;

    // 即便因为 Math.max 导致 changeQty === 0，由于我们要修复底层负数库存行，所以 diff != 0 依旧触发
    adjustmentRows.push({
      warehouse_id: stats.warehouseId,
      item_id: stats.itemId,
      owner_id: ownerId, 
      previous_quantity: previousQty,
      next_quantity: nextQty,
      change_quantity: changeQty, // 使用严谨计算后的差额，不直接用 diff
      reason: "库存重算校准",
      purchase_order_id: null,
      purchase_package_id: null,
    });

    stockUpdateDrafts.set(stockKey(stats.warehouseId, stats.itemId), {
      id: stockRow?.id,
      warehouse_id: stats.warehouseId,
      item_id: stats.itemId,
      owner_id: ownerId,
      stock_quantity: stats.expected,
    });
  }
}

const stockUpdates = Array.from(stockUpdateDrafts.values()).filter(update => update.id); 

const expectedItemQuantityByKey = new Map(
  Array.from(statsByStockKey.values()).map((stats) => [
    stockKey(stats.warehouseId, stats.itemId),
    stats.expected,
  ]),
);
const skuRowsForComputation = dryRun
  ? [
      ...data.warehouse_skus,
      ...skuRowsToInsert.map((row) => ({
        id: `dry-run:${row.warehouse_id}:${row.sku_id}`,
        created_at: "",
        updated_at: "",
        stock_quantity: 0,
        ...row,
      })),
    ]
  : data.warehouse_skus;
const skuUpdates = [];

for (const warehouseSku of skuRowsForComputation) {
  const links = linksBySkuId.get(warehouseSku.sku_id) ?? [];
  if (links.length === 0) continue;

  const possibleQuantities = links.flatMap((link) => {
    const linkQuantity = Math.max(0, Math.trunc(Number(link.quantity) || 0));
    if (linkQuantity <= 0) return [];

    const itemQuantity =
      expectedItemQuantityByKey.get(stockKey(warehouseSku.warehouse_id, link.item_id)) ??
      stocksByKey.get(stockKey(warehouseSku.warehouse_id, link.item_id))?.stock_quantity ??
      0;
    return [Math.floor(itemQuantity / linkQuantity)];
  });
  if (possibleQuantities.length === 0) continue;

  const expectedSkuQuantity = Math.max(0, Math.min(...possibleQuantities));
  if (Math.trunc(Number(warehouseSku.stock_quantity) || 0) === expectedSkuQuantity) continue;

  skuUpdates.push({
    id: warehouseSku.id,
    warehouse_id: warehouseSku.warehouse_id,
    product_id: warehouseSku.product_id,
    sku_id: warehouseSku.sku_id,
    owner_id: warehouseSku.owner_id,
    stock_quantity: expectedSkuQuantity,
  });
}

const stockChangeSummary = Array.from(statsByStockKey.values())
  .filter(stats => stats.diff !== 0)
  .map(stats => {
    const item = itemById.get(stats.itemId);
    const product = productById.get(item?.product_id);
    const warehouse = warehouseById.get(stats.warehouseId);
    return {
      warehouse: warehouse?.name ?? stats.warehouseId,
      product: product?.product_code ?? "",
      item: item?.item_name ?? stats.itemId,
      current: stats.current,
      expected: stats.expected,
      diff: stats.diff,
      purchaseInbound: stats.purchaseInbound,
      orderOutbound: stats.orderOutbound,
      transferIn: stats.transferIn,
      transferOut: stats.transferOut,
      manualAdjustment: stats.manualAdjustment,
    };
  })
  .sort((left, right) =>
    left.product.localeCompare(right.product, "zh-CN", { numeric: true }) ||
    left.item.localeCompare(right.item, "zh-CN", { numeric: true }),
  );

const skuById = mapById(data.product_skus);
const skuChangeSummary = skuUpdates
  .map((update) => {
    const sku = skuById.get(update.sku_id);
    const product = productById.get(update.product_id);
    const warehouse = warehouseById.get(update.warehouse_id);
    const current = skuRowsForComputation.find((row) => row.id === update.id);
    return {
      warehouse: warehouse?.name ?? update.warehouse_id,
      product: product?.product_code ?? "",
      sku: sku?.sku_code ?? update.sku_id,
      before: current?.stock_quantity ?? 0,
      after: update.stock_quantity,
      diff: update.stock_quantity - (current?.stock_quantity ?? 0),
    };
  })
  .filter((row) => row.diff !== 0)
  .sort((left, right) =>
    left.warehouse.localeCompare(right.warehouse, "zh-CN", { numeric: true }) ||
    left.product.localeCompare(right.product, "zh-CN", { numeric: true }) ||
    left.sku.localeCompare(right.sku, "zh-CN", { numeric: true }),
  );

console.log(dryRun ? "库存重算校准预览：" : "开始库存校准：");
console.log(`补齐仓库 SKU：${skuRowsToInsert.length}`);
console.log(`补齐配件库存行：${stockRowsToInsert.length}`);
console.log(`回写采购明细配件：${purchaseItemIdUpdates.size}`);
console.log(`将插入的校准流水：${adjustmentRows.length}`);
console.log(`将更新的库存数量：${stockUpdates.length}`);
console.log(`将回填的 SKU 库存数量：${skuUpdates.length}`);

if (stockChangeSummary.length > 0) {
    console.table(stockChangeSummary);
} else {
    console.log("所有配件库存账实相符，无需校准。");
}
if (skuChangeSummary.length > 0) {
  console.log("SKU 库存回填预览：");
  console.table(skuChangeSummary);
} else {
  console.log("所有 SKU 库存无需回填。");
}

if (!dryRun) {
  await updatePurchaseOrderItemRows(supabase, Array.from(purchaseItemIdUpdates.values()));
  await insertRows(supabase, "warehouse_item_stock_adjustments", adjustmentRows);
  await updateStockRows(supabase, stockUpdates);
  await updateWarehouseSkuRows(supabase, skuUpdates);
  console.log("库存校准完成。");
}
