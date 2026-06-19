/**
 * Temu Settlement Data Parser & Storage
 *
 * Parses Temu SettledParentFlow Excel exports and stores them locally.
 * Settlement files have a two-row merged header:
 *   Row 0: PO单号 | 商品信息 * 销售件数 (merged) | 币种 | 销售回款 | 销售回款已减优惠 | 销售冲回 | 运费回款 | 运费回款已减优惠 | 运费冲回
 *   Row 1: (null) | SKU ID | SKU名称 | SKU货号 | 件数 | 申报价格 | 是否活动价 | ...
 * Data starts at Row 2.
 */

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
  /** 实际回款 = 销售回款 + 运费回款 */
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
      totalRevenue: roundMoney(salesRevenue + freightRevenue),
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

// ── Storage (localStorage) ─────────────────────────────────────────────────────

const STORAGE_KEY = "codex_temu_settlements";

export function loadSettlementFiles(): SettlementFile[] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  try {
    return JSON.parse(saved) as SettlementFile[];
  } catch {
    console.error("Failed to parse settlement files from localStorage");
    return [];
  }
}

export function saveSettlementFiles(files: SettlementFile[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

export function deleteSettlementFile(fileId: string): SettlementFile[] {
  const files = loadSettlementFiles().filter((f) => f.id !== fileId);
  saveSettlementFiles(files);
  return files;
}

export function addSettlementFile(
  fileName: string,
  records: SettlementRecord[],
): SettlementFile {
  const { start, end } = parseDateRange(fileName);
  const totalSalesRevenue = roundMoney(records.reduce((sum, r) => sum + r.salesRevenue, 0));
  const totalFreightRevenue = roundMoney(records.reduce((sum, r) => sum + r.freightRevenue, 0));

  const file: SettlementFile = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    fileName,
    dateRangeStart: start,
    dateRangeEnd: end,
    importedAt: new Date().toISOString(),
    records,
    totalSalesRevenue,
    totalFreightRevenue,
    totalRevenue: roundMoney(totalSalesRevenue + totalFreightRevenue),
    recordCount: records.length,
  };

  const existing = loadSettlementFiles();
  // Replace if same filename exists
  const filtered = existing.filter((f) => f.fileName !== fileName);
  filtered.push(file);
  saveSettlementFiles(filtered);
  return file;
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

      // Index by SKU code
      const skuKey = record.skuCode.trim().toLowerCase();
      if (skuKey) {
        const existing = bySkuCode.get(skuKey) ?? {
          totalRevenue: 0,
          salesRevenue: 0,
          freightRevenue: 0,
          quantity: 0,
          recordCount: 0,
        };
        existing.totalRevenue += record.totalRevenue;
        existing.salesRevenue += record.salesRevenue;
        existing.freightRevenue += record.freightRevenue;
        existing.quantity += record.quantity;
        existing.recordCount += 1;
        bySkuCode.set(skuKey, existing);
      }

      totalSalesRevenue += record.salesRevenue;
      totalFreightRevenue += record.freightRevenue;
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
  if (!skuData || skuData.recordCount === 0) return null;

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
