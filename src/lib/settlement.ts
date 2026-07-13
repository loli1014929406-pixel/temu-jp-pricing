/**
 * Temu Settlement Data Parser & Storage
 *
 * Parses Temu SettledParentFlow Excel exports and stores them locally.
 * Settlement files have a two-row merged header:
 *   Row 0: PO单号 | 商品信息 * 销售件数 (merged) | 币种 | 销售回款 | 销售回款已减优惠 | 销售冲回 | 运费回款 | 运费回款已减优惠 | 运费冲回
 *   Row 1: (null) | SKU ID | SKU名称 | SKU货号 | 件数 | 申报价格 | 是否活动价 | ...
 * Data starts at Row 2.
 */
import { getSupabaseClient } from "./supabase";
import { fetchAllPages } from "./paginated-fetch";
import { withTimeout } from "./supabase-helpers";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SettlementRecord = {
  poNumber: string;
  skuId: string;
  skuName: string;
  skuCode: string;
  quantity: number;
  declaredPrice: number;
  isPromotionPrice: boolean;
  currency: string;
  salesRevenue: number;
  salesDiscountDeducted: number;
  salesReversal: number;
  freightRevenue: number;
  freightDiscountDeducted: number;
  freightReversal: number;
  /** 实际回款 = 销售回款 + 销售冲回 + 运费回款 + 运费冲回 */
  totalRevenue: number;
};

export type SettlementFile = {
  id: string;
  fileName: string;
  dateRangeStart: string; // YYYYMMDD
  dateRangeEnd: string;   // YYYYMMDD
  importedAt: string;     // ISO timestamp
  records: SettlementRecord[];
  totalSalesRevenue: number;
  totalFreightRevenue: number;
  totalRevenue: number;
  recordCount: number;
};

export type SettlementImportResult = {
  file: SettlementFile | null;
  parsedRecordCount: number;
  importedRecordCount: number;
  skippedRecordCount: number;
  totalRevenue: number;
};

export type SettlementSummary = {
  totalSalesRevenue: number;
  totalFreightRevenue: number;
  totalRevenue: number;
  totalQuantity: number;
  recordCount: number;
  fileCount: number;
};

type SettlementFileRow = {
  id: string;
  file_name: string;
  date_range_start: string;
  date_range_end: string;
  imported_at: string;
  total_sales_revenue: number | string;
  total_freight_revenue: number | string;
  record_count: number;
};

type SettlementRecordRow = {
  id: string;
  file_id: string;
  po_number: string;
  sku_id: string;
  sku_name: string;
  sku_code: string;
  quantity: number;
  declared_price: number | string;
  is_promotion_price: boolean;
  currency: string;
  sales_revenue: number | string;
  sales_discount_deducted: number | string;
  sales_reversal: number | string;
  freight_revenue: number | string;
  freight_discount_deducted: number | string;
  freight_reversal: number | string;
  total_revenue: number | string;
};

type SettlementPoSummaryRow = {
  file_id: string;
  po_number: string;
  quantity: number;
  sales_revenue: number | string;
  freight_revenue: number | string;
  record_count: number;
};

// ── Parsing ────────────────────────────────────────────────────────────────────

function num(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Parse a SettledParentFlow Excel file.
 *
 * The file uses `read-excel-file` which returns a single-element array where
 * `[0]` is `{ sheet, data }`.  `data` is a 2D array.  The first two rows are
 * a merged header; actual data starts at row index 2.
 *
 * For combo orders (合单) where a single PO contains multiple SKUs,
 * the second SKU's row has a null PO number and null currency/amounts.
 * The parent row already contains the combined totals, so sub-rows are
 * parsed separately and linked to the same PO.
 */
export function parseSettlementData(
  rawData: unknown[][],
): SettlementRecord[] {
  // Data rows start at index 2 (after 2-row header)
  const dataRows = rawData.slice(2);
  const records: SettlementRecord[] = [];
  let lastPO = "";

  for (const row of dataRows) {
    const poRaw = str(row[0]);
    const po = poRaw || lastPO;
    if (poRaw) lastPO = poRaw;

    // Skip rows with no SKU code at all
    const skuCode = str(row[3]);
    if (!skuCode) continue;

    const currency = str(row[7]);
    const salesRevenue = num(row[8]);
    const salesDiscountDeducted = num(row[9]);
    const salesReversal = num(row[10]);
    const freightRevenue = num(row[11]);
    const freightDiscountDeducted = num(row[12]);
    const freightReversal = num(row[13]);

    records.push({
      poNumber: po,
      skuId: str(row[1]),
      skuName: str(row[2]),
      skuCode,
      quantity: num(row[4]),
      declaredPrice: num(row[5]),
      isPromotionPrice: str(row[6]) === "是",
      currency: currency || "CNY",
      salesRevenue,
      salesDiscountDeducted,
      salesReversal,
      freightRevenue,
      freightDiscountDeducted,
      freightReversal,
      totalRevenue: calculateSettlementNetTotalRevenue({
        salesRevenue,
        salesReversal,
        freightRevenue,
        freightReversal,
      }),
    });
  }

  return records;
}

/**
 * Parse date range from settlement filename.
 * Expected format: SettledParentFlow-YYYYMMDD-YYYYMMDD.xlsx
 * The second date may have a typo (e.g. 26060531 → 20260531).
 */
export function parseDateRange(fileName: string): { start: string; end: string } {
  const match = fileName.match(/(\d{8})-(\d{8})/);
  if (!match) return { start: "", end: "" };

  const fixDate = (d: string) => {
    // Fix common typo: year starting with 2606 → 2026
    if (d.startsWith("2606")) return "2026" + d.slice(4);
    return d;
  };

  return { start: fixDate(match[1]), end: fixDate(match[2]) };
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function getSettlementRecordKey(record: Pick<SettlementRecord, "poNumber" | "skuCode">) {
  return `${record.poNumber.trim().toLowerCase()}\u0000${record.skuCode.trim().toLowerCase()}`;
}

export function calculateSettlementNetSalesRevenue(
  record: Pick<SettlementRecord, "salesRevenue" | "salesReversal">,
): number {
  return roundMoney(record.salesRevenue + record.salesReversal);
}

export function calculateSettlementNetFreightRevenue(
  record: Pick<SettlementRecord, "freightRevenue" | "freightReversal">,
): number {
  return roundMoney(record.freightRevenue + record.freightReversal);
}

export function calculateSettlementNetTotalRevenue(
  record: Pick<SettlementRecord, "salesRevenue" | "salesReversal" | "freightRevenue" | "freightReversal">,
): number {
  return roundMoney(
    calculateSettlementNetSalesRevenue(record) +
    calculateSettlementNetFreightRevenue(record),
  );
}

function getSettlementStorageErrorMessage(error: { code?: string; message?: string } | null, action: string) {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === "42P01" || code === "PGRST205" || message.toLowerCase().includes("schema cache")) {
    return "结算数据库表尚未初始化，请先执行最新结算迁移后再导入 Temu 结算文件。";
  }
  if (code === "42703") {
    return "结算数据库字段不完整，请先执行最新结算迁移后再导入 Temu 结算文件。";
  }
  return `${action}失败: ${message || "未知错误"}`;
}

// ── Storage (Supabase) ─────────────────────────────────────────────────────

export async function loadSettlementFiles(userId: string): Promise<SettlementFile[]> {
  const supabase = getSupabaseClient();
  const { data: summaryData, error: summaryError } = await withTimeout(
    supabase.rpc("get_finance_settlement_summary"),
    "加载结算汇总",
  );

  if (!summaryError) {
    const payload = (Array.isArray(summaryData) ? summaryData[0] : summaryData) as
      | { files?: unknown; po_records?: unknown }
      | null;
    const filesData = (Array.isArray(payload?.files) ? payload.files : []) as SettlementFileRow[];
    const poRecords = (Array.isArray(payload?.po_records) ? payload.po_records : []) as SettlementPoSummaryRow[];
    const recordsByFile = new Map<string, SettlementRecord[]>();
    for (const row of poRecords) {
      const record: SettlementRecord = {
        poNumber: row.po_number,
        skuId: "",
        skuName: "",
        skuCode: "",
        quantity: Number(row.quantity ?? 0),
        declaredPrice: 0,
        isPromotionPrice: false,
        currency: "CNY",
        salesRevenue: Number(row.sales_revenue ?? 0),
        salesDiscountDeducted: 0,
        salesReversal: 0,
        freightRevenue: Number(row.freight_revenue ?? 0),
        freightDiscountDeducted: 0,
        freightReversal: 0,
        totalRevenue: roundMoney(Number(row.sales_revenue ?? 0) + Number(row.freight_revenue ?? 0)),
      };
      recordsByFile.set(row.file_id, [...(recordsByFile.get(row.file_id) ?? []), record]);
    }
    return filesData.map((file) => ({
      id: file.id,
      fileName: file.file_name,
      dateRangeStart: file.date_range_start,
      dateRangeEnd: file.date_range_end,
      importedAt: file.imported_at,
      totalSalesRevenue: Number(file.total_sales_revenue),
      totalFreightRevenue: Number(file.total_freight_revenue),
      totalRevenue: roundMoney(Number(file.total_sales_revenue) + Number(file.total_freight_revenue)),
      recordCount: file.record_count,
      records: recordsByFile.get(file.id) ?? [],
    }));
  }

  const summaryCode = String((summaryError as { code?: unknown } | null)?.code ?? "");
  if (summaryCode !== "PGRST202" && summaryCode !== "42883") {
    throw new Error(getSettlementStorageErrorMessage(summaryError, "加载结算汇总"));
  }

  // Compatibility fallback until the read-only summary migration is deployed.
  const [filesResult, recordsResult] = await Promise.all([
    fetchAllPages<SettlementFileRow, { code?: string; message?: string }>(
      async (from, to) => {
        const { data, error } = await withTimeout(
          supabase
            .from("finance_settlement_files")
            .select("id, file_name, date_range_start, date_range_end, imported_at, total_sales_revenue, total_freight_revenue, record_count")
            .eq("user_id", userId)
            .order("imported_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
          "加载结算文件",
        );
        return { data: (data ?? []) as SettlementFileRow[], error };
      },
    ),
    fetchAllPages<SettlementRecordRow, { code?: string; message?: string }>(
      async (from, to) => {
        const { data, error } = await withTimeout(
          supabase
            .from("finance_settlement_records")
            .select("id, file_id, po_number, sku_id, sku_name, sku_code, quantity, declared_price, is_promotion_price, currency, sales_revenue, sales_discount_deducted, sales_reversal, freight_revenue, freight_discount_deducted, freight_reversal, total_revenue")
            .eq("user_id", userId)
            .order("id", { ascending: true })
            .range(from, to),
          "加载结算明细",
        );
        return { data: (data ?? []) as SettlementRecordRow[], error };
      },
    ),
  ]);
  const { data: filesData, error: filesError } = filesResult;

  if (filesError || !filesData) {
    console.error("Failed to load settlement files:", filesError);
    throw new Error(getSettlementStorageErrorMessage(filesError, "加载结算文件"));
  }

  const { data: recordsData, error: recordsError } = recordsResult;

  if (recordsError || !recordsData) {
    console.error("Failed to load settlement records:", recordsError);
    throw new Error(getSettlementStorageErrorMessage(recordsError, "加载结算记录"));
  }

  const recordsByFile = new Map<string, SettlementRecord[]>();
  for (const r of recordsData) {
    const list = recordsByFile.get(r.file_id) ?? [];
    const record: SettlementRecord = {
      poNumber: r.po_number,
      skuId: r.sku_id,
      skuName: r.sku_name,
      skuCode: r.sku_code,
      quantity: r.quantity,
      declaredPrice: Number(r.declared_price),
      isPromotionPrice: r.is_promotion_price,
      currency: r.currency,
      salesRevenue: Number(r.sales_revenue),
      salesDiscountDeducted: Number(r.sales_discount_deducted),
      salesReversal: Number(r.sales_reversal),
      freightRevenue: Number(r.freight_revenue),
      freightDiscountDeducted: Number(r.freight_discount_deducted),
      freightReversal: Number(r.freight_reversal),
      totalRevenue: Number(r.total_revenue),
    };
    record.totalRevenue = calculateSettlementNetTotalRevenue(record);
    list.push(record);
    recordsByFile.set(r.file_id, list);
  }

  return filesData.map((f) => {
    const records = recordsByFile.get(f.id) ?? [];
    return {
      id: f.id,
      fileName: f.file_name,
      dateRangeStart: f.date_range_start,
      dateRangeEnd: f.date_range_end,
      importedAt: f.imported_at,
      totalSalesRevenue: Number(f.total_sales_revenue),
      totalFreightRevenue: Number(f.total_freight_revenue),
      totalRevenue: roundMoney(records.reduce((sum, record) => sum + calculateSettlementNetTotalRevenue(record), 0)),
      recordCount: f.record_count,
      records,
    };
  });
}

export async function loadSettlementRecordsPage(options: {
  fileId?: string;
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<{ records: SettlementRecord[]; totalCount: number }> {
  const supabase = getSupabaseClient();
  const { data, error } = await withTimeout(
    supabase.rpc("get_finance_settlement_records_page", {
      p_file_id: options.fileId || null,
      p_page: Math.max(1, Math.trunc(options.page ?? 1)),
      p_page_size: Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50))),
      p_search: options.search?.trim() ?? "",
    }),
    "加载结算明细分页",
  );
  if (error) throw new Error(getSettlementStorageErrorMessage(error, "加载结算明细"));
  const payload = (Array.isArray(data) ? data[0] : data) as
    | { records?: unknown; total_count?: unknown }
    | null;
  const rows = (Array.isArray(payload?.records) ? payload.records : []) as SettlementRecordRow[];
  return {
    records: rows.map((row) => ({
      poNumber: row.po_number,
      skuId: row.sku_id,
      skuName: row.sku_name,
      skuCode: row.sku_code,
      quantity: row.quantity,
      declaredPrice: Number(row.declared_price),
      isPromotionPrice: row.is_promotion_price,
      currency: row.currency,
      salesRevenue: Number(row.sales_revenue),
      salesDiscountDeducted: Number(row.sales_discount_deducted),
      salesReversal: Number(row.sales_reversal),
      freightRevenue: Number(row.freight_revenue),
      freightDiscountDeducted: Number(row.freight_discount_deducted),
      freightReversal: Number(row.freight_reversal),
      totalRevenue: roundMoney(
        Number(row.sales_revenue) + Number(row.sales_reversal) +
        Number(row.freight_revenue) + Number(row.freight_reversal),
      ),
    })),
    totalCount: Number(payload?.total_count ?? 0),
  };
}

export async function deleteSettlementFile(fileId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("finance_settlement_files").delete().eq("id", fileId);
  if (error) throw new Error(error.message);
}

export async function addSettlementFile(
  userId: string,
  fileName: string,
  records: SettlementRecord[],
): Promise<SettlementImportResult> {
  const supabase = getSupabaseClient();
  const importedAt = new Date().toISOString();
  type ExistingSettlementRecordKey = { po_number: string; sku_code: string };
  const { data: existingRecords, error: existingRecordsError } = await fetchAllPages<
    ExistingSettlementRecordKey,
    { code?: string; message?: string }
  >(async (from, to) => {
    const { data, error } = await supabase
      .from("finance_settlement_records")
      .select("po_number, sku_code")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, to);
    return { data: (data ?? []) as ExistingSettlementRecordKey[], error };
  });

  if (existingRecordsError) {
    throw new Error(getSettlementStorageErrorMessage(existingRecordsError, "检查已有结算记录"));
  }

  const seenKeys = new Set(
    (existingRecords ?? []).map((record) =>
      `${String(record.po_number ?? "").trim().toLowerCase()}\u0000${String(record.sku_code ?? "").trim().toLowerCase()}`,
    ),
  );
  const recordsToInsert: SettlementRecord[] = [];
  let skippedRecordCount = 0;

  for (const record of records) {
    if (!record.poNumber.trim() || !record.skuCode.trim()) {
      skippedRecordCount += 1;
      continue;
    }
    const key = getSettlementRecordKey(record);
    if (seenKeys.has(key)) {
      skippedRecordCount += 1;
      continue;
    }
    recordsToInsert.push(record);
    seenKeys.add(key);
  }

  const totalSalesRevenue = roundMoney(recordsToInsert.reduce((sum, r) => sum + r.salesRevenue, 0));
  const totalFreightRevenue = roundMoney(recordsToInsert.reduce((sum, r) => sum + r.freightRevenue, 0));
  const totalRevenue = roundMoney(recordsToInsert.reduce((sum, r) => sum + calculateSettlementNetTotalRevenue(r), 0));

  if (recordsToInsert.length === 0) {
    return {
      file: null,
      parsedRecordCount: records.length,
      importedRecordCount: 0,
      skippedRecordCount,
      totalRevenue: 0,
    };
  }

  const recordPayload = recordsToInsert.map((r) => ({
      po_number: r.poNumber,
      sku_id: r.skuId,
      sku_name: r.skuName,
      sku_code: r.skuCode,
      quantity: r.quantity,
      declared_price: r.declaredPrice,
      is_promotion_price: r.isPromotionPrice,
      currency: r.currency,
      sales_revenue: r.salesRevenue,
      sales_discount_deducted: r.salesDiscountDeducted,
      sales_reversal: r.salesReversal,
      freight_revenue: r.freightRevenue,
      freight_discount_deducted: r.freightDiscountDeducted,
      freight_reversal: r.freightReversal,
      total_revenue: r.totalRevenue,
  }));
  const { data: fileData, error: importError } = await supabase.rpc(
    "import_finance_settlement_atomic",
    {
      p_file_name: fileName,
      p_imported_at: importedAt,
      p_total_sales_revenue: totalSalesRevenue,
      p_total_freight_revenue: totalFreightRevenue,
      p_total_revenue: totalRevenue,
      p_records: recordPayload,
    },
  );
  if (importError) {
    const message = String(importError.message ?? "");
    if (importError.code === "PGRST202" || importError.code === "42883" || message.includes("import_finance_settlement_atomic")) {
      throw new Error("结算导入事务尚未初始化，请先执行 20260713000000_fix_audit_consistency_and_security.sql 迁移。");
    }
    throw new Error(getSettlementStorageErrorMessage(importError, "保存结算文件"));
  }
  if (!fileData || typeof fileData !== "object") throw new Error("保存结算文件后没有返回结果");
  const storedFile = fileData as Record<string, unknown>;
  const fileId = String(storedFile.id ?? "");

  const file: SettlementFile = {
    id: fileId,
    fileName: String(storedFile.file_name ?? fileName),
    dateRangeStart: String(storedFile.date_range_start ?? ""),
    dateRangeEnd: String(storedFile.date_range_end ?? ""),
    importedAt: String(storedFile.imported_at ?? importedAt),
    totalSalesRevenue: Number(storedFile.total_sales_revenue ?? totalSalesRevenue),
    totalFreightRevenue: Number(storedFile.total_freight_revenue ?? totalFreightRevenue),
    totalRevenue,
    recordCount: Number(storedFile.record_count ?? recordsToInsert.length),
    records: recordsToInsert,
  };

  return {
    file,
    parsedRecordCount: records.length,
    importedRecordCount: recordsToInsert.length,
    skippedRecordCount,
    totalRevenue,
  };
}

// ── Lookup / Indexing ──────────────────────────────────────────────────────────

export type SettlementLookup = {
  /** PO单号 → SettlementRecord[] (one PO can have multiple SKUs in combo orders) */
  byPO: Map<string, SettlementRecord[]>;
  /** SKU货号 (lowercase) → aggregated revenue data */
  bySkuCode: Map<string, {
    totalRevenue: number;
    salesRevenue: number;
    freightRevenue: number;
    quantity: number;
    recordCount: number;
  }>;
  /** All records flattened */
  allRecords: SettlementRecord[];
  /** Summary stats */
  summary: SettlementSummary;
};

export function buildSettlementLookup(files: SettlementFile[]): SettlementLookup {
  const byPO = new Map<string, SettlementRecord[]>();
  const bySkuCode = new Map<string, {
    totalRevenue: number;
    salesRevenue: number;
    freightRevenue: number;
    quantity: number;
    recordCount: number;
  }>();
  const allRecords: SettlementRecord[] = [];

  let totalSalesRevenue = 0;
  let totalFreightRevenue = 0;
  let totalQuantity = 0;

  for (const file of files) {
    for (const record of file.records) {
      allRecords.push(record);

      // Index by PO
      const poKey = record.poNumber.trim();
      if (poKey) {
        const list = byPO.get(poKey) ?? [];
        list.push(record);
        byPO.set(poKey, list);
      }

      // Index by SKU code. Combo-order child rows carry the SKU but no money,
      // so they should not lower SKU average revenue.
      const skuKey = record.skuCode.trim().toLowerCase();
      const netSalesRevenue = calculateSettlementNetSalesRevenue(record);
      const netFreightRevenue = calculateSettlementNetFreightRevenue(record);
      const netTotalRevenue = calculateSettlementNetTotalRevenue(record);
      if (skuKey && netTotalRevenue !== 0) {
        const existing = bySkuCode.get(skuKey) ?? {
          totalRevenue: 0,
          salesRevenue: 0,
          freightRevenue: 0,
          quantity: 0,
          recordCount: 0,
        };
        existing.totalRevenue += netTotalRevenue;
        existing.salesRevenue += netSalesRevenue;
        existing.freightRevenue += netFreightRevenue;
        existing.quantity += record.quantity;
        existing.recordCount += 1;
        bySkuCode.set(skuKey, existing);
      }

      totalSalesRevenue += netSalesRevenue;
      totalFreightRevenue += netFreightRevenue;
      totalQuantity += record.quantity;
    }
  }

  return {
    byPO,
    bySkuCode,
    allRecords,
    summary: {
      totalSalesRevenue: roundMoney(totalSalesRevenue),
      totalFreightRevenue: roundMoney(totalFreightRevenue),
      totalRevenue: roundMoney(totalSalesRevenue + totalFreightRevenue),
      totalQuantity,
      recordCount: allRecords.length,
      fileCount: files.length,
    },
  };
}

/**
 * Match a Temu order to its settlement record(s) by SKU code.
 * Returns the total revenue for the matched records, or null if no match.
 */
export function getOrderSettlementRevenue(
  skuCode: string,
  quantity: number,
  lookup: SettlementLookup,
): { totalRevenue: number; salesRevenue: number; freightRevenue: number; matched: boolean } | null {
  const key = skuCode.trim().toLowerCase();
  if (!key) return null;

  const skuData = lookup.bySkuCode.get(key);
  if (!skuData || skuData.recordCount === 0 || skuData.quantity <= 0) return null;

  // Calculate per-unit average revenue from settlement data
  const avgRevenuePerUnit = skuData.totalRevenue / skuData.quantity;
  const avgSalesPerUnit = skuData.salesRevenue / skuData.quantity;
  const avgFreightPerUnit = skuData.freightRevenue / skuData.quantity;

  return {
    totalRevenue: roundMoney(avgRevenuePerUnit * quantity),
    salesRevenue: roundMoney(avgSalesPerUnit * quantity),
    freightRevenue: roundMoney(avgFreightPerUnit * quantity),
    matched: true,
  };
}

/**
 * Format a date range string for display
 */
export function formatDateRange(start: string, end: string): string {
  if (!start || !end) return "未知日期范围";
  const fmt = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return `${fmt(start)} ~ ${fmt(end)}`;
}

export function formatImportedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value || "--";
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
