import type { Workbook, Worksheet } from "./tabular-parser";

export type ActualShippingCarrier = "japan_post" | "ocs_yamato";

export type ActualShippingFeeImportRecord = {
  tracking_no: string;
  amount_rmb: number;
  source_row_number: number;
};

export type ActualShippingFeeParseIssue = {
  rowNumber: number;
  trackingNo: string;
  reason: string;
};

export type ActualShippingFeeParseResult = {
  carrier: ActualShippingCarrier;
  carrierLabel: string;
  sheetName: string;
  totalRowCount: number;
  records: ActualShippingFeeImportRecord[];
  issues: ActualShippingFeeParseIssue[];
};

type DetectedSheet = {
  carrier: ActualShippingCarrier;
  carrierLabel: string;
  worksheet: Worksheet;
  headerRowIndex: number;
  trackingColumnIndex: number;
  amountColumnIndex: number;
};

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, "")
    .trim();
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

function findDetectedSheet(workbook: Pick<Workbook, "worksheets">): DetectedSheet | null {
  for (const worksheet of workbook.worksheets) {
    const candidateRows = worksheet.data.slice(0, 30);
    for (let headerRowIndex = 0; headerRowIndex < candidateRows.length; headerRowIndex += 1) {
      const headers = (candidateRows[headerRowIndex] ?? []).map(normalizeHeader);
      const japanPostTrackingIndex = headers.indexOf("物流单号");
      const japanPostAmountIndex = headers.findIndex(
        (header) => header === "运费（人名币）" || header === "运费(人名币)" || header === "运费（人民币）" || header === "运费(人民币)",
      );
      if (japanPostTrackingIndex >= 0 && japanPostAmountIndex >= 0) {
        return {
          carrier: "japan_post",
          carrierLabel: "福冈仓日本邮便",
          worksheet,
          headerRowIndex,
          trackingColumnIndex: japanPostTrackingIndex,
          amountColumnIndex: japanPostAmountIndex,
        };
      }

      const ocsTrackingIndex = headers.indexOf("运单号");
      const ocsAmountIndex = headers.indexOf("总计数");
      if (ocsTrackingIndex >= 0 && ocsAmountIndex >= 0) {
        return {
          carrier: "ocs_yamato",
          carrierLabel: "苏州仓 OCS Yamato",
          worksheet,
          headerRowIndex,
          trackingColumnIndex: ocsTrackingIndex,
          amountColumnIndex: ocsAmountIndex,
        };
      }
    }
  }
  return null;
}

function looksLikeTrackingNo(value: string) {
  return value.length >= 8 && value.length <= 40 && /^[A-Za-z0-9-]+$/.test(value);
}

export function parseActualShippingFeeWorkbook(
  workbook: Pick<Workbook, "worksheets">,
): ActualShippingFeeParseResult {
  const detected = findDetectedSheet(workbook);
  if (!detected) {
    throw new Error(
      "无法识别运费表格。日本邮便需要“物流单号、运费（人名币）”列；OCS Yamato 需要“运单号、总计数”列。",
    );
  }

  const rows = detected.worksheet.data.slice(detected.headerRowIndex + 1);
  const parsedRecords: ActualShippingFeeImportRecord[] = [];
  const issues: ActualShippingFeeParseIssue[] = [];
  let totalRowCount = 0;

  rows.forEach((row, dataIndex) => {
    const rowNumber = detected.headerRowIndex + dataIndex + 2;
    const trackingNo = normalizeTrackingNo(row[detected.trackingColumnIndex]);
    const amountValue = row[detected.amountColumnIndex];
    const hasAnyValue = trackingNo || String(amountValue ?? "").trim();
    if (!hasAnyValue) return;
    totalRowCount += 1;

    if (!trackingNo) {
      issues.push({ rowNumber, trackingNo: "", reason: "物流单号为空" });
      return;
    }
    if (!looksLikeTrackingNo(trackingNo)) {
      issues.push({ rowNumber, trackingNo, reason: "不是有效物流单号，可能是汇总行" });
      return;
    }

    const amount = parseAmount(amountValue);
    if (amount === null || amount < 0) {
      issues.push({ rowNumber, trackingNo, reason: "实际运费为空、不是数字或小于 0" });
      return;
    }

    parsedRecords.push({
      tracking_no: trackingNo,
      amount_rmb: amount,
      source_row_number: rowNumber,
    });
  });

  const trackingCounts = parsedRecords.reduce<Map<string, number>>((counts, record) => {
    counts.set(record.tracking_no, (counts.get(record.tracking_no) ?? 0) + 1);
    return counts;
  }, new Map());
  const duplicateTrackingNos = new Set(
    [...trackingCounts.entries()].filter(([, count]) => count > 1).map(([trackingNo]) => trackingNo),
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
    carrier: detected.carrier,
    carrierLabel: detected.carrierLabel,
    sheetName: detected.worksheet.name,
    totalRowCount,
    records: parsedRecords.filter((record) => !duplicateTrackingNos.has(record.tracking_no)),
    issues: issues.sort((left, right) => left.rowNumber - right.rowNumber),
  };
}

