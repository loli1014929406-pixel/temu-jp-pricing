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
  return orders.map((order) => ({ ...order, sources: sourcesByOrder[order.id] ?? [], items: itemsByOrder[order.id] ?? [], packages: packagesByOrder[order.id] ?? [] }));
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
  const pkg = (packageRows as Omit<PurchasePackage, "items">[])[0];
  const packageCreatedAt = pkg.created_at;
  return {
    ...pkg,
    items: items.map((item) => ({
      id: crypto.randomUUID(),
      package_id: pkg.id,
      owner_id: session.user.id,
      created_at: packageCreatedAt,
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

export async function receivePurchasePackage(order: PurchaseOrder, pkg: PurchasePackage) {
  if (pkg.status === "received") throw new Error("该包裹已经签收");
  const { supabase, session } = await requireSession();
  const itemsById = Object.fromEntries(order.items.map((item) => [item.id, item]));
  const inventory: Array<{ stock: WarehouseItemStock; adjustment: WarehouseItemStockAdjustment }> = [];
  for (const packageItem of pkg.items) {
    const item = itemsById[packageItem.order_item_id];
    if (!item?.item_id || !item.product_id) continue;
    const { data: warehouseSku } = await supabase.from("warehouse_skus").select("id").eq("warehouse_id", order.warehouse_id).eq("product_id", item.product_id).eq("owner_id", session.user.id).limit(1).maybeSingle();
    if (!warehouseSku) throw new Error(`商品 ${item.product_code} 还没有加入该仓库库存`);
    const { data: currentData } = await supabase.from("warehouse_item_stocks").select("*").eq("warehouse_id", order.warehouse_id).eq("item_id", item.item_id).eq("owner_id", session.user.id).maybeSingle();
    const current = (currentData as WarehouseItemStock | null) ?? (await supabase.from("warehouse_item_stocks").insert({ warehouse_id: order.warehouse_id, item_id: item.item_id }).select().single()).data as WarehouseItemStock;
    const nextQuantity = current.stock_quantity + packageItem.quantity;
    const { data: nextData } = await supabase.from("warehouse_item_stocks").update({ stock_quantity: nextQuantity }).eq("id", current.id).eq("owner_id", session.user.id).select().single();
    const next = nextData as WarehouseItemStock;
    const { data: adjustmentData } = await supabase.from("warehouse_item_stock_adjustments").insert({
      warehouse_id: order.warehouse_id, item_id: item.item_id, previous_quantity: current.stock_quantity,
      next_quantity: next.stock_quantity, change_quantity: packageItem.quantity, reason: "采购入库",
      purchase_order_id: order.id, purchase_package_id: pkg.id,
    }).select().single();
    inventory.push({ stock: next, adjustment: adjustmentData as WarehouseItemStockAdjustment });
  }
  const { data: packageData } = await supabase.from("purchase_packages").update({ status: "received", received_at: new Date().toISOString() }).eq("id", pkg.id).eq("owner_id", session.user.id).select().single();
  const { data: pending } = await supabase.from("purchase_packages").select("id").eq("order_id", order.id).eq("owner_id", session.user.id).eq("status", "pending");
  const status = (pending ?? []).length === 0 ? "received" : "partially_received";
  const { data: orderData } = await supabase.from("purchase_orders").update({ status, received_at: status === "received" ? new Date().toISOString() : null }).eq("id", order.id).eq("owner_id", session.user.id).select().single();
  return { order: orderData as Omit<PurchaseOrder, "sources" | "items" | "packages">, package: { ...(packageData as Omit<PurchasePackage, "items">), items: pkg.items }, inventory };
}
