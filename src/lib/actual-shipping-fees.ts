import type {
  ActualShippingCarrier,
  ActualShippingFeeImportRecord,
} from "./actual-shipping-fee-parser";
import { requireSession, withTimeout } from "./supabase-helpers";

export type ActualShippingFeePreviewStatus =
  | "importable"
  | "existing"
  | "unmatched"
  | "conflict";

export type ActualShippingFeePreviewRow = {
  trackingNo: string;
  amountRmb: number;
  sourceRowNumber: number;
  orderNo: string;
  actualShipTime: string;
  settlementMonth: string;
  status: ActualShippingFeePreviewStatus;
};

export type ActualShippingFeeMonthSummary = {
  month: string;
  shipmentCount: number;
  totalAmountRmb: number;
};

export type ActualShippingFeeImportPreview = {
  parsedRecordCount: number;
  matchedRecordCount: number;
  importableRecordCount: number;
  existingRecordCount: number;
  unmatchedRecordCount: number;
  conflictRecordCount: number;
  missingActualShipTimeCount: number;
  importableTotalAmountRmb: number;
  months: ActualShippingFeeMonthSummary[];
  rows: ActualShippingFeePreviewRow[];
};

export type ActualShippingFeeImportResult = {
  parsedRecordCount: number;
  importedRecordCount: number;
  importedTotalAmountRmb: number;
  existingRecordCount: number;
  unmatchedRecordCount: number;
  conflictRecordCount: number;
  missingActualShipTimeCount: number;
};

export type ActualShippingFeeReportRow = {
  id: string;
  trackingNo: string;
  amountRmb: number;
  carrier: ActualShippingCarrier;
  sourceFileName: string;
  importedAt: string;
  orderNo: string;
  actualShipTime: string;
  settlementMonth: string;
};

export type ActualShippingFeeReport = {
  rows: ActualShippingFeeReportRow[];
  totalCount: number;
  summary: {
    shipmentCount: number;
    totalAmountRmb: number;
    missingActualShipTimeCount: number;
    payableAmountRmb: number;
    paidAmountRmb: number;
    outstandingAmountRmb: number;
    settlements: LogisticsSettlementSummary[];
  };
  months: ActualShippingFeeMonthSummary[];
};

export type LogisticsSettlementStatus = "unpaid" | "partial" | "paid";

export type LogisticsSettlementSummary = {
  carrier: ActualShippingCarrier;
  shippingMonth: string;
  shipmentCount: number;
  payableAmountRmb: number;
  paidAmountRmb: number;
  outstandingAmountRmb: number;
  lastPaidAt: string;
  status: LogisticsSettlementStatus;
};

export type LogisticsPaymentRecord = {
  id: string;
  amountRmb: number;
  paidAt: string;
  remark: string;
  voidedAt: string;
  voidReason: string;
  createdAt: string;
};

export type FinanceLogisticsCashSummary = {
  payableAmountRmb: number;
  paidAmountRmb: number;
  outstandingAmountRmb: number;
  monthly: Array<{ month: string; paidAmountRmb: number }>;
};

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function parseMonthSummary(value: unknown): ActualShippingFeeMonthSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      month: String(item.month ?? ""),
      shipmentCount: numberValue(item.shipmentCount),
      totalAmountRmb: numberValue(item.totalAmountRmb),
    };
  });
}

function getStorageErrorMessage(error: { code?: string; message?: string } | null, action: string) {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (["42P01", "PGRST202", "PGRST205", "42883"].includes(code)) {
    return "实际运费数据库尚未初始化，请先执行最新 Supabase migration。";
  }
  return `${action}失败: ${message || "未知错误"}`;
}

export async function previewActualShippingFeeImport(
  records: ActualShippingFeeImportRecord[],
): Promise<ActualShippingFeeImportPreview> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("preview_actual_shipping_fee_import", { p_records: records }),
    "预览实际运费导入",
    { requestKind: "rpc", rowCount: records.length },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "预览实际运费导入"));
  const payload = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  return {
    parsedRecordCount: numberValue(payload.parsedRecordCount),
    matchedRecordCount: numberValue(payload.matchedRecordCount),
    importableRecordCount: numberValue(payload.importableRecordCount),
    existingRecordCount: numberValue(payload.existingRecordCount),
    unmatchedRecordCount: numberValue(payload.unmatchedRecordCount),
    conflictRecordCount: numberValue(payload.conflictRecordCount),
    missingActualShipTimeCount: numberValue(payload.missingActualShipTimeCount),
    importableTotalAmountRmb: numberValue(payload.importableTotalAmountRmb),
    months: parseMonthSummary(payload.months),
    rows: rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        trackingNo: String(item.trackingNo ?? ""),
        amountRmb: numberValue(item.amountRmb),
        sourceRowNumber: numberValue(item.sourceRowNumber),
        orderNo: String(item.orderNo ?? ""),
        actualShipTime: String(item.actualShipTime ?? ""),
        settlementMonth: String(item.settlementMonth ?? ""),
        status: String(item.status ?? "unmatched") as ActualShippingFeePreviewStatus,
      };
    }),
  };
}

export async function importActualShippingFees(options: {
  fileName: string;
  carrier: ActualShippingCarrier;
  records: ActualShippingFeeImportRecord[];
}): Promise<ActualShippingFeeImportResult> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("import_actual_shipping_fees", {
      p_file_name: options.fileName,
      p_carrier: options.carrier,
      p_records: options.records,
    }),
    "导入实际运费",
    { requestKind: "rpc", rowCount: options.records.length },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "导入实际运费"));
  const payload = (data ?? {}) as Record<string, unknown>;
  return {
    parsedRecordCount: numberValue(payload.parsedRecordCount),
    importedRecordCount: numberValue(payload.importedRecordCount),
    importedTotalAmountRmb: numberValue(payload.importedTotalAmountRmb),
    existingRecordCount: numberValue(payload.existingRecordCount),
    unmatchedRecordCount: numberValue(payload.unmatchedRecordCount),
    conflictRecordCount: numberValue(payload.conflictRecordCount),
    missingActualShipTimeCount: numberValue(payload.missingActualShipTimeCount),
  };
}

export async function fetchActualShippingFeeReport(options: {
  page: number;
  pageSize: number;
  month: string;
  carrier: "all" | ActualShippingCarrier;
  search: string;
}): Promise<ActualShippingFeeReport> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("get_actual_shipping_fee_report", {
      p_page: Math.max(1, Math.trunc(options.page)),
      p_page_size: Math.min(100, Math.max(1, Math.trunc(options.pageSize))),
      p_month: options.month,
      p_carrier: options.carrier,
      p_search: options.search.trim(),
    }),
    "加载实际运费月结",
    { requestKind: "rpc" },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "加载实际运费月结"));
  const payload = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const summary = (payload?.summary ?? {}) as Record<string, unknown>;

  return {
    rows: rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        id: String(item.id ?? ""),
        trackingNo: String(item.trackingNo ?? ""),
        amountRmb: numberValue(item.amountRmb),
        carrier: String(item.carrier ?? "japan_post") as ActualShippingCarrier,
        sourceFileName: String(item.sourceFileName ?? ""),
        importedAt: String(item.importedAt ?? ""),
        orderNo: String(item.orderNo ?? ""),
        actualShipTime: String(item.actualShipTime ?? ""),
        settlementMonth: String(item.settlementMonth ?? ""),
      };
    }),
    totalCount: numberValue(payload?.total_count),
    summary: {
      shipmentCount: numberValue(summary.shipmentCount),
      totalAmountRmb: numberValue(summary.totalAmountRmb),
      missingActualShipTimeCount: numberValue(summary.missingActualShipTimeCount),
      payableAmountRmb: numberValue(summary.payableAmountRmb),
      paidAmountRmb: numberValue(summary.paidAmountRmb),
      outstandingAmountRmb: numberValue(summary.outstandingAmountRmb),
      settlements: (Array.isArray(summary.settlements) ? summary.settlements : []).map((row) => {
        const item = row as Record<string, unknown>;
        return {
          carrier: String(item.carrier ?? "japan_post") as ActualShippingCarrier,
          shippingMonth: String(item.shippingMonth ?? ""),
          shipmentCount: numberValue(item.shipmentCount),
          payableAmountRmb: numberValue(item.payableAmountRmb),
          paidAmountRmb: numberValue(item.paidAmountRmb),
          outstandingAmountRmb: numberValue(item.outstandingAmountRmb),
          lastPaidAt: String(item.lastPaidAt ?? ""),
          status: String(item.status ?? "unpaid") as LogisticsSettlementStatus,
        };
      }),
    },
    months: parseMonthSummary(payload?.months),
  };
}

export async function recordLogisticsPayment(options: {
  carrier: ActualShippingCarrier;
  shippingMonth: string;
  paidAmountRmb: number;
  paidAt: string;
  remark: string;
  requestKey: string;
}) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("record_logistics_payment", {
      p_carrier: options.carrier,
      p_shipping_month: options.shippingMonth,
      p_paid_amount_rmb: options.paidAmountRmb,
      p_paid_at: options.paidAt,
      p_remark: options.remark.trim(),
      p_request_key: options.requestKey,
    }),
    "登记物流付款",
    { requestKind: "rpc" },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "登记物流付款"));
  return (data ?? {}) as Record<string, unknown>;
}

export async function fetchLogisticsPaymentRecords(options: {
  carrier: ActualShippingCarrier;
  shippingMonth: string;
}): Promise<LogisticsPaymentRecord[]> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("get_logistics_payment_records", {
      p_carrier: options.carrier,
      p_shipping_month: options.shippingMonth,
    }),
    "加载物流付款记录",
    { requestKind: "rpc" },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "加载物流付款记录"));
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      id: String(item.id ?? ""),
      amountRmb: numberValue(item.amountRmb),
      paidAt: String(item.paidAt ?? ""),
      remark: String(item.remark ?? ""),
      voidedAt: String(item.voidedAt ?? ""),
      voidReason: String(item.voidReason ?? ""),
      createdAt: String(item.createdAt ?? ""),
    };
  });
}

export async function voidLogisticsPayment(paymentId: string, reason: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("void_logistics_payment", {
      p_payment_id: paymentId,
      p_reason: reason.trim(),
    }),
    "作废物流付款",
    { requestKind: "rpc" },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "作废物流付款"));
  return (data ?? {}) as Record<string, unknown>;
}

export async function fetchFinanceLogisticsCashSummary(): Promise<FinanceLogisticsCashSummary> {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.rpc("get_finance_logistics_cash_summary"),
    "加载物流现金汇总",
    { requestKind: "rpc" },
  );
  if (error) throw new Error(getStorageErrorMessage(error, "加载物流现金汇总"));
  const payload = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const summary = (payload?.summary ?? {}) as Record<string, unknown>;
  const monthly = Array.isArray(payload?.monthly) ? payload.monthly : [];
  return {
    payableAmountRmb: numberValue(summary.payableAmountRmb),
    paidAmountRmb: numberValue(summary.paidAmountRmb),
    outstandingAmountRmb: numberValue(summary.outstandingAmountRmb),
    monthly: monthly.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        month: String(item.month ?? ""),
        paidAmountRmb: numberValue(item.paidAmountRmb),
      };
    }),
  };
}

export async function updateActualShipTimeForShipment(options: {
  trackingNo: string;
  orderNo: string;
  actualShipTime: string;
}) {
  const trackingNo = options.trackingNo.trim();
  const orderNo = options.orderNo.trim();
  const actualShipTime = options.actualShipTime.trim();
  if (!trackingNo || !orderNo || !actualShipTime) {
    throw new Error("物流单号、订单号和实际发货时间不能为空");
  }

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_orders")
      .update({ actual_ship_time: actualShipTime })
      .eq("logistics_tracking_no", trackingNo)
      .eq("order_no", orderNo)
      .select("id"),
    "补填实际发货时间",
    { requestKind: "supabase" },
  );
  if (error) throw error;

  const updatedCount = Array.isArray(data) ? data.length : 0;
  if (updatedCount === 0) {
    throw new Error("未找到与该物流单号和订单号匹配的订单明细");
  }
  return updatedCount;
}
