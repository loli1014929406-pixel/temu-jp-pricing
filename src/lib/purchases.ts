import { withTimeout, requireSession } from "./supabase-helpers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderSource,
  PurchasePackage,
  PurchasePackageItem,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
} from "../types";

function getReceiptStatus(
  items: PurchaseOrderItem[],
  packages: PurchasePackage[],
): PurchaseOrder["status"] {
  if (items.length === 0) return "pending";

  const receivedQuantityByItemId = packages
    .filter((pkg) => pkg.status === "received")
    .flatMap((pkg) => pkg.items)
    .reduce<Record<string, number>>((quantities, item) => {
      quantities[item.order_item_id] = (quantities[item.order_item_id] ?? 0) + item.quantity;
      return quantities;
    }, {});
  const hasReceivedItems = Object.values(receivedQuantityByItemId).some((quantity) => quantity > 0);
  if (!hasReceivedItems) return "pending";

  return items.every((item) => (receivedQuantityByItemId[item.id] ?? 0) >= item.quantity)
    ? "received"
    : "partially_received";
}

type ResolvedPackageItem = {
  packageItem: PurchasePackageItem;
  orderItem: PurchaseOrderItem & { item_id: string; product_id: string };
  resolvedMissingItemId: boolean;
};

type PurchaseInventoryReversal = {
  packageId: string;
  itemId: string;
  itemName: string;
  quantity: number;
};

type PurchaseInventoryReceipt = {
  orderItem: PurchaseOrderItem & { item_id: string; product_id: string };
  quantity: number;
};

function getItemIdentity(item: Pick<PurchaseOrderItem, "item_name" | "item_spec">) {
  return `${item.item_name.trim()}\u0000${item.item_spec.trim()}`;
}

function hasValue(value: string | null | undefined) {
  return typeof value === "string" && value.trim() !== "";
}

async function resolvePackageItems(
  order: PurchaseOrder,
  pkg: PurchasePackage,
): Promise<ResolvedPackageItem[]> {
  const { supabase } = await requireSession();
  const itemsById = Object.fromEntries(order.items.map((item) => [item.id, item]));
  const missingProductIds = Array.from(
    new Set(
      pkg.items.flatMap((packageItem) => {
        const item = itemsById[packageItem.order_item_id];
        return item?.product_id && !hasValue(item.item_id) ? [item.product_id] : [];
      }),
    ),
  );
  const { data: productItems, error: productItemsError } = missingProductIds.length === 0
    ? { data: [] as Array<{ id: string; product_id: string; item_name: string; item_spec: string }>, error: null }
    : await supabase
        .from("product_items")
        .select("id, product_id, item_name, item_spec")
        .in("product_id", missingProductIds);
  if (productItemsError) throw productItemsError;

  const productItemsByKey = (productItems ?? []).reduce<Record<string, string>>((items, item) => {
    items[`${item.product_id}\u0000${item.item_name.trim()}\u0000${item.item_spec.trim()}`] = item.id;
    return items;
  }, {});

  return pkg.items.flatMap((packageItem) => {
    const item = itemsById[packageItem.order_item_id];
    if (!item?.product_id) return [];
    const resolvedMissingItemId = !hasValue(item.item_id);
    const itemId = !resolvedMissingItemId
      ? item.item_id
      : productItemsByKey[`${item.product_id}\u0000${getItemIdentity(item)}`];
    return itemId
      ? [{
          packageItem,
          orderItem: { ...item, product_id: item.product_id, item_id: itemId },
          resolvedMissingItemId,
        }]
      : [];
  });
}

async function persistResolvedPurchaseItemIds(
  supabase: SupabaseClient,
  ownerId: string,
  resolvedItems: ResolvedPackageItem[],
) {
  const updates = resolvedItems.filter(
    ({ resolvedMissingItemId }) => resolvedMissingItemId,
  );
  if (updates.length === 0) return;

  const results = await Promise.all(
    updates.map(({ orderItem }) =>
      supabase
        .from("purchase_order_items")
        .update({ item_id: orderItem.item_id })
        .eq("id", orderItem.id)
        .eq("owner_id", ownerId)
        .is("item_id", null)
        .select("id")
        .maybeSingle(),
    ),
  );
  const failedUpdate = results.find((result) => result.error);
  if (failedUpdate?.error) throw failedUpdate.error;

  // 对于没有匹配到行（item_id 已非 NULL）的情况，
  // 验证数据库里的值是否已经是期望值，是则幂等通过，否则才报错
  const missedUpdates = updates.filter((_, i) => !results[i].data);
  if (missedUpdates.length === 0) return;

  const missedIds = missedUpdates.map(({ orderItem }) => orderItem.id);
  const { data: existingRows, error: existingError } = await supabase
    .from("purchase_order_items")
    .select("id, item_id")
    .in("id", missedIds)
    .eq("owner_id", ownerId);
  if (existingError) throw existingError;

  const existingById = Object.fromEntries(
    (existingRows ?? []).map((row) => [row.id, row.item_id]),
  );
  const trueFailure = missedUpdates.find(
    ({ orderItem }) => existingById[orderItem.id] !== orderItem.item_id,
  );
  if (trueFailure) throw new Error("采购明细配件绑定未能写入，请刷新后重试");
}

export async function fetchPurchaseOrders() {
  const { supabase, session } = await requireSession();
  const { data: ordersData, error: ordersError } = await withTimeout(
    supabase.from("purchase_orders").select("id, order_code, warehouse_id, warehouse_name, purchased_at, items_total_rmb, total_cost_rmb, status").eq("owner_id", session.user.id).order("created_at", { ascending: false }),
    "加载采购单",
  );
  if (ordersError) throw ordersError;
  const orders = ordersData as Omit<PurchaseOrder, "sources" | "items" | "packages">[];
  if (orders.length === 0) return [] as PurchaseOrder[];
  const orderIds = orders.map((item) => item.id);
  const [{ data: sourcesData, error: sourcesError }, { data: itemsData, error: itemsError }, { data: packagesData, error: packagesError }] = await Promise.all([
    supabase.from("purchase_order_sources").select("id, order_id, purchase_url, alibaba_order_no, freight_rmb").in("order_id", orderIds).eq("owner_id", session.user.id),
    supabase.from("purchase_order_items").select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id").in("order_id", orderIds).eq("owner_id", session.user.id),
    supabase.from("purchase_packages").select("id, order_id, source_id, tracking_no, status").in("order_id", orderIds).eq("owner_id", session.user.id),
  ]);
  if (sourcesError) throw sourcesError;
  if (itemsError) throw itemsError;
  if (packagesError) throw packagesError;
  const packages = packagesData as Omit<PurchasePackage, "items">[];
  const { data: packageItemsData, error: packageItemsError } = packages.length === 0
    ? { data: [] as PurchasePackageItem[], error: null }
    : await supabase.from("purchase_package_items").select("package_id, order_item_id, quantity").in("package_id", packages.map((item) => item.id)).eq("owner_id", session.user.id);
  if (packageItemsError) throw packageItemsError;
  const group = <T extends { order_id: string }>(rows: T[]) =>
    rows.reduce<Record<string, T[]>>((acc, row) => ((acc[row.order_id] ??= []).push(row), acc), {});
  const packageItemsByPackage = (packageItemsData as PurchasePackageItem[]).reduce<Record<string, PurchasePackageItem[]>>((acc, row) => ((acc[row.package_id] ??= []).push(row), acc), {});
  const packagesByOrder = group(packages.map((item) => ({ ...item, items: packageItemsByPackage[item.id] ?? [] })) as PurchasePackage[]);
  const sourcesByOrder = group(sourcesData as PurchaseOrderSource[]);
  const itemsByOrder = group(itemsData as PurchaseOrderItem[]);
  return orders.map((order) => {
    const orderItems = itemsByOrder[order.id] ?? [];
    const orderPackages = packagesByOrder[order.id] ?? [];
    const status = getReceiptStatus(orderItems, orderPackages);
    return {
      ...order,
      status,
      received_at: status === "received" ? order.received_at : null,
      sources: sourcesByOrder[order.id] ?? [],
      items: orderItems,
      packages: orderPackages,
    };
  });
}

type CreatePurchaseOrderInput = {
  warehouse_id: string;
  warehouse_name: string;
  purchased_at: string;
  notes: string;
  sources: Array<{ purchase_url: string; alibaba_order_no: string; freight_rmb: number }>;
  items: Array<Omit<Pick<PurchaseOrderItem, "product_id" | "item_id" | "product_code" | "product_name_cn" | "item_name" | "item_spec" | "purchase_url" | "quantity" | "unit_price_rmb">, never>>;
};
export async function createPurchaseOrder(input: CreatePurchaseOrderInput) {
  const { supabase, session } = await requireSession();
  const missingLinkedItem = input.items.find((item) => !hasValue(item.item_id));
  if (missingLinkedItem) {
    throw new Error(`采购明细“${missingLinkedItem.item_name}”没有绑定商品配件，不能保存采购单`);
  }

  const itemsTotalRmb = input.items.reduce((sum, item) => sum + item.quantity * item.unit_price_rmb, 0);
  const freightTotalRmb = input.sources.reduce((sum, source) => sum + source.freight_rmb, 0);
  const { data: orderData, error: orderError } = await withTimeout(
    supabase.from("purchase_orders").insert({
      owner_id: session.user.id,
      warehouse_id: input.warehouse_id,
      warehouse_name: input.warehouse_name,
      purchased_at: input.purchased_at,
      items_total_rmb: itemsTotalRmb,
      total_cost_rmb: itemsTotalRmb + freightTotalRmb,
      notes: input.notes,
    }).select("id, order_code, warehouse_id, warehouse_name, purchased_at, items_total_rmb, total_cost_rmb, status").single(),
    "保存采购单",
  );
  if (orderError) throw orderError;
  const order = orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">;
  try {
    const { data: sourceData, error: sourceError } = await withTimeout(
      supabase.from("purchase_order_sources").insert(input.sources.map((source) => ({
        ...source,
        order_id: order.id,
        owner_id: session.user.id,
      }))).select("id, order_id, purchase_url, alibaba_order_no, freight_rmb"),
      "保存采购链接",
    );
    if (sourceError) throw sourceError;
    const sources = sourceData as PurchaseOrderSource[];
    const sourceIdByUrl = Object.fromEntries(sources.map((source) => [source.purchase_url, source.id]));
    const { data: itemData, error: itemError } = await withTimeout(
      supabase.from("purchase_order_items").insert(input.items.map((item) => ({
        ...item,
        order_id: order.id,
        source_id: sourceIdByUrl[item.purchase_url],
        owner_id: session.user.id,
      }))).select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id"),
      "保存采购单明细",
    );
    if (itemError) throw itemError;
    return { ...order, sources, items: itemData as PurchaseOrderItem[], packages: [] as PurchasePackage[] };
  } catch (error) {
    await supabase.from("purchase_orders").delete().eq("id", order.id).eq("owner_id", session.user.id);
    throw error;
  }
}

export async function updatePurchaseSource(sourceId: string, updates: Pick<PurchaseOrderSource, "alibaba_order_no" | "freight_rmb">) {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.from("purchase_order_sources").update(updates).eq("id", sourceId).eq("owner_id", session.user.id).select("id, order_id, purchase_url, alibaba_order_no, freight_rmb").single(),
    "更新采购链接信息",
  );
  if (error) throw error;
  const source = data as PurchaseOrderSource;
  const { data: allSources, error: sourceError } = await supabase.from("purchase_order_sources").select("freight_rmb").eq("order_id", source.order_id).eq("owner_id", session.user.id);
  if (sourceError) throw sourceError;
  const { data: order, error: orderError } = await supabase.from("purchase_orders").select("items_total_rmb").eq("id", source.order_id).eq("owner_id", session.user.id).single();
  if (orderError) throw orderError;
  const totalCost = Number(order.items_total_rmb) + allSources.reduce((sum, item) => sum + Number(item.freight_rmb), 0);
  await supabase.from("purchase_orders").update({ total_cost_rmb: totalCost }).eq("id", source.order_id).eq("owner_id", session.user.id);
  return source;
}

async function loadPurchaseOrderForDeletion(
  supabase: SupabaseClient,
  ownerId: string,
  orderId: string,
) {
  const { data: orderData, error: orderError } = await withTimeout(
    supabase
      .from("purchase_orders")
      .select("id, warehouse_id, order_code")
      .eq("id", orderId)
      .eq("owner_id", ownerId)
      .maybeSingle(),
    "读取采购单",
  );
  if (orderError) throw orderError;
  if (!orderData) return null;

  const order = orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">;
  const [{ data: itemData, error: itemError }, { data: packageData, error: packageError }] =
    await Promise.all([
      supabase
        .from("purchase_order_items")
        .select("id, order_id, product_id, item_id, item_name, item_spec")
        .eq("order_id", order.id)
        .eq("owner_id", ownerId),
      supabase
        .from("purchase_packages")
        .select("id, status")
        .eq("order_id", order.id)
        .eq("owner_id", ownerId),
    ]);
  if (itemError) throw itemError;
  if (packageError) throw packageError;

  const packages = packageData as Omit<PurchasePackage, "items">[];
  const { data: packageItemData, error: packageItemError } = packages.length === 0
    ? { data: [] as PurchasePackageItem[], error: null }
    : await supabase
        .from("purchase_package_items")
        .select("package_id, order_item_id, quantity")
        .in("package_id", packages.map((item) => item.id))
        .eq("owner_id", ownerId);
  if (packageItemError) throw packageItemError;

  const packageItemsByPackage = (packageItemData as PurchasePackageItem[]).reduce<
    Record<string, PurchasePackageItem[]>
  >((groups, item) => {
    groups[item.package_id] ??= [];
    groups[item.package_id].push(item);
    return groups;
  }, {});

  return {
    ...order,
    sources: [] as PurchaseOrderSource[],
    items: itemData as PurchaseOrderItem[],
    packages: packages.map((item) => ({
      ...item,
      items: packageItemsByPackage[item.id] ?? [],
    })),
  } as PurchaseOrder;
}

async function reverseReceivedPurchaseInventory(order: PurchaseOrder) {
  const receivedPackages = order.packages.filter((pkg) => pkg.status === "received");
  if (receivedPackages.length === 0) return;

  const reversals = new Map<string, PurchaseInventoryReversal>();
  for (const pkg of receivedPackages) {
    const resolvedItems = await resolvePackageItems(order, pkg);
    if (pkg.items.length > 0 && resolvedItems.length !== pkg.items.length) {
      throw new Error("采购单内有配件无法匹配到商品配件库，不能自动冲回库存");
    }

    resolvedItems.forEach(({ packageItem, orderItem }) => {
      const key = `${pkg.id}:${orderItem.item_id}`;
      const current = reversals.get(key);
      const quantity = Math.max(0, Math.trunc(Number(packageItem.quantity) || 0));
      if (current) {
        current.quantity += quantity;
        return;
      }

      reversals.set(key, {
        packageId: pkg.id,
        itemId: orderItem.item_id,
        itemName: orderItem.item_name || orderItem.item_spec || orderItem.item_id,
        quantity,
      });
    });
  }
  if (reversals.size === 0) return;

  const { supabase, session } = await requireSession();
  const reason = `删除采购单冲回：${order.order_code}`;
  for (const reversal of reversals.values()) {
    if (reversal.quantity <= 0) continue;

    const { data: existingReversal, error: existingReversalError } = await withTimeout(
      supabase
        .from("warehouse_item_stock_adjustments")
        .select("id")
        .eq("purchase_package_id", reversal.packageId)
        .eq("item_id", reversal.itemId)
        .eq("reason", reason)
        .limit(1)
        .maybeSingle(),
      "检查采购删除冲回记录",
    );
    if (existingReversalError) throw existingReversalError;
    if (existingReversal) continue;

    const { data: currentData, error: currentError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .select("id, warehouse_id, item_id, stock_quantity")
        .eq("warehouse_id", order.warehouse_id)
        .eq("item_id", reversal.itemId)
        .maybeSingle(),
      "读取配件库存",
    );
    if (currentError) throw currentError;
    if (!currentData) throw new Error(`仓库配件库存不存在：${reversal.itemName}`);

    const current = currentData as WarehouseItemStock;
    if (current.stock_quantity < reversal.quantity) {
      throw new Error(
        `库存不足，不能删除已入库采购单：${reversal.itemName} 当前 ${current.stock_quantity}，需要冲回 ${reversal.quantity}`,
      );
    }

    const nextQuantity = current.stock_quantity - reversal.quantity;
    const { data: nextData, error: nextError } = await withTimeout(
      supabase
        .from("warehouse_item_stocks")
        .update({ stock_quantity: nextQuantity })
        .eq("id", current.id)
        .eq("stock_quantity", current.stock_quantity)
        .select("id, warehouse_id, item_id, stock_quantity")
        .maybeSingle(),
      "冲回配件库存",
    );
    if (nextError) throw nextError;
    if (!nextData) throw new Error("库存已被其他操作更新，请刷新后重试");

    const { error: adjustmentError } = await withTimeout(
      supabase
        .from("warehouse_item_stock_adjustments")
        .insert({
          warehouse_id: order.warehouse_id,
          item_id: reversal.itemId,
          previous_quantity: current.stock_quantity,
          next_quantity: nextQuantity,
          change_quantity: -reversal.quantity,
          reason,
          purchase_order_id: order.id,
          purchase_package_id: reversal.packageId,
        }),
      "保存采购删除冲回记录",
    );
    if (adjustmentError) throw adjustmentError;
  }
}

export async function deletePurchaseOrder(orderId: string) {
  const { supabase, session } = await requireSession();
  const order = await loadPurchaseOrderForDeletion(supabase, session.user.id, orderId);
  if (!order) return;
  await reverseReceivedPurchaseInventory(order);

  const { error } = await withTimeout(
    supabase.from("purchase_orders").delete().eq("id", orderId).eq("owner_id", session.user.id),
    "删除采购单",
  );
  if (error) throw error;
}

export async function createPurchasePackage(orderId: string, sourceId: string, trackingNo: string, items: Array<{ order_item_id: string; quantity: number }>) {
  const { supabase, session } = await requireSession();
  const { data: packageRows, error: pkgError } = await withTimeout(
    supabase.rpc("create_purchase_package", {
      p_order_id: orderId,
      p_source_id: sourceId,
      p_tracking_no: trackingNo,
      p_items: items,
    }),
    "保存快递包裹",
  );
  if (pkgError) throw pkgError;
  const packageRow = (packageRows as Omit<PurchasePackage, "items">[])[0];
  if (!packageRow?.id) {
    throw new Error("保存快递包裹失败：数据库没有返回包裹记录");
  }

  return {
    ...packageRow,
    items: items.map((item) => ({
      id: crypto.randomUUID(),
      package_id: packageRow.id,
      owner_id: session.user.id,
      created_at: packageRow.created_at,
      ...item,
    })) as PurchasePackageItem[],
  };
}

export async function updatePurchasePackageTrackingNo(packageId: string, trackingNo: string) {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("purchase_packages")
      .update({ tracking_no: trackingNo })
      .eq("id", packageId)
      .eq("owner_id", session.user.id)
      .eq("status", "pending")
      .select("tracking_no")
      .single(),
    "更新快递单号",
  );
  if (error) throw error;
  return data as Omit<PurchasePackage, "items">;
}

export async function deletePurchasePackage(packageId: string) {
  const { supabase, session } = await requireSession();
  const { error } = await withTimeout(
    supabase
      .from("purchase_packages")
      .delete()
      .eq("id", packageId)
      .eq("owner_id", session.user.id)
      .eq("status", "pending"),
    "删除快递包裹",
  );
  if (error) throw error;
}

async function restoreMissingPurchasePackage(order: PurchaseOrder, pkg: PurchasePackage) {
  return createPurchasePackage(
    order.id,
    pkg.source_id,
    pkg.tracking_no,
    pkg.items.map((item) => ({
      order_item_id: item.order_item_id,
      quantity: item.quantity,
    })),
  );
}

async function ensureWarehouseProductInventory(
  warehouseId: string,
  productIds: string[],
  itemIds: string[],
) {
  const uniqueProductIds = Array.from(new Set(productIds));
  if (uniqueProductIds.length === 0) return;

  const { supabase, session } = await requireSession();
  const [
    { data: skuData, error: skuLoadError },
    { data: itemData, error: itemLoadError },
  ] = await Promise.all([
    supabase
      .from("product_skus")
      .select("id, product_id")
      .in("product_id", uniqueProductIds),
    supabase
      .from("product_items")
      .select("id")
      .in("product_id", uniqueProductIds),
  ]);
  if (skuLoadError) throw skuLoadError;
  if (itemLoadError) throw itemLoadError;

  const skuRows = (skuData ?? []).flatMap((sku) =>
    sku.id && sku.product_id
      ? [{
          warehouse_id: warehouseId,
          product_id: sku.product_id,
          sku_id: sku.id,
          owner_id: session.user.id,
        }]
      : [],
  );
  const productsWithSkus = new Set(skuRows.map((row) => row.product_id));
  const missingSkuProductId = uniqueProductIds.find((productId) => !productsWithSkus.has(productId));
  if (missingSkuProductId) {
    throw new Error("采购商品还没有 SKU，不能自动加入仓库库存");
  }

  if (skuRows.length > 0) {
    const { error: skuInsertError } = await supabase
      .from("warehouse_skus")
      .upsert(skuRows, { onConflict: "warehouse_id,sku_id", ignoreDuplicates: true });
    if (skuInsertError) throw skuInsertError;
  }

  const uniqueItemIds = Array.from(new Set([
    ...itemIds,
    ...(itemData ?? []).flatMap((item) => item.id ? [item.id] : []),
  ]));
  if (uniqueItemIds.length > 0) {
    const { error: itemInsertError } = await supabase
      .from("warehouse_item_stocks")
      .upsert(
        uniqueItemIds.map((itemId) => ({
          warehouse_id: warehouseId,
          item_id: itemId,
          owner_id: session.user.id,
        })),
        { onConflict: "warehouse_id,item_id", ignoreDuplicates: true },
      );
    if (itemInsertError) throw itemInsertError;
  }
}

async function applyPurchasePackageInventory(
  order: PurchaseOrder,
  pkg: PurchasePackage,
  equivalentPackageIds: string[] = [pkg.id],
) {
  const { supabase, session } = await requireSession();
  const resolvedItems = await resolvePackageItems(order, pkg);
  if (pkg.items.length > 0 && resolvedItems.length !== pkg.items.length) {
    throw new Error("包裹内有配件无法匹配到商品配件库，请检查采购明细后再入库");
  }
  await persistResolvedPurchaseItemIds(supabase, session.user.id, resolvedItems);

  const receivableItems = Array.from(
    resolvedItems.reduce((items, { packageItem, orderItem }) => {
      const quantity = Math.max(0, Math.trunc(Number(packageItem.quantity) || 0));
      if (quantity <= 0) return items;

      const current = items.get(orderItem.item_id);
      if (current) {
        current.quantity += quantity;
      } else {
        items.set(orderItem.item_id, { orderItem, quantity });
      }
      return items;
    }, new Map<string, PurchaseInventoryReceipt>()).values(),
  );

  await ensureWarehouseProductInventory(
    order.warehouse_id,
    receivableItems.map(({ orderItem }) => orderItem.product_id),
    receivableItems.map(({ orderItem }) => orderItem.item_id),
  );

  const inventory: Array<{ stock: WarehouseItemStock; adjustment: WarehouseItemStockAdjustment }> = [];
  const adjustmentPackageIds = Array.from(new Set([pkg.id, ...equivalentPackageIds]));
  for (const { orderItem: item, quantity } of receivableItems) {
    const { data: existingAdjustments, error: existingAdjustmentError } = await supabase
      .from("warehouse_item_stock_adjustments")
      .select("change_quantity")
      .in("purchase_package_id", adjustmentPackageIds)
      .eq("item_id", item.item_id)
      .gt("change_quantity", 0);
    if (existingAdjustmentError) throw existingAdjustmentError;

    const receivedQuantity = (existingAdjustments ?? []).reduce(
      (total, adjustment) =>
        total + Math.max(0, Math.trunc(Number(adjustment.change_quantity) || 0)),
      0,
    );
    const receiveQuantity = quantity - receivedQuantity;
    if (receiveQuantity <= 0) continue;

    const { data: currentData, error: currentError } = await supabase
      .from("warehouse_item_stocks")
      .select("id, warehouse_id, item_id, stock_quantity")
      .eq("warehouse_id", order.warehouse_id)
      .eq("item_id", item.item_id)
      .limit(1)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!currentData) {
      throw new Error(`仓库配件库存不存在：${item.item_name}`);
    }
    const current = currentData as WarehouseItemStock;
    const nextQuantity = current.stock_quantity + receiveQuantity;
    const { data: nextData, error: nextError } = await supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: nextQuantity })
      .eq("id", current.id)
      .eq("stock_quantity", current.stock_quantity)
      .select("id, warehouse_id, item_id, stock_quantity")
      .maybeSingle();
    if (nextError) throw nextError;
    if (!nextData) throw new Error("库存已被其他操作更新，请刷新后重试");
    const next = nextData as WarehouseItemStock;
    const { data: adjustmentData, error: adjustmentError } = await supabase.from("warehouse_item_stock_adjustments").insert({
      warehouse_id: order.warehouse_id, item_id: item.item_id, previous_quantity: current.stock_quantity,
      next_quantity: next.stock_quantity, change_quantity: receiveQuantity, reason: "采购入库",
      purchase_order_id: order.id, purchase_package_id: pkg.id,
    }).select("id, warehouse_id, item_id, owner_id, previous_quantity, next_quantity, change_quantity, reason, purchase_order_id, purchase_package_id, created_at").single();
    if (adjustmentError) throw adjustmentError;
    inventory.push({ stock: next, adjustment: adjustmentData as WarehouseItemStockAdjustment });
  }

  return inventory;
}

export async function receivePurchasePackage(order: PurchaseOrder, pkg: PurchasePackage) {
  const { supabase, session } = await requireSession();
  let packageToReceive = pkg;
  const { data: persistedPackageData, error: packageLoadError } = await supabase
    .from("purchase_packages")
    .select("id, source_id, tracking_no, status")
    .eq("id", pkg.id)
    .eq("owner_id", session.user.id)
    .maybeSingle();
  if (packageLoadError) throw packageLoadError;
  const persistedPackage = (persistedPackageData as Omit<PurchasePackage, "items"> | null);
  if (!persistedPackage) {
    packageToReceive = await restoreMissingPurchasePackage(order, pkg);
  }
  const activePackage = persistedPackage ?? packageToReceive;

  // 先更新包裹状态为 received，再写库存流水
  // 这样即使库存写入失败，包裹会停在 received，之后可按已入库数量补差恢复
  // 比原来「先写库存再更新包裹」更安全：不会出现「有流水但包裹还是 pending」
  const receivedAt = new Date().toISOString();
  let packageData = activePackage;
  if (activePackage.status !== "received") {
    const { data: updatedPackageData, error: packageError } = await supabase.from("purchase_packages").update({ status: "received", received_at: receivedAt }).eq("id", packageToReceive.id).eq("owner_id", session.user.id).eq("status", "pending").select("id, source_id, tracking_no, status").maybeSingle();
    if (packageError) throw packageError;
    if (!updatedPackageData) {
      throw new Error("快递包裹状态已变化，请刷新页面后查看");
    }
    packageData = updatedPackageData as Omit<PurchasePackage, "items">;
  }
  const receivedPackage = {
    ...packageToReceive,
    ...packageData,
    items: packageToReceive.items,
  } as PurchasePackage;
  const inventory = await applyPurchasePackageInventory(
    order,
    receivedPackage,
    [pkg.id, receivedPackage.id],
  );
  const { data: allPackageData, error: allPackageError } = await supabase
    .from("purchase_packages")
    .select("id, status")
    .eq("order_id", order.id)
    .eq("owner_id", session.user.id);
  if (allPackageError) throw allPackageError;
  const allPackageRows = allPackageData as Omit<PurchasePackage, "items">[];
  const { data: allPackageItemData, error: allPackageItemError } = allPackageRows.length === 0
    ? { data: [] as PurchasePackageItem[], error: null }
    : await supabase
        .from("purchase_package_items")
        .select("package_id, order_item_id, quantity")
        .in("package_id", allPackageRows.map((item) => item.id))
        .eq("owner_id", session.user.id);
  if (allPackageItemError) throw allPackageItemError;
  const packageItemsByPackage = (allPackageItemData as PurchasePackageItem[]).reduce<Record<string, PurchasePackageItem[]>>((acc, row) => ((acc[row.package_id] ??= []).push(row), acc), {});
  const allPackages = allPackageRows.map((item) => ({ ...item, items: packageItemsByPackage[item.id] ?? [] })) as PurchasePackage[];
  const status = getReceiptStatus(order.items, allPackages);
  const { data: orderData, error: orderError } = await supabase.from("purchase_orders").update({ status, received_at: status === "received" ? receivedAt : null }).eq("id", order.id).eq("owner_id", session.user.id).select("status").single();
  if (orderError) throw orderError;
  return { order: orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">, package: { ...(packageData as Omit<PurchasePackage, "items">), items: packageItemsByPackage[packageData.id] ?? packageToReceive.items }, inventory };
}

function getRemainingPackageItems(order: PurchaseOrder) {
  const receivedQuantityByItemId = order.packages
    .filter((pkg) => pkg.status === "received")
    .flatMap((pkg) => pkg.items)
    .reduce<Record<string, number>>((quantities, item) => {
      quantities[item.order_item_id] =
        (quantities[item.order_item_id] ?? 0) + item.quantity;
      return quantities;
    }, {});

  return order.items.flatMap((item) => {
    const remainingQuantity = item.quantity - (receivedQuantityByItemId[item.id] ?? 0);
    return remainingQuantity > 0
      ? [{ ...item, quantity: remainingQuantity }]
      : [];
  });
}

export async function receiveRemainingPurchaseOrder(order: PurchaseOrder) {
  if (order.status === "received") throw new Error("该采购管理单已经签收");

  const { supabase, session } = await requireSession();
  const remainingItems = getRemainingPackageItems(order);
  const receivedAt = new Date().toISOString();
  if (remainingItems.length === 0) {
    const { data: orderData, error: orderError } = await supabase
      .from("purchase_orders")
      .update({ status: "received", received_at: receivedAt })
      .eq("id", order.id)
      .eq("owner_id", session.user.id)
      .select("status")
      .single();
    if (orderError) throw orderError;
    return {
      order: orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">,
      packages: [] as PurchasePackage[],
      inventory: [] as Array<{ stock: WarehouseItemStock; adjustment: WarehouseItemStockAdjustment }>,
    };
  }

  const itemsBySourceId = remainingItems.reduce<Record<string, PurchaseOrderItem[]>>(
    (groups, item) => {
      if (!item.source_id) return groups;
      groups[item.source_id] ??= [];
      groups[item.source_id].push(item);
      return groups;
    },
    {},
  );
  const sourceEntries = Object.entries(itemsBySourceId);
  if (sourceEntries.length === 0) {
    throw new Error("剩余采购明细缺少采购来源，不能自动补签收");
  }

  const inventory: Array<{ stock: WarehouseItemStock; adjustment: WarehouseItemStockAdjustment }> = [];
  const receivedPackages: PurchasePackage[] = [];
  for (const [index, [sourceId, items]] of sourceEntries.entries()) {
    const pkg = await createPurchasePackage(
      order.id,
      sourceId,
      `补签收-${order.order_code}-${index + 1}`,
      items.map((item) => ({
        order_item_id: item.id,
        quantity: item.quantity,
      })),
    );
    const { data: packageData, error: packageError } = await supabase
      .from("purchase_packages")
      .update({ status: "received", received_at: receivedAt })
      .eq("id", pkg.id)
      .eq("owner_id", session.user.id)
      .eq("status", "pending")
      .select("id, source_id, tracking_no, status")
      .single();
    if (packageError) throw packageError;

    const packageInventory = await applyPurchasePackageInventory(order, pkg, [pkg.id]);
    inventory.push(...packageInventory);

    receivedPackages.push({
      ...(packageData as Omit<PurchasePackage, "items">),
      items: pkg.items,
    });
  }

  const nextPackages = [...order.packages, ...receivedPackages];
  const status = getReceiptStatus(order.items, nextPackages);
  const { data: orderData, error: orderError } = await supabase
    .from("purchase_orders")
    .update({ status, received_at: status === "received" ? receivedAt : null })
    .eq("id", order.id)
    .eq("owner_id", session.user.id)
    .select("status")
    .single();
  if (orderError) throw orderError;

  return {
    order: orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">,
    packages: receivedPackages,
    inventory,
  };
}
