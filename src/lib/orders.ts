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

export async function fetchTemuOrders() {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .select("*")
      .eq("owner_id", session.user.id)
      .order("latest_ship_time", { ascending: true })
      .order("created_at", { ascending: false }),
    "加载订单",
  );
  if (error) throw error;
  return (data ?? []) as TemuOrderRecord[];
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
      })
      .select(),
    "导入订单",
  );
  if (error) throw error;
  return (data ?? []) as TemuOrderRecord[];
}

export async function updateTemuOrder(
  orderId: string,
  updates: Pick<TemuOrderRecord, "order_status" | "actual_ship_time">,
) {
  const { supabase, session } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .update(updates)
      .eq("id", orderId)
      .eq("owner_id", session.user.id)
      .select()
      .single(),
    "更新订单",
  );
  if (error) throw error;
  return data as TemuOrderRecord;
}

export async function deleteTemuOrder(orderId: string) {
  const { supabase, session } = await requireSession();
  const { error } = await withTimeout(
    supabase.from("temu_orders").delete().eq("id", orderId).eq("owner_id", session.user.id),
    "删除订单",
  );
  if (error) throw error;
}
