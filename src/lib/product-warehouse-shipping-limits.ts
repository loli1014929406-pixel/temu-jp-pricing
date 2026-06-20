import { requireSession, withTimeout } from "./supabase-helpers";
import type { ProductWarehouseShippingLimit, Warehouse } from "../types";

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
}

function isMissingLimitsTableError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("product_warehouse_shipping_limits") &&
    (message.includes("schema cache") ||
      message.includes("does not exist") ||
      message.includes("relation") ||
      message.includes("could not find"))
  );
}

function normalizeLimit(row: Partial<ProductWarehouseShippingLimit>): ProductWarehouseShippingLimit {
  return {
    id: row.id,
    owner_id: row.owner_id,
    product_id: row.product_id,
    warehouse_id: String(row.warehouse_id ?? ""),
    max_units_per_parcel: Math.max(
      1,
      Math.trunc(Number(row.max_units_per_parcel) || 1),
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function buildWarehouseShippingLimits(
  warehouses: Warehouse[],
  existingLimits: ProductWarehouseShippingLimit[],
) {
  const limitByWarehouseId = new Map(
    existingLimits.map((limit) => [limit.warehouse_id, limit.max_units_per_parcel]),
  );

  return warehouses.map<ProductWarehouseShippingLimit>((warehouse) => ({
    warehouse_id: warehouse.id,
    max_units_per_parcel: Math.max(
      1,
      Math.trunc(Number(limitByWarehouseId.get(warehouse.id)) || 1),
    ),
  }));
}

export async function fetchProductWarehouseShippingLimits(productId: string) {
  if (!productId) return [] as ProductWarehouseShippingLimit[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("product_warehouse_shipping_limits")
      .select("id, owner_id, product_id, warehouse_id, max_units_per_parcel, created_at, updated_at")
      .eq("product_id", productId)
      .order("created_at", { ascending: true }),
    "加载3cm最大数",
  );

  if (error && isMissingLimitsTableError(error)) {
    return [];
  }
  if (error) throw error;
  return ((data ?? []) as Partial<ProductWarehouseShippingLimit>[]).map(normalizeLimit);
}

export async function upsertProductWarehouseShippingLimits(
  productId: string,
  limits: ProductWarehouseShippingLimit[],
) {
  if (!productId || limits.length === 0) return;

  const { supabase, session } = await requireSession();
  const rows = limits
    .filter((limit) => limit.warehouse_id)
    .map((limit) => ({
      owner_id: session.user.id,
      product_id: productId,
      warehouse_id: limit.warehouse_id,
      max_units_per_parcel: Math.max(
        1,
        Math.trunc(Number(limit.max_units_per_parcel) || 1),
      ),
    }));

  if (rows.length === 0) return;

  const { error } = await withTimeout(
    supabase
      .from("product_warehouse_shipping_limits")
      .upsert(rows, { onConflict: "product_id,warehouse_id" }),
    "保存3cm最大数",
  );

  if (error && isMissingLimitsTableError(error)) {
    throw new Error("数据库还没有 product_warehouse_shipping_limits 表，请先执行最新迁移。");
  }
  if (error) throw error;
}
