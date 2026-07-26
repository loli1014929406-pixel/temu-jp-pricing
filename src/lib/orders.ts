import { withTimeout, requireSession } from "./supabase-helpers";
import { fetchAllPages } from "./paginated-fetch";
import type {
  OrderCustomerHistoryStatus,
  TemuOrderRecord,
  WarehouseSku,
} from "../types";

export type TemuOrderImportRow = Pick<
  TemuOrderRecord,
  | "order_no"
  | "sub_order_no"
  | "order_status"
  | "sku_code"
  | "fulfillment_quantity"
  | "product_attributes"
  | "recipient_name"
  | "recipient_phone"
  | "email"
  | "province"
  | "city"
  | "district"
  | "address_line1"
  | "address_line2"
  | "postal_code"
  | "latest_ship_time"
  | "actual_ship_time"
  | "estimated_delivery_time"
>;

const textOrderFields = [
  "id",
  "source_order_id",
  "shipment_id",
  "shipment_item_id",
  "owner_id",
  "order_no",
  "sub_order_no",
  "order_status",
  "sku_code",
  "warehouse_name",
  "logistics_method",
  "label_printed_at",
  "logistics_tracking_no",
  "logistics_status",
  "logistics_status_detail",
  "tracking_event_time",
  "tracking_last_checked_at",
  "tracking_last_query_error",
  "tracking_last_query_error_at",
  "tracking_exception_reason",
  "tracking_exception_fingerprint",
  "tracking_exception_handled_at",
  "product_attributes",
  "recipient_name",
  "recipient_phone",
  "email",
  "province",
  "city",
  "district",
  "address_line1",
  "address_line2",
  "postal_code",
  "latest_ship_time",
  "actual_ship_time",
  "estimated_delivery_time",
  "actual_signed_time",
  "created_at",
  "updated_at",
] as const;

const temuOrderLegacySelectFields =
  "id, owner_id, order_no, sub_order_no, order_status, sku_code, warehouse_name, logistics_method, label_printed_at, logistics_tracking_no, logistics_status, product_attributes, recipient_name, recipient_phone, email, province, city, district, address_line1, address_line2, postal_code, latest_ship_time, actual_ship_time, estimated_delivery_time, actual_signed_time, created_at, updated_at, warehouse_id, fulfillment_quantity";

const temuOrderActualFeeSelectFields = `${temuOrderLegacySelectFields}, actual_shipping_fee_rmb`;
const temuOrderLogisticsMethodSelectFields = `${temuOrderActualFeeSelectFields}, logistics_method_id`;
const temuOrderSelectFields = `${temuOrderLogisticsMethodSelectFields}, logistics_status_detail, tracking_category, tracking_event_time, tracking_last_checked_at, tracking_last_query_error, tracking_last_query_error_at, tracking_is_exception, tracking_exception_reason, tracking_exception_fingerprint, tracking_exception_handled_at, tracking_exception_handled_by`;
const temuOrderFulfillmentSelectFields = `${temuOrderSelectFields}, source_order_id, shipment_id, shipment_item_id, package_sequence, package_count, is_split`;

function isMissingActualShippingFeeColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = String(maybeError.code ?? "");
  const message = String(maybeError.message ?? "");
  return code === "42703" && message.includes("actual_shipping_fee_rmb");
}

/**
 * Normalizes logistics method names parsed from Temu order exports.
 * Temu frequently changes the exact string representation of logistics channels.
 * This function maps known variations to our internal standard names (e.g., 'OCS Yamato').
 * @param value The raw logistics method string from the Temu export.
 * @returns The normalized internal logistics method name.
 */
function normalizeLogisticsMethod(value: string) {
  const text = value.trim();
  if (
    text === "OCS 昆山3cm" ||
    text === "OCS 昆山 3cm" ||
    text === "OCS 3cm" ||
    text === "OCS Yamato"
  ) {
    return "OCS Yamato";
  }
  if (text === "OCS 昆山小包" || text === "OCS 小包") return "OCS 小包";
  if (text === "福冈尾程" || text === "福冈Japan Post") return "福冈Japan Post";
  if (text === "大阪尾程" || text === "大阪Japan Post") return "大阪Japan Post";
  return text;
}

function getOrderNoKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSkuCode(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSalesSpec(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

export function normalizeOrderCustomerHistoryStatus(
  value: unknown,
): OrderCustomerHistoryStatus {
  return value === "repeat_customer" ||
    value === "refund_order" ||
    value === "refund_customer"
    ? value
    : "normal";
}

function getOrderLineKey(
  order: Pick<TemuOrderImportRow, "order_no" | "sub_order_no" | "sku_code" | "product_attributes">,
) {
  const orderNo = getOrderNoKey(order.order_no);
  if (!orderNo) return "";

  const subOrderNo = getOrderNoKey(order.sub_order_no);
  if (subOrderNo) return `${orderNo}\u0000${subOrderNo}`;

  return [
    orderNo,
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function getOrderLineSkuKey(
  order: Pick<TemuOrderImportRow, "order_no" | "sku_code" | "product_attributes">,
) {
  const orderNo = getOrderNoKey(order.order_no);
  if (!orderNo) return "";

  return [
    orderNo,
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function normalizeTemuOrder(row: Partial<TemuOrderRecord>): TemuOrderRecord {
  const normalized = Object.fromEntries(
    textOrderFields.map((field) => [field, String(row[field] ?? "")]),
  ) as Omit<
    TemuOrderRecord,
    | "fulfillment_quantity"
    | "warehouse_id"
    | "logistics_method_id"
    | "logistics_method_is_unmatched"
    | "actual_shipping_fee_rmb"
    | "tracking_category"
    | "tracking_is_exception"
    | "tracking_exception_handled_by"
    | "customer_history_status"
    | "customer_sales_reversal"
    | "customer_freight_reversal"
    | "package_sequence"
    | "package_count"
    | "is_split"
  >;

  return {
    ...normalized,
    logistics_method: normalizeLogisticsMethod(normalized.logistics_method),
    warehouse_id: row.warehouse_id ?? null,
    logistics_method_id: row.logistics_method_id ?? null,
    logistics_method_is_unmatched:
      Object.prototype.hasOwnProperty.call(row, "logistics_method_id") &&
      Boolean(normalized.logistics_method.trim()) &&
      !row.logistics_method_id,
    fulfillment_quantity: Number(row.fulfillment_quantity ?? 0),
    actual_shipping_fee_rmb: Number(row.actual_shipping_fee_rmb ?? 0),
    tracking_category:
      row.tracking_category === "in_transit" ||
      row.tracking_category === "out_for_delivery" ||
      row.tracking_category === "delivered" ||
      row.tracking_category === "available_for_pickup" ||
      row.tracking_category === "failed_attempt" ||
      row.tracking_category === "exception"
        ? row.tracking_category
        : "pending",
    tracking_is_exception: Boolean(row.tracking_is_exception),
    tracking_exception_handled_by:
      row.tracking_exception_handled_by ?? null,
    package_sequence: Math.max(1, Number(row.package_sequence ?? 1)),
    package_count: Math.max(1, Number(row.package_count ?? 1)),
    is_split: Boolean(row.is_split ?? Number(row.package_count ?? 1) > 1),
    customer_history_status: normalizeOrderCustomerHistoryStatus(
      row.customer_history_status,
    ),
    customer_sales_reversal: Number(row.customer_sales_reversal ?? 0),
    customer_freight_reversal: Number(row.customer_freight_reversal ?? 0),
  };
}

async function fetchFulfillmentLinesBySourceOrderIds(
  supabase: Awaited<ReturnType<typeof requireSession>>["supabase"],
  sourceOrderIds: string[],
) {
  const uniqueIds = Array.from(new Set(sourceOrderIds.filter(Boolean)));
  const rows: Partial<TemuOrderRecord>[] = [];

  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const { data, error } = await withTimeout(
      supabase
        .from("temu_order_fulfillment_lines")
        .select(temuOrderFulfillmentSelectFields)
        .in("source_order_id", chunk)
        .order("package_sequence", { ascending: true })
        .order("id", { ascending: true }),
      "加载订单包裹",
    );
    if (error) throw error;
    rows.push(...((data ?? []) as Partial<TemuOrderRecord>[]));
  }

  return rows.map(normalizeTemuOrder);
}

export async function fetchTemuOrders() {
  const { supabase } = await requireSession();
  const { data, error } = await fetchAllPages<Partial<TemuOrderRecord>>(
    async (from, to) => {
      const { data: pageData, error: pageError } = await withTimeout(
        supabase
          .from("temu_order_fulfillment_lines")
          .select(temuOrderFulfillmentSelectFields)
          .order("latest_ship_time", { ascending: true })
          .order("created_at", { ascending: false })
          .order("package_sequence", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
        "加载订单",
      );
      return {
        data: (pageData ?? []) as Partial<TemuOrderRecord>[],
        error: pageError,
      };
    },
  );
  if (error) throw error;
  return (data ?? []).map(normalizeTemuOrder);
}

function isMissingLogisticsMethodIdColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = String(maybeError.code ?? "");
  const message = String(maybeError.message ?? "");
  return code === "42703" && message.includes("logistics_method_id");
}

export type TemuOrderStageFilter =
  | "all"
  | "pending_assignment"
  | "new_order"
  | "pending_shipping"
  | "shipped"
  | "uploaded_temu"
  | "completed";

export type TemuOrderSortKey =
  | "ship_deadline"
  | "delivery_deadline"
  | "product"
  | "logistics_status";

export type TemuOrderStageCounts = Record<TemuOrderStageFilter, number>;

export type FetchTemuOrdersPageOptions = {
  page: number;
  pageSize: number;
  searchQuery?: string;
  stage?: TemuOrderStageFilter;
  warehouseId?: string;
  logisticsMethod?: string;
  urgentOnly?: boolean;
  sortKey?: TemuOrderSortKey;
  sortDirection?: "asc" | "desc";
};

export type TemuOrdersPage = {
  orders: TemuOrderRecord[];
  totalCount: number;
  totalLineCount: number;
  stageCounts: TemuOrderStageCounts;
  urgentUnuploadedCount: number;
};

export const emptyTemuOrderStageCounts: TemuOrderStageCounts = {
  all: 0,
  pending_assignment: 0,
  new_order: 0,
  pending_shipping: 0,
  shipped: 0,
  uploaded_temu: 0,
  completed: 0,
};

export function normalizeTemuOrdersPageOptions(
  options: FetchTemuOrdersPageOptions,
): Required<FetchTemuOrdersPageOptions> {
  return {
    page: Math.max(1, Math.trunc(options.page || 1)),
    pageSize: Math.min(100, Math.max(1, Math.trunc(options.pageSize || 20))),
    searchQuery: options.searchQuery?.trim() ?? "",
    stage: options.stage ?? "all",
    warehouseId: options.warehouseId?.trim() ?? "",
    logisticsMethod: options.logisticsMethod?.trim() ?? "",
    urgentOnly: options.urgentOnly ?? false,
    sortKey: options.sortKey ?? "ship_deadline",
    sortDirection: options.sortDirection ?? "asc",
  };
}

function isMissingTemuOrderPageRpcError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = String(maybeError.code ?? "");
  const message = String(maybeError.message ?? "");
  return (
    code === "PGRST202" ||
    code === "42883" ||
    message.includes("get_temu_orders_page")
  );
}

export async function fetchTemuOrdersPage(
  rawOptions: FetchTemuOrdersPageOptions,
): Promise<TemuOrdersPage> {
  const { supabase } = await requireSession();
  const options = normalizeTemuOrdersPageOptions(rawOptions);
  const { data, error } = await withTimeout(
    supabase.rpc("get_temu_orders_page", {
      p_page: options.page,
      p_page_size: options.pageSize,
      p_search: options.searchQuery,
      p_stage: options.stage,
      p_warehouse_id: options.warehouseId || null,
      p_logistics_method: options.logisticsMethod,
      p_urgent_only: options.urgentOnly,
      p_sort_key: options.sortKey,
      p_sort_direction: options.sortDirection,
      p_now: new Date().toISOString(),
    }),
    "加载订单分页",
    { requestKind: "rpc" },
  );

  if (error) {
    if (isMissingTemuOrderPageRpcError(error)) {
      throw new Error(
        "订单后端分页尚未初始化，请执行 20260711000000_add_temu_order_page_rpc.sql 迁移。",
      );
    }
    throw error;
  }

  const response = (Array.isArray(data) ? data[0] : data) as
    | {
        orders?: unknown;
        total_count?: unknown;
        total_line_count?: unknown;
        stage_counts?: unknown;
        urgent_unuploaded_count?: unknown;
      }
    | null
    | undefined;
  const responseOrders = Array.isArray(response?.orders) ? response.orders : [];
  const rawStageCounts =
    response?.stage_counts && typeof response.stage_counts === "object"
      ? (response.stage_counts as Partial<Record<TemuOrderStageFilter, unknown>>)
      : {};

  return {
    orders: (responseOrders as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder),
    totalCount: Number(response?.total_count ?? 0),
    totalLineCount: Number(response?.total_line_count ?? 0),
    stageCounts: Object.fromEntries(
      Object.keys(emptyTemuOrderStageCounts).map((stage) => [
        stage,
        Number(rawStageCounts[stage as TemuOrderStageFilter] ?? 0),
      ]),
    ) as TemuOrderStageCounts,
    urgentUnuploadedCount: Number(response?.urgent_unuploaded_count ?? 0),
  };
}

export type FetchFinanceOrdersPageOptions = {
  page: number;
  pageSize: number;
  search?: string;
  dateStart?: string;
  dateEnd?: string;
  settlementStatus?: "all" | "settled" | "unsettled";
};

export async function fetchFinanceOrdersPage(
  options: FetchFinanceOrdersPageOptions,
): Promise<{ orders: TemuOrderRecord[]; totalCount: number }> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("get_finance_orders_page", {
      p_page: Math.max(1, Math.trunc(options.page || 1)),
      p_page_size: Math.min(100, Math.max(1, Math.trunc(options.pageSize || 50))),
      p_search: options.search?.trim() ?? "",
      p_date_start: options.dateStart || null,
      p_date_end: options.dateEnd || null,
      p_settlement_status: options.settlementStatus ?? "all",
    }),
    "加载财务订单分页",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  const payload = (Array.isArray(data) ? data[0] : data) as
    | { orders?: unknown; total_count?: unknown }
    | null;
  const orders = Array.isArray(payload?.orders) ? payload.orders : [];
  return {
    orders: (orders as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder),
    totalCount: Number(payload?.total_count ?? 0),
  };
}

export async function importTemuOrders(rows: TemuOrderImportRow[]) {
  const { supabase, session } = await requireSession();
  if (rows.length === 0) return [] as TemuOrderRecord[];

  type ExistingOrderLine = Pick<
    TemuOrderImportRow,
    "order_no" | "sub_order_no" | "sku_code" | "product_attributes"
  >;
  const { data: existingData, error: existingError } = await fetchAllPages<ExistingOrderLine>(
    async (from, to) => {
      const { data, error } = await withTimeout(
        supabase
          .from("temu_orders")
          .select("order_no, sub_order_no, sku_code, product_attributes")
          .order("id", { ascending: true })
          .range(from, to),
        "检查已有订单",
      );
      return { data: (data ?? []) as ExistingOrderLine[], error };
    },
  );
  if (existingError) throw existingError;

  const existingRows = existingData ?? [];
  const existingRowsByLineKey = new Map<string, typeof existingRows[number]>();
  const existingRowsBySkuKey = new Map<string, typeof existingRows[number]>();
  const existingOrderNoCounts = existingRows.reduce<Record<string, number>>(
    (counts, row) => {
      const key = getOrderNoKey(row.order_no);
      if (key) counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const importOrderNoCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = getOrderNoKey(row.order_no);
    if (key) counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  existingRows.forEach((row) => {
    const lineKey = getOrderLineKey(row);
    if (lineKey && !existingRowsByLineKey.has(lineKey)) {
      existingRowsByLineKey.set(lineKey, row);
    }

    const skuKey = getOrderLineSkuKey(row);
    if (skuKey && !existingRowsBySkuKey.has(skuKey)) {
      existingRowsBySkuKey.set(skuKey, row);
    }
  });

  const newRows = rows.filter((row) => {
    const lineKey = getOrderLineKey(row);
    if (lineKey && existingRowsByLineKey.has(lineKey)) return false;

    const skuKey = getOrderLineSkuKey(row);
    if (skuKey && existingRowsBySkuKey.has(skuKey)) return false;

    const orderNoKey = getOrderNoKey(row.order_no);
    return !(
      orderNoKey &&
      (existingOrderNoCounts[orderNoKey] ?? 0) === 1 &&
      (importOrderNoCounts[orderNoKey] ?? 0) === 1
    );
  });
  if (newRows.length === 0) return [] as TemuOrderRecord[];

  const payload = newRows.map((row) => ({
    ...row,
    owner_id: session.user.id,
  }));

  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .upsert(payload, {
        onConflict: "order_no,sub_order_no",
        ignoreDuplicates: true,
      })
      .select(temuOrderSelectFields),
    "导入订单",
  );
  if (error && isMissingLogisticsMethodIdColumnError(error)) {
    const { data: compatibleData, error: compatibleError } = await withTimeout(
      supabase
        .from("temu_orders")
        .upsert(payload, {
          onConflict: "order_no,sub_order_no",
          ignoreDuplicates: true,
        })
        .select(temuOrderActualFeeSelectFields),
      "导入订单",
    );
    if (compatibleError) throw compatibleError;
    return ((compatibleData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
  }
  if (error) {
    const message = String(error.message ?? "");
    if (isMissingActualShippingFeeColumnError(error)) {
      const { data: legacyData, error: legacyError } = await withTimeout(
        supabase
          .from("temu_orders")
          .upsert(payload, {
            onConflict: "order_no,sub_order_no",
            ignoreDuplicates: true,
          })
          .select(temuOrderLegacySelectFields),
        "导入订单",
      );
      if (legacyError) throw legacyError;
      return ((legacyData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
    }
    if (message.includes("sku_code")) {
      const legacyPayload = payload.map(({ sku_code, ...row }) => {
        void sku_code;
        return row;
      });
      const { data: legacyData, error: legacyError } = await withTimeout(
        supabase
          .from("temu_orders")
          .upsert(legacyPayload, {
            onConflict: "order_no,sub_order_no",
            ignoreDuplicates: true,
          })
          .select(temuOrderLegacySelectFields),
        "导入订单",
      );
      if (legacyError) throw legacyError;
      return ((legacyData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
    }
    throw error;
  }
  return fetchFulfillmentLinesBySourceOrderIds(
    supabase,
    ((data ?? []) as Array<{ id?: string }>).map((row) => String(row.id ?? "")),
  );
}

export async function updateTemuOrder(
  orderId: string,
  updates: Partial<
    Pick<
      TemuOrderRecord,
      | "order_status"
      | "warehouse_id"
      | "warehouse_name"
      | "logistics_method_id"
      | "logistics_method"
      | "label_printed_at"
      | "logistics_tracking_no"
      | "logistics_status"
      | "actual_ship_time"
      | "actual_signed_time"
      | "actual_shipping_fee_rmb"
    >
  >,
) {
  const { supabase } = await requireSession();
  const {
    warehouse_id,
    warehouse_name,
    logistics_method_id,
    logistics_method,
    ...shipmentUpdates
  } = updates;
  void warehouse_id;
  void warehouse_name;
  void logistics_method;

  if (logistics_method_id) {
    const { error } = await withTimeout(
      supabase.rpc("correct_temu_order_shipment_logistics_method", {
        p_shipment_item_id: orderId,
        p_logistics_method_id: logistics_method_id,
      }),
      "修正订单物流方式",
      { requestKind: "rpc" },
    );
    if (error) throw error;
  }

  if (Object.keys(shipmentUpdates).length > 0) {
    const { error } = await withTimeout(
      supabase.rpc("update_temu_order_shipment", {
        p_shipment_item_id: orderId,
        p_updates: shipmentUpdates,
      }),
      "更新订单",
      { requestKind: "rpc" },
    );
    if (error) throw error;
  }

  const { data: updated, error: fetchError } = await withTimeout(
    supabase
      .from("temu_order_fulfillment_lines")
      .select(temuOrderFulfillmentSelectFields)
      .eq("id", orderId)
      .single(),
    "加载更新后的订单包裹",
  );
  if (fetchError) throw fetchError;
  return normalizeTemuOrder(updated as Partial<TemuOrderRecord>);
}

export async function deleteTemuOrder(orderId: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("delete_temu_order_group", {
      p_shipment_item_id: orderId,
    }),
    "删除订单",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  return data as {
    deleted_order_no?: string;
    released_changes?: Array<{
      sku: WarehouseSku;
      previous_quantity: number;
      change_quantity: number;
    }>;
  } | null;
}

export type TemuShipmentInventoryChange = {
  sku: WarehouseSku;
  previous_quantity: number;
  change_quantity: number;
};

async function fetchShipmentLines(
  supabase: Awaited<ReturnType<typeof requireSession>>["supabase"],
  shipmentId: string,
) {
  const { data, error } = await withTimeout(
    supabase
      .from("temu_order_fulfillment_lines")
      .select(temuOrderFulfillmentSelectFields)
      .eq("shipment_id", shipmentId)
      .order("id", { ascending: true }),
    "加载包裹明细",
  );
  if (error) throw error;
  return ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
}

export async function fetchTemuOrderFulfillmentByOrderNo(orderNo: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_order_fulfillment_lines")
      .select(temuOrderFulfillmentSelectFields)
      .eq("order_no", orderNo)
      .order("package_sequence", { ascending: true })
      .order("id", { ascending: true }),
    "加载订单全部包裹",
  );
  if (error) throw error;
  return ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
}

export async function assignTemuOrderShipment(input: {
  shipmentId: string;
  warehouseId: string;
  logisticsMethodId: string;
  reservations: Array<{
    shipmentItemId: string;
    warehouseSkuId: string;
  }>;
  reason?: string;
}) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("assign_temu_order_shipment", {
      p_shipment_id: input.shipmentId,
      p_warehouse_id: input.warehouseId,
      p_logistics_method_id: input.logisticsMethodId,
      p_reservations: input.reservations.map((reservation) => ({
        shipment_item_id: reservation.shipmentItemId,
        warehouse_sku_id: reservation.warehouseSkuId,
      })),
      p_reason: input.reason ?? "",
    }),
    "分配订单包裹",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  const payload = (data ?? {}) as { changes?: TemuShipmentInventoryChange[] };
  return {
    orders: await fetchShipmentLines(supabase, input.shipmentId),
    changes: Array.isArray(payload.changes) ? payload.changes : [],
  };
}

export async function releaseTemuOrderShipmentInventory(
  shipmentId: string,
  reason = "",
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("release_temu_order_shipment_inventory", {
      p_shipment_id: shipmentId,
      p_reason: reason,
    }),
    "释放订单包裹库存",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  const payload = (data ?? {}) as { changes?: TemuShipmentInventoryChange[] };
  return {
    orders: await fetchShipmentLines(supabase, shipmentId),
    changes: Array.isArray(payload.changes) ? payload.changes : [],
  };
}

export type TemuOrderSplitPackageInput = {
  items: Array<{ orderId: string; quantity: number }>;
};

export async function saveTemuOrderSplit(
  orderNo: string,
  packages: TemuOrderSplitPackageInput[],
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("save_temu_order_split", {
      p_order_no: orderNo,
      p_packages: packages.map((shipmentPackage) => ({
        items: shipmentPackage.items.map((item) => ({
          order_id: item.orderId,
          quantity: item.quantity,
        })),
      })),
    }),
    "保存拆单",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  return data;
}

export async function cancelTemuOrderSplit(orderNo: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("cancel_temu_order_split", {
      p_order_no: orderNo,
    }),
    "取消拆单",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  return data;
}

export async function createReshipmentOrder(
  originalOrders: TemuOrderRecord[],
  suffix: string,
  itemsToReship: Array<{
    skuCode: string;
    productAttributes: string;
    quantity: number;
  }>
) {
  const { supabase, session } = await requireSession();
  
  const cleanSuffix = suffix.trim().replace(/^-+/, "");
  if (!cleanSuffix) throw new Error("请输入有效的补发单号后缀");
  if (itemsToReship.length === 0) throw new Error("请至少选择或添加一项补发商品");
  
  const payload = itemsToReship.map((item, index) => {
    const matchingOrig = originalOrders.find(o => o.sku_code === item.skuCode) || originalOrders[0];
    
    return {
      owner_id: session.user.id,
      order_no: `${matchingOrig.order_no}-${cleanSuffix}`,
      sub_order_no: matchingOrig.sub_order_no 
        ? `${matchingOrig.sub_order_no}-${cleanSuffix}` 
        : `${matchingOrig.order_no}-${cleanSuffix}-sub-${index}`,
      order_status: "待发货",
      sku_code: item.skuCode,
      fulfillment_quantity: item.quantity,
      product_attributes: item.productAttributes,
      
      warehouse_id: null,
      warehouse_name: "",
      logistics_method_id: null,
      logistics_method: "",
      logistics_tracking_no: "",
      logistics_status: "",
      label_printed_at: "",
      actual_ship_time: "",
      actual_signed_time: "",
      
      recipient_name: matchingOrig.recipient_name,
      recipient_phone: matchingOrig.recipient_phone,
      email: matchingOrig.email,
      province: matchingOrig.province,
      city: matchingOrig.city,
      district: matchingOrig.district,
      address_line1: matchingOrig.address_line1,
      address_line2: matchingOrig.address_line2,
      postal_code: matchingOrig.postal_code,
      latest_ship_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      estimated_delivery_time: "",
      actual_shipping_fee_rmb: 0,
    };
  });

  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .insert(payload)
      .select(temuOrderSelectFields),
    "创建补发订单"
  );

  if (error) {
    if (isMissingLogisticsMethodIdColumnError(error)) {
      const compatiblePayload = payload.map(({ logistics_method_id, ...row }) => {
        void logistics_method_id;
        return row;
      });
      const { data: compatibleData, error: compatibleError } = await withTimeout(
        supabase
          .from("temu_orders")
          .insert(compatiblePayload)
          .select(temuOrderActualFeeSelectFields),
        "创建补发订单",
      );
      if (compatibleError) throw compatibleError;
      return ((compatibleData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
    }
    // If standard fields fail, check if actual_shipping_fee_rmb exists
    if (isMissingActualShippingFeeColumnError(error)) {
      const { data: legacyData, error: legacyError } = await withTimeout(
        supabase
          .from("temu_orders")
          .insert(payload)
          .select(temuOrderLegacySelectFields),
        "创建补发订单"
      );
      if (legacyError) throw legacyError;
      return ((legacyData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
    }
    throw error;
  }
  return fetchFulfillmentLinesBySourceOrderIds(
    supabase,
    ((data ?? []) as Array<{ id?: string }>).map((row) => String(row.id ?? "")),
  );
}
