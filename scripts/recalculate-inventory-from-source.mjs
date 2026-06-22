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

function stockKey(warehouseId, itemId) {
  return `${warehouseId}:${itemId}`;
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

function inferSkuQuantitiesFromItems(itemQuantityById, skus, linksBySkuId) {
  const remainingItemQuantityById = new Map(itemQuantityById);
  const skuQuantityById = new Map();
  const candidateSkus = [...skus].sort((left, right) => {
    const leftLinks = linksBySkuId.get(left.id) ?? [];
    const rightLinks = linksBySkuId.get(right.id) ?? [];
    return (
      rightLinks.length - leftLinks.length ||
      String(left.sku_code ?? "").localeCompare(String(right.sku_code ?? ""), "zh-CN", {
        numeric: true,
      })
    );
  });

  for (const sku of candidateSkus) {
    const links = linksBySkuId.get(sku.id) ?? [];
    if (links.length === 0) continue;

    const possibleQuantities = links.flatMap((link) => {
      const perSkuQuantity = nonNegativeInteger(link.quantity);
      if (perSkuQuantity <= 0) return [];
      const itemQuantity = remainingItemQuantityById.get(link.item_id) ?? 0;
      return [Math.floor(itemQuantity / perSkuQuantity)];
    });
    if (possibleQuantities.length !== links.length) continue;

    const skuQuantity = Math.min(...possibleQuantities);
    if (skuQuantity <= 0) continue;

    skuQuantityById.set(sku.id, (skuQuantityById.get(sku.id) ?? 0) + skuQuantity);
    for (const link of links) {
      const perSkuQuantity = nonNegativeInteger(link.quantity);
      remainingItemQuantityById.set(
        link.item_id,
        (remainingItemQuantityById.get(link.item_id) ?? 0) - perSkuQuantity * skuQuantity,
      );
    }
  }

  return skuQuantityById;
}

function buildExpectedInventory(data, suzhouWarehouse, fukuokaWarehouse) {
  const ordersById = byId(data.purchase_orders);
  const packagesById = byId(data.purchase_packages);
  const orderItemsById = byId(data.purchase_order_items);
  const skusByCode = new Map(data.product_skus.map((sku) => [sku.sku_code, sku]));
  const linksBySkuId = data.product_sku_items.reduce((groups, link) => {
    if (!groups.has(link.sku_id)) groups.set(link.sku_id, []);
    groups.get(link.sku_id).push(link);
    return groups;
  }, new Map());

  const skuQuantityByKey = new Map();

  function addExpectedSku(warehouseId, skuId, quantity) {
    if (!warehouseId || !skuId || quantity === 0) return;
    addQuantity(skuQuantityByKey, skuStockKey(warehouseId, skuId), quantity);
  }

  const packageItemsByPackageId = data.purchase_package_items.reduce((groups, packageItem) => {
    if (!groups.has(packageItem.package_id)) groups.set(packageItem.package_id, []);
    groups.get(packageItem.package_id).push(packageItem);
    return groups;
  }, new Map());
  for (const pkg of data.purchase_packages) {
    if (!pkg || pkg.status !== "received") continue;

    const order = ordersById.get(pkg.order_id);
    if (!order || order.warehouse_id !== suzhouWarehouse.id) continue;

    const itemQuantityById = new Map();
    for (const packageItem of packageItemsByPackageId.get(pkg.id) ?? []) {
      const orderItem = orderItemsById.get(packageItem.order_item_id);
      if (!orderItem?.item_id) continue;

      addQuantity(
        itemQuantityById,
        orderItem.item_id,
        nonNegativeInteger(packageItem.quantity),
      );
    }

    const inferredSkuQuantities = inferSkuQuantitiesFromItems(
      itemQuantityById,
      data.product_skus,
      linksBySkuId,
    );
    for (const [skuId, quantity] of inferredSkuQuantities) {
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

  const itemQuantityByKey = new Map();
  for (const [key, skuQuantity] of skuQuantityByKey) {
    const [warehouseId, skuId] = key.split(":");
    for (const link of linksBySkuId.get(skuId) ?? []) {
      addQuantity(
        itemQuantityByKey,
        stockKey(warehouseId, link.item_id),
        nonNegativeInteger(link.quantity) * skuQuantity,
      );
    }
  }

  return { skuQuantityByKey, itemQuantityByKey, linksBySkuId };
}

function buildUpdates(data, suzhouWarehouse, fukuokaWarehouse, expected) {
  const productsById = byId(data.products);
  const itemsById = byId(data.product_items);
  const skusById = byId(data.product_skus);
  const stocksByKey = new Map(
    data.warehouse_item_stocks.map((stock) => [stockKey(stock.warehouse_id, stock.item_id), stock]),
  );
  const skuRowsByKey = new Map(
    data.warehouse_skus.map((stock) => [skuStockKey(stock.warehouse_id, stock.sku_id), stock]),
  );

  for (const stock of data.warehouse_skus) {
    if (stock.warehouse_id === suzhouWarehouse.id || stock.warehouse_id === fukuokaWarehouse.id) {
      const key = skuStockKey(stock.warehouse_id, stock.sku_id);
      if (!expected.skuQuantityByKey.has(key)) {
        expected.skuQuantityByKey.set(key, 0);
      }
    }
  }

  for (const stock of data.warehouse_item_stocks) {
    if (stock.warehouse_id === suzhouWarehouse.id || stock.warehouse_id === fukuokaWarehouse.id) {
      if (!expected.itemQuantityByKey.has(stockKey(stock.warehouse_id, stock.item_id))) {
        expected.itemQuantityByKey.set(stockKey(stock.warehouse_id, stock.item_id), 0);
      }
    }
  }

  const itemInserts = [];
  const itemUpdates = [];
  for (const [key, expectedQuantity] of expected.itemQuantityByKey) {
    const [warehouseId, itemId] = key.split(":");
    const current = stocksByKey.get(key);
    if (!current && expectedQuantity > 0) {
      const warehouse = warehouseId === suzhouWarehouse.id ? suzhouWarehouse : fukuokaWarehouse;
      itemInserts.push({
        warehouse_id: warehouseId,
        item_id: itemId,
        owner_id: warehouse.owner_id,
        stock_quantity: expectedQuantity,
      });
      continue;
    }
    if (current && nonNegativeInteger(current.stock_quantity) !== expectedQuantity) {
      itemUpdates.push({
        row: current,
        expectedQuantity,
      });
    }
  }

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

  function itemSummary(entry) {
    const row = entry.row ?? entry;
    const item = itemsById.get(row.item_id);
    const product = item ? productsById.get(item.product_id) : null;
    const warehouse =
      row.warehouse_id === suzhouWarehouse.id ? suzhouWarehouse.name : fukuokaWarehouse.name;
    return {
      warehouse,
      product: product?.product_code ?? "",
      item: item?.item_name ?? row.item_id,
      before: entry.row ? nonNegativeInteger(entry.row.stock_quantity) : 0,
      after: entry.expectedQuantity ?? row.stock_quantity,
      diff: (entry.expectedQuantity ?? row.stock_quantity) -
        (entry.row ? nonNegativeInteger(entry.row.stock_quantity) : 0),
    };
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
    itemChangeSummary: [...itemInserts.map(itemSummary), ...itemUpdates.map(itemSummary)]
      .filter((row) => row.diff !== 0)
      .sort((left, right) =>
        left.warehouse.localeCompare(right.warehouse, "zh-CN", { numeric: true }) ||
        left.product.localeCompare(right.product, "zh-CN", { numeric: true }) ||
        left.item.localeCompare(right.item, "zh-CN", { numeric: true }),
      ),
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
    "product_items",
    "product_sku_items",
    "warehouse_skus",
    "warehouse_item_stocks",
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
  console.log(`配件库存新增：${updates.itemInserts.length}`);
  console.log(`配件库存更新：${updates.itemUpdates.length}`);
  console.log(`SKU库存新增：${updates.skuInserts.length}`);
  console.log(`SKU库存更新：${updates.skuUpdates.length}`);

  if (updates.itemChangeSummary.length > 0) {
    console.log("\n配件库存变化：");
    console.table(updates.itemChangeSummary);
  } else {
    console.log("\n配件库存无变化。");
  }

  if (updates.skuChangeSummary.length > 0) {
    console.log("\nSKU库存变化：");
    console.table(updates.skuChangeSummary);
  } else {
    console.log("\nSKU库存无变化。");
  }

  if (!apply) return;

  const reason = `库存重算校准：采购签收-订单仓库发货-苏州调拨到福冈 / ${new Date().toISOString()}`;

  for (const row of updates.itemInserts) {
    const { error: insertError } = await supabase.from("warehouse_item_stocks").insert(row);
    if (insertError) throw new Error(`warehouse_item_stocks insert: ${insertError.message}`);
    if (row.stock_quantity !== 0) {
      const { error: adjustmentError } = await supabase
        .from("warehouse_item_stock_adjustments")
        .insert({
          warehouse_id: row.warehouse_id,
          item_id: row.item_id,
          owner_id: row.owner_id,
          previous_quantity: 0,
          next_quantity: row.stock_quantity,
          change_quantity: row.stock_quantity,
          reason,
          purchase_order_id: null,
          purchase_package_id: null,
        });
      if (adjustmentError) {
        throw new Error(`warehouse_item_stock_adjustments insert: ${adjustmentError.message}`);
      }
    }
  }

  for (const update of updates.itemUpdates) {
    const { row, expectedQuantity } = update;
    const before = nonNegativeInteger(row.stock_quantity);
    const { error: updateError } = await supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: expectedQuantity })
      .eq("id", row.id);
    if (updateError) throw new Error(`warehouse_item_stocks update: ${updateError.message}`);

    const { error: adjustmentError } = await supabase
      .from("warehouse_item_stock_adjustments")
      .insert({
        warehouse_id: row.warehouse_id,
        item_id: row.item_id,
        owner_id: row.owner_id,
        previous_quantity: before,
        next_quantity: expectedQuantity,
        change_quantity: expectedQuantity - before,
        reason,
        purchase_order_id: null,
        purchase_package_id: null,
      });
    if (adjustmentError) {
      throw new Error(`warehouse_item_stock_adjustments insert: ${adjustmentError.message}`);
    }
  }

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
