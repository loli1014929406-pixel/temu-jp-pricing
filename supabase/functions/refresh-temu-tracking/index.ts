import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import {
  buildTrackingEventIdentity,
  parseJapanPostTrackingHtml,
  parseYamatoTrackingHtml,
  type ParsedTrackingResult,
  type TrackingCarrier,
} from "../_shared/order-tracking.ts";

type TrackingOrder = {
  id: string;
  order_no: string;
  order_status: string;
  warehouse_name: string;
  logistics_method: string;
  logistics_tracking_no: string;
  actual_ship_time: string | null;
  actual_signed_time: string | null;
  tracking_exception_fingerprint: string | null;
  tracking_exception_handled_at: string | null;
};

type RefreshRequest = {
  source?: "manual" | "cron";
  orderIds?: string[];
};

const corsHeaders = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "仅支持 POST 请求。" }, 405);
  }

  try {
    const body = (await request.json().catch(() => ({}))) as RefreshRequest;
    const source = body.source === "cron" ? "cron" : "manual";
    let trackingProxySecret = "";

    if (source === "cron") {
      trackingProxySecret = await requireCronAuthorization(request);
    } else {
      await requireEditorAuthorization(request);
      trackingProxySecret = await getTrackingProxySecret();
    }

    const orderIds =
      source === "manual"
        ? Array.from(
            new Set(
              (body.orderIds ?? [])
                .map((value) => String(value).trim())
                .filter(Boolean),
            ),
          ).slice(0, 100)
        : [];

    if (source === "manual" && orderIds.length === 0) {
      return jsonResponse({ error: "当前页面没有可查询的订单。" }, 400);
    }

    const rows = await fetchOrderRows(orderIds);
    const eligibleRows = rows.filter(isTrackingCandidate);
    const orderGroups = groupTrackingOrders(eligibleRows);
    const outcomes = await mapWithConcurrency(orderGroups, 5, (group) =>
      refreshOrderGroup(group, trackingProxySecret),
    );
    const successful = outcomes.filter((outcome) => outcome.ok);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    return jsonResponse({
      source,
      queriedOrderCount: orderGroups.length,
      updatedOrderCount: successful.length,
      deliveredOrderCount: successful.filter((outcome) => outcome.delivered)
        .length,
      exceptionOrderCount: successful.filter((outcome) => outcome.exception)
        .length,
      failedOrderCount: failed.length,
      failures: failed.map((outcome) => ({
        orderNo: outcome.orderNo,
        message: outcome.message,
      })),
    });
  } catch (error) {
    console.error("refresh-temu-tracking failed", error);
    return jsonResponse(
      {
        error: getErrorMessage(error),
      },
      getHttpStatus(error),
    );
  }
});

async function requireEditorAuthorization(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) throw httpError("登录状态已失效，请重新登录。", 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser(accessToken);
  if (userError || !user) throw httpError("登录状态已失效，请重新登录。", 401);

  const { data: canEdit, error: permissionError } = await userClient.rpc(
    "current_account_can_edit",
  );
  if (permissionError) throw permissionError;
  if (!canEdit) throw httpError("当前账号没有编辑权限，不能更新物流状态。", 403);
}

async function requireCronAuthorization(request: Request) {
  const providedSecret = request.headers.get("x-cron-secret") ?? "";
  const { data: expectedSecret, error } = await serviceClient.rpc(
    "get_temu_tracking_cron_secret",
  );
  if (error) throw error;
  if (
    !providedSecret ||
    !expectedSecret ||
    !constantTimeEqual(providedSecret, String(expectedSecret))
  ) {
    throw httpError("定时任务认证失败。", 401);
  }
  return String(expectedSecret);
}

async function getTrackingProxySecret() {
  const { data, error } = await serviceClient.rpc(
    "get_temu_tracking_cron_secret",
  );
  if (error) throw error;
  if (!data) throw new Error("物流代理认证尚未配置。");
  return String(data);
}

async function fetchOrderRows(orderIds: string[]) {
  const { data, error } = await serviceClient.rpc(
    "get_temu_tracking_candidates",
    { p_order_ids: orderIds.length > 0 ? orderIds : null },
  );
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as TrackingOrder[];
}

function isTrackingCandidate(order: TrackingOrder) {
  return (
    Boolean(order.logistics_tracking_no?.trim()) &&
    !order.actual_signed_time?.trim() &&
    (isUploadedTemuStatus(order.order_status) ||
      Boolean(order.actual_ship_time?.trim()) ||
      Boolean(order.logistics_tracking_no?.trim()))
  );
}

function isUploadedTemuStatus(value: string) {
  const status = String(value ?? "").trim().toLowerCase();
  return status === "上传temu".toLowerCase() || status === "已上传temu".toLowerCase();
}

function groupTrackingOrders(rows: TrackingOrder[]) {
  const groups = new Map<string, TrackingOrder[]>();

  rows.forEach((row) => {
    const orderNo = row.order_no.trim();
    if (!orderNo) return;
    const key = orderNo.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });

  return Array.from(groups.values());
}

async function refreshOrderGroup(
  group: TrackingOrder[],
  trackingProxySecret: string,
) {
  const representative = group[0];
  const orderNo = representative.order_no.trim();
  const trackingNo = representative.logistics_tracking_no.trim();
  const carrier = getTrackingCarrier(representative);
  const checkedAt = new Date().toISOString();

  try {
    const trackingResult = await fetchTrackingStatus(
      carrier,
      trackingNo,
      trackingProxySecret,
    );
    const fingerprint = trackingResult.isException
      ? await sha256(
          buildTrackingEventIdentity(carrier, trackingNo, trackingResult),
        )
      : "";
    const preserveHandled =
      trackingResult.isException &&
      representative.tracking_exception_fingerprint === fingerprint &&
      Boolean(representative.tracking_exception_handled_at);
    const { error } = await serviceClient.rpc("save_temu_tracking_result", {
      p_order_no: orderNo,
      p_tracking_no: trackingNo,
      p_checked_at: checkedAt,
      p_query_error: "",
      p_logistics_status: trackingResult.status,
      p_logistics_status_detail: trackingResult.detail,
      p_tracking_category: trackingResult.category,
      p_tracking_event_time: trackingResult.eventTime || null,
      p_tracking_is_exception: trackingResult.isException,
      p_tracking_exception_reason: trackingResult.exceptionReason,
      p_tracking_exception_fingerprint: fingerprint,
      p_preserve_handled: preserveHandled,
      p_complete_uploaded_temu: trackingResult.category === "delivered",
      p_actual_signed_time:
        formatOrderDateTime(trackingResult.eventTime) ??
        formatOrderDateTime(checkedAt),
    });
    if (error) throw error;

    return {
      ok: true as const,
      orderNo,
      delivered: trackingResult.category === "delivered",
      exception: trackingResult.isException,
      message: "",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "承运商查询发生未知错误";
    const { error: saveError } = await serviceClient.rpc(
      "save_temu_tracking_result",
      {
        p_order_no: orderNo,
        p_tracking_no: trackingNo,
        p_checked_at: checkedAt,
        p_query_error: message.slice(0, 500),
        p_logistics_status: "",
        p_logistics_status_detail: "",
        p_tracking_category: "pending",
        p_tracking_event_time: null,
        p_tracking_is_exception: false,
        p_tracking_exception_reason: "",
        p_tracking_exception_fingerprint: "",
        p_preserve_handled: true,
        p_complete_uploaded_temu: false,
        p_actual_signed_time: "",
      },
    );
    if (saveError) {
      console.error("failed to record tracking query error", orderNo, saveError);
    }

    return {
      ok: false as const,
      orderNo,
      delivered: false,
      exception: false,
      message,
    };
  }
}

function getTrackingCarrier(
  order: Pick<TrackingOrder, "warehouse_name" | "logistics_method">,
): TrackingCarrier {
  const value = `${order.warehouse_name} ${order.logistics_method}`;
  if (
    /japan\s*post|japanpost|日本[邮郵]便|邮便|郵便|福[冈岡]|fukuoka/i.test(
      value,
    )
  ) {
    return "japan_post";
  }
  return "yamato";
}

async function fetchTrackingStatus(
  carrier: TrackingCarrier,
  trackingNo: string,
  trackingProxySecret: string,
): Promise<ParsedTrackingResult> {
  if (carrier === "japan_post") {
    const params = new URLSearchParams({
      reqCodeNo1: trackingNo,
      searchKind: "S002",
      locale: "ja",
    });
    const response = await fetch(
      `https://trackings.post.japanpost.jp/services/srv/search/direct?${params.toString()}`,
      {
        headers: {
          "Accept-Language": "ja-JP,ja;q=0.9",
          "User-Agent": "TemuOrderTrackingMonitor/1.0",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Japan Post 查询失败：HTTP ${response.status}`);
    }
    return parseJapanPostTrackingHtml(await response.text());
  }

  const response = await fetch(
    "https://temu.zxiaobai1234.us.ci/yamato-tracking/cgi-bin/tneko",
    {
      method: "POST",
      headers: {
        "Accept-Language": "ja-JP,ja;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "TemuOrderTrackingMonitor/1.0",
        "x-tracking-proxy-secret": trackingProxySecret,
      },
      body: new URLSearchParams({ number01: trackingNo, category: "0" }),
    },
  );
  if (!response.ok) {
    throw new Error(`Yamato 查询失败：HTTP ${response.status}`);
  }
  return parseYamatoTrackingHtml(await response.text());
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function formatOrderDateTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => runWorker(),
    ),
  );
  return results;
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |=
      (leftBytes[index % leftBytes.length] ?? 0) ^
      (rightBytes[index % rightBytes.length] ?? 0);
  }
  return mismatch === 0;
}

function httpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function getHttpStatus(error: unknown) {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  return 500;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    return [
      record.code ? `[${String(record.code)}]` : "",
      String(record.message ?? ""),
      String(record.details ?? ""),
      String(record.hint ?? ""),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(error || "物流状态查询发生未知错误。");
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
