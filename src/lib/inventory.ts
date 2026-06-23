import { withTimeout, requireSession } from "./supabase-helpers";
import type {
  Product,
  ProductItem,
  ProductSku,
  ProductSkuItemLink,
} from "../types";

import type {
  Warehouse,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
  WarehouseSku,
} from "../types";

function isTransientFetchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof TypeError ||
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("fetch failed")
  );
}

async function retryInventoryRequest<T>(operation: () => PromiseLike<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientFetchError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

export async function fetchWarehouses() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .select("id, name, owner_id, created_at, updated_at")
      .order("created_at", { ascending: true }),
    "加载仓库",
  );

  if (error) throw error;
  return data as Warehouse[];
}

export async function createWarehouse(name: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .insert({
        name,
      })
      .select("id, name, owner_id, created_at, updated_at")
      .single(),
    "新增仓库",
  );

  if (error) throw error;
  return data as Warehouse;
}

export async function updateWarehouse(
  warehouseId: string,
  updates: Pick<Warehouse, "name">,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .update(updates)
      .eq("id", warehouseId)
      .select("id, name, owner_id, created_at, updated_at")
      .single(),
    "更新仓库",
  );

  if (error) throw error;
  return data as Warehouse;
}

export async function deleteWarehouse(warehouseId: string) {
  const { supabase } = await requireSession();
  const { error } = await withTimeout(
    supabase
      .from("warehouses")
      .delete()
      .eq("id", warehouseId),
    "删除仓库",
  );

  if (error) throw error;
}

export async function fetchWarehouseSkuCounts(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return {} as Record<string, number>;

  const { supabase } = await requireSession();
  const counts: Record<string, number> = {};

  await Promise.all(
    warehouseIds.map(async (warehouseId) => {
      const { error, count } = await withTimeout(
        supabase
          .from("warehouse_skus")
          .select("*", { count: "exact", head: true })
          .eq("warehouse_id", warehouseId),
        `加载仓库 ${warehouseId} SKU 计数`,
      );
      if (error) throw error;
      counts[warehouseId] = count ?? 0;
    })
  );

  return counts;
}

export async function fetchWarehouseSkus(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseSku[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
      .in("warehouse_id", warehouseIds)
      .order("created_at", { ascending: true }),
    "加载库存 SKU",
  );

  if (error) throw error;
  return data as WarehouseSku[];
}

export async function fetchWarehouseItemStocks(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseItemStock[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .in("warehouse_id", warehouseIds)
      .order("created_at", { ascending: true }),
    "加载仓库配件库存",
  );

  if (error) throw error;
  return data as WarehouseItemStock[];
}

export async function fetchWarehouseItemStockAdjustments(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseItemStockAdjustment[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stock_adjustments")
      .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason, created_at")
      .in("warehouse_id", warehouseIds)
      .order("created_at", { ascending: false }),
    "加载库存调整记录",
  );

  if (error) throw error;
  return data as WarehouseItemStockAdjustment[];
}

export async function fetchWarehouseItemStockAdjustmentsForItems(
  warehouseId: string,
  itemIds: string[],
) {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueItemIds.length === 0) return [] as WarehouseItemStockAdjustment[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    retryInventoryRequest(() =>
      supabase
        .from("warehouse_item_stock_adjustments")
        .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason, created_at")
        .eq("warehouse_id", warehouseId)
        .in("item_id", uniqueItemIds)
        .order("created_at", { ascending: false })
        .limit(uniqueItemIds.length * 20),
    ),
    "加载配件编辑记录",
  );

  if (error) throw error;
  return data as WarehouseItemStockAdjustment[];
}

export async function fetchWarehouseInventoryPage(
  warehouseId: string,
  page: number,
  pageSize: number = 20,
  searchQuery: string = "",
) {
  const { supabase } = await requireSession();

  return withTimeout(
    retryInventoryRequest(async () => {
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const query = searchQuery.trim();

      let productIdMatches: string[] = [];
      let skuIdMatches: string[] = [];
      if (query) {
        const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;
        const [productsResult, skusResult] = await Promise.all([
          supabase
            .from("products")
            .select("id")
            .or(`product_code.ilike.${pattern},product_name_cn.ilike.${pattern}`)
            .limit(1000),
          supabase
            .from("product_skus")
            .select("id, product_id")
            .ilike("sku_code", pattern)
            .limit(1000),
        ]);

        if (productsResult.error) throw productsResult.error;
        if (skusResult.error) throw skusResult.error;

        productIdMatches = Array.from(
          new Set([
            ...((productsResult.data ?? []) as Array<{ id: string }>).map((item) => item.id),
            ...((skusResult.data ?? []) as Array<{ product_id: string }>).map((item) => item.product_id),
          ].filter(Boolean)),
        );
        skuIdMatches = Array.from(
          new Set(((skusResult.data ?? []) as Array<{ id: string }>).map((item) => item.id).filter(Boolean)),
        );

        if (productIdMatches.length === 0 && skuIdMatches.length === 0) {
          return {
            warehouseSkus: [],
            products: [] as Product[],
            skus: [] as ProductSku[],
            productItems: [] as ProductItem[],
            warehouseItemStocks: [] as WarehouseItemStock[],
            warehouseItemStockAdjustments: [] as WarehouseItemStockAdjustment[],
            total: 0,
            hasMore: false,
          };
        }
      }

      // ── Round 1: page of warehouse_skus ──────────────────────────────────
      let warehouseSkuQuery = supabase
        .from("warehouse_skus")
        .select(
          "id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at",
          { count: "exact" },
        )
        .eq("warehouse_id", warehouseId)
        .order("created_at", { ascending: false });

      if (query) {
        const filters = [
          productIdMatches.length > 0 ? `product_id.in.(${productIdMatches.join(",")})` : "",
          skuIdMatches.length > 0 ? `sku_id.in.(${skuIdMatches.join(",")})` : "",
        ].filter(Boolean);
        warehouseSkuQuery = warehouseSkuQuery.or(filters.join(","));
      }

      const { data: skuRows, error: skuError, count } = await warehouseSkuQuery.range(from, to);

      if (skuError) throw skuError;

      const warehouseSkus = (skuRows ?? []) as WarehouseSku[];
      if (warehouseSkus.length === 0) {
        return {
          warehouseSkus: [],
          products: [] as Product[],
          skus: [] as ProductSku[],
          productItems: [] as ProductItem[],
          warehouseItemStocks: [] as WarehouseItemStock[],
          warehouseItemStockAdjustments: [] as WarehouseItemStockAdjustment[],
          total: count ?? 0,
          hasMore: false,
        };
      }

      const productIds = Array.from(new Set(warehouseSkus.map(s => s.product_id)));

      // ── Round 2: products + product_items + product_skus (all parallel) ──
      const [productsResult, productItemsResult, baseSkusResult] = await Promise.all([
        supabase
          .from("products")
          .select("*")
          .in("id", productIds)
          .order("created_at", { ascending: false }),
        supabase
          .from("product_items")
          .select("*")
          .in("product_id", productIds)
          .order("created_at", { ascending: true }),
        supabase
          .from("product_skus")
          .select("id, product_id, owner_id, sku_code, temu_image_url, attributes, notes")
          .in("product_id", productIds)
          .order("created_at", { ascending: true }),
      ]);

      if (productsResult.error) throw productsResult.error;
      if (productItemsResult.error) throw productItemsResult.error;
      if (baseSkusResult.error) throw baseSkusResult.error;

      const products = (productsResult.data ?? []) as Product[];
      const productItems = (productItemsResult.data ?? []) as ProductItem[];
      const baseSkus = (baseSkusResult.data ?? []) as Omit<ProductSku, "component_links">[];

      const skuIds = baseSkus.map(sku => sku.id).filter(Boolean) as string[];

      // ── Round 3: SKU component links. Warehouse component quantities are
      // inferred from SKU stock in the UI instead of reading item stock rows.
      const linksResult = skuIds.length > 0
        ? await supabase
          .from("product_sku_items")
          .select("sku_id, item_id, quantity")
          .in("sku_id", skuIds)
        : { data: [] as ProductSkuItemLink[], error: null };

      if (linksResult.error) throw linksResult.error;

      // Build SKUs with component_links
      const links = (linksResult.data ?? []) as ProductSkuItemLink[];
      const linksBySkuId = links.reduce<Record<string, ProductSkuItemLink[]>>((groups, link) => {
        if (!link.sku_id) return groups;
        groups[link.sku_id] ??= [];
        groups[link.sku_id].push(link);
        return groups;
      }, {});

      const skus: ProductSku[] = baseSkus.map(sku => ({
        ...sku,
        temu_image_url: String(sku.temu_image_url ?? ""),
        component_links: sku.id ? (linksBySkuId[sku.id] ?? []) : [],
      }));

      return {
        warehouseSkus,
        products,
        skus,
        productItems,
        warehouseItemStocks: [] as WarehouseItemStock[],
        warehouseItemStockAdjustments: [] as WarehouseItemStockAdjustment[],
        total: count ?? 0,
        hasMore: to + 1 < (count ?? 0),
      };
    }),
    "加载仓库库存页面",
  );
}


export async function addWarehouseProductInventory(
  warehouseId: string,
  productId: string,
  skuIds: string[],
) {
  if (skuIds.length === 0) {
    throw new Error("该商品还没有 SKU，不能加入库存");
  }

  const { supabase } = await requireSession();
  const { data: skuRows, error: skuError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .insert(
        skuIds.map((skuId) => ({
          warehouse_id: warehouseId,
          product_id: productId,
          sku_id: skuId,
        })),
      )
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at"),
    "添加库存 SKU",
  );

  if (skuError) throw skuError;

  return {
    skus: skuRows as WarehouseSku[],
    itemStocks: [] as WarehouseItemStock[],
  };
}

export async function removeWarehouseProduct(
  warehouseId: string,
  productId: string,
) {
  const { supabase } = await requireSession();
  const { error: skuError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .delete()
      .eq("warehouse_id", warehouseId)
      .eq("product_id", productId),
    "移除库存商品",
  );

  if (skuError) throw skuError;
}

export async function updateWarehouseItemStock(
  item: WarehouseItemStock,
  stockQuantity: number,
  reason: string,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: stockQuantity })
      .eq("id", item.id)
      .eq("stock_quantity", item.stock_quantity)
      .select("id, warehouse_id, item_id, stock_quantity")
      .maybeSingle(),
    "更新配件库存",
  );

  if (error) throw error;
  if (!data) throw new Error("库存已被其他操作更新，请刷新后重试");

  const nextItem = data as WarehouseItemStock;
  const { data: adjustment, error: adjustmentError } = await withTimeout(
    supabase
      .from("warehouse_item_stock_adjustments")
      .insert({
        warehouse_id: item.warehouse_id,
        item_id: item.item_id,
        previous_quantity: item.stock_quantity,
        next_quantity: nextItem.stock_quantity,
        change_quantity: nextItem.stock_quantity - item.stock_quantity,
        reason,
        purchase_order_id: null,
        purchase_package_id: null,
      })
      .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason, created_at")
      .single(),
    "保存库存调整记录",
  );

  if (adjustmentError) throw adjustmentError;
  return {
    item: nextItem,
    adjustment: adjustment as WarehouseItemStockAdjustment,
  };
}

export type WarehouseInventoryTransferLineInput = {
  productId: string;
  skuId: string;
  skuLabel: string;
  quantity: number;
  items: Array<{
    itemId: string;
    quantity: number;
  }>;
};

export type WarehouseInventoryTransferInput = {
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceWarehouseName: string;
  destinationWarehouseName: string;
  transferDate: string;
  trackingNo: string;
  lines: WarehouseInventoryTransferLineInput[];
};

export type WarehouseInventoryTransferMetadataLine = {
  productId: string;
  skuId: string;
  quantity: number;
  items: Array<{
    itemId: string;
    quantity: number;
  }>;
};

export type WarehouseInventoryTransferMetadata = {
  batchId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  lines: WarehouseInventoryTransferMetadataLine[];
};

type WarehouseInventoryTransferResult = {
  warehouseSkus: WarehouseSku[];
  itemStocks: WarehouseItemStock[];
  adjustments: WarehouseItemStockAdjustment[];
};

const transferOutReasonPrefix = "库存调拨出库：";
const transferInReasonPrefix = "库存调拨入库：";
const transferMetadataPartPrefix = "调拨数据：";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWarehouseInventoryTransferMetadataLine(
  value: unknown,
): WarehouseInventoryTransferMetadataLine | null {
  if (!isRecord(value)) return null;

  const productId = typeof value.productId === "string" ? value.productId.trim() : "";
  const skuId = typeof value.skuId === "string" ? value.skuId.trim() : "";
  const quantity = Math.trunc(Number(value.quantity) || 0);
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.flatMap((item): WarehouseInventoryTransferMetadataLine["items"] => {
    if (!isRecord(item)) return [];
    const itemId = typeof item.itemId === "string" ? item.itemId.trim() : "";
    const itemQuantity = Math.trunc(Number(item.quantity) || 0);
    return itemId && itemQuantity > 0 ? [{ itemId, quantity: itemQuantity }] : [];
  });

  if (!productId || !skuId || quantity <= 0 || items.length === 0) return null;
  return { productId, skuId, quantity, items };
}

export function parseWarehouseInventoryTransferMetadata(
  encodedMetadata: string,
): WarehouseInventoryTransferMetadata | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encodedMetadata));
    if (!isRecord(parsed)) return null;

    const batchId = typeof parsed.batchId === "string" ? parsed.batchId.trim() : "";
    const sourceWarehouseId =
      typeof parsed.sourceWarehouseId === "string"
        ? parsed.sourceWarehouseId.trim()
        : "";
    const destinationWarehouseId =
      typeof parsed.destinationWarehouseId === "string"
        ? parsed.destinationWarehouseId.trim()
        : "";
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
    const lines = rawLines.flatMap((line): WarehouseInventoryTransferMetadataLine[] => {
      const parsedLine = parseWarehouseInventoryTransferMetadataLine(line);
      return parsedLine ? [parsedLine] : [];
    });

    if (!batchId || !sourceWarehouseId || !destinationWarehouseId || lines.length === 0) {
      return null;
    }
    return { batchId, sourceWarehouseId, destinationWarehouseId, lines };
  } catch {
    return null;
  }
}

export function getWarehouseTransferReasonInfo(reason: string) {
  if (reason.startsWith(transferOutReasonPrefix)) {
    return {
      direction: "out" as const,
      detail: reason.slice(transferOutReasonPrefix.length),
    };
  }
  if (reason.startsWith(transferInReasonPrefix)) {
    return {
      direction: "in" as const,
      detail: reason.slice(transferInReasonPrefix.length),
    };
  }
  return null;
}

export function parseWarehouseTransferReasonDetail(detail: string, fallbackDate: string) {
  const parts = detail
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean);
  const route = parts[0] ?? "";
  const [sourceWarehouseName = "--", destinationWarehouseName = "--"] = route
    .split(" -> ")
    .map((part) => part.trim());
  const transferDate =
    parts.find((part) => part.startsWith("调拨日期："))?.replace("调拨日期：", "").trim() ||
    fallbackDate;
  const trackingNo =
    parts.find((part) => part.startsWith("快递单号："))?.replace("快递单号：", "").trim() ||
    "--";
  const metadata = parseWarehouseInventoryTransferMetadata(
    parts
      .find((part) => part.startsWith(transferMetadataPartPrefix))
      ?.slice(transferMetadataPartPrefix.length) ?? "",
  );
  const skuSummary =
    parts
      .slice(1)
      .filter(
        (part) =>
          !part.startsWith("调拨日期：") &&
          !part.startsWith("快递单号：") &&
          !part.startsWith(transferMetadataPartPrefix),
      )
      .join(" / ") || "--";

  return {
    sourceWarehouseName,
    destinationWarehouseName,
    transferDate,
    trackingNo,
    skuSummary,
    metadata,
  };
}

function createTransferBatchId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildTransferReasonLabel(
  input: WarehouseInventoryTransferInput,
  transferLines: Array<
    Omit<WarehouseInventoryTransferLineInput, "items"> & {
      items: WarehouseInventoryTransferMetadataLine["items"];
    }
  >,
) {
  const metadata: WarehouseInventoryTransferMetadata = {
    batchId: createTransferBatchId(),
    sourceWarehouseId: input.sourceWarehouseId.trim(),
    destinationWarehouseId: input.destinationWarehouseId.trim(),
    lines: transferLines.map((line) => ({
      productId: line.productId,
      skuId: line.skuId,
      quantity: line.quantity,
      items: line.items,
    })),
  };
  const skuLabel = transferLines
    .map((line) => `${line.skuLabel || line.skuId} x${line.quantity}`)
    .join("；");

  return `${input.sourceWarehouseName || metadata.sourceWarehouseId} -> ${input.destinationWarehouseName || metadata.destinationWarehouseId
    } / ${skuLabel} / 调拨日期：${input.transferDate.trim()} / 快递单号：${input.trackingNo.trim()} / ${transferMetadataPartPrefix}${encodeURIComponent(
      JSON.stringify(metadata),
    )}`;
}

function normalizeTransferItems(items: WarehouseInventoryTransferLineInput["items"]) {
  const quantityByItemId = new Map<string, number>();

  items.forEach((item) => {
    const itemId = item.itemId.trim();
    const quantity = Math.trunc(Number(item.quantity) || 0);
    if (!itemId || quantity <= 0) return;
    quantityByItemId.set(itemId, (quantityByItemId.get(itemId) ?? 0) + quantity);
  });

  return Array.from(quantityByItemId, ([itemId, quantity]) => ({ itemId, quantity }));
}

export async function transferWarehouseInventory(
  input: WarehouseInventoryTransferInput,
): Promise<WarehouseInventoryTransferResult> {
  const sourceWarehouseId = input.sourceWarehouseId.trim();
  const destinationWarehouseId = input.destinationWarehouseId.trim();
  const transferDate = input.transferDate.trim();
  const trackingNo = input.trackingNo.trim();
  const transferLines = input.lines
    .map((line) => ({
      ...line,
      productId: line.productId.trim(),
      skuId: line.skuId.trim(),
      skuLabel: line.skuLabel.trim(),
      quantity: Math.trunc(Number(line.quantity) || 0),
      items: normalizeTransferItems(line.items),
    }))
    .filter(
      (line) =>
        line.productId &&
        line.skuId &&
        line.quantity > 0 &&
        line.items.length > 0,
    );
  const transferItems = normalizeTransferItems(
    transferLines.flatMap((line) => line.items),
  );

  if (!sourceWarehouseId || !destinationWarehouseId) {
    throw new Error("请选择调出仓库和调入仓库");
  }
  if (sourceWarehouseId === destinationWarehouseId) {
    throw new Error("调出仓库和调入仓库不能相同");
  }
  if (transferLines.length === 0 || transferItems.length === 0) {
    throw new Error("请至少添加一个要调拨的 SKU");
  }
  if (!transferDate) {
    throw new Error("请选择调拨日期");
  }
  if (!trackingNo) {
    throw new Error("请填写调拨快递单号");
  }

  const { supabase } = await requireSession();
  const itemIds = transferItems.map((item) => item.itemId);
  const skuIds = transferLines.map((line) => line.skuId);

  const { data: sourceSkuData, error: sourceSkuError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
      .eq("warehouse_id", sourceWarehouseId)
      .in("sku_id", skuIds),
    "读取调出仓库 SKU 库存",
  );
  if (sourceSkuError) throw sourceSkuError;
  const sourceSkusBySkuId = new Map(
    ((sourceSkuData ?? []) as WarehouseSku[]).map((item) => [item.sku_id, item]),
  );
  const missingSourceSku = transferLines.find(
    (line) => !sourceSkusBySkuId.has(line.skuId),
  );
  if (missingSourceSku) {
    throw new Error("调出仓库缺少对应 SKU 库存，请先检查库存商品");
  }

  const { data: sourceStockData, error: sourceStockError } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .eq("warehouse_id", sourceWarehouseId)
      .in("item_id", itemIds),
    "读取调出仓库库存",
  );
  if (sourceStockError) throw sourceStockError;

  const sourceStocksByItemId = new Map(
    ((sourceStockData ?? []) as WarehouseItemStock[]).map((item) => [item.item_id, item]),
  );
  const missingSourceStock = transferItems.find(
    (item) => !sourceStocksByItemId.has(item.itemId),
  );
  if (missingSourceStock) {
    throw new Error("调出仓库缺少对应配件库存，请先检查库存商品");
  }

  const insufficientStock = transferItems.find((item) => {
    const stock = sourceStocksByItemId.get(item.itemId);
    return !stock || stock.stock_quantity < item.quantity;
  });
  if (insufficientStock) {
    const stock = sourceStocksByItemId.get(insufficientStock.itemId);
    throw new Error(
      `调出仓库配件库存不足：当前 ${stock?.stock_quantity ?? 0}，需要 ${insufficientStock.quantity}`,
    );
  }
  const insufficientSkuStock = transferLines.find((line) => {
    const skuStock = sourceSkusBySkuId.get(line.skuId);
    return !skuStock || skuStock.stock_quantity < line.quantity;
  });
  if (insufficientSkuStock) {
    const skuStock = sourceSkusBySkuId.get(insufficientSkuStock.skuId);
    throw new Error(
      `调出仓库 SKU 库存不足：当前 ${skuStock?.stock_quantity ?? 0}，需要 ${insufficientSkuStock.quantity}`,
    );
  }

  const reasonLabel = buildTransferReasonLabel(input, transferLines);
  const updatedSkus: WarehouseSku[] = [];
  const updatedStocks: WarehouseItemStock[] = [];
  const adjustments: WarehouseItemStockAdjustment[] = [];

  for (const transferLine of transferLines) {
    const sourceSku = sourceSkusBySkuId.get(transferLine.skuId);
    if (!sourceSku) continue;

    const nextSourceQuantity = Math.max(0, sourceSku.stock_quantity - transferLine.quantity);
    const { data: nextSourceSkuData, error: sourceSkuUpdateError } = await withTimeout(
      supabase
        .from("warehouse_skus")
        .update({ stock_quantity: nextSourceQuantity })
        .eq("id", sourceSku.id)
        .eq("stock_quantity", sourceSku.stock_quantity)
        .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
        .maybeSingle(),
      "扣减调出仓库 SKU 库存",
    );
    if (sourceSkuUpdateError) throw sourceSkuUpdateError;
    if (!nextSourceSkuData) throw new Error("库存已被其他操作更新，请刷新后重试");
    updatedSkus.push(nextSourceSkuData as WarehouseSku);
  }

  for (const transferItem of transferItems) {
    const sourceStock = sourceStocksByItemId.get(transferItem.itemId);
    if (!sourceStock) continue;

    const nextSourceQuantity = sourceStock.stock_quantity - transferItem.quantity;
    const { data: nextSourceStockData, error: sourceUpdateError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .update({ stock_quantity: nextSourceQuantity })
        .eq("id", sourceStock.id)
        .eq("stock_quantity", sourceStock.stock_quantity)
        .select("id, warehouse_id, item_id, stock_quantity")
        .maybeSingle(),
      "扣减调出仓库库存",
    );
    if (sourceUpdateError) throw sourceUpdateError;
    if (!nextSourceStockData) throw new Error("库存已被其他操作更新，请刷新后重试");

    const nextSourceStock = nextSourceStockData as WarehouseItemStock;
    const { data: sourceAdjustmentData, error: sourceAdjustmentError } =
      await withTimeout(
        supabase
          .from("warehouse_item_stock_adjustments")
          .insert({
            warehouse_id: sourceStock.warehouse_id,
            item_id: sourceStock.item_id,
            previous_quantity: sourceStock.stock_quantity,
            next_quantity: nextSourceStock.stock_quantity,
            change_quantity: -transferItem.quantity,
            reason: `${transferOutReasonPrefix}${reasonLabel}`,
            purchase_order_id: null,
            purchase_package_id: null,
          })
          .select("id, warehouse_id, item_id, owner_id, previous_quantity, next_quantity, change_quantity, reason, purchase_order_id, purchase_package_id, created_at")
          .single(),
        "保存调拨出库记录",
      );
    if (sourceAdjustmentError) throw sourceAdjustmentError;

    updatedStocks.push(nextSourceStock);
    adjustments.push(sourceAdjustmentData as WarehouseItemStockAdjustment);
  }

  return {
    warehouseSkus: updatedSkus,
    itemStocks: updatedStocks,
    adjustments,
  };
}

export type WarehouseInventoryTransferReceiptInput = {
  destinationWarehouseId: string;
  reasonDetail: string;
  items: Array<{
    itemId: string;
    quantity: number;
  }>;
  lines?: WarehouseInventoryTransferMetadataLine[];
};

export async function receiveWarehouseTransferInventory(
  input: WarehouseInventoryTransferReceiptInput,
): Promise<WarehouseInventoryTransferResult> {
  const destinationWarehouseId = input.destinationWarehouseId.trim();
  const reasonDetail = input.reasonDetail.trim();
  const transferItems = normalizeTransferItems(input.items);
  const transferLines = (input.lines ?? [])
    .map((line) => ({
      productId: line.productId.trim(),
      skuId: line.skuId.trim(),
      quantity: Math.trunc(Number(line.quantity) || 0),
      items: normalizeTransferItems(line.items),
    }))
    .filter(
      (line) =>
        line.productId &&
        line.skuId &&
        line.quantity > 0 &&
        line.items.length > 0,
    );

  if (!destinationWarehouseId) {
    throw new Error("缺少调入仓库，不能签收入库");
  }
  if (!reasonDetail) {
    throw new Error("缺少调拨记录，不能签收入库");
  }
  if (transferItems.length === 0) {
    throw new Error("调拨记录没有可签收的配件明细");
  }

  const { supabase, session } = await requireSession();
  const itemIds = transferItems.map((item) => item.itemId);
  const skuIds = Array.from(new Set(transferLines.map((line) => line.skuId)));
  const inboundReason = `${transferInReasonPrefix}${reasonDetail}`;

  if (transferLines.length > 0) {
    const { error: skuUpsertError } = await withTimeout(
      supabase
        .from("warehouse_skus")
        .upsert(
          Array.from(
            new Map(
              transferLines.map((line) => [
                line.skuId,
                {
                  warehouse_id: destinationWarehouseId,
                  product_id: line.productId,
                  sku_id: line.skuId,
                  owner_id: session.user.id,
                },
              ]),
            ).values(),
          ),
          { onConflict: "warehouse_id,sku_id", ignoreDuplicates: true },
        ),
      "准备签收仓库 SKU",
    );
    if (skuUpsertError) throw skuUpsertError;
  }

  const { error: itemStockUpsertError } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .upsert(
        itemIds.map((itemId) => ({
          warehouse_id: destinationWarehouseId,
          item_id: itemId,
          owner_id: session.user.id,
        })),
        { onConflict: "warehouse_id,item_id", ignoreDuplicates: true },
      ),
    "准备签收仓库配件库存",
  );
  if (itemStockUpsertError) throw itemStockUpsertError;

  const [
    { data: destinationSkuData, error: destinationSkuError },
    { data: destinationStockData, error: destinationStockError },
    { data: existingInboundData, error: existingInboundError },
  ] = await Promise.all([
    skuIds.length > 0
      ? supabase
        .from("warehouse_skus")
        .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
        .eq("warehouse_id", destinationWarehouseId)
        .in("sku_id", skuIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .eq("warehouse_id", destinationWarehouseId)
      .in("item_id", itemIds),
    supabase
      .from("warehouse_item_stock_adjustments")
      .select("item_id, change_quantity")
      .eq("warehouse_id", destinationWarehouseId)
      .eq("reason", inboundReason)
      .in("item_id", itemIds),
  ]);
  if (destinationSkuError) throw destinationSkuError;
  if (destinationStockError) throw destinationStockError;
  if (existingInboundError) throw existingInboundError;

  const destinationStocksByItemId = new Map(
    ((destinationStockData ?? []) as WarehouseItemStock[]).map((item) => [
      item.item_id,
      item,
    ]),
  );
  const missingDestinationStock = transferItems.find(
    (item) => !destinationStocksByItemId.has(item.itemId),
  );
  if (missingDestinationStock) {
    throw new Error("签收仓库配件库存准备失败，请刷新后重试");
  }

  const receivedQuantityByItemId = new Map<string, number>();
  ((existingInboundData ?? []) as Array<
    Pick<WarehouseItemStockAdjustment, "item_id" | "change_quantity">
  >).forEach((adjustment) => {
    receivedQuantityByItemId.set(
      adjustment.item_id,
      (receivedQuantityByItemId.get(adjustment.item_id) ?? 0) +
      Math.trunc(Number(adjustment.change_quantity) || 0),
    );
  });

  const updatedStocks: WarehouseItemStock[] = [];
  const adjustments: WarehouseItemStockAdjustment[] = [];
  const updatedSkus: WarehouseSku[] = [];

  const destinationSkusBySkuId = new Map(
    ((destinationSkuData ?? []) as WarehouseSku[]).map((item) => [item.sku_id, item]),
  );
  for (const transferLine of transferLines) {
    const currentSkuStock = destinationSkusBySkuId.get(transferLine.skuId);
    if (!currentSkuStock) continue;

    const alreadyReceivedQuantity = Math.max(
      0,
      Math.min(
        ...transferLine.items.map((item) => {
          const perSkuQuantity =
            transferLine.quantity > 0
              ? Math.trunc(Number(item.quantity) || 0) / transferLine.quantity
              : 0;
          const receivedItemQuantity = receivedQuantityByItemId.get(item.itemId) ?? 0;
          return perSkuQuantity > 0
            ? Math.floor(receivedItemQuantity / perSkuQuantity)
            : 0;
        }),
      ),
    );
    const receiveSkuQuantity = transferLine.quantity - alreadyReceivedQuantity;
    if (receiveSkuQuantity <= 0) continue;

    const nextSkuQuantity = currentSkuStock.stock_quantity + receiveSkuQuantity;
    const { data: nextSkuData, error: skuUpdateError } = await withTimeout(
      supabase
        .from("warehouse_skus")
        .update({ stock_quantity: nextSkuQuantity })
        .eq("id", currentSkuStock.id)
        .eq("stock_quantity", currentSkuStock.stock_quantity)
        .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
        .maybeSingle(),
      "增加签收仓库 SKU 库存",
    );
    if (skuUpdateError) throw skuUpdateError;
    if (!nextSkuData) throw new Error("库存已被其他操作更新，请刷新后重试");
    updatedSkus.push(nextSkuData as WarehouseSku);
  }

  for (const transferItem of transferItems) {
    const alreadyReceivedQuantity =
      Math.max(0, receivedQuantityByItemId.get(transferItem.itemId) ?? 0);
    const receiveQuantity = transferItem.quantity - alreadyReceivedQuantity;
    if (receiveQuantity <= 0) continue;

    const currentStock = destinationStocksByItemId.get(transferItem.itemId);
    if (!currentStock) continue;

    const { data: currentData, error: currentError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .select("id, warehouse_id, item_id, stock_quantity")
        .eq("id", currentStock.id)
        .maybeSingle(),
      "读取签收仓库配件库存",
    );
    if (currentError) throw currentError;
    if (!currentData) throw new Error("签收仓库配件库存不存在，请刷新后重试");

    const current = currentData as WarehouseItemStock;
    const nextQuantity = current.stock_quantity + receiveQuantity;
    const { data: nextStockData, error: stockUpdateError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .update({ stock_quantity: nextQuantity })
        .eq("id", current.id)
        .eq("stock_quantity", current.stock_quantity)
        .select("id, warehouse_id, item_id, stock_quantity")
        .maybeSingle(),
      "增加签收仓库配件库存",
    );
    if (stockUpdateError) throw stockUpdateError;
    if (!nextStockData) throw new Error("库存已被其他操作更新，请刷新后重试");

    const nextStock = nextStockData as WarehouseItemStock;
    const { data: adjustmentData, error: adjustmentError } = await withTimeout(
      supabase
        .from("warehouse_item_stock_adjustments")
        .insert({
          warehouse_id: destinationWarehouseId,
          item_id: current.item_id,
          previous_quantity: current.stock_quantity,
          next_quantity: nextStock.stock_quantity,
          change_quantity: receiveQuantity,
          reason: inboundReason,
          purchase_order_id: null,
          purchase_package_id: null,
        })
        .select("id, warehouse_id, item_id, owner_id, previous_quantity, next_quantity, change_quantity, reason, purchase_order_id, purchase_package_id, created_at")
        .single(),
      "保存调拨签收记录",
    );
    if (adjustmentError) throw adjustmentError;

    updatedStocks.push(nextStock);
    adjustments.push(adjustmentData as WarehouseItemStockAdjustment);
  }

  return {
    warehouseSkus: updatedSkus.length > 0 ? updatedSkus : (destinationSkuData ?? []) as WarehouseSku[],
    itemStocks: updatedStocks,
    adjustments,
  };
}

export type WarehouseItemStockDeductionInput = {
  stockId: string;
  quantity: number;
  reason: string;
  dedupeKey?: string;
  reversalReason?: string;
};

export type WarehouseSkuStockDeductionInput = {
  stockId: string;
  quantity: number;
};

type WarehouseSkuStockInventoryChange = {
  sku: WarehouseSku;
  previous_quantity: number;
  change_quantity: number;
};

export type WarehouseSkuStockReservationInput = {
  orderId: string;
  stockId: string;
  quantity: number;
  reason?: string;
};

function parseWarehouseSkuStockInventoryChanges(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.changes)) {
    return [] as WarehouseSkuStockInventoryChange[];
  }

  return data.changes.flatMap((change): WarehouseSkuStockInventoryChange[] => {
    if (!isRecord(change) || !isRecord(change.sku)) return [];
    const previousQuantity = Math.trunc(Number(change.previous_quantity) || 0);
    const changeQuantity = Math.trunc(Number(change.change_quantity) || 0);
    return [
      {
        sku: change.sku as WarehouseSku,
        previous_quantity: previousQuantity,
        change_quantity: changeQuantity,
      },
    ];
  });
}

export async function updateWarehouseSkuStockQuantity(
  skuStock: WarehouseSku,
  stockQuantity: number,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .update({ stock_quantity: stockQuantity })
      .eq("id", skuStock.id)
      .eq("stock_quantity", skuStock.stock_quantity)
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
      .maybeSingle(),
    "更新 SKU 库存",
  );

  if (error) throw error;
  if (!data) throw new Error("库存已被其他操作更新，请刷新后重试");
  return data as WarehouseSku;
}

export async function deductWarehouseSkuStocks(
  deductions: WarehouseSkuStockDeductionInput[],
) {
  const normalizedDeductions = deductions
    .map((deduction) => ({
      stockId: deduction.stockId,
      quantity: Math.trunc(Number(deduction.quantity) || 0),
    }))
    .filter((deduction) => deduction.quantity > 0);

  if (normalizedDeductions.length === 0) {
    return [] as WarehouseSkuStockInventoryChange[];
  }

  const { supabase } = await requireSession();
  const stockIds = Array.from(new Set(normalizedDeductions.map((item) => item.stockId)));
  const { data: stockData, error: stockLoadError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
      .in("id", stockIds),
    "读取 SKU 库存",
  );

  if (stockLoadError) throw stockLoadError;

  const stocksById = new Map(
    ((stockData ?? []) as WarehouseSku[]).map((item) => [item.id, item]),
  );
  const quantityByStockId = normalizedDeductions.reduce<Record<string, number>>(
    (totals, deduction) => {
      totals[deduction.stockId] = (totals[deduction.stockId] ?? 0) + deduction.quantity;
      return totals;
    },
    {},
  );

  for (const [stockId, quantity] of Object.entries(quantityByStockId)) {
    const current = stocksById.get(stockId);
    if (!current) throw new Error("仓库 SKU 库存不存在，请刷新后重试");
    if (current.stock_quantity < quantity) {
      throw new Error(`仓库 SKU 库存不足：当前 ${current.stock_quantity}，需要 ${quantity}`);
    }
  }

  const inventory: WarehouseSkuStockInventoryChange[] = [];
  for (const [stockId, quantity] of Object.entries(quantityByStockId)) {
    const current = stocksById.get(stockId);
    if (!current) throw new Error("仓库 SKU 库存不存在，请刷新后重试");

    const nextQuantity = current.stock_quantity - quantity;
    const nextSku = await updateWarehouseSkuStockQuantity(current, nextQuantity);
    inventory.push({
      sku: nextSku,
      previous_quantity: current.stock_quantity,
      change_quantity: -quantity,
    });
  }

  return inventory;
}

export async function restoreWarehouseSkuStocks(
  restorations: WarehouseSkuStockDeductionInput[],
) {
  const normalizedRestorations = restorations
    .map((restoration) => ({
      stockId: restoration.stockId,
      quantity: Math.trunc(Number(restoration.quantity) || 0),
    }))
    .filter((restoration) => restoration.quantity > 0);

  if (normalizedRestorations.length === 0) {
    return [] as WarehouseSkuStockInventoryChange[];
  }

  const { supabase } = await requireSession();
  const stockIds = Array.from(new Set(normalizedRestorations.map((item) => item.stockId)));
  const { data: stockData, error: stockLoadError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, owner_id, stock_quantity, created_at, updated_at")
      .in("id", stockIds),
    "读取 SKU 库存",
  );

  if (stockLoadError) throw stockLoadError;

  const stocksById = new Map(
    ((stockData ?? []) as WarehouseSku[]).map((item) => [item.id, item]),
  );
  const quantityByStockId = normalizedRestorations.reduce<Record<string, number>>(
    (totals, restoration) => {
      totals[restoration.stockId] = (totals[restoration.stockId] ?? 0) + restoration.quantity;
      return totals;
    },
    {},
  );

  const inventory: WarehouseSkuStockInventoryChange[] = [];
  for (const [stockId, quantity] of Object.entries(quantityByStockId)) {
    const current = stocksById.get(stockId);
    if (!current) throw new Error("仓库 SKU 库存不存在，请刷新后重试");

    const nextQuantity = current.stock_quantity + quantity;
    const nextSku = await updateWarehouseSkuStockQuantity(current, nextQuantity);
    inventory.push({
      sku: nextSku,
      previous_quantity: current.stock_quantity,
      change_quantity: quantity,
    });
  }

  return inventory;
}

export async function reserveWarehouseSkuStockForOrder(
  reservation: WarehouseSkuStockReservationInput,
) {
  const quantity = Math.trunc(Number(reservation.quantity) || 0);
  if (!reservation.orderId || !reservation.stockId || quantity <= 0) {
    return [] as WarehouseSkuStockInventoryChange[];
  }

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("reserve_order_sku_inventory", {
      p_order_id: reservation.orderId,
      p_warehouse_sku_id: reservation.stockId,
      p_quantity: quantity,
      p_reason: reservation.reason ?? "",
    }),
    "占用订单 SKU 库存",
  );

  if (error) throw error;
  return parseWarehouseSkuStockInventoryChanges(data);
}

export async function releaseWarehouseSkuStockForOrder(
  orderId: string,
  reason?: string,
) {
  if (!orderId) return [] as WarehouseSkuStockInventoryChange[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("release_order_sku_inventory", {
      p_order_id: orderId,
      p_reason: reason ?? "",
    }),
    "释放订单 SKU 库存",
  );

  if (error) throw error;
  return parseWarehouseSkuStockInventoryChanges(data);
}

type WarehouseItemStockInventoryChange = {
  item: WarehouseItemStock;
  adjustment: WarehouseItemStockAdjustment;
};

const orderOutboundReasonPrefix = "订单出库：";
const legacyOrderOutboundReasonPrefix = "出库：";

function getOrderOutboundReasonCandidates(outboundReason: string) {
  const reason = outboundReason.trim();
  if (!reason) return [];

  const legacyLabel = reason.startsWith(legacyOrderOutboundReasonPrefix)
    ? reason.slice(legacyOrderOutboundReasonPrefix.length)
    : "";
  if (legacyLabel) {
    return Array.from(
      new Set([
        `${orderOutboundReasonPrefix}${legacyLabel}`,
        `${legacyOrderOutboundReasonPrefix}${legacyLabel}`,
      ]),
    );
  }

  const standardLabel = reason.startsWith(orderOutboundReasonPrefix)
    ? reason.slice(orderOutboundReasonPrefix.length)
    : "";
  if (standardLabel) {
    return Array.from(
      new Set([
        `${orderOutboundReasonPrefix}${standardLabel}`,
        `${legacyOrderOutboundReasonPrefix}${standardLabel}`,
      ]),
    );
  }

  return [reason];
}

export type AtomicDeductionGroup = {
  groupId: string;
  dedupeKey?: string;
  deductions: WarehouseItemStockDeductionInput[];
};

export type AtomicDeductionResult = {
  results: {
    id: string;
    warehouse_id: string;
    item_id: string;
    stock_quantity: number;
    adjustment_id: string;
    previous_quantity: number;
    change_quantity: number;
    reason: string;
  }[];
  failures: {
    groupId: string;
    detail: {
      message: string;
      stockId: string;
      itemId?: string;
      requiredQuantity: number;
      currentQuantity: number;
    };
  }[];
};

export async function deductWarehouseItemStocksAtomic(
  groups: AtomicDeductionGroup[],
) {
  if (groups.length === 0) {
    return { results: [], failures: [] } as AtomicDeductionResult;
  }

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("deduct_inventory_atomic", { order_groups: groups }),
    "执行库存原子扣减",
  );

  if (error) {
    throw new Error(`批量库存扣减失败: ${error.message}`);
  }

  return data as unknown as AtomicDeductionResult;
}


export async function deductWarehouseItemStocksLegacy(
  deductions: WarehouseItemStockDeductionInput[],
) {
  const normalizedDeductions = deductions
    .map((deduction) => ({
      ...deduction,
      quantity: Math.trunc(deduction.quantity),
    }))
    .filter((deduction) => deduction.quantity > 0);

  if (normalizedDeductions.length === 0) {
    return [] as WarehouseItemStockInventoryChange[];
  }

  const { supabase } = await requireSession();
  const inventory: WarehouseItemStockInventoryChange[] = [];
  const stockIds = Array.from(new Set(normalizedDeductions.map((item) => item.stockId)));
  const { data: stockData, error: stockLoadError } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .in("id", stockIds),
    "读取配件库存",
  );

  if (stockLoadError) throw stockLoadError;

  const stocksById = new Map(
    ((stockData ?? []) as WarehouseItemStock[]).map((item) => [item.id, item]),
  );
  const activeDeductions: Array<WarehouseItemStockDeductionInput & {
    quantity: number;
  }> = [];

  for (const deduction of normalizedDeductions) {
    const current = stocksById.get(deduction.stockId);
    if (!current) throw new Error("仓库配件库存不存在，请刷新后重试");
    if (deduction.dedupeKey) {
      const relatedReasons = [
        deduction.reason,
        deduction.reversalReason ?? `删除订单冲回：${deduction.dedupeKey}`,
      ];
      const { data: existingAdjustments, error: existingAdjustmentError } =
        await withTimeout(
          supabase
            .from("warehouse_item_stock_adjustments")
            .select("change_quantity")
            .eq("warehouse_id", current.warehouse_id)
            .eq("item_id", current.item_id)
            .in("reason", relatedReasons),
          "检查库存出库记录",
        );

      if (existingAdjustmentError) throw existingAdjustmentError;
      const netChange = (existingAdjustments ?? []).reduce(
        (total, adjustment) =>
          total + Math.trunc(Number(adjustment.change_quantity) || 0),
        0,
      );
      if (netChange < 0) continue;
    }

    activeDeductions.push(deduction);
  }

  const quantityByStockId = activeDeductions.reduce<Record<string, number>>(
    (totals, deduction) => {
      totals[deduction.stockId] = (totals[deduction.stockId] ?? 0) + deduction.quantity;
      return totals;
    },
    {},
  );
  for (const [stockId, quantity] of Object.entries(quantityByStockId)) {
    const current = stocksById.get(stockId);
    if (!current) throw new Error("仓库配件库存不存在，请刷新后重试");
    if (current.stock_quantity < quantity) {
      throw new Error(
        `仓库配件库存不足：当前 ${current.stock_quantity}，需要 ${quantity}`,
      );
    }
  }

  for (const deduction of activeDeductions) {
    const { data: currentData, error: currentError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .select("id, warehouse_id, item_id, stock_quantity")
        .eq("id", deduction.stockId)
        .maybeSingle(),
      "读取配件库存",
    );

    if (currentError) throw currentError;
    if (!currentData) throw new Error("仓库配件库存不存在，请刷新后重试");

    const current = currentData as WarehouseItemStock;
    const nextQuantity = current.stock_quantity - deduction.quantity;
    const { data: nextData, error: nextError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .update({ stock_quantity: nextQuantity })
        .eq("id", current.id)
        .eq("stock_quantity", current.stock_quantity)
        .select("id, warehouse_id, item_id, stock_quantity")
        .maybeSingle(),
      "扣减配件库存",
    );

    if (nextError) throw nextError;
    if (!nextData) throw new Error("库存已被其他操作更新，请刷新后重试");

    const nextItem = nextData as WarehouseItemStock;
    const { data: adjustmentData, error: adjustmentError } = await withTimeout(
      supabase
        .from("warehouse_item_stock_adjustments")
        .insert({
          warehouse_id: current.warehouse_id,
          item_id: current.item_id,
          previous_quantity: current.stock_quantity,
          next_quantity: nextItem.stock_quantity,
          change_quantity: -deduction.quantity,
          reason: deduction.reason,
          purchase_order_id: null,
          purchase_package_id: null,
        })
        .select("id")
        .single(),
      "保存库存出库记录",
    );

    if (adjustmentError) throw adjustmentError;
    inventory.push({
      item: nextItem,
      adjustment: adjustmentData as WarehouseItemStockAdjustment,
    });
  }

  return inventory;
}

export type WarehouseItemStockRestorationInput = {
  outboundReason: string;
  reversalReason: string;
  /**
   * 预期至少应找到并冲回的扣减记录数量（以涉及的唯一 item 数计）。
   * 传入正整数时，若实际匹配到的净扣减记录为 0，则抛出异常阻止后续操作。
   * 不传（或传 0）时，匹配不到记录视为正常（该订单本就没有库存扣减）。
   */
  expectedDeductionCount?: number;
};

export async function restoreWarehouseItemStockDeductions(
  restorations: WarehouseItemStockRestorationInput[],
) {
  const normalizedRestorations = Array.from(
    new Map(
      restorations
        .map((restoration) => ({
          outboundReason: restoration.outboundReason.trim(),
          outboundReasons: getOrderOutboundReasonCandidates(restoration.outboundReason),
          reversalReason: restoration.reversalReason.trim(),
          expectedDeductionCount: restoration.expectedDeductionCount,
        }))
        .filter((restoration) => restoration.outboundReasons.length > 0 && restoration.reversalReason)
        .map((restoration) => [
          `${restoration.outboundReason}\u0000${restoration.reversalReason}`,
          restoration,
        ]),
    ).values(),
  );

  if (normalizedRestorations.length === 0) {
    return [] as WarehouseItemStockInventoryChange[];
  }

  const { supabase } = await requireSession();
  const reasons = Array.from(
    new Set(
      normalizedRestorations.flatMap((restoration) => [
        ...restoration.outboundReasons,
        restoration.reversalReason,
      ]),
    ),
  );

  const { data: adjustmentData, error: adjustmentError } = await withTimeout(
    supabase
      .from("warehouse_item_stock_adjustments")
      .select("warehouse_id, item_id, change_quantity, reason")
      .in("reason", reasons),
    "读取订单库存流水",
  );

  if (adjustmentError) throw adjustmentError;

  const adjustments = (adjustmentData ?? []) as WarehouseItemStockAdjustment[];
  const inventory: WarehouseItemStockInventoryChange[] = [];

  for (const restoration of normalizedRestorations) {
    const netChangesByStock = new Map<
      string,
      {
        warehouseId: string;
        itemId: string;
        netChange: number;
      }
    >();

    adjustments.forEach((adjustment) => {
      if (
        !restoration.outboundReasons.includes(adjustment.reason) &&
        adjustment.reason !== restoration.reversalReason
      ) {
        return;
      }

      const changeQuantity = Math.trunc(Number(adjustment.change_quantity) || 0);
      if (changeQuantity === 0) return;

      const key = `${adjustment.warehouse_id}\u0000${adjustment.item_id}`;
      const current = netChangesByStock.get(key) ?? {
        warehouseId: adjustment.warehouse_id,
        itemId: adjustment.item_id,
        netChange: 0,
      };
      current.netChange += changeQuantity;
      netChangesByStock.set(key, current);
    });

    // 若调用方声明预期有库存扣减记录，但实际未匹配到任何净扣减，则报错阻止继续
    if (
      restoration.expectedDeductionCount !== undefined &&
      restoration.expectedDeductionCount > 0 &&
      !Array.from(netChangesByStock.values()).some((s) => s.netChange < 0)
    ) {
      console.error(
        `[库存冲回] 未找到匹配的扣减记录。出库原因："${restoration.outboundReason}"，冲回原因："${restoration.reversalReason}"`,
      );
      throw new Error("库存回补失败，订单未删除，请联系管理员处理");
    }

    for (const stockChange of netChangesByStock.values()) {
      if (stockChange.netChange >= 0) continue;

      const restoreQuantity = -stockChange.netChange;
      const { data: currentData, error: currentError } = await withTimeout(
        supabase
          .from("warehouse_item_stocks")
          .select("id, warehouse_id, item_id, stock_quantity")
          .eq("warehouse_id", stockChange.warehouseId)
          .eq("item_id", stockChange.itemId)
          .maybeSingle(),
        "读取配件库存",
      );

      if (currentError) throw currentError;
      if (!currentData) throw new Error("仓库配件库存不存在，请刷新后重试");

      const current = currentData as WarehouseItemStock;
      const nextQuantity = current.stock_quantity + restoreQuantity;
      const { data: nextData, error: nextError } = await withTimeout(
        supabase
          .from("warehouse_item_stocks")
          .update({ stock_quantity: nextQuantity })
          .eq("id", current.id)
          .eq("stock_quantity", current.stock_quantity)
          .select("id, warehouse_id, item_id, stock_quantity")
          .maybeSingle(),
        "回补配件库存",
      );

      if (nextError) throw nextError;
      if (!nextData) throw new Error("库存已被其他操作更新，请刷新后重试");

      const nextItem = nextData as WarehouseItemStock;
      const { data: reversalData, error: reversalError } = await withTimeout(
        supabase
          .from("warehouse_item_stock_adjustments")
          .insert({
            warehouse_id: current.warehouse_id,
            item_id: current.item_id,
            previous_quantity: current.stock_quantity,
            next_quantity: nextItem.stock_quantity,
            change_quantity: restoreQuantity,
            reason: restoration.reversalReason,
            purchase_order_id: null,
            purchase_package_id: null,
          })
          .select("id")
          .single(),
        "保存订单删除回补记录",
      );

      if (reversalError) throw reversalError;
      inventory.push({
        item: nextItem,
        adjustment: reversalData as WarehouseItemStockAdjustment,
      });
    }
  }

  return inventory;
}
