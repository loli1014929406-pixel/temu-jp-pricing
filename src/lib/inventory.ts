import { withTimeout, requireSession } from "./supabase-helpers";
import type {
  Warehouse,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
  WarehouseSku,
} from "../types";

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

type WarehouseInventoryTransferResult = {
  warehouseSkus: WarehouseSku[];
  itemStocks: WarehouseItemStock[];
  adjustments: WarehouseItemStockAdjustment[];
};

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

  const { supabase, session } = await requireSession();
  const itemIds = transferItems.map((item) => item.itemId);

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
    "准备调入仓库 SKU",
  );
  if (skuUpsertError) throw skuUpsertError;

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
    "准备调入仓库配件库存",
  );
  if (itemStockUpsertError) throw itemStockUpsertError;

  const [
    { data: destinationSkuData, error: destinationSkuError },
    { data: destinationStockData, error: destinationStockError },
  ] = await Promise.all([
    supabase
      .from("warehouse_skus")
      .select("id, warehouse_id, product_id, sku_id, created_at")
      .eq("warehouse_id", destinationWarehouseId)
      .in("sku_id", Array.from(new Set(transferLines.map((line) => line.skuId)))),
    supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .eq("warehouse_id", destinationWarehouseId)
      .in("item_id", itemIds),
  ]);
  if (destinationSkuError) throw destinationSkuError;
  if (destinationStockError) throw destinationStockError;

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
    throw new Error("调入仓库配件库存准备失败，请刷新后重试");
  }

  const skuLabel = transferLines
    .map((line) => `${line.skuLabel || line.skuId} x${line.quantity}`)
    .join("；");
  const reasonLabel = `${input.sourceWarehouseName || sourceWarehouseId} -> ${
    input.destinationWarehouseName || destinationWarehouseId
  } / ${skuLabel} / 调拨日期：${transferDate} / 快递单号：${trackingNo}`;
  const updatedStocks: WarehouseItemStock[] = [];
  const adjustments: WarehouseItemStockAdjustment[] = [];

  for (const transferItem of transferItems) {
    const sourceStock = sourceStocksByItemId.get(transferItem.itemId);
    const destinationStock = destinationStocksByItemId.get(transferItem.itemId);
    if (!sourceStock || !destinationStock) continue;

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
            reason: `库存调拨出库：${reasonLabel}`,
            purchase_order_id: null,
            purchase_package_id: null,
          })
          .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason, created_at")
          .single(),
        "保存调拨出库记录",
      );
    if (sourceAdjustmentError) throw sourceAdjustmentError;

    const nextDestinationQuantity =
      destinationStock.stock_quantity + transferItem.quantity;
    const { data: nextDestinationStockData, error: destinationUpdateError } =
      await withTimeout(
        supabase
          .from("warehouse_item_stocks")
          .update({ stock_quantity: nextDestinationQuantity })
          .eq("id", destinationStock.id)
          .eq("stock_quantity", destinationStock.stock_quantity)
          .select("id, warehouse_id, item_id, stock_quantity")
          .maybeSingle(),
        "增加调入仓库库存",
      );
    if (destinationUpdateError) throw destinationUpdateError;
    if (!nextDestinationStockData) {
      throw new Error("库存已被其他操作更新，请刷新后重试");
    }

    const nextDestinationStock = nextDestinationStockData as WarehouseItemStock;
    const { data: destinationAdjustmentData, error: destinationAdjustmentError } =
      await withTimeout(
        supabase
          .from("warehouse_item_stock_adjustments")
          .insert({
            warehouse_id: destinationStock.warehouse_id,
            item_id: destinationStock.item_id,
            previous_quantity: destinationStock.stock_quantity,
            next_quantity: nextDestinationStock.stock_quantity,
            change_quantity: transferItem.quantity,
            reason: `库存调拨入库：${reasonLabel}`,
            purchase_order_id: null,
            purchase_package_id: null,
          })
          .select("id, warehouse_id, item_id, previous_quantity, next_quantity, change_quantity, reason, created_at")
          .single(),
        "保存调拨入库记录",
      );
    if (destinationAdjustmentError) throw destinationAdjustmentError;

    updatedStocks.push(nextSourceStock, nextDestinationStock);
    adjustments.push(
      sourceAdjustmentData as WarehouseItemStockAdjustment,
      destinationAdjustmentData as WarehouseItemStockAdjustment,
    );
  }

  return {
    warehouseSkus: (destinationSkuData ?? []) as WarehouseSku[],
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
