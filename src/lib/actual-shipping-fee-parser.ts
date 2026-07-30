import type { LogisticsMethod } from "../types";
import { normalizeLogisticsMethodName } from "./logistics-methods";
import type {
  ActualShippingFeeImportTemplate,
  ActualShippingFeeMappingSource,
} from "./actual-shipping-fee-templates";
import type { Workbook, Worksheet } from "./tabular-parser";

export type ActualShippingFeeImportRecord = {
  tracking_no: string;
  amount_rmb: number;
  logistics_method_id: string;
  source_row_number: number;
};

export type ActualShippingFeeParseIssue = {
  rowNumber: number;
  trackingNo: string;
  reason: string;
};

export type ActualShippingFeeParseResult = {
  templateId: string;
  templateName: string;
  sheetName: string;
  totalRowCount: number;
  records: ActualShippingFeeImportRecord[];
  issues: ActualShippingFeeParseIssue[];
};

type SourceValueOptions = {
  sourceType: ActualShippingFeeMappingSource;
  column: number | null;
  fixedValue: unknown;
};

function getSourceValue(row: Worksheet["data"][number], options: SourceValueOptions) {
  if (options.sourceType === "fixed") return options.fixedValue;
  if (!options.column || options.column < 1) return null;
  return row[options.column - 1];
}

function normalizeTrackingNo(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  return String(value).trim();
}

function parseAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "")
    .replace(/[,，\s¥￥元]/g, "")
    .trim();
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function looksLikeTrackingNo(value: string) {
  return value.length >= 8 && value.length <= 40 && /^[A-Za-z0-9-]+$/.test(value);
}

function resolveLogisticsMethod(
  value: unknown,
  logisticsMethods: Pick<LogisticsMethod, "id" | "name">[],
) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const byId = logisticsMethods.find((method) => method.id === text);
  if (byId) return byId;
  const normalized = normalizeLogisticsMethodName(text).toLowerCase();
  return logisticsMethods.find(
    (method) => normalizeLogisticsMethodName(method.name).toLowerCase() === normalized,
  ) ?? null;
}

function getWorksheet(
  workbook: Pick<Workbook, "worksheets">,
  template: ActualShippingFeeImportTemplate,
) {
  const requestedName = template.worksheet_name.trim();
  if (requestedName) {
    const worksheet = workbook.worksheets.find((item) => item.name === requestedName);
    if (!worksheet) {
      throw new Error(`表格中找不到模板指定的工作表“${requestedName}”，请修改模板的工作表。`);
    }
    return worksheet;
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("表格中没有可读取的工作表");
  return worksheet;
}

export function columnNumberToLabel(columnNumber: number | null) {
  if (!columnNumber || columnNumber < 1) return "";
  let value = Math.trunc(columnNumber);
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function parseActualShippingFeeWorkbook(
  workbook: Pick<Workbook, "worksheets">,
  template: ActualShippingFeeImportTemplate,
  logisticsMethods: Pick<LogisticsMethod, "id" | "name">[],
): ActualShippingFeeParseResult {
  const worksheet = getWorksheet(workbook, template);
  const startRow = Math.max(1, Math.trunc(template.start_row));
  const rows = worksheet.data.slice(startRow - 1);
  const parsedRecords: ActualShippingFeeImportRecord[] = [];
  const issues: ActualShippingFeeParseIssue[] = [];
  let totalRowCount = 0;

  rows.forEach((row, dataIndex) => {
    const rowNumber = startRow + dataIndex;
    const trackingValue = getSourceValue(row, {
      sourceType: template.tracking_source_type,
      column: template.tracking_column,
      fixedValue: template.tracking_fixed_value,
    });
    const amountValue = getSourceValue(row, {
      sourceType: template.amount_source_type,
      column: template.amount_column,
      fixedValue: template.amount_fixed_value,
    });
    const logisticsMethodValue = getSourceValue(row, {
      sourceType: template.logistics_method_source_type,
      column: template.logistics_method_column,
      fixedValue: template.logistics_method_fixed_id,
    });
    const hasAnyValue = [trackingValue, amountValue, logisticsMethodValue]
      .some((value) => String(value ?? "").trim());
    if (!hasAnyValue) return;
    totalRowCount += 1;

    const trackingNo = normalizeTrackingNo(trackingValue);
    if (!trackingNo) {
      issues.push({ rowNumber, trackingNo: "", reason: "物流单号为空" });
      return;
    }
    if (!looksLikeTrackingNo(trackingNo)) {
      issues.push({ rowNumber, trackingNo, reason: "不是有效物流单号，可能是标题或汇总行" });
      return;
    }

    const amount = parseAmount(amountValue);
    if (amount === null || amount < 0) {
      issues.push({ rowNumber, trackingNo, reason: "实际运费为空、不是数字或小于 0" });
      return;
    }

    const logisticsMethod = resolveLogisticsMethod(logisticsMethodValue, logisticsMethods);
    if (!logisticsMethod) {
      issues.push({
        rowNumber,
        trackingNo,
        reason: `物流方式“${String(logisticsMethodValue ?? "").trim() || "空"}”未匹配网站已设置的物流方式`,
      });
      return;
    }

    parsedRecords.push({
      tracking_no: trackingNo,
      amount_rmb: amount,
      logistics_method_id: logisticsMethod.id,
      source_row_number: rowNumber,
    });
  });

  const trackingCounts = parsedRecords.reduce<Map<string, number>>((counts, record) => {
    counts.set(record.tracking_no, (counts.get(record.tracking_no) ?? 0) + 1);
    return counts;
  }, new Map());
  const duplicateTrackingNos = new Set(
    [...trackingCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([trackingNo]) => trackingNo),
  );

  parsedRecords.forEach((record) => {
    if (!duplicateTrackingNos.has(record.tracking_no)) return;
    issues.push({
      rowNumber: record.source_row_number,
      trackingNo: record.tracking_no,
      reason: "同一文件中物流单号重复，已整组跳过",
    });
  });

  return {
    templateId: template.id,
    templateName: template.name,
    sheetName: worksheet.name,
    totalRowCount,
    records: parsedRecords.filter(
      (record) => !duplicateTrackingNos.has(record.tracking_no),
    ),
    issues: issues.sort((left, right) => left.rowNumber - right.rowNumber),
  };
}

