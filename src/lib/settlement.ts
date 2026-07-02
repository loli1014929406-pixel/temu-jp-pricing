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

export type SettlementSummary = {
  totalSalesRevenue: number;
  totalFreightRevenue: number;
  totalRevenue: number;
  totalQuantity: number;
  recordCount: number;
  fileCount: number;
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
  const { data: filesData, error: filesError } = await supabase
    .from("finance_settlement_files")
    .select("*")
    .eq("user_id", userId)
    .order("imported_at", { ascending: false });

  if (filesError || !filesData) {
    console.error("Failed to load settlement files:", filesError);
    throw new Error(getSettlementStorageErrorMessage(filesError, "加载结算文件"));
  }

  // To build the full file structure, we need the records too.
  // Since records can be large, we might fetch them concurrently.
  const { data: recordsData, error: recordsError } = await supabase
    .from("finance_settlement_records")
    .select("*")
    .eq("user_id", userId);

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

  return filesData.map((f: any) => {
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

export async function deleteSettlementFile(fileId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("finance_settlement_files").delete().eq("id", fileId);
  if (error) throw new Error(error.message);
}

export async function addSettlementFile(
  userId: string,
  fileName: string,
  records: SettlementRecord[],
): Promise<SettlementFile> {
  const supabase = getSupabaseClient();
  const { start, end } = parseDateRange(fileName);
  const totalSalesRevenue = roundMoney(records.reduce((sum, r) => sum + r.salesRevenue, 0));
  const totalFreightRevenue = roundMoney(records.reduce((sum, r) => sum + r.freightRevenue, 0));
  const totalRevenue = roundMoney(records.reduce((sum, r) => sum + calculateSettlementNetTotalRevenue(r), 0));

  // Check existing file with same name
  const { data: existing } = await supabase
    .from("finance_settlement_files")
    .select("id")
    .eq("user_id", userId)
    .eq("file_name", fileName);
    
  if (existing && existing.length > 0) {
    for (const f of existing) {
      await deleteSettlementFile(f.id);
    }
  }

  // Insert file
  const { data: fileData, error: fileError } = await supabase
    .from("finance_settlement_files")
    .insert({
      user_id: userId,
      file_name: fileName,
      date_range_start: start,
      date_range_end: end,
      total_sales_revenue: totalSalesRevenue,
      total_freight_revenue: totalFreightRevenue,
      total_revenue: totalRevenue,
      record_count: records.length,
      imported_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (fileError) throw new Error(getSettlementStorageErrorMessage(fileError, "保存文件信息"));

  const fileId = fileData.id;

  // Insert records in batches of 500
  const BATCH_SIZE = 500;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE).map((r) => ({
      user_id: userId,
      file_id: fileId,
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
    
    const { error: batchError } = await supabase.from("finance_settlement_records").insert(batch);
    if (batchError) {
      await deleteSettlementFile(fileId);
      throw new Error(getSettlementStorageErrorMessage(batchError, "保存文件数据"));
    }
  }

  return {
    id: fileId,
    fileName: fileData.file_name,
    dateRangeStart: fileData.date_range_start,
    dateRangeEnd: fileData.date_range_end,
    importedAt: fileData.imported_at,
    totalSalesRevenue: Number(fileData.total_sales_revenue),
    totalFreightRevenue: Number(fileData.total_freight_revenue),
    totalRevenue,
    recordCount: fileData.record_count,
    records,
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
