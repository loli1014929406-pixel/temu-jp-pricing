import { withTimeout, requireSession } from "./supabase-helpers";
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

const temuOrderSelectFields =
  "id, owner_id, order_no, sub_order_no, order_status, sku_code, warehouse_name, logistics_method, label_printed_at, logistics_tracking_no, logistics_status, product_attributes, recipient_name, recipient_phone, email, province, city, district, address_line1, address_line2, postal_code, latest_ship_time, actual_ship_time, estimated_delivery_time, actual_signed_time, created_at, updated_at, warehouse_id, fulfillment_quantity";

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
  ) as Omit<TemuOrderRecord, "fulfillment_quantity" | "warehouse_id">;

  return {
    ...normalized,
    logistics_method: normalizeLogisticsMethod(normalized.logistics_method),
    warehouse_id: row.warehouse_id ?? null,
    fulfillment_quantity: Number(row.fulfillment_quantity ?? 0),
  };
}

export async function fetchTemuOrders() {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .select(temuOrderSelectFields)
      .eq("owner_id", session.user.id)
      .order("latest_ship_time", { ascending: true })
      .order("created_at", { ascending: false }),
    "加载订单",
  );
  if (error) throw error;
  return ((data ?? []) as Partial<TemuOrderRecord>[]).map(normalizeTemuOrder);
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
          .select(temuOrderSelectFields),
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
