import { withTimeout, requireSession } from "./supabase-helpers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderSource,
  PurchasePackage,
  PurchasePackageItem,
} from "../types";

export function getReceiptStatus(
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

type PurchaseSkuInventoryChange = {
  skuId: string;
  previousQuantity: number;
  nextQuantity: number;
  changeQuantity: number;
};

type ProductSkuLinkRow = {
  sku_id: string;
  item_id: string;
  quantity: number;
};

type PurchaseItemSkuReceiptFields = Pick<
  PurchaseOrderItem,
  "product_id" | "sku_id" | "sku_quantity" | "product_code" | "item_name" | "item_spec"
>;

function getItemIdentity(item: Pick<PurchaseOrderItem, "item_name" | "item_spec">) {
  return `${item.item_name.trim()}\u0000${item.item_spec.trim()}`;
}

function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isMissingPurchaseTransactionRpcError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code ?? "") : "";
  const message = "message" in error ? String(error.message ?? "") : "";
  return (
    code === "42883" ||
    code === "PGRST202" ||
    message.includes("create_purchase_order_atomic") ||
    message.includes("update_purchase_source_atomic")
  );
}

function getPurchaseItemLabel(item: Pick<PurchaseOrderItem, "product_code" | "item_name" | "item_spec">) {
  return [item.product_code, item.item_name, item.item_spec]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

function assertPurchaseItemsHaveSkuInfo(
  items: PurchaseItemSkuReceiptFields[],
  context = "采购明细",
) {
  const missingSkuItem = items.find((item) =>
    !hasValue(item.product_id) ||
    !hasValue(item.sku_id) ||
    Math.trunc(Number(item.sku_quantity) || 0) <= 0,
  );
  if (!missingSkuItem) return;

  throw new Error(
    `${context}“${getPurchaseItemLabel(missingSkuItem)}”缺少 SKU 信息，不能签收入库。请用 SKU 选择创建采购单，或先补齐 SKU 后再签收。`,
  );
}

function assertPackageItemsHaveSkuInfo(
  orderItems: PurchaseOrderItem[],
  packageItems: PurchasePackageItem[],
) {
  const orderItemsById = Object.fromEntries(orderItems.map((item) => [item.id, item]));
  const itemsToReceive = packageItems.flatMap((packageItem) => {
    const quantity = Math.max(0, Math.trunc(Number(packageItem.quantity) || 0));
    if (quantity <= 0) return [];
    const orderItem = orderItemsById[packageItem.order_item_id];
    if (!orderItem) {
      throw new Error("包裹内有采购明细不存在，请刷新后重试");
    }
    return [orderItem];
  });

  assertPurchaseItemsHaveSkuInfo(itemsToReceive);
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
    supabase.from("purchase_order_items").select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id, sku_id, sku_quantity").in("order_id", orderIds).eq("owner_id", session.user.id),
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
  items: Array<Pick<
    PurchaseOrderItem,
    | "product_id"
    | "item_id"
    | "sku_id"
    | "sku_quantity"
    | "product_code"
    | "product_name_cn"
    | "item_name"
    | "item_spec"
    | "purchase_url"
    | "quantity"
    | "unit_price_rmb"
  >>;
};

function validateCreatePurchaseOrderInput(input: CreatePurchaseOrderInput) {
  const missingLinkedItem = input.items.find((item) => !hasValue(item.item_id));
  if (missingLinkedItem) {
    throw new Error(`采购明细“${missingLinkedItem.item_name}”没有绑定商品配件，不能保存采购单`);
  }
  assertPurchaseItemsHaveSkuInfo(input.items);
}

type AtomicPurchaseOrderPayload = {
  order: Omit<PurchaseOrder, "sources" | "items" | "packages">;
  sources: PurchaseOrderSource[];
  items: PurchaseOrderItem[];
};

function normalizeAtomicPurchaseOrder(payload: AtomicPurchaseOrderPayload): PurchaseOrder {
  return {
    ...payload.order,
    items_total_rmb: Number(payload.order.items_total_rmb),
    total_cost_rmb: Number(payload.order.total_cost_rmb),
    sources: payload.sources.map((source) => ({
      ...source,
      freight_rmb: Number(source.freight_rmb),
    })),
    items: payload.items.map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      unit_price_rmb: Number(item.unit_price_rmb),
      sku_quantity: item.sku_quantity === null ? null : Number(item.sku_quantity),
    })),
    packages: [],
  };
}

async function createPurchaseOrderLegacy(input: CreatePurchaseOrderInput) {
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
      }))).select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id, sku_id, sku_quantity"),
      "保存采购单明细",
    );
    if (itemError) throw itemError;
    return { ...order, sources, items: itemData as PurchaseOrderItem[], packages: [] as PurchasePackage[] };
  } catch (error) {
    await supabase.from("purchase_orders").delete().eq("id", order.id).eq("owner_id", session.user.id);
    throw error;
  }
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput) {
  validateCreatePurchaseOrderInput(input);
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("create_purchase_order_atomic", {
      p_warehouse_id: input.warehouse_id,
      p_warehouse_name: input.warehouse_name,
      p_purchased_at: input.purchased_at,
      p_notes: input.notes,
      p_sources: input.sources,
      p_items: input.items,
    }),
    "保存采购单",
  );

  if (error && isMissingPurchaseTransactionRpcError(error)) {
    return createPurchaseOrderLegacy(input);
  }
  if (error) throw error;
  if (!data) throw new Error("保存采购单后没有返回结果，请刷新后确认");
  return normalizeAtomicPurchaseOrder(data as AtomicPurchaseOrderPayload);
}

async function updatePurchaseSourceLegacy(sourceId: string, updates: Pick<PurchaseOrderSource, "alibaba_order_no" | "freight_rmb">) {
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

export async function updatePurchaseSource(
  sourceId: string,
  updates: Pick<PurchaseOrderSource, "alibaba_order_no" | "freight_rmb">,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("update_purchase_source_atomic", {
      p_source_id: sourceId,
      p_alibaba_order_no: updates.alibaba_order_no,
      p_freight_rmb: updates.freight_rmb,
    }),
    "更新采购链接信息",
  );

  if (error && isMissingPurchaseTransactionRpcError(error)) {
    return updatePurchaseSourceLegacy(sourceId, updates);
  }
  if (error) throw error;
  if (!data) throw new Error("更新采购链接后没有返回结果，请刷新后确认");
  const source = data as PurchaseOrderSource;
  return { ...source, freight_rmb: Number(source.freight_rmb) };
}

export async function updatePurchaseOrderItemSkuInfo(orderItemId: string, skuId: string) {
  const { supabase, session } = await requireSession();
  const normalizedSkuId = skuId.trim();
  if (!normalizedSkuId) throw new Error("请选择 SKU 后再保存");

  const { data: targetData, error: targetError } = await withTimeout(
    supabase
      .from("purchase_order_items")
      .select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id, sku_id, sku_quantity")
      .eq("id", orderItemId)
      .eq("owner_id", session.user.id)
      .maybeSingle(),
    "读取采购明细",
  );
  if (targetError) throw targetError;
  const targetItem = targetData as PurchaseOrderItem | null;
  if (!targetItem) throw new Error("采购明细不存在，请刷新后重试");
  if (!hasValue(targetItem.product_id)) {
    throw new Error("该采购明细缺少商品绑定，不能补 SKU 信息");
  }

  const { data: orderData, error: orderError } = await supabase
    .from("purchase_orders")
    .select("id, status")
    .eq("id", targetItem.order_id)
    .eq("owner_id", session.user.id)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!orderData) throw new Error("采购管理单不存在，请刷新后重试");
  if ((orderData as Pick<PurchaseOrder, "status">).status === "received") {
    throw new Error("已签收的采购管理单不能修改 SKU 信息");
  }

  const { data: skuData, error: skuError } = await supabase
    .from("product_skus")
    .select("id, product_id")
    .eq("id", normalizedSkuId)
    .maybeSingle();
  if (skuError) throw skuError;
  const sku = skuData as { id: string; product_id: string | null } | null;
  if (!sku?.id) throw new Error("SKU 不存在，请刷新后重试");
  if (sku.product_id !== targetItem.product_id) {
    throw new Error("所选 SKU 不属于该采购商品，不能保存");
  }

  const { data: linkData, error: linkError } = await supabase
    .from("product_sku_items")
    .select("sku_id, item_id, quantity")
    .eq("sku_id", normalizedSkuId);
  if (linkError) throw linkError;
  const skuLinks = (linkData ?? []) as ProductSkuLinkRow[];
  if (skuLinks.length === 0) throw new Error("该 SKU 没有维护组成明细，不能绑定到采购单");

  const { data: orderItemData, error: orderItemError } = await supabase
    .from("purchase_order_items")
    .select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id, sku_id, sku_quantity")
    .eq("order_id", targetItem.order_id)
    .eq("source_id", targetItem.source_id)
    .eq("product_id", targetItem.product_id)
    .eq("owner_id", session.user.id);
  if (orderItemError) throw orderItemError;

  const productOrderItems = (orderItemData ?? []) as PurchaseOrderItem[];
  const itemIdByIdentity = new Map<string, string>();
  if (productOrderItems.some((item) => !hasValue(item.item_id))) {
    const { data: productItemData, error: productItemError } = await supabase
      .from("product_items")
      .select("id, item_name, item_spec")
      .eq("product_id", targetItem.product_id);
    if (productItemError) throw productItemError;
    (productItemData ?? []).forEach((item) => {
      itemIdByIdentity.set(
        `${String(item.item_name ?? "").trim()}\u0000${String(item.item_spec ?? "").trim()}`,
        item.id,
      );
    });
  }

  const resolveItemId = (item: PurchaseOrderItem) =>
    hasValue(item.item_id)
      ? item.item_id
      : itemIdByIdentity.get(
        `${String(item.item_name ?? "").trim()}\u0000${String(item.item_spec ?? "").trim()}`,
      ) ?? null;

  const matchedRows = skuLinks.map((link) => {
    const rows = productOrderItems.filter((item) => resolveItemId(item) === link.item_id);
    if (rows.length === 0) {
      throw new Error("采购单中缺少该 SKU 所需的组成明细，不能自动补 SKU 信息");
    }
    if (rows.length > 1) {
      throw new Error("采购单中同一组成明细有多行，无法判断要绑定哪一行 SKU");
    }
    const row = rows[0];
    const perSkuQuantity = Math.trunc(Number(link.quantity) || 0);
    if (perSkuQuantity <= 0) {
      throw new Error("该 SKU 的组成数量不正确，不能绑定到采购单");
    }
    if (row.quantity % perSkuQuantity !== 0) {
      throw new Error("采购数量无法按所选 SKU 组成数量整除，不能自动推导 SKU 数量");
    }
    return {
      item: row,
      itemId: link.item_id,
      skuQuantity: row.quantity / perSkuQuantity,
    };
  });

  const targetInSku = matchedRows.some((entry) => entry.item.id === targetItem.id);
  if (!targetInSku) {
    throw new Error("所选 SKU 不包含当前采购明细，不能保存");
  }

  const expectedSkuQuantity = matchedRows[0]?.skuQuantity ?? 0;
  if (
    expectedSkuQuantity <= 0 ||
    matchedRows.some((entry) => entry.skuQuantity !== expectedSkuQuantity)
  ) {
    throw new Error("该 SKU 各组成明细推导出的 SKU 数量不一致，不能自动补 SKU 信息");
  }

  const { data: receivedPackageData, error: receivedPackageError } = await supabase
    .from("purchase_packages")
    .select("id")
    .eq("order_id", targetItem.order_id)
    .eq("owner_id", session.user.id)
    .eq("status", "received");
  if (receivedPackageError) throw receivedPackageError;
  const receivedPackageIds = (receivedPackageData ?? []).map((pkg) => pkg.id);
  if (receivedPackageIds.length > 0) {
    const touchedItemIds = matchedRows.map((entry) => entry.item.id);
    const { data: receivedItemData, error: receivedItemError } = await supabase
      .from("purchase_package_items")
      .select("order_item_id, quantity")
      .in("package_id", receivedPackageIds)
      .in("order_item_id", touchedItemIds)
      .eq("owner_id", session.user.id);
    if (receivedItemError) throw receivedItemError;
    const hasReceivedTouchedItem = (receivedItemData ?? []).some(
      (item) => Math.trunc(Number(item.quantity) || 0) > 0,
    );
    if (hasReceivedTouchedItem) {
      throw new Error("该 SKU 相关明细已有签收入库记录，不能修改 SKU 信息");
    }
  }

  const results = await Promise.all(
    matchedRows.map(({ item, itemId }) =>
      supabase
        .from("purchase_order_items")
        .update({
          item_id: itemId,
          sku_id: normalizedSkuId,
          sku_quantity: expectedSkuQuantity,
        })
        .eq("id", item.id)
        .eq("owner_id", session.user.id)
        .select("id, order_id, source_id, purchase_url, product_code, product_name_cn, item_name, item_spec, quantity, unit_price_rmb, product_id, item_id, sku_id, sku_quantity")
        .single(),
    ),
  );
  const failedUpdate = results.find((result) => result.error);
  if (failedUpdate?.error) throw failedUpdate.error;

  return results.map((result) => result.data as PurchaseOrderItem);
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
        .select("id, order_id, product_id, item_id, item_name, item_spec, sku_id, sku_quantity")
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

  const { supabase, session } = await requireSession();
  receivedPackages.forEach((pkg) => assertPackageItemsHaveSkuInfo(order.items, pkg.items));

  const skuQuantities = getSkuQtyReceived(order.items, order.packages);
  const reverseQuantities = Object.fromEntries(
    Object.entries(skuQuantities).map(([skuId, quantity]) => [skuId, -quantity]),
  );
  await applyWarehouseSkuQuantityChanges(
    supabase,
    session.user.id,
    order.warehouse_id,
    order.items,
    reverseQuantities,
  );
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

async function ensureWarehouseSkuInventory(
  supabase: SupabaseClient,
  ownerId: string,
  warehouseId: string,
  orderItems: PurchaseOrderItem[],
  skuIds: string[],
) {
  const uniqueSkuIds = Array.from(new Set(skuIds.filter(hasValue)));
  if (uniqueSkuIds.length === 0) return;

  const productIdBySkuId = new Map<string, string>();
  orderItems.forEach((item) => {
    if (hasValue(item.sku_id) && hasValue(item.product_id)) {
      productIdBySkuId.set(item.sku_id, item.product_id);
    }
  });

  const missingProductSkuId = uniqueSkuIds.find((skuId) => !productIdBySkuId.has(skuId));
  if (missingProductSkuId) {
    throw new Error("采购明细缺少 SKU 对应商品，不能自动加入仓库 SKU 库存");
  }

  const { error } = await supabase
    .from("warehouse_skus")
    .upsert(
      uniqueSkuIds.map((skuId) => {
        const productId = productIdBySkuId.get(skuId);
        if (!productId) {
          throw new Error("采购明细缺少 SKU 对应商品，不能自动加入仓库 SKU 库存");
        }
        return {
          warehouse_id: warehouseId,
          product_id: productId,
          sku_id: skuId,
          owner_id: ownerId,
        };
      }),
      { onConflict: "warehouse_id,sku_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

async function preparePurchasePackageForSkuReceipt(
  order: PurchaseOrder,
  pkg: PurchasePackage,
) {
  const { supabase, session } = await requireSession();
  const resolvedItems = await resolvePackageItems(order, pkg);
  if (pkg.items.length > 0 && resolvedItems.length !== pkg.items.length) {
    throw new Error("包裹内有配件无法匹配到商品配件库，请检查采购明细后再入库");
  }
  await persistResolvedPurchaseItemIds(supabase, session.user.id, resolvedItems);
  assertPackageItemsHaveSkuInfo(order.items, pkg.items);
}

async function applyWarehouseSkuQuantityChanges(
  supabase: SupabaseClient,
  ownerId: string,
  warehouseId: string,
  orderItems: PurchaseOrderItem[],
  quantitiesBySkuId: Record<string, number>,
): Promise<PurchaseSkuInventoryChange[]> {
  const changes = Object.entries(quantitiesBySkuId)
    .map(([skuId, quantity]) => ({
      skuId,
      quantity: Math.trunc(Number(quantity) || 0),
    }))
    .filter((change) => hasValue(change.skuId) && change.quantity !== 0);
  if (changes.length === 0) return [];

  await ensureWarehouseSkuInventory(
    supabase,
    ownerId,
    warehouseId,
    orderItems,
    changes.map((change) => change.skuId),
  );

  const inventory: PurchaseSkuInventoryChange[] = [];
  for (const { skuId, quantity } of changes) {
    const { data: currentData, error: currentError } = await withTimeout(
      supabase
        .from("warehouse_skus")
        .select("id, sku_id, stock_quantity")
        .eq("warehouse_id", warehouseId)
        .eq("sku_id", skuId)
        .maybeSingle(),
      "读取仓库 SKU 库存",
    );
    if (currentError) throw currentError;
    if (!currentData) throw new Error("仓库 SKU 库存不存在，请刷新后重试");

    const currentQuantity = Math.max(0, Math.trunc(Number(currentData.stock_quantity) || 0));
    if (quantity < 0 && currentQuantity < Math.abs(quantity)) {
      throw new Error(
        `SKU 库存不足，不能冲回已入库采购单：当前 ${currentQuantity}，需要冲回 ${Math.abs(quantity)}`,
      );
    }

    const nextQuantity = currentQuantity + quantity;
    const { data: nextData, error: nextError } = await withTimeout(
      supabase
        .from("warehouse_skus")
        .update({ stock_quantity: nextQuantity })
        .eq("id", currentData.id)
        .eq("stock_quantity", currentData.stock_quantity)
        .select("id, sku_id, stock_quantity")
        .maybeSingle(),
      "更新仓库 SKU 库存",
    );
    if (nextError) throw nextError;
    if (!nextData) throw new Error("库存已被其他操作更新，请刷新后重试");

    inventory.push({
      skuId,
      previousQuantity: currentQuantity,
      nextQuantity: Math.max(0, Math.trunc(Number(nextData.stock_quantity) || 0)),
      changeQuantity: quantity,
    });
  }

  return inventory;
}

function getSkuQtyDiff(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const skuIds = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    Array.from(skuIds).map((skuId) => [skuId, (after[skuId] ?? 0) - (before[skuId] ?? 0)]),
  );
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
  const shouldReceivePackage = activePackage.status !== "received";
  if (shouldReceivePackage) {
    await preparePurchasePackageForSkuReceipt(order, packageToReceive);
  }

  const receivedAt = new Date().toISOString();
  let packageData = activePackage;
  let inventory: PurchaseSkuInventoryChange[] = [];
  if (shouldReceivePackage) {
    const { data: updatedPackageData, error: packageError } = await supabase.from("purchase_packages").update({ status: "received", received_at: receivedAt }).eq("id", packageToReceive.id).eq("owner_id", session.user.id).eq("status", "pending").select("id, source_id, tracking_no, status").maybeSingle();
    if (packageError) throw packageError;
    if (!updatedPackageData) {
      throw new Error("快递包裹状态已变化，请刷新页面后查看");
    }
    packageData = updatedPackageData as Omit<PurchasePackage, "items">;
  }
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
  const skuQtyBefore = getSkuQtyReceived(order.items, order.packages);
  const skuQtyAfter = getSkuQtyReceived(order.items, allPackages);
  if (shouldReceivePackage) {
    inventory = await applyWarehouseSkuQuantityChanges(
      supabase,
      session.user.id,
      order.warehouse_id,
      order.items,
      getSkuQtyDiff(skuQtyBefore, skuQtyAfter),
    );
  }
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
      inventory: [] as PurchaseSkuInventoryChange[],
    };
  }
  assertPurchaseItemsHaveSkuInfo(remainingItems, "剩余采购明细");

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
    await preparePurchasePackageForSkuReceipt(order, pkg);
    const { data: packageData, error: packageError } = await supabase
      .from("purchase_packages")
      .update({ status: "received", received_at: receivedAt })
      .eq("id", pkg.id)
      .eq("owner_id", session.user.id)
      .eq("status", "pending")
      .select("id, source_id, tracking_no, status")
      .single();
    if (packageError) throw packageError;

    receivedPackages.push({
      ...(packageData as Omit<PurchasePackage, "items">),
      items: pkg.items,
    });
  }

  const nextPackages = [...order.packages, ...receivedPackages];
  const skuQtyBefore = getSkuQtyReceived(order.items, order.packages);
  const skuQtyAfter = getSkuQtyReceived(order.items, nextPackages);
  const inventory = await applyWarehouseSkuQuantityChanges(
    supabase,
    session.user.id,
    order.warehouse_id,
    order.items,
    getSkuQtyDiff(skuQtyBefore, skuQtyAfter),
  );
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

function getSkuQtyReceived(
  items: PurchaseOrderItem[],
  packages: PurchasePackage[],
): Record<string, number> {
  const receivedQtyByOrderItemId: Record<string, number> = {};
  packages
    .filter((p) => p.status === "received")
    .flatMap((p) => p.items)
    .forEach((pi) => {
      receivedQtyByOrderItemId[pi.order_item_id] =
        (receivedQtyByOrderItemId[pi.order_item_id] ?? 0) + pi.quantity;
    });

  const orderItemsBySkuId: Record<
    string,
    Record<string, { receivedItemQty: number; itemQtyOrdered: number; skuQtyOrdered: number }>
  > = {};
  items.forEach((item) => {
    if (item.sku_id) {
      const componentKey = item.item_id ?? item.id;
      const skuItems = (orderItemsBySkuId[item.sku_id] ??= {});
      const current = skuItems[componentKey] ?? {
        receivedItemQty: 0,
        itemQtyOrdered: 0,
        skuQtyOrdered: 0,
      };
      current.receivedItemQty += receivedQtyByOrderItemId[item.id] ?? 0;
      current.itemQtyOrdered += item.quantity ?? 0;
      current.skuQtyOrdered += item.sku_quantity ?? 0;
      skuItems[componentKey] = current;
    }
  });

  const skuQtyReceived: Record<string, number> = {};
  Object.entries(orderItemsBySkuId).forEach(([skuId, componentGroups]) => {
    const skuQty = Math.min(
      ...Object.values(componentGroups).map(({ receivedItemQty, itemQtyOrdered, skuQtyOrdered }) => {
        const itemPerSku = skuQtyOrdered > 0 ? itemQtyOrdered / skuQtyOrdered : 1;
        return itemPerSku > 0 ? Math.floor(receivedItemQty / itemPerSku) : 0;
      })
    );
    skuQtyReceived[skuId] = Math.max(0, skuQty);
  });

  return skuQtyReceived;
}
