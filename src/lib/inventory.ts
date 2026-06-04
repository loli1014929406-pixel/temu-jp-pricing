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
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouses")
      .select("id, name")
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
      .select("id, name")
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
      .select("id, name")
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

export async function fetchWarehouseSkus(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseSku[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, created_at")
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
      .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason")
      .in("warehouse_id", warehouseIds)
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
      .select("id, warehouse_id, product_id, sku_id, created_at"),
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
        .select("id, warehouse_id, item_id, stock_quantity"),
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

  if (itemIds.length > 0) {
    const { error: itemError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .delete()
        .eq("warehouse_id", warehouseId)
        .in("item_id", itemIds),
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
      .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason")
      .single(),
    "保存库存调整记录",
  );

  if (adjustmentError) throw adjustmentError;
  return {
    item: nextItem,
    adjustment: adjustment as WarehouseItemStockAdjustment,
  };
}

export type WarehouseItemStockDeductionInput = {
  stockId: string;
  quantity: number;
  reason: string;
  dedupeKey?: string;
  reversalReason?: string;
};

type WarehouseItemStockInventoryChange = {
  item: WarehouseItemStock;
  adjustment: WarehouseItemStockAdjustment;
};

export async function deductWarehouseItemStocks(
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
};

export async function restoreWarehouseItemStockDeductions(
  restorations: WarehouseItemStockRestorationInput[],
) {
  const normalizedRestorations = Array.from(
    new Map(
      restorations
        .map((restoration) => ({
          outboundReason: restoration.outboundReason.trim(),
          reversalReason: restoration.reversalReason.trim(),
        }))
        .filter((restoration) => restoration.outboundReason && restoration.reversalReason)
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
        restoration.outboundReason,
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
        adjustment.reason !== restoration.outboundReason &&
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
