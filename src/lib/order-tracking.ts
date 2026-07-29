import { requireSession, withTimeout } from "./supabase-helpers";
import type { TrackingCategory } from "../types";

export type TemuTrackingAlert = {
  order_no: string;
  package_sequence: number;
  package_count: number;
  stage: "shipped" | "uploaded_temu";
  logistics_tracking_no: string;
  logistics_method: string;
  logistics_status: string;
  logistics_status_detail: string;
  tracking_category: TrackingCategory;
  tracking_exception_reason: string;
  tracking_exception_fingerprint: string;
  tracking_exception_handled_at: string;
  tracking_last_checked_at: string;
};

export type TrackingRefreshResult = {
  source: "manual" | "cron";
  queriedOrderCount: number;
  updatedOrderCount: number;
  deliveredOrderCount: number;
  exceptionOrderCount: number;
  failedOrderCount: number;
  failures: Array<{ orderNo: string; message: string }>;
};

export async function fetchTemuTrackingAlerts() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("get_temu_tracking_alerts"),
    "加载物流异常提醒",
    { requestKind: "rpc" },
  );
  if (error) throw error;

  return ((data ?? []) as Array<Partial<TemuTrackingAlert>>).map(
    (row): TemuTrackingAlert => ({
      order_no: String(row.order_no ?? ""),
      package_sequence: Math.max(1, Number(row.package_sequence ?? 1)),
      package_count: Math.max(1, Number(row.package_count ?? 1)),
      stage: row.stage === "uploaded_temu" ? "uploaded_temu" : "shipped",
      logistics_tracking_no: String(row.logistics_tracking_no ?? ""),
      logistics_method: String(row.logistics_method ?? ""),
      logistics_status: String(row.logistics_status ?? ""),
      logistics_status_detail: String(row.logistics_status_detail ?? ""),
      tracking_category:
        row.tracking_category === "in_transit" ||
        row.tracking_category === "out_for_delivery" ||
        row.tracking_category === "delivered" ||
        row.tracking_category === "available_for_pickup" ||
        row.tracking_category === "failed_attempt" ||
        row.tracking_category === "exception"
          ? row.tracking_category
          : "pending",
      tracking_exception_reason: String(
        row.tracking_exception_reason ?? "",
      ),
      tracking_exception_fingerprint: String(
        row.tracking_exception_fingerprint ?? "",
      ),
      tracking_exception_handled_at: String(
        row.tracking_exception_handled_at ?? "",
      ),
      tracking_last_checked_at: String(row.tracking_last_checked_at ?? ""),
    }),
  );
}

export async function markTemuTrackingAlertHandled(
  orderNo: string,
  fingerprint: string,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("mark_temu_tracking_exception_handled", {
      p_order_no: orderNo,
      p_fingerprint: fingerprint,
    }),
    "处理物流异常",
    { requestKind: "rpc" },
  );
  if (error) throw error;
  return Number(data ?? 0);
}

export async function refreshTemuTrackingForOrderIds(orderIds: string[]) {
  const { supabase } = await requireSession();
  const {
    data: { session },
    error: refreshError,
  } = await withTimeout(
    supabase.auth.refreshSession(),
    "刷新登录状态",
    { requestKind: "auth" },
  );
  if (refreshError || !session?.access_token) {
    throw new Error("当前登录已失效，请重新登录后再查询物流状态。");
  }

  const { data, error } = await withTimeout(
    supabase.functions.invoke("refresh-temu-tracking", {
      body: { source: "manual", orderIds },
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    }),
    "查询物流状态",
  );
  if (error) {
    throw new Error(
      await getEdgeFunctionErrorMessage(error, "查询物流状态失败。"),
    );
  }
  if (!data || typeof data !== "object") {
    throw new Error("物流查询服务返回了无效结果。");
  }
  return data as TrackingRefreshResult;
}

export async function getEdgeFunctionErrorMessage(
  error: unknown,
  fallback: string,
) {
  const context =
    error && typeof error === "object" && "context" in error
      ? (error as { context?: unknown }).context
      : null;

  if (typeof Response !== "undefined" && context instanceof Response) {
    try {
      const body = await context.clone().text();
      if (body.trim()) {
        try {
          const payload = JSON.parse(body) as {
            error?: unknown;
            message?: unknown;
          };
          const message = String(payload.error ?? payload.message ?? "").trim();
          if (message) return message;
        } catch {
          return body.trim();
        }
      }
    } catch {
      // Fall back to the structured error message below.
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}
