import { getSupabaseClient } from "./supabase";
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderSource,
  PurchasePackage,
  PurchasePackageItem,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
} from "../types";

const requestTimeoutMs = 15000;
async function withTimeout<T>(promise: PromiseLike<T>, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}超时，请稍后重试`)), requestTimeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timeoutId) clearTimeout(timeoutId); }
}
async function requireSession() {
  const supabase = getSupabaseClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("当前登录已失效，请重新登录");
  return { supabase, session };
}

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
  const { supabase, session } = await requireSession();
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
        .in("product_id", missingProductIds)
        .eq("owner_id", session.user.id);
  if (productItemsError) throw productItemsError;

  const productItemsByKey = (productItems ?? []).reduce<Record<string, string>>((items, item) => {
    items[`${item.product_id}\u0000${item.item_name.trim()}\u0000${item.item_spec.trim()}`] = item.id;
    return items;
  }, {});

  return pkg.items.flatMap((packageItem) => {
    const item = itemsById[packageItem.order_item_id];
    if (!item?.product_id) return [];
    const itemId = hasValue(item.item_id)
      ? item.item_id
      : productItemsByKey[`${item.product_id}\u0000${getItemIdentity(item)}`];
    return itemId
      ? [{ packageItem, orderItem: { ...item, product_id: item.product_id, item_id: itemId } }]
      : [];
  });
}

export async function fetchPurchaseOrders() {
  const { supabase, session } = await requireSession();
  const { data: ordersData, error: ordersError } = await withTimeout(
    supabase.from("purchase_orders").select("*").eq("owner_id", session.user.id).order("created_at", { ascending: false }),
    "加载采购单",
  );
  if (ordersError) throw ordersError;
  const orders = ordersData as Omit<PurchaseOrder, "sources" | "items" | "packages">[];
  if (orders.length === 0) return [] as PurchaseOrder[];
  const orderIds = orders.map((item) => item.id);
  const [{ data: sourcesData, error: sourcesError }, { data: itemsData, error: itemsError }, { data: packagesData, error: packagesError }] = await Promise.all([
    supabase.from("purchase_order_sources").select("*").in("order_id", orderIds).eq("owner_id", session.user.id),
    supabase.from("purchase_order_items").select("*").in("order_id", orderIds).eq("owner_id", session.user.id),
    supabase.from("purchase_packages").select("*").in("order_id", orderIds).eq("owner_id", session.user.id),
  ]);
  if (sourcesError) throw sourcesError;
  if (itemsError) throw itemsError;
  if (packagesError) throw packagesError;
  const packages = packagesData as Omit<PurchasePackage, "items">[];
  const { data: packageItemsData, error: packageItemsError } = packages.length === 0
    ? { data: [] as PurchasePackageItem[], error: null }
    : await supabase.from("purchase_package_items").select("*").in("package_id", packages.map((item) => item.id)).eq("owner_id", session.user.id);
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
    }).select().single(),
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
      }))).select(),
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
      }))).select(),
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
    supabase.from("purchase_order_sources").update(updates).eq("id", sourceId).eq("owner_id", session.user.id).select().single(),
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

export async function deletePurchaseOrder(orderId: string) {
  const { supabase, session } = await requireSession();
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
      .select()
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
      .in("product_id", uniqueProductIds)
      .eq("owner_id", session.user.id),
    supabase
      .from("product_items")
      .select("id")
      .in("product_id", uniqueProductIds)
      .eq("owner_id", session.user.id),
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

  const receivableItems = resolvedItems.map((entry) => entry.orderItem);
  await ensureWarehouseProductInventory(
    order.warehouse_id,
    receivableItems.map((item) => item.product_id),
    receivableItems.map((item) => item.item_id),
  );

  const inventory: Array<{ stock: WarehouseItemStock; adjustment: WarehouseItemStockAdjustment }> = [];
  const adjustmentPackageIds = Array.from(new Set([pkg.id, ...equivalentPackageIds]));
  for (const { packageItem, orderItem: item } of resolvedItems) {
    const { data: existingAdjustment, error: existingAdjustmentError } = await supabase
      .from("warehouse_item_stock_adjustments")
      .select("id")
      .in("purchase_package_id", adjustmentPackageIds)
      .eq("item_id", item.item_id)
      .eq("owner_id", session.user.id)
      .limit(1)
      .maybeSingle();
    if (existingAdjustmentError) throw existingAdjustmentError;
    if (existingAdjustment) continue;

    const { data: currentData, error: currentError } = await supabase
      .from("warehouse_item_stocks")
      .select("*")
      .eq("warehouse_id", order.warehouse_id)
      .eq("item_id", item.item_id)
      .eq("owner_id", session.user.id)
      .limit(1)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!currentData) {
      throw new Error(`仓库配件库存不存在：${item.item_name}`);
    }
    const current = currentData as WarehouseItemStock;
    const nextQuantity = current.stock_quantity + packageItem.quantity;
    const { data: nextData, error: nextError } = await supabase
      .from("warehouse_item_stocks")
      .update({ stock_quantity: nextQuantity })
      .eq("id", current.id)
      .eq("owner_id", session.user.id)
      .select()
      .single();
    if (nextError) throw nextError;
    const next = nextData as WarehouseItemStock;
    const { data: adjustmentData, error: adjustmentError } = await supabase.from("warehouse_item_stock_adjustments").insert({
      warehouse_id: order.warehouse_id, item_id: item.item_id, previous_quantity: current.stock_quantity,
      next_quantity: next.stock_quantity, change_quantity: packageItem.quantity, reason: "采购入库",
      purchase_order_id: order.id, purchase_package_id: pkg.id,
    }).select().single();
    if (adjustmentError) throw adjustmentError;
    inventory.push({ stock: next, adjustment: adjustmentData as WarehouseItemStockAdjustment });
  }

  return inventory;
}

export async function receivePurchasePackage(order: PurchaseOrder, pkg: PurchasePackage) {
  if (pkg.status === "received") throw new Error("该包裹已经签收");
  const { supabase, session } = await requireSession();
  let packageToReceive = pkg;
  const { data: persistedPackageData, error: packageLoadError } = await supabase
    .from("purchase_packages")
    .select("*")
    .eq("id", pkg.id)
    .eq("owner_id", session.user.id)
    .maybeSingle();
  if (packageLoadError) throw packageLoadError;
  const persistedPackage = (persistedPackageData as Omit<PurchasePackage, "items"> | null);
  if (!persistedPackage) {
    packageToReceive = await restoreMissingPurchasePackage(order, pkg);
  }
  const activePackage = persistedPackage ?? packageToReceive;
  if (activePackage.status === "received") {
    throw new Error("该包裹已经签收");
  }

  const inventory = await applyPurchasePackageInventory(
    order,
    packageToReceive,
    [pkg.id, packageToReceive.id],
  );
  const receivedAt = new Date().toISOString();
  const { data: packageData, error: packageError } = await supabase.from("purchase_packages").update({ status: "received", received_at: receivedAt }).eq("id", packageToReceive.id).eq("owner_id", session.user.id).eq("status", "pending").select().maybeSingle();
  if (packageError) throw packageError;
  if (!packageData) {
    throw new Error("快递包裹状态已变化，请刷新页面后查看");
  }
  const { data: allPackageData, error: allPackageError } = await supabase
    .from("purchase_packages")
    .select("*")
    .eq("order_id", order.id)
    .eq("owner_id", session.user.id);
  if (allPackageError) throw allPackageError;
  const allPackageRows = allPackageData as Omit<PurchasePackage, "items">[];
  const { data: allPackageItemData, error: allPackageItemError } = allPackageRows.length === 0
    ? { data: [] as PurchasePackageItem[], error: null }
    : await supabase
        .from("purchase_package_items")
        .select("*")
        .in("package_id", allPackageRows.map((item) => item.id))
        .eq("owner_id", session.user.id);
  if (allPackageItemError) throw allPackageItemError;
  const packageItemsByPackage = (allPackageItemData as PurchasePackageItem[]).reduce<Record<string, PurchasePackageItem[]>>((acc, row) => ((acc[row.package_id] ??= []).push(row), acc), {});
  const allPackages = allPackageRows.map((item) => ({ ...item, items: packageItemsByPackage[item.id] ?? [] })) as PurchasePackage[];
  const status = getReceiptStatus(order.items, allPackages);
  const { data: orderData, error: orderError } = await supabase.from("purchase_orders").update({ status, received_at: status === "received" ? receivedAt : null }).eq("id", order.id).eq("owner_id", session.user.id).select().single();
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
      .select()
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
    const packageInventory = await applyPurchasePackageInventory(order, pkg, [pkg.id]);
    inventory.push(...packageInventory);

    const { data: packageData, error: packageError } = await supabase
      .from("purchase_packages")
      .update({ status: "received", received_at: receivedAt })
      .eq("id", pkg.id)
      .eq("owner_id", session.user.id)
      .eq("status", "pending")
      .select()
      .single();
    if (packageError) throw packageError;
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
    .select()
    .single();
  if (orderError) throw orderError;

  return {
    order: orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">,
    packages: receivedPackages,
    inventory,
  };
}
