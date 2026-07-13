export { formatCurrency } from "../../utils/pricing";
import type { ReactNode } from "react";
import type {
  Product,
  ProductItem,
  ProductSku,
  PurchaseOrder,
  TemuOrderRecord,
  PricingSettings,
  Warehouse,
  WarehouseSku,
  LogisticsMethod,
  WarehouseLogisticsMethod,
} from "../../types";
import { calculatePurchaseShippingRmb, calculateDynamicMethodCost } from "../../utils/shipping-costs";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../../utils/sku-code";
import { normalizeLogisticsMethodName } from "../../lib/logistics-methods";
import { resolveLastLegMethods } from "../../lib/defaults";
import {
  calculateHighestWarehouseFirstLegCostRmb,
  getWarehouseLogisticsConfigStatus,
} from "../../lib/warehouse-logistics";
import {
  calculateSettlementNetFreightRevenue,
  calculateSettlementNetSalesRevenue,
  type SettlementLookup,
} from "../../lib/settlement";

export const financeBusinessTimeZone = "Asia/Tokyo";

const financeBusinessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: financeBusinessTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getDirectDateKey(value: string) {
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return "";

  const [, year, month, day] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const candidate = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (
    candidate.getUTCFullYear() !== yearNumber ||
    candidate.getUTCMonth() !== monthNumber - 1 ||
    candidate.getUTCDate() !== dayNumber
  ) {
    return "";
  }

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatBusinessDate(value: Date) {
  const parts = Object.fromEntries(
    financeBusinessDateFormatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getTodayInputValue() {
  return formatBusinessDate(new Date());
}

export function getCurrentMonthInputValue() {
  return getTodayInputValue().slice(0, 7);
}

export function getMonthStart(month: string) {
  return month ? `${month}-01` : "";
}

export function getMonthEnd(month: string) {
  if (!month) return "";
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return "";
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

export function getDateKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const hasExplicitTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (!hasExplicitTimeZone && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
    return getDirectDateKey(trimmed);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "" : formatBusinessDate(parsed);
}

export type FinancePeriodMode = "all" | "month" | "custom";

export type FinancePeriod = {
  mode: FinancePeriodMode;
  start: string;
  end: string;
  label: string;
};

export function isDateInPeriod(value: string, period: FinancePeriod) {
  if (period.mode === "all") return true;
  const dateKey = getDateKey(value);
  if (!dateKey) return false;
  if (period.start && dateKey < period.start) return false;
  if (period.end && dateKey > period.end) return false;
  return true;
}

export type FinanceData = {
  orders: TemuOrderRecord[];
  purchases: PurchaseOrder[];
  products: Product[];
  productItems: ProductItem[];
  productSkus: ProductSku[];
  warehouses: Warehouse[];
  warehouseSkus: WarehouseSku[];
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
};

export type FinanceBadgeTone = "success" | "warning" | "danger" | "neutral" | "info";
export type ShippingFeeSource = "actual" | "estimated" | "missing";
export type ReconciliationIssue =
  | "unmatched"
  | "shipping-method-missing"
  | "shipping-cost-missing"
  | "warehouse-logistics-incomplete"
  | "settlement-overdue";

export type FinanceOrderRow = {
  order: TemuOrderRecord;
  sku: ProductSku | null;
  product: Product | null;
  quantity: number;
  productCostRmb: number;
  shippingFeeRmb: number;
  firstLegShippingRmb: number;
  lastLegShippingRmb: number;
  cashShippingFeeRmb: number;
  estimatedShippingRmb: number;
  shippingFeeSource: ShippingFeeSource;
  isShippingFeeEstimated: boolean;
  warehouseLogisticsIssue: string;
  billAmountRmb: number;
  actualSalesRevenueRmb: number;
  actualFreightRevenueRmb: number;
  actualRevenueRmb: number;
  isSettled: boolean;
  matched: boolean;
  matchLabel: string;
};

export function getSignedAmountClass(value: number, neutralClass = "text-slate-700") {
  if (value < 0) return "text-rose-700";
  if (value > 0) return "text-emerald-700";
  return neutralClass;
}

export function calculateMarginRate(profit: number, revenue: number) {
  if (!Number.isFinite(profit) || !Number.isFinite(revenue)) return 0;
  if (revenue !== 0) return (profit / Math.abs(revenue)) * 100;
  return profit < 0 ? -100 : 0;
}

export function hasActualShippingFee(row: FinanceOrderRow) {
  return Number(row.order.actual_shipping_fee_rmb || 0) > 0;
}

export function hasShippingActivity(row: FinanceOrderRow) {
  return Boolean(
    row.order.actual_ship_time ||
    row.order.label_printed_at ||
    row.order.logistics_tracking_no ||
    row.order.logistics_method,
  );
}

export function needsShippingFeeAttention(row: FinanceOrderRow) {
  return row.shippingFeeSource === "missing" && hasShippingActivity(row);
}

export function needsShippingMethodAttention(row: FinanceOrderRow) {
  return needsShippingFeeAttention(row) && !normalizeLogisticsMethodName(row.order.logistics_method || "");
}

export function needsSettlementOverdueAttention(row: FinanceOrderRow, now = new Date()) {
  if (row.isSettled) return false;
  const signedAt = row.order.actual_signed_time;
  if (!signedAt) return false;

  const signedDate = new Date(signedAt);
  if (Number.isNaN(signedDate.getTime())) return false;

  const settlementDeadline = new Date(signedDate);
  settlementDeadline.setMonth(settlementDeadline.getMonth() + 1);
  return now.getTime() > settlementDeadline.getTime();
}

export function getShippingFeeSourceLabel(source: ShippingFeeSource) {
  if (source === "actual") return "实际";
  if (source === "estimated") return "自动估算";
  return "缺失";
}

export function getReconciliationIssues(row: FinanceOrderRow): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  if (!row.matched) issues.push("unmatched");
  if (row.warehouseLogisticsIssue) issues.push("warehouse-logistics-incomplete");
  if (needsSettlementOverdueAttention(row)) issues.push("settlement-overdue");
  if (needsShippingFeeAttention(row)) {
    issues.push(needsShippingMethodAttention(row) ? "shipping-method-missing" : "shipping-cost-missing");
  }
  return issues;
}

export function getAccountingStatus(row: FinanceOrderRow): { label: string; tone: FinanceBadgeTone } {
  const issues = getReconciliationIssues(row);
  if (issues.includes("unmatched")) return { label: "异常(未匹配)", tone: "danger" };
  if (issues.includes("warehouse-logistics-incomplete")) return { label: "待处理(仓库物流配置)", tone: "warning" };
  if (issues.includes("settlement-overdue")) return { label: "待处理(结算超期)", tone: "warning" };
  if (issues.includes("shipping-method-missing")) return { label: "待处理(缺发货方式)", tone: "warning" };
  if (issues.includes("shipping-cost-missing")) return { label: "待处理(缺运费)", tone: "warning" };
  return { label: "对账成功", tone: "success" };
}

export function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

export function buildSkuLookup(products: Product[], skus: ProductSku[]) {
  const productsById = Object.fromEntries(products.map((product) => [product.id, product]));
  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
    if (!sku.product_id) return groups;
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});

  const skuByCode = new Map<string, ProductSku>();
  const skuBySalesSpec = new Map<string, ProductSku>();

  Object.entries(skusByProductId).forEach(([productId, productSkus]) => {
    const product = productsById[productId];
    productSkus.forEach((sku, index) => {
      const salesSpecKey = normalizeSalesSpec(formatSkuSalesSpec(sku));
      if (salesSpecKey && !skuBySalesSpec.has(salesSpecKey)) {
        skuBySalesSpec.set(salesSpecKey, sku);
      }

      [sku.sku_code, product && isLegacyDefaultSkuCode(sku.sku_code)
        ? buildDefaultSkuCode(product.product_code, index)
        : ""].forEach((skuCode) => {
        const key = normalizeSkuCode(skuCode);
        if (key) skuByCode.set(key, sku);
      });
    });
  });

  return { skuByCode, skuBySalesSpec };
}

export function getOrderSku(order: TemuOrderRecord, lookup: ReturnType<typeof buildSkuLookup>) {
  return (
    lookup.skuByCode.get(normalizeSkuCode(order.sku_code)) ??
    lookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ??
    null
  );
}

export function getOrderQuantity(order: TemuOrderRecord) {
  return Math.max(0, Number(order.fulfillment_quantity || 0));
}

export function getSkuUnitCostRmb(sku: ProductSku, productItemsById: Map<string, ProductItem>) {
  return sku.component_links.reduce((total, link) => {
    const item = productItemsById.get(link.item_id);
    if (!item) return total;
    const quantity = Math.max(0, Number(link.quantity || 0));
    return (
      total +
      item.purchase_price_rmb * quantity +
      calculatePurchaseShippingRmb(item, quantity)
    );
  }, 0);
}

function estimateOrderLastLegShippingFee(
  order: TemuOrderRecord,
  product: Product | null,
  settings: PricingSettings | null
): number {
  if (!product || !settings) return 0;

  const orderMethodRaw = order.logistics_method || "";
  const orderMethodName = normalizeLogisticsMethodName(orderMethodRaw);
  if (!orderMethodName) return 0;

  const lastLegs = resolveLastLegMethods(settings);

  let matchedMethod = lastLegs.find(
    (m) => normalizeLogisticsMethodName(m.name).toLowerCase() === orderMethodName.toLowerCase()
  );

  if (!matchedMethod) {
    matchedMethod = lastLegs.find(
      (m) =>
        m.name.toLowerCase().includes(orderMethodName.toLowerCase()) ||
        orderMethodName.toLowerCase().includes(m.name.toLowerCase())
    );
  }

  if (!matchedMethod) {
    const lowerRaw = orderMethodRaw.toLowerCase();
    if (lowerRaw.includes("3cm") || lowerRaw.includes("yamato")) {
      matchedMethod = lastLegs.find((m) => m.formula === "ocs_3cm");
    } else if (lowerRaw.includes("小包") || lowerRaw.includes("small")) {
      matchedMethod = lastLegs.find((m) => m.formula === "ocs_small");
    } else if (lowerRaw.includes("福冈") || lowerRaw.includes("fukuoka") || lowerRaw.includes("post")) {
      matchedMethod = lastLegs.find((m) => m.name.includes("福冈") || m.id.includes("fukuoka"));
    } else if (lowerRaw.includes("大阪") || lowerRaw.includes("osaka")) {
      matchedMethod = lastLegs.find((m) => m.name.includes("大阪") || m.id.includes("osaka"));
    }
  }

  if (!matchedMethod) return 0;

  const qty = Math.max(0, Number(order.fulfillment_quantity || 0));
  const packageWeightG = Math.max(0, product.package_weight_g * qty);

  const costRmb = calculateDynamicMethodCost(
    matchedMethod,
    packageWeightG,
    settings.exchange_rate_rmb_per_jpy
  );

  return Number(costRmb.toFixed(2));
}

export function estimateOrderShippingBreakdown({
  order,
  product,
  settings,
  logisticsMethods,
  warehouseLogisticsMethods,
}: {
  order: TemuOrderRecord;
  product: Product | null;
  settings: PricingSettings | null;
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
}) {
  const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
  const estimatedLastLegShippingRmb = estimateOrderLastLegShippingFee(
    order,
    product,
    settings,
  );
  const shippingFeeSource: ShippingFeeSource =
    actualShippingFeeRmb > 0
      ? "actual"
      : estimatedLastLegShippingRmb > 0
        ? "estimated"
        : "missing";
  const qty = Math.max(0, Number(order.fulfillment_quantity || 0));
  const packageWeightG = Math.max(0, (product?.package_weight_g ?? 0) * qty);
  const warehouseLogisticsIssue = !order.warehouse_id
    ? "仓库物流配置不完整：缺少仓库"
    : getWarehouseLogisticsConfigStatus(
        order.warehouse_id,
        settings,
        logisticsMethods,
        warehouseLogisticsMethods,
      ).issue;
  const firstLegShippingRmb = warehouseLogisticsIssue
    ? 0
    : calculateHighestWarehouseFirstLegCostRmb({
        warehouseId: order.warehouse_id,
        packageWeightG,
        settings,
        logisticsMethods,
        warehouseLogisticsMethods,
      });
  const lastLegShippingRmb =
    shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedLastLegShippingRmb;
  const estimatedShippingRmb = roundMoney(firstLegShippingRmb + estimatedLastLegShippingRmb);
  const shippingFeeRmb = roundMoney(firstLegShippingRmb + lastLegShippingRmb);

  return {
    firstLegShippingRmb: roundMoney(firstLegShippingRmb),
    lastLegShippingRmb: roundMoney(lastLegShippingRmb),
    cashShippingFeeRmb: roundMoney(lastLegShippingRmb),
    estimatedShippingRmb,
    shippingFeeRmb,
    shippingFeeSource,
    isShippingFeeEstimated: firstLegShippingRmb > 0 || shippingFeeSource === "estimated",
    warehouseLogisticsIssue,
  };
}

export function estimateOrderShippingFee(
  order: TemuOrderRecord,
  product: Product | null,
  settings: PricingSettings | null,
  logisticsMethods: LogisticsMethod[] = [],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[] = [],
): number {
  return estimateOrderShippingBreakdown({
    order,
    product,
    settings,
    logisticsMethods,
    warehouseLogisticsMethods,
  }).shippingFeeRmb;
}

export function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getOrderDate(order: TemuOrderRecord) {
  return (
    order.actual_ship_time ||
    order.label_printed_at ||
    order.latest_ship_time ||
    order.created_at ||
    ""
  );
}

export function formatDate(value: string) {
  return getDateKey(value) || value || "--";
}

export function getMonthKey(value: string) {
  const dateKey = getDateKey(value);
  return dateKey ? dateKey.slice(0, 7) : "未定";
}

export function getOrderSearchText(row: FinanceOrderRow) {
  return [
    row.order.order_no,
    row.order.sub_order_no,
    row.order.sku_code,
    row.order.product_attributes,
    row.order.recipient_name,
    row.order.logistics_tracking_no,
    row.product?.product_code ?? "",
    row.product?.product_name_cn ?? "",
  ].join(" ").toLowerCase();
}

export function getPurchaseTotalRmb(purchase: PurchaseOrder) {
  return Number(purchase.total_cost_rmb || 0);
}

export function calculateFinanceTotals(orderRows: FinanceOrderRow[], purchases: PurchaseOrder[]) {
  const estimatedBillAmount = orderRows.reduce((sum, row) => sum + row.billAmountRmb, 0);
  const actualRevenueAmount = orderRows.reduce((sum, row) => sum + row.actualRevenueRmb, 0);
  const orderShippingFee = orderRows.reduce((sum, row) => sum + row.shippingFeeRmb, 0);
  const cashOrderShippingFee = orderRows.reduce((sum, row) => sum + row.cashShippingFeeRmb, 0);
  const orderProductCost = orderRows.reduce((sum, row) => sum + row.productCostRmb, 0);
  const purchasePayment = purchases.reduce(
    (sum, purchase) => sum + getPurchaseTotalRmb(purchase),
    0,
  );
  const missingShippingFeeCount = orderRows.filter(needsShippingFeeAttention).length;
  const unmatchedCount = orderRows.filter((row) => !row.matched).length;
  const unsettledCount = orderRows.filter((row) => !row.isSettled).length;
  return {
    estimatedBillAmount: roundMoney(estimatedBillAmount),
    actualRevenueAmount: roundMoney(actualRevenueAmount),
    orderShippingFee: roundMoney(orderShippingFee),
    cashOrderShippingFee: roundMoney(cashOrderShippingFee),
    orderProductCost: roundMoney(orderProductCost),
    purchasePayment: roundMoney(purchasePayment),
    missingShippingFeeCount,
    unmatchedCount,
    unsettledCount,
  };
}

export function EmptyPanel({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`empty-state ${compact ? "py-4" : ""}`}>
      {label}
    </div>
  );
}

export function FinanceTable({
  children,
  minWidth = "min-w-[1100px]",
  tableClassName = "",
}: {
  children: ReactNode;
  minWidth?: string;
  tableClassName?: string;
}) {
  return (
    <div className="table-card min-w-0 w-full shadow-none">
      <div className="min-w-0 max-w-full overflow-x-auto">
        <table className={`data-table ${minWidth} ${tableClassName}`}>{children}</table>
      </div>
    </div>
  );
}

export function getPaginatedRows<T>(key: string, rows: T[], page: number, pageSize: number = 20) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  return {
    page: safePage,
    total,
    totalPages,
    rows: rows.slice(startIndex, startIndex + pageSize),
  };
}

export const financePageSizeOptions = [20, 30, 50, 100] as const;

export function renderPaginationControls(
  key: string,
  page: number,
  totalPages: number,
  total: number,
  setPage: (p: number | ((prev: number) => number)) => void,
  pageSize: number = 20,
  setPageSize?: (s: number) => void
) {
  if (total === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 text-xs text-slate-500">
      <div className="flex items-center gap-4">
        <span>
          共 <strong className="font-bold text-slate-700">{total}</strong> 条
        </span>
        {setPageSize && (
          <div className="flex items-center gap-2">
            <span>每页展示:</span>
            <select
              aria-label="每页展示数量"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-7 rounded border border-line bg-white px-1 text-xs font-semibold outline-none focus:border-accent"
            >
              {financePageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt} 条
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="font-medium text-slate-600">
          第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1}
            className="btn-secondary h-7 px-2.5 text-xs"
          >
            上一页
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages}
            className="btn-secondary h-7 px-2.5 text-xs"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

export function getResolvedSettlementMetrics(
  order: TemuOrderRecord,
  quantity: number,
  settlementLookup: SettlementLookup
): { actualSalesRevenueRmb: number; actualFreightRevenueRmb: number; isSettled: boolean; matchType: "none" | "po" | "sku_avg" } {
  let actualSalesRevenueRmb = 0;
  let actualFreightRevenueRmb = 0;
  let isSettled = false;
  let matchType: "none" | "po" | "sku_avg" = "none";

  // Level 1: PO exact match
  const poKey = order.order_no.trim();
  
  if (poKey && settlementLookup.byPO.has(poKey)) {
    const matchingRecords = settlementLookup.byPO.get(poKey)!;
    actualSalesRevenueRmb = roundMoney(
      matchingRecords.reduce((sum, record) => sum + calculateSettlementNetSalesRevenue(record), 0),
    );
    actualFreightRevenueRmb = roundMoney(
      matchingRecords.reduce((sum, record) => sum + calculateSettlementNetFreightRevenue(record), 0),
    );
    isSettled = true;
    matchType = "po";
  }

  return { actualSalesRevenueRmb, actualFreightRevenueRmb, isSettled, matchType };
}
