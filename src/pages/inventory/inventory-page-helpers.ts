import type { Warehouse, WarehouseLogisticsMethod, WarehouseSku } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { TABLE_COLUMN_WIDTH } from "../../components/ui/table-layout";

export const inventoryTableColumns = [
  { key: "product_code", width: TABLE_COLUMN_WIDTH.short },
  { key: "product_name", width: TABLE_COLUMN_WIDTH.content },
  { key: "sku_code", width: TABLE_COLUMN_WIDTH.medium },
  { key: "sales_spec", width: TABLE_COLUMN_WIDTH.content },
  { key: "stock", width: TABLE_COLUMN_WIDTH.short },
  { key: "components", width: TABLE_COLUMN_WIDTH.short },
  { key: "actions", width: TABLE_COLUMN_WIDTH.short },
] as const;

export type InventoryDraft = {
  draftWarehouseName: string;
  draftLogisticsMethodName: string;
  selectedProductIds: Record<string, string>;
  itemStockDrafts: Record<string, string>;
  itemStockReasonDrafts: Record<string, string>;
  warehouseNameDrafts: Record<string, string>;
};

export const knownWarehouseSlugRules = [
  { slug: "suzhou", names: ["苏州", "suzhou"] },
  { slug: "fugang", names: ["福冈", "福岡", "fugang", "fukuoka"] },
] as const;

export function normalizeWarehouseRouteText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[仓庫库]/g, "");
}

export function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getWarehouseRouteSlug(warehouse: Pick<Warehouse, "name" | "id">) {
  const normalizedName = normalizeWarehouseRouteText(warehouse.name);
  const knownRule = knownWarehouseSlugRules.find((rule) =>
    rule.names.some((name) => normalizeWarehouseRouteText(name) === normalizedName),
  );
  if (knownRule) return knownRule.slug;

  const asciiSlug = warehouse.name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return asciiSlug || encodeURIComponent(warehouse.name.trim() || warehouse.id);
}

export function isWarehouseRouteMatch(warehouse: Warehouse, routeSlug: string) {
  const decodedRouteSlug = decodeRouteSegment(routeSlug);
  const normalizedRouteSlug = normalizeWarehouseRouteText(decodedRouteSlug);
  const normalizedWarehouseName = normalizeWarehouseRouteText(warehouse.name);
  const normalizedGeneratedSlug = normalizeWarehouseRouteText(
    decodeRouteSegment(getWarehouseRouteSlug(warehouse)),
  );

  return (
    normalizedRouteSlug === normalizedGeneratedSlug ||
    normalizedRouteSlug === normalizedWarehouseName
  );
}

export function getWarehouseRouteLabel(routeSlug: string) {
  const decodedRouteSlug = decodeRouteSegment(routeSlug);
  const normalizedRouteSlug = normalizeWarehouseRouteText(decodedRouteSlug);
  const knownRule = knownWarehouseSlugRules.find(
    (rule) => normalizeWarehouseRouteText(rule.slug) === normalizedRouteSlug,
  );
  return knownRule?.names[0] ?? decodedRouteSlug;
}

export function hasInventoryDraft(
  draft: InventoryDraft | null | undefined,
  skuStockValuesById: Record<string, string> = {},
) {
  if (!draft) return false;

  return Boolean(
    draft.draftWarehouseName.trim() ||
    draft.draftLogisticsMethodName?.trim() ||
    Object.values(draft.selectedProductIds).some(Boolean) ||
    Object.values(draft.itemStockReasonDrafts).some((value) => value.trim()) ||
    Object.values(draft.warehouseNameDrafts).some((value) => value.trim()) ||
    Object.entries(draft.itemStockDrafts).some(
      ([skuStockId, value]) =>
        skuStockValuesById[skuStockId] === undefined || value !== skuStockValuesById[skuStockId],
    ),
  );
}

export function getInventoryErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const code = String(error.code);
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "42P01") {
      if (
        message.includes("public.logistics_methods") ||
        message.includes("public.warehouse_logistics_methods")
      ) {
        return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613000000_add_warehouse_logistics_methods.sql 迁移";
      }
      if (
        message.includes("public.warehouses") ||
        message.includes("public.warehouse_skus") ||
        message.includes("public.warehouse_item_stocks") ||
        message.includes("public.warehouse_item_stock_adjustments")
      ) {
        return "库存数据库还没有初始化，请先执行最新的库存表迁移";
      }
    }
  }

  const message = getErrorMessage(error, fallback);
  if (
    message.includes("public.logistics_methods") ||
    message.includes("public.warehouse_logistics_methods")
  ) {
    return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613000000_add_warehouse_logistics_methods.sql 迁移";
  }
  return message.includes("public.warehouses") ||
    message.includes("public.warehouse_skus") ||
    message.includes("public.warehouse_item_stocks") ||
    message.includes("public.warehouse_item_stock_adjustments")
    ? "库存数据库还没有初始化，请先执行最新的库存表迁移"
    : message;
}

export function parseStockDraftValue(item: Pick<WarehouseSku, "stock_quantity">, value: string) {
  const text = value.trim();
  if (!text) {
    return { stockQuantity: item.stock_quantity, errorMessage: "" };
  }

  const quantity = Number(text);
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity)) {
    return { stockQuantity: item.stock_quantity, errorMessage: "请填写整数库存数量。" };
  }

  const isDeltaInput = /^[+-]/.test(text);
  const stockQuantity = isDeltaInput ? item.stock_quantity + quantity : quantity;
  if (stockQuantity < 0) {
    return {
      stockQuantity: item.stock_quantity,
      errorMessage: `库存不能小于 0，当前库存 ${item.stock_quantity}。`,
    };
  }

  return { stockQuantity, errorMessage: "" };
}

export function groupWarehouseLogisticsMethodIds(links: WarehouseLogisticsMethod[]) {
  return links.reduce<Record<string, string[]>>((groups, item) => {
    groups[item.warehouse_id] ??= [];
    groups[item.warehouse_id].push(item.logistics_method_id);
    return groups;
  }, {});
}
