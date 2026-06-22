import fs from "node:fs";
import path from "node:path";

const snapshotPath = path.resolve("local-data/codex-supabase-data.json");

function readSnapshot() {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`缺少本地快照：${snapshotPath}。请先运行 npm run sync:data`);
  }

  const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (!parsed?.tables) {
    throw new Error("本地快照格式不正确：缺少 tables");
  }
  return parsed.tables;
}

function parseArgs(argv) {
  const filters = {
    warehouse: "",
    product: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--warehouse") {
      filters.warehouse = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--warehouse=")) {
      filters.warehouse = arg.slice("--warehouse=".length);
    } else if (arg === "--product") {
      filters.product = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--product=")) {
      filters.product = arg.slice("--product=".length);
    }
  }

  return filters;
}

function byId(rows) {
  return Object.fromEntries((rows ?? []).map((row) => [row.id, row]));
}

function normalizeQuantity(value) {
  const quantity = Math.trunc(Number(value) || 0);
  return quantity > 0 ? quantity : 0;
}

function getSkuCode(sku, productsById, skusByProductId) {
  if (!sku) return "--";
  if (sku.sku_code && !/^SKU-\d+$/i.test(sku.sku_code)) return sku.sku_code;
  const siblings = skusByProductId[sku.product_id] ?? [];
  const index = siblings.findIndex((item) => item.id === sku.id);
  const productCode = productsById[sku.product_id]?.product_code;
  return productCode && index >= 0 ? `${productCode}-${index + 1}` : sku.sku_code || "--";
}

function parseTransferSummarySkuLines(reason) {
  const detail = reason.replace(/^库存调拨(?:出库|入库)：/, "");
  const skuSummary = detail.split(" / ")[1] ?? "";
  return skuSummary
    .split("；")
    .map((part) => part.trim())
    .flatMap((part) => {
      const match = part.match(/(.+?)\s*x\s*(\d+)/i);
      const codes = match
        ? [...match[1].matchAll(/\b[A-Za-z]+\d+(?:-\d+)?\b/g)].map(
            (codeMatch) => codeMatch[0],
          )
        : [];
      const skuCode = codes.at(-1);
      return match && skuCode
        ? [
            {
              skuCode,
              quantity: Number(match[2]),
              raw: part,
            },
          ]
        : [];
    });
}

function matchesFilter(value, filter) {
  return !filter || String(value).toLowerCase() === filter.trim().toLowerCase();
}

function collectInventoryFindings(tables, filters) {
  const productsById = byId(tables.products);
  const skusById = byId(tables.product_skus);
  const itemsById = byId(tables.product_items);
  const warehousesById = byId(tables.warehouses);
  const skusByProductId = (tables.product_skus ?? []).reduce((groups, sku) => {
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});
  Object.values(skusByProductId).forEach((items) =>
    items.sort((left, right) => left.created_at.localeCompare(right.created_at)),
  );

  const skuByCode = {};
  for (const sku of tables.product_skus ?? []) {
    skuByCode[getSkuCode(sku, productsById, skusByProductId)] = sku;
    if (sku.sku_code) skuByCode[sku.sku_code] = sku;
  }

  const skuLinksBySkuId = (tables.product_sku_items ?? []).reduce((groups, link) => {
    groups[link.sku_id] ??= [];
    groups[link.sku_id].push(link);
    return groups;
  }, {});

  const itemStockByKey = new Map(
    (tables.warehouse_item_stocks ?? []).map((row) => [
      `${row.warehouse_id}:${row.item_id}`,
      row,
    ]),
  );
  const warehouseSkuByKey = new Map(
    (tables.warehouse_skus ?? []).map((row) => [`${row.warehouse_id}:${row.sku_id}`, row]),
  );

  const expectedItemStockByKey = new Map();
  for (const warehouseSku of tables.warehouse_skus ?? []) {
    const sku = skusById[warehouseSku.sku_id];
    const links = skuLinksBySkuId[warehouseSku.sku_id] ?? [];
    if (!sku || links.length === 0) continue;
    const warehouseName = warehousesById[warehouseSku.warehouse_id]?.name ?? warehouseSku.warehouse_id;
    const productCode = productsById[warehouseSku.product_id]?.product_code ?? warehouseSku.product_id;
    if (!matchesFilter(warehouseName, filters.warehouse)) continue;
    if (!matchesFilter(productCode, filters.product)) continue;

    for (const link of links) {
      const key = `${warehouseSku.warehouse_id}:${link.item_id}`;
      expectedItemStockByKey.set(
        key,
        (expectedItemStockByKey.get(key) ?? 0) +
          normalizeQuantity(warehouseSku.stock_quantity) * normalizeQuantity(link.quantity),
      );
    }
  }

  const itemStockMismatches = [];
  const itemStockKeys = new Set([
    ...expectedItemStockByKey.keys(),
    ...(tables.warehouse_item_stocks ?? []).map((row) => `${row.warehouse_id}:${row.item_id}`),
  ]);
  for (const key of itemStockKeys) {
    const [warehouseId, itemId] = key.split(":");
    const item = itemsById[itemId];
    const warehouseName = warehousesById[warehouseId]?.name ?? warehouseId;
    const productCode = item ? productsById[item.product_id]?.product_code : "";
    if (!matchesFilter(warehouseName, filters.warehouse)) continue;
    if (!matchesFilter(productCode, filters.product)) continue;

    const itemStock = itemStockByKey.get(key);
    const itemStockQuantity = normalizeQuantity(itemStock?.stock_quantity);
    const expectedQuantity = expectedItemStockByKey.get(key) ?? 0;
    if (itemStockQuantity !== expectedQuantity) {
      itemStockMismatches.push({
        warehouse: warehouseName,
        product: productCode || item?.product_id || "",
        item: item?.item_name ?? itemId,
        itemStock: itemStockQuantity,
        skuDerivedStock: expectedQuantity,
      });
    }
  }

  const skuStockMismatches = [];
  for (const warehouseSku of tables.warehouse_skus ?? []) {
    const sku = skusById[warehouseSku.sku_id];
    const links = skuLinksBySkuId[warehouseSku.sku_id] ?? [];
    if (!sku || links.length === 0) continue;
    const warehouseName = warehousesById[warehouseSku.warehouse_id]?.name ?? warehouseSku.warehouse_id;
    const productCode = productsById[warehouseSku.product_id]?.product_code ?? warehouseSku.product_id;
    if (!matchesFilter(warehouseName, filters.warehouse)) continue;
    if (!matchesFilter(productCode, filters.product)) continue;

    const possibleQuantities = links.map((link) => {
      const itemStock =
        itemStockByKey.get(`${warehouseSku.warehouse_id}:${link.item_id}`)?.stock_quantity ?? 0;
      const perSkuQuantity = normalizeQuantity(link.quantity);
      return perSkuQuantity > 0 ? Math.floor(itemStock / perSkuQuantity) : 0;
    });
    const impliedStock = Math.min(...possibleQuantities);
    if (impliedStock !== warehouseSku.stock_quantity) {
      skuStockMismatches.push({
        warehouse: warehouseName,
        product: productCode,
        sku: getSkuCode(sku, productsById, skusByProductId),
        warehouseSkuStock: warehouseSku.stock_quantity,
        componentImpliedStock: impliedStock,
      });
    }
  }

  const transferGroups = new Map();
  for (const adjustment of tables.warehouse_item_stock_adjustments ?? []) {
    if (!adjustment.reason?.startsWith("库存调拨")) continue;
    const reasonDetail = adjustment.reason.replace(/^库存调拨(?:出库|入库)：/, "");
    const group = transferGroups.get(reasonDetail) ?? [];
    group.push(adjustment);
    transferGroups.set(reasonDetail, group);
  }

  const transferMismatches = [];
  for (const [reasonDetail, rows] of transferGroups) {
    const route = reasonDetail.split(" / ")[0] ?? "";
    const [sourceWarehouseName = "", destinationWarehouseName = ""] = route
      .split(" -> ")
      .map((part) => part.trim());
    const summaryLines = parseTransferSummarySkuLines(rows[0].reason);
    const summaryProducts = new Set(
      summaryLines.flatMap((line) => {
        const sku = skuByCode[line.skuCode];
        const productCode = sku ? productsById[sku.product_id]?.product_code : "";
        return productCode ? [productCode] : [];
      }),
    );
    const actualProducts = new Set(
      rows.flatMap((row) => {
        const item = itemsById[row.item_id];
        const productCode = item ? productsById[item.product_id]?.product_code : "";
        return productCode ? [productCode] : [];
      }),
    );
    const missingProducts = [...summaryProducts].filter((code) => !actualProducts.has(code));
    const textOnlySkus = summaryLines
      .filter((line) => {
        const sku = skuByCode[line.skuCode];
        const productCode = sku ? productsById[sku.product_id]?.product_code : "";
        return productCode && missingProducts.includes(productCode);
      })
      .map((line) => `${line.skuCode} x${line.quantity}`);

    const relatedProducts = new Set([...summaryProducts, ...actualProducts]);
    const matchesWarehouse =
      matchesFilter(sourceWarehouseName, filters.warehouse) ||
      matchesFilter(destinationWarehouseName, filters.warehouse);
    const matchesProduct =
      !filters.product || [...relatedProducts].some((code) => matchesFilter(code, filters.product));

    if (missingProducts.length > 0 && matchesWarehouse && matchesProduct) {
      transferMismatches.push({
        reason: reasonDetail,
        rows: rows.length,
        summaryProducts: [...summaryProducts],
        actualProducts: [...actualProducts],
        textOnlySkus,
      });
    }
  }

  const missingWarehouseSkuRows = [];
  for (const mismatch of transferMismatches) {
    for (const skuLabel of mismatch.textOnlySkus) {
      const skuCode = skuLabel.replace(/\s*x\d+$/, "");
      const sku = skuByCode[skuCode];
      if (!sku) continue;
      const destinationName = mismatch.reason.split(" / ")[0]?.split(" -> ")[1]?.trim();
      const destinationWarehouse = (tables.warehouses ?? []).find(
        (warehouse) => warehouse.name === destinationName,
      );
      if (!destinationWarehouse) continue;
      if (!matchesFilter(destinationWarehouse.name, filters.warehouse)) continue;
      const productCode = productsById[sku.product_id]?.product_code ?? sku.product_id;
      if (!matchesFilter(productCode, filters.product)) continue;
      if (!warehouseSkuByKey.has(`${destinationWarehouse.id}:${sku.id}`)) {
        missingWarehouseSkuRows.push({
          warehouse: destinationWarehouse.name,
          product: productCode,
          sku: skuCode,
        });
      }
    }
  }

  const suggestedRepairActions = [
    ...itemStockMismatches.map((row) => ({
      action: "update_warehouse_item_stock_from_sku",
      warehouse: row.warehouse,
      product: row.product,
      item: row.item,
      from: row.itemStock,
      to: row.skuDerivedStock,
    })),
    ...missingWarehouseSkuRows.map((row) => ({
      action: "insert_missing_warehouse_sku_row",
      warehouse: row.warehouse,
      product: row.product,
      sku: row.sku,
      stock: 0,
      note: "仅补 SKU 行；是否补配件库存和调拨流水必须按实际业务确认",
    })),
  ];

  return {
    itemStockMismatches,
    skuStockMismatches,
    transferMismatches,
    missingWarehouseSkuRows,
    suggestedRepairActions,
  };
}

function printSection(title, rows) {
  console.log(`\n## ${title}`);
  if (rows.length === 0) {
    console.log("无");
    return;
  }
  console.table(rows);
}

const filters = parseArgs(process.argv.slice(2));
const tables = readSnapshot();
const findings = collectInventoryFindings(tables, filters);

console.log(`库存一致性检查：${snapshotPath}`);
if (filters.warehouse || filters.product) {
  console.log(
    `过滤条件：${[
      filters.warehouse ? `warehouse=${filters.warehouse}` : "",
      filters.product ? `product=${filters.product}` : "",
    ]
      .filter(Boolean)
      .join(" ")}`,
  );
}
printSection("配件库存与SKU口径派生库存不一致", findings.itemStockMismatches);
printSection("SKU库存与配件可组成库存不一致（参考，不作为主口径错误）", findings.skuStockMismatches);
printSection("调拨摘要与实际流水产品不一致", findings.transferMismatches);
printSection("调拨摘要提到但目标仓缺少的 SKU 行", findings.missingWarehouseSkuRows);
printSection("建议修复动作 dry-run，不执行数据库写入", findings.suggestedRepairActions);

if (
  findings.itemStockMismatches.length > 0 ||
  findings.transferMismatches.length > 0 ||
  findings.missingWarehouseSkuRows.length > 0 ||
  findings.suggestedRepairActions.length > 0
) {
  process.exitCode = 1;
}
