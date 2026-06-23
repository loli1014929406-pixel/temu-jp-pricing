import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const apply = process.argv.includes("--apply");

const sourceWarehouseAliases = ["苏州", "suzhou"];
const destinationWarehouseAliases = ["福冈", "福岡", "fukuoka", "fugang"];
const transferMetadataPartPrefix = "调拨数据：";

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
  return parseEnv(await readFile(path.join(projectDir, ".env"), "utf8"));
}

async function fetchAll(supabase, table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function skuStockKey(warehouseId, skuId) {
  return `${warehouseId}:${skuId}`;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function warehouseMatches(warehouse, aliases) {
  const name = normalizeText(warehouse?.name);
  return aliases.some((alias) => name.includes(normalizeText(alias)));
}

function isShippedOrder(order) {
  return Boolean(
    String(order.actual_ship_time ?? "").trim() ||
      String(order.logistics_tracking_no ?? "").trim(),
  );
}

function isTransferReason(reason) {
  return /^库存调拨(?:出库|入库)：/.test(String(reason ?? ""));
}

function transferDirection(reason) {
  if (String(reason ?? "").startsWith("库存调拨出库：")) return "out";
  if (String(reason ?? "").startsWith("库存调拨入库：")) return "in";
  return "";
}

function transferDetail(reason) {
  return String(reason ?? "").replace(/^库存调拨(?:出库|入库)：/, "");
}

function transferRoute(detail) {
  const route = detail.split(" / ")[0] ?? "";
  const [source = "", destination = ""] = route.split(" -> ").map((part) => part.trim());
  return { source, destination };
}

function addQuantity(map, key, quantity) {
  map.set(key, (map.get(key) ?? 0) + quantity);
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function getSkuQuantitiesFromPurchaseReceipts(orderItems, packageItems) {
  const receivedQtyByOrderItemId = new Map();
  for (const packageItem of packageItems) {
    const quantity = nonNegativeInteger(packageItem.quantity);
    if (quantity <= 0) continue;
    addQuantity(receivedQtyByOrderItemId, packageItem.order_item_id, quantity);
  }

  const componentGroupsBySkuId = new Map();
  for (const item of orderItems) {
    if (!item.sku_id || nonNegativeInteger(item.sku_quantity) <= 0) continue;
    if (!componentGroupsBySkuId.has(item.sku_id)) componentGroupsBySkuId.set(item.sku_id, new Map());
    const componentKey = item.item_id || item.id;
    const componentGroups = componentGroupsBySkuId.get(item.sku_id);
    const current = componentGroups.get(componentKey) ?? {
      receivedItemQty: 0,
      itemQtyOrdered: 0,
      skuQtyOrdered: 0,
    };
    current.receivedItemQty += receivedQtyByOrderItemId.get(item.id) ?? 0;
    current.itemQtyOrdered += nonNegativeInteger(item.quantity);
    current.skuQtyOrdered += nonNegativeInteger(item.sku_quantity);
    componentGroups.set(componentKey, current);
  }

  const skuQuantities = new Map();
  for (const [skuId, componentGroups] of componentGroupsBySkuId) {
    const possibleQuantities = [...componentGroups.values()].map((group) => {
      const { receivedItemQty, itemQtyOrdered, skuQtyOrdered } = group;
      const itemPerSku = skuQtyOrdered > 0 ? itemQtyOrdered / skuQtyOrdered : 1;
      return itemPerSku > 0 ? Math.floor(receivedItemQty / itemPerSku) : 0;
    });
    const skuQuantity = Math.min(...possibleQuantities);
    if (Number.isFinite(skuQuantity) && skuQuantity > 0) {
      skuQuantities.set(skuId, skuQuantity);
    }
  }

  return skuQuantities;
}

function parseTransferMetadata(detail) {
  const metadataPart = detail
    .split(" / ")
    .map((part) => part.trim())
    .find((part) => part.startsWith(transferMetadataPartPrefix));
  if (!metadataPart) return null;

  try {
    const parsed = JSON.parse(
      decodeURIComponent(metadataPart.slice(transferMetadataPartPrefix.length)),
    );
    return Array.isArray(parsed?.lines) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTransferSummarySkuLines(detail) {
  return detail
    .split(" / ")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !part.startsWith("调拨日期：") &&
        !part.startsWith("快递单号：") &&
        !part.startsWith(transferMetadataPartPrefix),
    )
    .slice(1)
    .join(" / ")
    .split("；")
    .map((part) => part.trim())
    .flatMap((part) => {
      const match = part.match(/(.+?)\s*x\s*(\d+)/i);
      if (!match) return [];
      const codes = [...match[1].matchAll(/\b[A-Za-z]+\d+(?:-\d+)?\b/g)].map(
        (codeMatch) => codeMatch[0],
      );
      const skuCode = codes.at(-1);
      return skuCode
        ? [
            {
              skuCode,
              quantity: nonNegativeInteger(match[2]),
            },
          ]
        : [];
    });
}

function getTransferSkuLines(detail, skusByCode) {
  const metadata = parseTransferMetadata(detail);
  if (metadata?.lines?.length) {
    return metadata.lines
      .map((line) => ({
        skuId: String(line.skuId ?? "").trim(),
        quantity: nonNegativeInteger(line.quantity),
      }))
      .filter((line) => line.skuId && line.quantity > 0);
  }

  return parseTransferSummarySkuLines(detail)
    .map((line) => {
      const sku = skusByCode.get(line.skuCode);
      return sku?.id
        ? {
            skuId: sku.id,
            quantity: line.quantity,
          }
        : null;
    })
    .filter(Boolean);
}

function buildExpectedInventory(data, suzhouWarehouse, fukuokaWarehouse) {
  const ordersById = byId(data.purchase_orders);
  const orderItemsById = byId(data.purchase_order_items);
  const skusByCode = new Map(data.product_skus.map((sku) => [sku.sku_code, sku]));
  const orderItemsByOrderId = data.purchase_order_items.reduce((groups, item) => {
    if (!groups.has(item.order_id)) groups.set(item.order_id, []);
    groups.get(item.order_id).push(item);
    return groups;
  }, new Map());

  const skuQuantityByKey = new Map();
  const legacyPurchaseReceiptItems = [];

  function addExpectedSku(warehouseId, skuId, quantity) {
    if (!warehouseId || !skuId || quantity === 0) return;
    addQuantity(skuQuantityByKey, skuStockKey(warehouseId, skuId), quantity);
  }

  const packageItemsByPackageId = data.purchase_package_items.reduce((groups, packageItem) => {
    if (!groups.has(packageItem.package_id)) groups.set(packageItem.package_id, []);
    groups.get(packageItem.package_id).push(packageItem);
    return groups;
  }, new Map());
  const receivedPackageItemsByOrderId = new Map();
  for (const pkg of data.purchase_packages) {
    if (!pkg || pkg.status !== "received") continue;

    const order = ordersById.get(pkg.order_id);
    if (!order || order.warehouse_id !== suzhouWarehouse.id) continue;

    for (const packageItem of packageItemsByPackageId.get(pkg.id) ?? []) {
      const orderItem = orderItemsById.get(packageItem.order_item_id);
      if (!orderItem) continue;
      if (!orderItem.sku_id || nonNegativeInteger(orderItem.sku_quantity) <= 0) {
        legacyPurchaseReceiptItems.push({
          order: order.order_code,
          package: pkg.tracking_no || pkg.id,
          product: orderItem.product_code,
          item: [orderItem.item_name, orderItem.item_spec].filter(Boolean).join(" / "),
          quantity: nonNegativeInteger(packageItem.quantity),
        });
        continue;
      }
      if (!receivedPackageItemsByOrderId.has(order.id)) {
        receivedPackageItemsByOrderId.set(order.id, []);
      }
      receivedPackageItemsByOrderId.get(order.id).push(packageItem);
    }
  }

  for (const [orderId, packageItems] of receivedPackageItemsByOrderId) {
    const order = ordersById.get(orderId);
    if (!order || order.warehouse_id !== suzhouWarehouse.id) continue;
    const skuQuantities = getSkuQuantitiesFromPurchaseReceipts(
      orderItemsByOrderId.get(orderId) ?? [],
      packageItems,
    );
    for (const [skuId, quantity] of skuQuantities) {
      addExpectedSku(suzhouWarehouse.id, skuId, quantity);
    }
  }

  const countedOrderIds = new Set();
  for (const order of data.temu_orders) {
    if (!isShippedOrder(order) || countedOrderIds.has(order.id)) continue;
    countedOrderIds.add(order.id);

    const sku = skusByCode.get(String(order.sku_code ?? "").trim());
    if (!sku?.id) continue;

    const warehouseId =
      order.warehouse_id === fukuokaWarehouse.id
        ? fukuokaWarehouse.id
        : order.warehouse_id === suzhouWarehouse.id
          ? suzhouWarehouse.id
          : "";
    if (!warehouseId) continue;

    addExpectedSku(warehouseId, sku.id, -nonNegativeInteger(order.fulfillment_quantity || 1));
  }

  const transferGroups = new Map();
  for (const adjustment of data.warehouse_item_stock_adjustments) {
    if (!isTransferReason(adjustment.reason)) continue;
    const detail = transferDetail(adjustment.reason);
    const { source, destination } = transferRoute(detail);
    if (
      !sourceWarehouseAliases.some((alias) => normalizeText(source).includes(normalizeText(alias))) ||
      !destinationWarehouseAliases.some((alias) =>
        normalizeText(destination).includes(normalizeText(alias)),
      )
    ) {
      continue;
    }

    const group = transferGroups.get(detail) ?? {
      hasOut: false,
      hasIn: false,
    };
    const direction = transferDirection(adjustment.reason);
    if (direction === "out") group.hasOut = true;
    if (direction === "in") group.hasIn = true;
    transferGroups.set(detail, group);
  }

  for (const [detail, group] of transferGroups) {
    const transferSkuLines = getTransferSkuLines(detail, skusByCode);
    for (const line of transferSkuLines) {
      if (group.hasOut) {
        addExpectedSku(suzhouWarehouse.id, line.skuId, -line.quantity);
      }
      if (group.hasIn) {
        addExpectedSku(fukuokaWarehouse.id, line.skuId, line.quantity);
      }
    }
  }

  for (const [key, quantity] of Array.from(skuQuantityByKey.entries())) {
    skuQuantityByKey.set(key, Math.max(0, quantity));
  }

  return { skuQuantityByKey, legacyPurchaseReceiptItems };
}

function buildUpdates(data, suzhouWarehouse, fukuokaWarehouse, expected) {
  const productsById = byId(data.products);
  const skusById = byId(data.product_skus);
  const skuRowsByKey = new Map(
    data.warehouse_skus.map((stock) => [skuStockKey(stock.warehouse_id, stock.sku_id), stock]),
  );
  if (expected.legacyPurchaseReceiptItems.length > 0) {
    return {
      itemInserts: [],
      itemUpdates: [],
      skuInserts: [],
      skuUpdates: [],
      itemChangeSummary: [],
      skuChangeSummary: [],
    };
  }

  for (const stock of data.warehouse_skus) {
    if (stock.warehouse_id === suzhouWarehouse.id || stock.warehouse_id === fukuokaWarehouse.id) {
      const key = skuStockKey(stock.warehouse_id, stock.sku_id);
      if (!expected.skuQuantityByKey.has(key)) {
        expected.skuQuantityByKey.set(key, 0);
      }
    }
  }

  const itemInserts = [];
  const itemUpdates = [];

  const skuInserts = [];
  const skuUpdates = [];
  for (const [key, expectedQuantity] of expected.skuQuantityByKey) {
    const [warehouseId, skuId] = key.split(":");
    const current = skuRowsByKey.get(key);
    const warehouse = warehouseId === suzhouWarehouse.id ? suzhouWarehouse : fukuokaWarehouse;
    const sku = skusById.get(skuId);
    if (!sku) continue;
    if (!current && expectedQuantity > 0) {
      skuInserts.push({
        warehouse_id: warehouseId,
        product_id: sku.product_id,
        sku_id: skuId,
        owner_id: warehouse.owner_id,
        stock_quantity: expectedQuantity,
      });
      continue;
    }
    if (current && nonNegativeInteger(current.stock_quantity) !== expectedQuantity) {
      skuUpdates.push({
        row: current,
        expectedQuantity,
      });
    }
  }

  function skuSummary(entry) {
    const row = entry.row ?? entry;
    const sku = skusById.get(row.sku_id);
    const product = productsById.get(row.product_id);
    const warehouse =
      row.warehouse_id === suzhouWarehouse.id ? suzhouWarehouse.name : fukuokaWarehouse.name;
    return {
      warehouse,
      product: product?.product_code ?? "",
      sku: sku?.sku_code ?? row.sku_id,
      before: entry.row ? nonNegativeInteger(entry.row.stock_quantity) : 0,
      after: entry.expectedQuantity ?? row.stock_quantity,
      diff: (entry.expectedQuantity ?? row.stock_quantity) -
        (entry.row ? nonNegativeInteger(entry.row.stock_quantity) : 0),
    };
  }

  return {
    itemInserts,
    itemUpdates,
    skuInserts,
    skuUpdates,
    itemChangeSummary: [],
    skuChangeSummary: [...skuInserts.map(skuSummary), ...skuUpdates.map(skuSummary)]
      .filter((row) => row.diff !== 0)
      .sort((left, right) =>
        left.warehouse.localeCompare(right.warehouse, "zh-CN", { numeric: true }) ||
        left.product.localeCompare(right.product, "zh-CN", { numeric: true }) ||
        left.sku.localeCompare(right.sku, "zh-CN", { numeric: true }),
      ),
  };
}

async function main() {
  const env = { ...(await loadEnv()), ...process.env };
  const supabaseUrl = env.VITE_SUPABASE_URL;
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const email = env.SUPABASE_SYNC_EMAIL || env.VITE_AUTO_LOGIN_EMAIL;
  const password = env.SUPABASE_SYNC_PASSWORD || env.VITE_AUTO_LOGIN_PASSWORD;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY");
  }
  if (!serviceRoleKey && (!email || !password)) {
    throw new Error("缺少 Supabase 登录信息");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!serviceRoleKey) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`登录失败：${error.message}`);
  }

  const tableNames = [
    "warehouses",
    "products",
    "product_skus",
    "warehouse_skus",
    "warehouse_item_stock_adjustments",
    "temu_orders",
    "purchase_orders",
    "purchase_order_items",
    "purchase_packages",
    "purchase_package_items",
  ];
  const data = Object.fromEntries(
    await Promise.all(tableNames.map(async (table) => [table, await fetchAll(supabase, table)])),
  );

  const suzhouWarehouse = data.warehouses.find((warehouse) =>
    warehouseMatches(warehouse, sourceWarehouseAliases),
  );
  const fukuokaWarehouse = data.warehouses.find((warehouse) =>
    warehouseMatches(warehouse, destinationWarehouseAliases),
  );
  if (!suzhouWarehouse || !fukuokaWarehouse) {
    throw new Error("找不到苏州或福冈仓库");
  }

  const expected = buildExpectedInventory(data, suzhouWarehouse, fukuokaWarehouse);
  const updates = buildUpdates(data, suzhouWarehouse, fukuokaWarehouse, expected);

  console.log(apply ? "开始按业务源表重算并写入库存：" : "库存重算 dry-run，不写数据库：");
  if (expected.legacyPurchaseReceiptItems.length > 0) {
    console.log(
      `发现 ${expected.legacyPurchaseReceiptItems.length} 条已签收采购明细缺少 SKU 信息，库存重算已暂停生成更新动作。`,
    );
    console.log("请先补齐这些历史采购明细的 sku_id/sku_quantity，再执行库存重算。");
    console.table(expected.legacyPurchaseReceiptItems.slice(0, 20));
    if (apply) {
      throw new Error("存在缺少 SKU 信息的已签收采购明细，已停止写入库存");
    }
  }
  console.log("配件库存不再作为重算目标。");
  console.log(`SKU库存新增：${updates.skuInserts.length}`);
  console.log(`SKU库存更新：${updates.skuUpdates.length}`);

  if (updates.skuChangeSummary.length > 0) {
    console.log("\nSKU库存变化：");
    console.table(updates.skuChangeSummary);
  } else {
    console.log("\nSKU库存无变化。");
  }

  if (!apply) return;

  const reason = `库存重算校准：采购签收-订单仓库发货-苏州调拨到福冈 / ${new Date().toISOString()}`;
  console.log(`校准原因：${reason}`);

  for (const row of updates.skuInserts) {
    const { error } = await supabase.from("warehouse_skus").insert(row);
    if (error) throw new Error(`warehouse_skus insert: ${error.message}`);
  }

  for (const update of updates.skuUpdates) {
    const { row, expectedQuantity } = update;
    const { error } = await supabase
      .from("warehouse_skus")
      .update({ stock_quantity: expectedQuantity })
      .eq("id", row.id);
    if (error) throw new Error(`warehouse_skus update: ${error.message}`);
  }

  console.log("库存重算写入完成。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
