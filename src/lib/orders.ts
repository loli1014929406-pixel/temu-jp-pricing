import { getSupabaseClient } from "./supabase";
import type { TemuOrderRecord } from "../types";

const requestTimeoutMs = 15000;

async function withTimeout<T>(promise: PromiseLike<T>, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}超时，请稍后重试`)), requestTimeoutMs);
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
  if (!session?.user) throw new Error("当前登录已失效，请重新登录");
  return { supabase, session };
}

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
  if (text === "OCS 昆山3cm" || text === "OCS 昆山 3cm") return "OCS 3cm";
  if (text === "OCS 昆山小包") return "OCS 小包";
  return text;
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

  const payload = rows.map((row) => ({
    ...row,
    owner_id: session.user.id,
  }));

  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .upsert(payload, {
        onConflict: "owner_id,order_no,sub_order_no",
        ignoreDuplicates: false,
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
            ignoreDuplicates: false,
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
