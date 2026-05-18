import { getSupabaseClient } from "./supabase";
import type {
  Warehouse,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
  WarehouseSku,
} from "../types";

const requestTimeoutMs = 15000;

async function withTimeout<T>(promise: PromiseLike<T>, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}超时，请稍后重试`)),
      requestTimeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requireSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  return { supabase, session };
}

export async function fetchWarehouses() {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .select("*")
      .eq("owner_id", session.user.id)
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
      .select()
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
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .update(updates)
      .eq("id", warehouseId)
      .eq("owner_id", session.user.id)
      .select()
      .single(),
    "更新仓库",
  );

  if (error) throw error;
  return data as Warehouse;
}

export async function deleteWarehouse(warehouseId: string) {
  const { supabase, session } = await requireSession();
  const { error } = await withTimeout(
    supabase
      .from("warehouses")
      .delete()
      .eq("id", warehouseId)
      .eq("owner_id", session.user.id),
    "删除仓库",
  );

  if (error) throw error;
}

export async function fetchWarehouseSkus(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseSku[];

  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("*")
      .in("warehouse_id", warehouseIds)
      .eq("owner_id", session.user.id)
      .order("created_at", { ascending: true }),
    "加载库存 SKU",
  );

  if (error) throw error;
  return data as WarehouseSku[];
}

export async function fetchWarehouseItemStocks(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseItemStock[];

  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .select("*")
      .in("warehouse_id", warehouseIds)
      .eq("owner_id", session.user.id)
      .order("created_at", { ascending: true }),
    "加载仓库配件库存",
  );

  if (error) throw error;
  return data as WarehouseItemStock[];
}

export async function fetchWarehouseItemStockAdjustments(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseItemStockAdjustment[];

  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stock_adjustments")
      .select("*")
      .in("warehouse_id", warehouseIds)
      .eq("owner_id", session.user.id)
      .order("created_at", { ascending: false }),
    "加载库存调整记录",
  );

  if (error) throw error;
  return data as WarehouseItemStockAdjustment[];
}

export async function addWarehouseProductInventory(
  warehouseId: string,
  productId: string,
  skuIds: string[],
  itemIds: string[],
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
      .select(),
    "添加库存 SKU",
  );

  if (skuError) throw skuError;

  let itemRows = [] as WarehouseItemStock[];
  if (itemIds.length > 0) {
    const { data, error } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .insert(
          itemIds.map((itemId) => ({
            warehouse_id: warehouseId,
            item_id: itemId,
          })),
        )
        .select(),
      "添加仓库配件库存",
    );

    if (error) throw error;
    itemRows = data as WarehouseItemStock[];
  }

  return {
    skus: skuRows as WarehouseSku[],
    itemStocks: itemRows,
  };
}

export async function removeWarehouseProduct(
  warehouseId: string,
  productId: string,
  itemIds: string[],
) {
  const { supabase, session } = await requireSession();
  const { error: skuError } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .delete()
      .eq("warehouse_id", warehouseId)
      .eq("product_id", productId)
      .eq("owner_id", session.user.id),
    "移除库存商品",
  );

  if (skuError) throw skuError;

  if (itemIds.length > 0) {
    const { error: itemError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .delete()
        .eq("warehouse_id", warehouseId)
        .in("item_id", itemIds)
        .eq("owner_id", session.user.id),
      "移除仓库配件库存",
    );

    if (itemError) throw itemError;
  }
}

export async function updateWarehouseItemStock(
  item: WarehouseItemStock,
  stockQuantity: number,
  reason: string,
) {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: stockQuantity })
      .eq("id", item.id)
      .eq("owner_id", session.user.id)
      .select()
      .single(),
    "更新配件库存",
  );

  if (error) throw error;

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
      .select()
      .single(),
    "保存库存调整记录",
  );

  if (adjustmentError) throw adjustmentError;
  return {
    item: nextItem,
    adjustment: adjustment as WarehouseItemStockAdjustment,
  };
}
