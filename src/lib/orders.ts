import { withTimeout, requireSession } from "./supabase-helpers";
import { fetchAllPages } from "./paginated-fetch";
import type { TemuOrderRecord } from "../types";

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

const temuOrderSelectFields = `${temuOrderLegacySelectFields}, actual_shipping_fee_rmb`;

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
    "fulfillment_quantity" | "warehouse_id" | "actual_shipping_fee_rmb"
  >;

  return {
    ...normalized,
    logistics_method: normalizeLogisticsMethod(normalized.logistics_method),
    warehouse_id: row.warehouse_id ?? null,
    fulfillment_quantity: Number(row.fulfillment_quantity ?? 0),
    actual_shipping_fee_rmb: Number(row.actual_shipping_fee_rmb ?? 0),
  };
}

export async function fetchTemuOrders() {
  const { supabase, session } = await requireSession();
  const fetchByFields = (fields: string) =>
    fetchAllPages<Partial<TemuOrderRecord>>(async (from, to) => {
      const { data, error } = await withTimeout(
        supabase
          .from("temu_orders")
          .select(fields)
          .eq("owner_id", session.user.id)
          .order("latest_ship_time", { ascending: true })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
        "加载订单",
      );
      return { data: (data ?? []) as Partial<TemuOrderRecord>[], error };
    });

  const { data, error } = await fetchByFields(temuOrderSelectFields);
  if (error && isMissingActualShippingFeeColumnError(error)) {
    const { data: legacyData, error: legacyError } = await fetchByFields(
      temuOrderLegacySelectFields,
    );
    if (legacyError) throw legacyError;
    return (legacyData ?? []).map(normalizeTemuOrder);
  }
  if (error) throw error;
  return (data ?? []).map(normalizeTemuOrder);
}

export type FetchTemuOrdersPaginatedOptions = {
  page: number;
  pageSize: number;
  searchQuery?: string;
  statusFilter?: string;
};

export async function fetchTemuOrdersPaginated(options: FetchTemuOrdersPaginatedOptions) {
  const { supabase, session } = await requireSession();
  const { page, pageSize, searchQuery, statusFilter } = options;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const buildRequest = (fields: string) => {
    let req = supabase
      .from("temu_orders")
      .select(fields, { count: "exact" })
      .eq("owner_id", session.user.id);
    
    if (statusFilter) {
      req = req.eq("order_status", statusFilter);
    }
    
    if (searchQuery) {
      const escaped = searchQuery.replace(/[%_\\]/g, "\\$&").replace(/"/g, '""');
      req = req.or(`order_no.ilike."%${escaped}%",sub_order_no.ilike."%${escaped}%",logistics_tracking_no.ilike."%${escaped}%"`);
    }

    return req
      .order("latest_ship_time", { ascending: true })
      .order("created_at", { ascending: false })
      .range(from, to);
  };

  const { data, error, count } = await withTimeout(buildRequest(temuOrderSelectFields), "加载订单分页");

  if (error && isMissingActualShippingFeeColumnError(error)) {
    const { data: legacyData, error: legacyError, count: legacyCount } = await withTimeout(
      buildRequest(temuOrderLegacySelectFields),
      "加载订单分页",
    );
    if (legacyError) throw legacyError;
    return {
      data: ((legacyData ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder),
      count: legacyCount ?? 0,
    };
  }
  
  if (error) throw error;

  return {
    data: ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder),
    count: count ?? 0,
  };
}

export async function importTemuOrders(rows: TemuOrderImportRow[]) {
  const { supabase, session } = await requireSession();
  if (rows.length === 0) return [] as TemuOrderRecord[];

  const { data: existingData, error: existingError } = await withTimeout(
    supabase
      .from("temu_orders")
      .select("order_no, sub_order_no, sku_code, product_attributes")
      .eq("owner_id", session.user.id),
    "检查已有订单",
  );
  if (existingError) throw existingError;

  const existingRows = (existingData ?? []) as Array<
    Pick<TemuOrderImportRow, "order_no" | "sub_order_no" | "sku_code" | "product_attributes">
  >;
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
        onConflict: "owner_id,order_no,sub_order_no",
        ignoreDuplicates: true,
      })
      .select(temuOrderSelectFields),
    "导入订单",
  );
  if (error) {
    const message = String(error.message ?? "");
    if (isMissingActualShippingFeeColumnError(error)) {
      const { data: legacyData, error: legacyError } = await withTimeout(
        supabase
          .from("temu_orders")
          .upsert(payload, {
            onConflict: "owner_id,order_no,sub_order_no",
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
            onConflict: "owner_id,order_no,sub_order_no",
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
  return ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
}

export async function updateTemuOrder(
  orderId: string,
  updates: Partial<
    Pick<
      TemuOrderRecord,
      | "order_status"
      | "warehouse_id"
      | "warehouse_name"
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
  const { supabase, session } = await requireSession();
  const normalizedUpdates = {
    ...updates,
    logistics_method:
      updates.logistics_method === undefined
        ? undefined
        : normalizeLogisticsMethod(updates.logistics_method),
  };
  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .update(normalizedUpdates)
      .eq("id", orderId)
      .eq("owner_id", session.user.id)
      .select(temuOrderSelectFields)
      .single(),
    "更新订单",
  );
  if (error && isMissingActualShippingFeeColumnError(error)) {
    if (Object.prototype.hasOwnProperty.call(updates, "actual_shipping_fee_rmb")) {
      throw new Error("订单数据库还没有新增“实际运费”字段，请先执行最新订单迁移。");
    }
    const { data: legacyData, error: legacyError } = await withTimeout(
      supabase
        .from("temu_orders")
        .update(normalizedUpdates)
        .eq("id", orderId)
        .eq("owner_id", session.user.id)
        .select(temuOrderLegacySelectFields)
        .single(),
      "更新订单",
    );
    if (legacyError) throw legacyError;
    return normalizeTemuOrder(legacyData as Partial<TemuOrderRecord>);
  }
  if (error) throw error;
  return normalizeTemuOrder(data as Partial<TemuOrderRecord>);
}

export async function deleteTemuOrder(orderId: string) {
  const { supabase, session } = await requireSession();
  const { error } = await withTimeout(
    supabase.from("temu_orders").delete().eq("id", orderId).eq("owner_id", session.user.id),
    "删除订单",
  );
  if (error) throw error;
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
  return ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
}
