import type { User } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Check,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  Edit2,
  LineChart,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Badge, PageHeader, StatCard } from "../components/ui";
import { addObjectSheet, createWorkbook, downloadWorkbook } from "../lib/excel";
import { fetchTemuOrders, updateTemuOrder } from "../lib/orders";
import { fetchWarehouses, fetchWarehouseSkus } from "../lib/inventory";
import {
  fetchProducts,
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  updateSkuCode,
} from "../lib/products";
import { fetchPurchaseOrders } from "../lib/purchases";
import {
  parseSettlementData,
  loadSettlementFiles,
  saveSettlementFiles,
  addSettlementFile,
  deleteSettlementFile,
  buildSettlementLookup,
  formatDateRange,
  type SettlementFile,
  type SettlementLookup,
} from "../lib/settlement";
import { readTabularFileObjects } from "../lib/excel";
import type {
  Product,
  ProductItem,
  ProductSku,
  PurchaseOrder,
  TemuOrderRecord,
  PricingSettings,
  Warehouse,
  WarehouseSku,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePurchaseShippingRmb, calculateDynamicMethodCost } from "../utils/shipping-costs";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { formatCurrency } from "../utils/pricing";
import { usePermissions } from "../hooks/use-permissions";
import { fetchSettings } from "../lib/settings";
import { normalizeLogisticsMethodName } from "../lib/logistics-methods";
import { defaultLastLegMethods } from "../lib/defaults";

export type OtherExpense = {
  id: string;
  date: string;
  category: "ad" | "customs" | "packaging" | "other";
  amount: number;
  remark: string;
};

export const categoryLabels: Record<OtherExpense["category"], string> = {
  ad: "广告推广",
  customs: "关税头程",
  packaging: "包装耗材",
  other: "其他杂费",
};

function getTodayInputValue() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function getCurrentMonthInputValue() {
  return getTodayInputValue().slice(0, 7);
}

function getMonthStart(month: string) {
  return month ? `${month}-01` : "";
}

function getMonthEnd(month: string) {
  if (!month) return "";
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return "";
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function getDateKey(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const direct = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(direct) ? direct : "";
}

function isDateInPeriod(value: string, period: FinancePeriod) {
  if (period.mode === "all") return true;
  const dateKey = getDateKey(value);
  if (!dateKey) return false;
  if (period.start && dateKey < period.start) return false;
  if (period.end && dateKey > period.end) return false;
  return true;
}


const financeViews = [
  {
    key: "overview",
    label: "财务总览",
    path: "/finance",
    icon: CircleDollarSign,
    description: "集中查看回款、成本、费用、利润和待处理对账风险",
  },
  {
    key: "ledger",
    label: "流水账本",
    path: "/finance/books",
    icon: Wallet,
    description: "整合收支流水、采购付款和其他费用录入",
  },
  {
    key: "profit",
    label: "利润报表",
    path: "/finance/profit",
    icon: LineChart,
    description: "整合月度利润和商品利润核算",
  },
  {
    key: "settlement",
    label: "结算对账",
    path: "/finance/settlement",
    icon: ClipboardCheck,
    description: "整合结算文件、异常对账和订单收入明细",
  },
] as const;

const financePageSizeOptions = [20, 50, 100] as const;

export type FinanceView = typeof financeViews[number]["key"];

type FinancePageProps = {
  user: User;
  view: FinanceView;
};

type FinanceData = {
  orders: TemuOrderRecord[];
  purchases: PurchaseOrder[];
  products: Product[];
  productItems: ProductItem[];
  productSkus: ProductSku[];
  warehouses: Warehouse[];
  warehouseSkus: WarehouseSku[];
};

type FinanceOrderRow = {
  order: TemuOrderRecord;
  sku: ProductSku | null;
  product: Product | null;
  quantity: number;
  productCostRmb: number;
  shippingFeeRmb: number;
  estimatedShippingRmb: number;
  shippingFeeSource: ShippingFeeSource;
  isShippingFeeEstimated: boolean;
  billAmountRmb: number; // Product cost + accounting shipping fee
  actualSalesRevenueRmb: number; // From settlement
  actualFreightRevenueRmb: number; // From settlement
  actualRevenueRmb: number; // Actual total revenue from settlement
  isSettled: boolean; // True if matched with settlement data
  matched: boolean;
  matchLabel: string;
};

type LedgerRow = {
  date: string;
  type: string;
  direction: "收入" | "支出";
  subject: string;
  amountRmb: number;
  remark: string;
};

type FinanceBadgeTone = "success" | "warning" | "danger" | "neutral" | "info";
type ShippingFeeSource = "actual" | "estimated" | "missing";
type ReconciliationIssue = "unmatched" | "shipping-missing";
type FinancePeriodMode = "all" | "month" | "custom";
type FinancePeriod = {
  mode: FinancePeriodMode;
  start: string;
  end: string;
  label: string;
};

type InventoryValueRow = {
  productId: string;
  productCode: string;
  productName: string;
  skuId: string;
  skuCode: string;
  skuSpec: string;
  stockQuantity: number;
  unitCostRmb: number;
  inventoryValueRmb: number;
  warehouseSummary: string;
};

function getSignedAmountClass(value: number, neutralClass = "text-slate-700") {
  if (value < 0) return "text-rose-700";
  if (value > 0) return "text-emerald-700";
  return neutralClass;
}

function calculateMarginRate(profit: number, revenue: number) {
  if (!Number.isFinite(profit) || !Number.isFinite(revenue)) return 0;
  if (revenue !== 0) return (profit / Math.abs(revenue)) * 100;
  return profit < 0 ? -100 : 0;
}

function hasActualShippingFee(row: FinanceOrderRow) {
  return Number(row.order.actual_shipping_fee_rmb || 0) > 0;
}

function hasShippingActivity(row: FinanceOrderRow) {
  return Boolean(
    row.order.actual_ship_time ||
    row.order.label_printed_at ||
    row.order.logistics_tracking_no ||
    row.order.logistics_method,
  );
}

function needsShippingFeeAttention(row: FinanceOrderRow) {
  return row.shippingFeeSource === "missing" && hasShippingActivity(row);
}

function getShippingFeeSourceLabel(source: ShippingFeeSource) {
  if (source === "actual") return "实际";
  if (source === "estimated") return "自动估算";
  return "缺失";
}

function getReconciliationIssues(row: FinanceOrderRow): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  if (!row.matched) issues.push("unmatched");
  if (needsShippingFeeAttention(row)) {
    issues.push("shipping-missing");
  }
  return issues;
}

function getAccountingStatus(row: FinanceOrderRow): { label: string; tone: FinanceBadgeTone } {
  const issues = getReconciliationIssues(row);
  if (issues.includes("unmatched")) return { label: "异常(未匹配)", tone: "danger" };
  if (issues.includes("shipping-missing")) return { label: "待处理(缺运费)", tone: "danger" };
  return { label: "对账成功", tone: "success" };
}

const emptyData: FinanceData = {
  orders: [],
  purchases: [],
  products: [],
  productItems: [],
  productSkus: [],
  warehouses: [],
  warehouseSkus: [],
};

function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

function buildSkuLookup(products: Product[], skus: ProductSku[]) {
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

function getOrderSku(order: TemuOrderRecord, lookup: ReturnType<typeof buildSkuLookup>) {
  return (
    lookup.skuByCode.get(normalizeSkuCode(order.sku_code)) ??
    lookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ??
    null
  );
}

function getOrderQuantity(order: TemuOrderRecord) {
  return Math.max(0, Number(order.fulfillment_quantity || 0));
}

function getSkuUnitCostRmb(sku: ProductSku, productItemsById: Map<string, ProductItem>) {
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

function estimateOrderShippingFee(
  order: TemuOrderRecord,
  product: Product | null,
  settings: PricingSettings | null
): number {
  if (!product || !settings) return 0;

  const orderMethodRaw = order.logistics_method || "";
  const orderMethodName = normalizeLogisticsMethodName(orderMethodRaw);
  if (!orderMethodName) return 0;

  const lastLegs = settings.last_leg_methods || defaultLastLegMethods;

  // Try to find the method that matches normalized name
  let matchedMethod = lastLegs.find(
    (m) => normalizeLogisticsMethodName(m.name).toLowerCase() === orderMethodName.toLowerCase()
  );

  if (!matchedMethod) {
    // If not found, check name inclusion
    matchedMethod = lastLegs.find(
      (m) =>
        m.name.toLowerCase().includes(orderMethodName.toLowerCase()) ||
        orderMethodName.toLowerCase().includes(m.name.toLowerCase())
    );
  }

  if (!matchedMethod) {
    // If still not matched, check if it's one of standard formulas directly
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

function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function getOrderDate(order: TemuOrderRecord) {
  return (
    order.actual_ship_time ||
    order.label_printed_at ||
    order.latest_ship_time ||
    order.created_at ||
    ""
  );
}

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value || "--";
  return parsed.toISOString().slice(0, 10);
}

function getMonthKey(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "未定";
  return parsed.toISOString().slice(0, 7);
}

function getOrderSearchText(row: FinanceOrderRow) {
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

function getCurrentView(view: FinanceView) {
  return financeViews.find((item) => item.key === view) ?? financeViews[0];
}

function getPurchaseTotalRmb(purchase: PurchaseOrder) {
  return Number(purchase.total_cost_rmb || 0);
}

function calculateFinanceTotals(orderRows: FinanceOrderRow[], purchases: PurchaseOrder[]) {
  const estimatedBillAmount = orderRows.reduce((sum, row) => sum + row.billAmountRmb, 0);
  const actualRevenueAmount = orderRows.reduce((sum, row) => sum + row.actualRevenueRmb, 0);
  const orderShippingFee = orderRows.reduce((sum, row) => sum + row.shippingFeeRmb, 0);
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
    orderProductCost: roundMoney(orderProductCost),
    purchasePayment: roundMoney(purchasePayment),
    missingShippingFeeCount,
    unmatchedCount,
    unsettledCount,
  };
}

function EmptyPanel({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-dashed border-slate-200 bg-slate-50/70 text-center text-sm font-medium text-slate-500 ${compact ? "p-4" : "p-8"}`}>
      {label}
    </div>
  );
}

function FinanceTable({
  children,
  minWidth = "min-w-[1100px]",
  tableClassName = "",
}: {
  children: ReactNode;
  minWidth?: string;
  tableClassName?: string;
}) {
  return (
    <div className="table-card shadow-none">
      <div className="overflow-x-auto">
        <table className={`data-table ${minWidth} ${tableClassName}`}>{children}</table>
      </div>
    </div>
  );
}

export function FinancePage({ user, view }: FinancePageProps) {
  const { canEdit } = usePermissions();
  const [data, setData] = useState<FinanceData>(emptyData);
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [search, setSearch] = useState("");
  const [periodMode, setPeriodMode] = useState<FinancePeriodMode>("all");
  const [periodMonth, setPeriodMonth] = useState(getCurrentMonthInputValue());
  const [periodStart, setPeriodStart] = useState(getMonthStart(getCurrentMonthInputValue()));
  const [periodEnd, setPeriodEnd] = useState(getTodayInputValue());

  // Settlement Data state
  const [settlementFiles, setSettlementFiles] = useState<SettlementFile[]>([]);
  const [settlementImporting, setSettlementImporting] = useState(false);

  // Other Expenses state
  const [otherExpenses, setOtherExpenses] = useState<OtherExpense[]>([]);

  // Other Expenses Form state
  const [expenseDate, setExpenseDate] = useState(getTodayInputValue());
  const [expenseCategory, setExpenseCategory] = useState<OtherExpense["category"]>("ad");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseRemark, setExpenseRemark] = useState("");
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);

  // Cashflow filter states
  const [cashflowDirection, setCashflowDirection] = useState<"all" | "收入" | "支出">("all");
  const [cashflowType, setCashflowType] = useState<string>("all");
  const [cashflowMonth, setCashflowMonth] = useState<string>("all");
  const [financePageSize, setFinancePageSize] = useState<number>(20);
  const [financePages, setFinancePages] = useState<Record<string, number>>({});

  // Order income filter states
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>("all");
  const [orderMatchFilter, setOrderMatchFilter] = useState<"all" | "matched" | "unmatched">("all");
  const [orderShippingFilter, setOrderShippingFilter] = useState<"all" | ShippingFeeSource>("all");

  // Inline shipping fee editing state
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingFeeValue, setEditingFeeValue] = useState<string>("");
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);

  // Reconciliation matching state
  const [matchingOrderId, setMatchingOrderId] = useState<string | null>(null);
  const [matchingSkuId, setMatchingSkuId] = useState<string>("");
  const [linkingOrderId, setLinkingOrderId] = useState<string | null>(null);

  // Product Sort/Filter states
  const [productSortField, setProductSortField] = useState<"quantity" | "orderCount" | "productCost" | "shipping" | "billAmount" | "profit" | "margin">("billAmount");
  const [productSortOrder, setProductSortOrder] = useState<"asc" | "desc">("desc");
  const [productSearch, setProductSearch] = useState("");

  const currentView = getCurrentView(view);

  // Load other expenses and settlements from localStorage
  useEffect(() => {
    const savedExpenses = localStorage.getItem("codex_finance_other_expenses");
    if (savedExpenses) {
      try {
        setOtherExpenses(JSON.parse(savedExpenses));
      } catch (e) {
        console.error("Failed to parse other expenses", e);
      }
    }

    setSettlementFiles(loadSettlementFiles());
  }, []);

  const saveOtherExpenses = (newExpenses: OtherExpense[]) => {
    setOtherExpenses(newExpenses);
    localStorage.setItem("codex_finance_other_expenses", JSON.stringify(newExpenses));
  };

  async function loadFinanceData() {
    setLoading(true);
    setErrorMessage("");
    try {
      const [orders, purchases, products, warehouses, fetchedSettings] = await Promise.all([
        fetchTemuOrders(),
        fetchPurchaseOrders(),
        fetchProducts({ includeNotSelling: true }),
        fetchWarehouses(),
        fetchSettings(user.id).catch((err) => {
          console.error("Failed to fetch settings:", err);
          return null;
        }),
      ]);
      const productIds = products.map((product) => product.id);
      const [productItems, productSkus] = await Promise.all([
        fetchProductItemsByProductIds(productIds),
        fetchProductSkusByProductIds(productIds),
      ]);
      const warehouseSkus = await fetchWarehouseSkus(warehouses.map((warehouse) => warehouse.id));
      setData({ orders, purchases, products, productItems, productSkus, warehouses, warehouseSkus });
      setSettings(fetchedSettings);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "加载财务数据失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void user.id;
    void loadFinanceData();
  }, [user.id]);

  const productItemsById = useMemo(
    () =>
      new Map(
        data.productItems.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
      ),
    [data.productItems],
  );

  const productsById = useMemo(
    () => new Map(data.products.map((product) => [product.id, product])),
    [data.products],
  );

  const skuLookup = useMemo(
    () => buildSkuLookup(data.products, data.productSkus),
    [data.products, data.productSkus],
  );

  const skusById = useMemo(
    () => new Map(data.productSkus.flatMap((sku) => (sku.id ? [[sku.id, sku] as const] : []))),
    [data.productSkus],
  );

  const warehousesById = useMemo(
    () => new Map(data.warehouses.map((warehouse) => [warehouse.id, warehouse])),
    [data.warehouses],
  );

  const selectedPeriod = useMemo<FinancePeriod>(() => {
    if (periodMode === "month") {
      return {
        mode: periodMode,
        start: getMonthStart(periodMonth),
        end: getMonthEnd(periodMonth),
        label: periodMonth ? `${periodMonth} 月` : "未选择月份",
      };
    }
    if (periodMode === "custom") {
      const label = `${periodStart || "开始"} ~ ${periodEnd || "结束"}`;
      return { mode: periodMode, start: periodStart, end: periodEnd, label };
    }
    return { mode: "all", start: "", end: "", label: "全部累计" };
  }, [periodMode, periodMonth, periodStart, periodEnd]);

  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles), [settlementFiles]);

  const orderRows = useMemo<FinanceOrderRow[]>(
    () =>
      data.orders.map((order) => {
        const sku = getOrderSku(order, skuLookup);
        const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
        const quantity = getOrderQuantity(order);
        const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
        const productCostRmb = roundMoney(unitCost * quantity);

        const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
        const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
        const shippingFeeSource: ShippingFeeSource = actualShippingFeeRmb > 0
          ? "actual"
          : estimatedShippingRmb > 0
            ? "estimated"
            : "missing";
        const shippingFeeRmb = roundMoney(shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedShippingRmb);

        // Get actual settlement revenue (matching by PO number first, fallback to SKU averages if needed, but here we match PO from settlement lookup)
        let actualSalesRevenueRmb = 0;
        let actualFreightRevenueRmb = 0;
        let isSettled = false;

        const poKey = order.order_no.trim();
        const skuCodeKey = order.sku_code.trim().toLowerCase();
        
        if (poKey && settlementLookup.byPO.has(poKey)) {
          const matchingRecords = settlementLookup.byPO.get(poKey)!;
          // An order could have multiple SKUs (sub-items in combo). Try to find specific SKU, or just take total if single.
          let matchedRecord = matchingRecords.find(r => r.skuCode.toLowerCase() === skuCodeKey);
          if (!matchedRecord && matchingRecords.length === 1) {
            matchedRecord = matchingRecords[0];
          }
          
          if (matchedRecord) {
            actualSalesRevenueRmb = matchedRecord.salesRevenue;
            actualFreightRevenueRmb = matchedRecord.freightRevenue;
            isSettled = true;
          }
        }

        const actualRevenueRmb = roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);

        return {
          order,
          sku,
          product,
          quantity,
          productCostRmb,
          shippingFeeRmb,
          estimatedShippingRmb,
          shippingFeeSource,
          isShippingFeeEstimated: shippingFeeSource === "estimated",
          billAmountRmb: roundMoney(productCostRmb + shippingFeeRmb),
          actualSalesRevenueRmb,
          actualFreightRevenueRmb,
          actualRevenueRmb,
          isSettled,
          matched: Boolean(sku && product),
          matchLabel: sku && product ? "已匹配" : "待匹配",
        };
      }),
    [data.orders, productItemsById, productsById, skuLookup, settings, settlementLookup],
  );

  const periodOrderRows = useMemo(
    () => orderRows.filter((row) => isDateInPeriod(getOrderDate(row.order), selectedPeriod)),
    [orderRows, selectedPeriod],
  );

  const periodPurchases = useMemo(
    () => data.purchases.filter((purchase) => isDateInPeriod(purchase.purchased_at, selectedPeriod)),
    [data.purchases, selectedPeriod],
  );

  const periodOtherExpenses = useMemo(
    () => otherExpenses.filter((expense) => isDateInPeriod(expense.date, selectedPeriod)),
    [otherExpenses, selectedPeriod],
  );

  const filteredOrderRows = useMemo(() => {
    let rows = periodOrderRows;
    const keyword = search.trim().toLowerCase();
    if (keyword) {
      rows = rows.filter((row) => getOrderSearchText(row).includes(keyword));
    }
    return rows.filter((row) => {
      if (orderStatusFilter !== "all" && row.order.order_status !== orderStatusFilter) return false;
      if (orderMatchFilter !== "all") {
        const isMatched = row.matched;
        if (orderMatchFilter === "matched" && !isMatched) return false;
        if (orderMatchFilter === "unmatched" && isMatched) return false;
      }
      if (orderShippingFilter !== "all") {
        if (row.shippingFeeSource !== orderShippingFilter) return false;
      }
      return true;
    });
  }, [periodOrderRows, search, orderStatusFilter, orderMatchFilter, orderShippingFilter]);

  const ledgerRows = useMemo<LedgerRow[]>(() => {
    const orderLedgerRows = periodOrderRows
      .filter((row) => row.actualRevenueRmb > 0)
      .map((row) => ({
        date: formatDate(getOrderDate(row.order)),
        type: "订单回款",
        direction: "收入" as const,
        subject: row.order.order_no,
        amountRmb: row.actualRevenueRmb,
        remark: `销售回款 ${formatCurrency(row.actualSalesRevenueRmb)} / 运费回款 ${formatCurrency(row.actualFreightRevenueRmb)}`,
      }));

    const purchaseLedgerRows = periodPurchases.map((purchase) => ({
      date: formatDate(purchase.purchased_at),
      type: "采购付款",
      direction: "支出" as const,
      subject: purchase.order_code,
      amountRmb: -getPurchaseTotalRmb(purchase),
      remark: purchase.warehouse_name,
    }));

    const otherExpensesLedgerRows = periodOtherExpenses.map((expense) => ({
      date: formatDate(expense.date),
      type: "其他费用",
      direction: "支出" as const,
      subject: categoryLabels[expense.category] || "其他费用",
      amountRmb: -expense.amount,
      remark: expense.remark,
    }));

    return [...orderLedgerRows, ...purchaseLedgerRows, ...otherExpensesLedgerRows].sort((left, right) =>
      right.date.localeCompare(left.date),
    );
  }, [periodPurchases, periodOrderRows, periodOtherExpenses]);

  const uniqueMonths = useMemo(() => {
    const months = new Set<string>();
    ledgerRows.forEach((r) => {
      if (r.date && r.date !== "--") {
        months.add(r.date.slice(0, 7));
      }
    });
    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [ledgerRows]);

  const filteredLedgerRows = useMemo(() => {
    return ledgerRows.filter((row) => {
      if (cashflowDirection !== "all" && row.direction !== cashflowDirection) return false;
      if (cashflowType !== "all" && row.type !== cashflowType) return false;
      if (cashflowMonth !== "all" && !row.date.startsWith(cashflowMonth)) return false;
      return true;
    });
  }, [ledgerRows, cashflowDirection, cashflowType, cashflowMonth]);

  const orderStatuses = useMemo(() => {
    const statuses = new Set<string>();
    orderRows.forEach((r) => {
      if (r.order.order_status) statuses.add(r.order.order_status);
    });
    return Array.from(statuses);
  }, [orderRows]);

  const totals = useMemo(
    () => calculateFinanceTotals(periodOrderRows, periodPurchases),
    [periodOrderRows, periodPurchases],
  );

  const allTotals = useMemo(
    () => calculateFinanceTotals(orderRows, data.purchases),
    [orderRows, data.purchases],
  );

  const inventoryRows = useMemo<InventoryValueRow[]>(() => {
    const groups = new Map<string, InventoryValueRow & { warehouseParts: string[] }>();

    data.warehouseSkus.forEach((stock) => {
      const stockQuantity = Math.max(0, Number(stock.stock_quantity || 0));
      if (stockQuantity <= 0) return;

      const sku = skusById.get(stock.sku_id);
      const product = productsById.get(stock.product_id) ?? (sku?.product_id ? productsById.get(sku.product_id) : null);
      const unitCostRmb = sku ? roundMoney(getSkuUnitCostRmb(sku, productItemsById)) : 0;
      const key = `${stock.product_id}:${stock.sku_id}`;
      const warehouseName = warehousesById.get(stock.warehouse_id)?.name ?? "未知仓库";
      const current = groups.get(key) ?? {
        productId: stock.product_id,
        productCode: product?.product_code ?? "--",
        productName: product?.product_name_cn ?? "未匹配商品",
        skuId: stock.sku_id,
        skuCode: sku?.sku_code ?? "--",
        skuSpec: sku ? formatSkuSalesSpec(sku) : "--",
        stockQuantity: 0,
        unitCostRmb,
        inventoryValueRmb: 0,
        warehouseSummary: "",
        warehouseParts: [],
      };

      current.stockQuantity += stockQuantity;
      current.inventoryValueRmb += stockQuantity * unitCostRmb;
      current.warehouseParts.push(`${warehouseName} ${stockQuantity}`);
      groups.set(key, current);
    });

    return Array.from(groups.values())
      .map(({ warehouseParts, ...row }) => ({
        ...row,
        stockQuantity: Math.trunc(row.stockQuantity),
        unitCostRmb: roundMoney(row.unitCostRmb),
        inventoryValueRmb: roundMoney(row.inventoryValueRmb),
        warehouseSummary: warehouseParts.join(" / "),
      }))
      .sort((left, right) => right.inventoryValueRmb - left.inventoryValueRmb);
  }, [data.warehouseSkus, productItemsById, productsById, skusById, warehousesById]);

  const inventoryTotals = useMemo(() => {
    const productIds = new Set(inventoryRows.map((row) => row.productId));
    return {
      productCount: productIds.size,
      skuCount: inventoryRows.length,
      stockQuantity: inventoryRows.reduce((sum, row) => sum + row.stockQuantity, 0),
      inventoryValueRmb: roundMoney(inventoryRows.reduce((sum, row) => sum + row.inventoryValueRmb, 0)),
    };
  }, [inventoryRows]);

  const monthlyRows = useMemo(() => {
    const groups = new Map<
      string,
      { month: string; income: number; purchase: number; productCost: number; shipping: number; otherExpense: number }
    >();
    periodOrderRows.forEach((row) => {
      const month = getMonthKey(getOrderDate(row.order));
      const group = groups.get(month) ?? {
        month,
        income: 0,
        purchase: 0,
        productCost: 0,
        shipping: 0,
        otherExpense: 0,
      };
      group.income += row.actualRevenueRmb;
      group.productCost += row.productCostRmb;
      group.shipping += row.shippingFeeRmb;
      groups.set(month, group);
    });
    periodPurchases.forEach((purchase) => {
      const month = getMonthKey(purchase.purchased_at);
      const group = groups.get(month) ?? {
        month,
        income: 0,
        purchase: 0,
        productCost: 0,
        shipping: 0,
        otherExpense: 0,
      };
      group.purchase += getPurchaseTotalRmb(purchase);
      groups.set(month, group);
    });
    periodOtherExpenses.forEach((expense) => {
      const month = getMonthKey(expense.date);
      const group = groups.get(month) ?? {
        month,
        income: 0,
        purchase: 0,
        productCost: 0,
        shipping: 0,
        otherExpense: 0,
      };
      group.otherExpense += expense.amount;
      groups.set(month, group);
    });
    return Array.from(groups.values())
      .map((row) => ({
        ...row,
        income: roundMoney(row.income),
        purchase: roundMoney(row.purchase),
        productCost: roundMoney(row.productCost),
        shipping: roundMoney(row.shipping),
        otherExpense: roundMoney(row.otherExpense),
        cashProfit: roundMoney(row.income - row.purchase - row.shipping - row.otherExpense),
        orderProfit: roundMoney(row.income - row.productCost - row.shipping - row.otherExpense),
      }))
      .sort((left, right) => right.month.localeCompare(left.month));
  }, [periodPurchases, periodOrderRows, periodOtherExpenses]);

  const productRows = useMemo(() => {
    const groups = new Map<
      string,
      {
        productCode: string;
        productName: string;
        quantity: number;
        orderCount: number;
        productCost: number;
        shipping: number;
        billAmount: number;
        profit: number;
        margin: number;
      }
    >();
    periodOrderRows.forEach((row) => {
      const key = row.product?.id ?? `unmatched:${row.order.sku_code}:${row.order.product_attributes}`;
      const group = groups.get(key) ?? {
        productCode: row.product?.product_code ?? "--",
        productName: row.product?.product_name_cn ?? "未匹配商品",
        quantity: 0,
        orderCount: 0,
        productCost: 0,
        shipping: 0,
        billAmount: 0,
        profit: 0,
        margin: 0,
      };
      group.quantity += row.quantity;
      group.orderCount += 1;
      group.productCost += row.productCostRmb;
      group.shipping += row.shippingFeeRmb;
      group.billAmount += row.actualRevenueRmb; // Use actual revenue
      groups.set(key, group);
    });

    return Array.from(groups.values()).map((row) => {
      const profit = roundMoney(row.billAmount - row.productCost - row.shipping);
      const margin = roundMoney(calculateMarginRate(profit, row.billAmount));
      return {
        ...row,
        productCost: roundMoney(row.productCost),
        shipping: roundMoney(row.shipping),
        billAmount: roundMoney(row.billAmount),
        profit,
        margin,
      };
    });
  }, [periodOrderRows]);

  const filteredProductRows = useMemo(() => {
    let rows = productRows;
    const keyword = productSearch.trim().toLowerCase();
    if (keyword) {
      rows = rows.filter((r) =>
        r.productCode.toLowerCase().includes(keyword) ||
        r.productName.toLowerCase().includes(keyword)
      );
    }

    return [...rows].sort((a, b) => {
      const left = a[productSortField];
      const right = b[productSortField];
      if (left === right) return 0;
      const factor = productSortOrder === "desc" ? -1 : 1;
      return left > right ? factor : -factor;
    });
  }, [productRows, productSortField, productSortOrder, productSearch]);

  const groupedSkuOptions = useMemo(() => {
    const skusByProduct = new Map<string, Array<{ sku: ProductSku; label: string }>>();
    data.productSkus.forEach((sku) => {
      if (!sku.product_id) return;
      const list = skusByProduct.get(sku.product_id) ?? [];
      const specLabel = formatSkuSalesSpec(sku);
      list.push({ sku, label: `${sku.sku_code || "无货号"} (${specLabel})` });
      skusByProduct.set(sku.product_id, list);
    });
    return data.products.map((product) => {
      const list = skusByProduct.get(product.id) ?? [];
      return { product, list };
    }).filter((item) => item.list.length > 0);
  }, [data.products, data.productSkus]);

  const handleUpdateShippingFee = async (orderId: string, fee: number) => {
    try {
      const updated = await updateTemuOrder(orderId, { actual_shipping_fee_rmb: fee });
      setData((current) => ({
        ...current,
        orders: current.orders.map((o) => (o.id === orderId ? updated : o)),
      }));
    } catch (error) {
      alert("更新运费失败：" + getErrorMessage(error, "更新运费失败"));
    }
  };

  const handleMatchSkuCode = async (skuId: string, skuCode: string) => {
    try {
      await updateSkuCode(skuId, skuCode);
      setData((current) => ({
        ...current,
        productSkus: current.productSkus.map((s) => (s.id === skuId ? { ...s, sku_code: skuCode } : s)),
      }));
      alert(`已成功将 SKU 货号关联为: ${skuCode}`);
    } catch (error) {
      alert("关联 SKU 失败：" + getErrorMessage(error, "关联 SKU 失败"));
    }
  };

  const handleSaveShippingFee = async (orderId: string, value: string) => {
    const fee = Number(value);
    if (Number.isNaN(fee) || fee < 0) {
      alert("请输入有效的运费金额");
      return;
    }
    setSavingOrderId(orderId);
    try {
      await handleUpdateShippingFee(orderId, fee);
      setEditingOrderId(null);
    } finally {
      setSavingOrderId(null);
    }
  };

  const handleLinkSkuCode = async (orderId: string, temuSkuCode: string, skuId: string) => {
    setLinkingOrderId(orderId);
    try {
      await handleMatchSkuCode(skuId, temuSkuCode);
      setMatchingOrderId(null);
    } finally {
      setLinkingOrderId(null);
    }
  };

  const handleAddExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(expenseAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      alert("请输入有效的费用金额");
      return;
    }
    const newExpense: OtherExpense = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      date: expenseDate,
      category: expenseCategory,
      amount,
      remark: expenseRemark.trim(),
    };
    const next = [...otherExpenses, newExpense];
    saveOtherExpenses(next);
    setExpenseAmount("");
    setExpenseRemark("");
    setExpenseFormOpen(false);
  };

  const handleDeleteExpense = (id: string) => {
    if (!window.confirm("确定删除该笔费用记录吗？")) return;
    const next = otherExpenses.filter((e) => e.id !== id);
    saveOtherExpenses(next);
  };

  async function handleRefresh() {
    setBusy(true);
    await loadFinanceData();
    setBusy(false);
  }

  async function handleExportOrderBill() {
    const workbook = await createWorkbook();
    addObjectSheet(
      workbook,
      "订单账单",
      filteredOrderRows.map((row) => ({
        订单号: row.order.order_no,
        子订单号: row.order.sub_order_no,
        日期: formatDate(getOrderDate(row.order)),
        订单状态: row.order.order_status,
        SKU货号: row.order.sku_code,
        商品: row.product?.product_name_cn ?? "",
        销售规格: row.order.product_attributes,
        数量: row.quantity,
        商品成本: row.productCostRmb,
        核算运费: row.shippingFeeRmb,
        运费口径: getShippingFeeSourceLabel(row.shippingFeeSource),
        上传实际运费: Number(row.order.actual_shipping_fee_rmb || 0),
        自动估算运费: row.estimatedShippingRmb,
        核算账单金额: row.billAmountRmb,
        仓库: row.order.warehouse_name,
        发货方式: row.order.logistics_method,
        物流单号: row.order.logistics_tracking_no,
        收件人: row.order.recipient_name,
        电话: row.order.recipient_phone,
        地址: [
          row.order.province,
          row.order.city,
          row.order.district,
          row.order.address_line1,
          row.order.address_line2,
        ].filter(Boolean).join(" "),
      })),
    );
    await downloadWorkbook(workbook, `订单账单-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function getPaginatedRows<T>(key: string, rows: T[]) {
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / financePageSize));
    const page = Math.min(Math.max(financePages[key] ?? 1, 1), totalPages);
    const startIndex = (page - 1) * financePageSize;
    return {
      page,
      total,
      totalPages,
      startIndex,
      rows: rows.slice(startIndex, startIndex + financePageSize),
    };
  }

  function setFinanceTablePage(key: string, page: number) {
    setFinancePages((current) => ({ ...current, [key]: page }));
  }

  function renderPaginationControls(key: string, page: number, totalPages: number, total: number) {
    if (total <= financePageSize && page === 1) return null;

    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-3 text-xs text-slate-500">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            共 <span className="font-semibold text-slate-700">{total}</span> 条，
            第 <span className="font-semibold text-slate-700">{page}</span> / {totalPages} 页
          </span>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-slate-400">每页</span>
            <select
              value={financePageSize}
              onChange={(event) => {
                setFinancePageSize(Number(event.target.value));
                setFinancePages({});
              }}
              className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition hover:border-slate-300 focus:border-violet-500"
            >
              {financePageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setFinanceTablePage(key, page - 1)}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setFinanceTablePage(key, page + 1)}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    );
  }

  function updatePeriodMode(nextMode: FinancePeriodMode) {
    setPeriodMode(nextMode);
    setFinancePages({});
  }

  function renderPeriodControls() {
    return (
      <section className="surface-card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">财务时间口径</h3>
            <p className="mt-1 text-xs text-slate-500">当前报表：{selectedPeriod.label}；库存金额显示当前库存余额。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[
              ["all", "全部累计"],
              ["month", "按月"],
              ["custom", "自定义"],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => updatePeriodMode(mode as FinancePeriodMode)}
                className={`h-9 rounded-lg px-3 text-xs font-bold transition ${
                  periodMode === mode
                    ? "bg-violet-600 text-white shadow-sm"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <span>月份</span>
            <input
              type="month"
              value={periodMonth}
              onChange={(event) => {
                setPeriodMonth(event.target.value);
                setPeriodMode("month");
                setFinancePages({});
              }}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <span>开始</span>
            <input
              type="date"
              value={periodStart}
              onChange={(event) => {
                setPeriodStart(event.target.value);
                setPeriodMode("custom");
                setFinancePages({});
              }}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <span>结束</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(event) => {
                setPeriodEnd(event.target.value);
                setPeriodMode("custom");
                setFinancePages({});
              }}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600"
            />
          </label>
        </div>
      </section>
    );
  }

  function renderOverview() {
    const totalOtherExpenses = periodOtherExpenses.reduce((sum, e) => sum + e.amount, 0);
    const allOtherExpenses = otherExpenses.reduce((sum, e) => sum + e.amount, 0);
    const cashProfit = totals.actualRevenueAmount - totals.purchasePayment - totals.orderShippingFee - totalOtherExpenses;
    const orderProfit = totals.actualRevenueAmount - totals.orderProductCost - totals.orderShippingFee - totalOtherExpenses;
    const allCashProfit = allTotals.actualRevenueAmount - allTotals.purchasePayment - allTotals.orderShippingFee - allOtherExpenses;
    const allOrderProfit = allTotals.actualRevenueAmount - allTotals.orderProductCost - allTotals.orderShippingFee - allOtherExpenses;
    const cashMarginRate = calculateMarginRate(cashProfit, totals.actualRevenueAmount);
    const orderMarginRate = calculateMarginRate(orderProfit, totals.actualRevenueAmount);
    const isCashLoss = cashProfit < 0;
    const isOrderLoss = orderProfit < 0;

    return (
      <>
        {/* Stat Cards Grid */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <StatCard label="实际结算总回款" value={formatCurrency(totals.actualRevenueAmount)} />
          <StatCard label="订单核算总运费" value={formatCurrency(totals.orderShippingFee)} />
          <StatCard label="订单商品成本" value={formatCurrency(totals.orderProductCost)} />
          <StatCard label="当前库存商品金额" value={formatCurrency(inventoryTotals.inventoryValueRmb)} />
          <StatCard label="期间采购付款" value={formatCurrency(totals.purchasePayment)} />
          <StatCard label="其他扣减费用" value={formatCurrency(totalOtherExpenses)} />
        </div>

        {/* Net Profit and Margin overview */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border border-slate-100 p-6 text-white shadow-lg ${
            isCashLoss ? "bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/20" : "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/20"
          }`}>
            <div className={`text-xs font-bold uppercase tracking-wider ${isCashLoss ? "text-rose-100" : "text-emerald-100"}`}>实际现金利润（按收付）</div>
            <div className="mt-2 text-3xl font-black tabular-nums">{formatCurrency(cashProfit)}</div>
            <p className={`mt-2 text-[11px] ${isCashLoss ? "text-rose-100/75" : "text-emerald-100/75"}`}>
              回款 - 当月采购付款 - 运费 - 其他费用，利润率 {cashMarginRate.toFixed(2)}%
            </p>
          </div>
          <div className={`rounded-2xl border border-slate-100 p-6 text-white shadow-lg ${
            isOrderLoss ? "bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/20" : "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/20"
          }`}>
            <div className={`text-xs font-bold uppercase tracking-wider ${isOrderLoss ? "text-rose-100" : "text-emerald-100"}`}>实际订单利润（不含库存）</div>
            <div className="mt-2 text-3xl font-black tabular-nums">{formatCurrency(orderProfit)}</div>
            <p className={`mt-2 text-[11px] ${isOrderLoss ? "text-rose-100/75" : "text-emerald-100/75"}`}>回款 - 订单商品成本 - 运费 - 其他费用</p>
          </div>
          <div className={`rounded-2xl border border-slate-100 p-6 text-white shadow-lg ${
            isOrderLoss ? "bg-gradient-to-br from-rose-400 to-red-500 shadow-rose-500/15" : "bg-gradient-to-br from-emerald-400 to-teal-500 shadow-emerald-500/15"
          }`}>
            <div className={`text-xs font-bold uppercase tracking-wider ${isOrderLoss ? "text-rose-100" : "text-emerald-100"}`}>订单销售利润率</div>
            <div className="mt-2 text-3xl font-black tabular-nums">{orderMarginRate.toFixed(2)}%</div>
            <p className={`mt-2 text-[11px] ${isOrderLoss ? "text-rose-100/75" : "text-emerald-100/75"}`}>实际订单利润 / 实际结算总回款</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm flex flex-col justify-between">
            <div>
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">结算回款状态</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-black tabular-nums text-slate-800">{periodOrderRows.length - totals.unsettledCount}</span>
                <span className="text-sm font-semibold text-slate-400">/ {periodOrderRows.length} 笔订单已结算</span>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">预估待结金额</span>
                <span className="font-bold text-slate-700">{formatCurrency(totals.estimatedBillAmount - totals.actualRevenueAmount)}</span>
              </div>
              <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500 rounded-full" style={{ width: `${periodOrderRows.length > 0 ? ((periodOrderRows.length - totals.unsettledCount) / periodOrderRows.length) * 100 : 0}%` }} />
              </div>
            </div>
          </div>
        </div>

        <section className="surface-card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-800">全部累计对照</h3>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
              当前筛选：{selectedPeriod.label}
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="累计实际回款" value={formatCurrency(allTotals.actualRevenueAmount)} />
            <StatCard label="累计现金利润" value={formatCurrency(allCashProfit)} tone={allCashProfit < 0 ? "danger" : "success"} />
            <StatCard label="累计实际订单利润" value={formatCurrency(allOrderProfit)} tone={allOrderProfit < 0 ? "danger" : "success"} />
            <StatCard label="当前库存商品金额" value={formatCurrency(inventoryTotals.inventoryValueRmb)} />
            <StatCard label="累计订单数" value={String(orderRows.length)} />
          </div>
        </section>

        {/* Cost Breakdown Visual */}
        <section className="surface-card p-5">
          <h3 className="text-sm font-bold text-slate-800 mb-4">订单财务收支与成本占比</h3>
          <div className="flex flex-col gap-4">
            <div className="h-6 w-full overflow-hidden rounded-full bg-slate-100 flex shadow-inner">
              {totals.actualRevenueAmount > 0 ? (
                <>
                  <div
                    style={{ width: `${(totals.orderProductCost / totals.actualRevenueAmount) * 100}%` }}
                    className="bg-amber-400 transition-all duration-300"
                    title={`商品采购成本: ${((totals.orderProductCost / totals.actualRevenueAmount) * 100).toFixed(1)}%`}
                  />
                  <div
                    style={{ width: `${(totals.orderShippingFee / totals.actualRevenueAmount) * 100}%` }}
                    className="bg-sky-400 transition-all duration-300"
                    title={`核算运费: ${((totals.orderShippingFee / totals.actualRevenueAmount) * 100).toFixed(1)}%`}
                  />
                  <div
                    style={{ width: `${(totalOtherExpenses / totals.actualRevenueAmount) * 100}%` }}
                    className="bg-rose-400 transition-all duration-300"
                    title={`其他费用: ${((totalOtherExpenses / totals.actualRevenueAmount) * 100).toFixed(1)}%`}
                  />
                  {orderProfit > 0 && (
                    <div
                      style={{ width: `${(orderProfit / totals.actualRevenueAmount) * 100}%` }}
                      className="bg-emerald-500 transition-all duration-300"
                      title={`实际订单利润: ${(orderMarginRate).toFixed(1)}%`}
                    />
                  )}
                </>
              ) : (
                <div className="w-full text-center text-xs text-slate-400 leading-6">暂无结算回款数据，无法计算占比</div>
              )}
            </div>
            {totals.actualRevenueAmount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-4 text-xs font-semibold text-slate-500 pt-1">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-amber-400 block" />
                  <span>商品采购成本 ({((totals.orderProductCost / totals.actualRevenueAmount) * 100).toFixed(1)}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-sky-400 block" />
                  <span>核算运费 ({((totals.orderShippingFee / totals.actualRevenueAmount) * 100).toFixed(1)}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-rose-400 block" />
                  <span>其他杂项费用 ({((totalOtherExpenses / totals.actualRevenueAmount) * 100).toFixed(1)}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full block ${isOrderLoss ? "bg-rose-500" : "bg-emerald-500"}`} />
                  <span className={isOrderLoss ? "text-rose-700" : "text-emerald-700"}>
                    {isOrderLoss ? "实际订单亏损" : "实际订单利润"} ({orderMarginRate.toFixed(1)}%)
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Pending Reconciliation Summary */}
        <section className="surface-card grid gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <h2 className="text-base font-bold text-slate-900">待处理对账 (最新)</h2>
            <div className="flex flex-wrap gap-2">
              <Badge tone={totals.missingShippingFeeCount > 0 ? "warning" : "success"}>
                缺运费 {totals.missingShippingFeeCount}
              </Badge>
              <Badge tone={totals.unmatchedCount > 0 ? "warning" : "success"}>
                未匹配 {totals.unmatchedCount}
              </Badge>
            </div>
          </div>
          {renderReconciliationTable(periodOrderRows.filter((row) => getReconciliationIssues(row).length > 0).slice(0, 5))}
        </section>
      </>
    );
  }

  function renderOrderIncome() {
    return (
      <section className="surface-card grid gap-4 p-5">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex items-center">
              <Search size={16} className="absolute left-3 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索订单号 / SKU / 收件人 / 物流单号"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-600 focus:ring-2 focus:ring-violet-600/10 sm:w-80"
              />
            </div>

            {/* Status filters */}
            <select
              value={orderStatusFilter}
              onChange={(e) => setOrderStatusFilter(e.target.value)}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
            >
              <option value="all">所有订单状态</option>
              {orderStatuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <select
              value={orderMatchFilter}
              onChange={(e) => setOrderMatchFilter(e.target.value as any)}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
            >
              <option value="all">所有匹配状态</option>
              <option value="matched">已匹配商品</option>
              <option value="unmatched">待匹配商品</option>
            </select>

            <select
              value={orderShippingFilter}
              onChange={(e) => setOrderShippingFilter(e.target.value as any)}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
            >
              <option value="all">所有运费口径</option>
              <option value="actual">已上传实际运费</option>
              <option value="estimated">自动估算运费</option>
              <option value="missing">缺失运费</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
              筛选后共 {filteredOrderRows.length} 条订单
            </span>
            <button type="button" className="btn-secondary h-10 px-4 text-xs font-bold" onClick={() => void handleExportOrderBill()}>
              <Download size={15} />
              导出账单 Excel
            </button>
          </div>
        </div>
        {renderOrderTable(filteredOrderRows)}
      </section>
    );
  }

  function renderOrderTable(rows: FinanceOrderRow[]) {
    if (rows.length === 0) return <EmptyPanel label="暂无匹配筛选条件的订单数据" />;
    const paginated = getPaginatedRows("finance-orders", rows);
    return (
      <>
        <FinanceTable minWidth="min-w-[1480px]" tableClassName="finance-freeze-order">
          <thead>
            <tr>
              <th>订单号</th>
              <th>Temu SKU</th>
              <th>日期</th>
              <th>状态</th>
              <th>系统商品 SKU</th>
              <th>数量</th>
              <th className="number-cell">采购商品成本</th>
              <th className="number-cell">核算运费</th>
              <th className="number-cell">核算账单金额</th>
              <th className="number-cell">实际结算回款</th>
              <th>发货物流方式</th>
              <th>结算状态</th>
              <th>匹配状态</th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((row) => {
              const accountingStatus = getAccountingStatus(row);
              return (
              <tr key={row.order.id} className="hover:bg-slate-50/50">
                <td className="font-bold text-slate-900">{row.order.order_no}</td>
                <td className="font-mono text-slate-600">{row.order.sku_code || "--"}</td>
                <td className="text-slate-500 font-mono">{formatDate(getOrderDate(row.order))}</td>
                <td>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 font-semibold">{row.order.order_status || "--"}</span>
                </td>
                <td className="font-medium">
                  {row.product ? (
                    <span className="text-slate-800">{row.product.product_name_cn}</span>
                  ) : (
                    <span className="text-slate-400 italic">{row.order.product_attributes || "--"}</span>
                  )}
                </td>
                <td className="number-cell font-bold">{row.quantity}</td>
                <td className="money">{formatCurrency(row.productCostRmb)}</td>
                <td className="money">
                  {editingOrderId === row.order.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={editingFeeValue}
                        onChange={(e) => setEditingFeeValue(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter") {
                            await handleSaveShippingFee(row.order.id, editingFeeValue);
                          } else if (e.key === "Escape") {
                            setEditingOrderId(null);
                          }
                        }}
                        disabled={savingOrderId === row.order.id}
                        className="h-8 w-20 rounded-xl border border-slate-350 bg-white px-2.5 text-xs outline-none text-right"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveShippingFee(row.order.id, editingFeeValue)}
                        disabled={savingOrderId === row.order.id}
                        className="rounded-lg bg-emerald-500 p-1.5 text-white hover:bg-emerald-600 transition"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingOrderId(null)}
                        disabled={savingOrderId === row.order.id}
                        className="rounded-lg bg-slate-200 p-1.5 text-slate-600 hover:bg-slate-300 transition"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 group justify-end">
                      {row.shippingFeeSource === "missing" ? (
                        <span className="text-rose-600 font-bold" title="商品未匹配或发货方式未知，无法自动计算">
                          缺失
                        </span>
                      ) : (
                        <>
                          <span className={row.isShippingFeeEstimated ? "text-violet-600 font-semibold" : "font-bold text-slate-900"}>
                            {formatCurrency(row.shippingFeeRmb)}
                          </span>
                          {row.shippingFeeSource === "actual" ? (
                            <span className="rounded bg-emerald-50 border border-emerald-100 px-1 py-0.2 text-[9px] font-black text-emerald-600 cursor-help" title="已录入实际每单运费，财务核算优先使用该金额">
                              实际
                            </span>
                          ) : (
                            <span className="rounded bg-violet-50 border border-violet-100 px-1 py-0.2 text-[9px] font-black text-violet-600 cursor-help" title="已基于发货物流公式与商品重量自动估算">
                              自动估算
                            </span>
                          )}
                        </>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingOrderId(row.order.id);
                            setEditingFeeValue(row.shippingFeeRmb > 0 ? String(row.shippingFeeRmb) : "");
                          }}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 p-1 transition"
                          title="录入/修改实际运费"
                        >
                          <Edit2 size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="money text-slate-500">{formatCurrency(row.billAmountRmb)}</td>
                <td className="money">
                  {row.isSettled ? (
                    <span className="font-bold text-indigo-700">{formatCurrency(row.actualRevenueRmb)}</span>
                  ) : (
                    <span className="text-slate-400 font-medium">未结算</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-col">
                    <span className="font-semibold text-slate-700">{row.order.logistics_method || "--"}</span>
                    <span className="text-[10px] text-slate-400 font-mono mt-0.5">{row.order.logistics_tracking_no}</span>
                  </div>
                </td>
                <td>
                  <Badge tone={row.isSettled ? "success" : "neutral"}>
                    {row.isSettled ? "已结算" : "未结算"}
                  </Badge>
                </td>
                <td>
                  <Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge>
                </td>
              </tr>
              );
            })}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-orders", paginated.page, paginated.totalPages, paginated.total)}
      </>
    );
  }

  function renderCashflow() {
    if (ledgerRows.length === 0) return <EmptyPanel label="暂无收支流水数据" />;
    const paginated = getPaginatedRows("finance-cashflow", filteredLedgerRows);
    return (
      <section className="surface-card grid gap-4 p-5">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-150 pb-4">
          <select
            value={cashflowMonth}
            onChange={(e) => setCashflowMonth(e.target.value)}
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
          >
            <option value="all">全部月份</option>
            {uniqueMonths.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <select
            value={cashflowDirection}
            onChange={(e) => setCashflowDirection(e.target.value as any)}
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
          >
            <option value="all">全部收支方向</option>
            <option value="收入">收入流水</option>
            <option value="支出">支出流水</option>
          </select>

          <select
            value={cashflowType}
            onChange={(e) => setCashflowType(e.target.value)}
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
          >
            <option value="all">全部交易类型</option>
            <option value="订单回款">订单回款</option>
            <option value="采购付款">采购付款出账</option>
            <option value="其他费用">其他杂项费用</option>
          </select>

          <span className="ml-auto rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            筛选后共 {filteredLedgerRows.length} 条记录
          </span>
        </div>

        <FinanceTable>
          <thead>
            <tr>
              <th>交易日期</th>
              <th>流水类型</th>
              <th>收支流向</th>
              <th>流水对象 / 单号</th>
              <th className="number-cell">流出/流入金额</th>
              <th>流水详情说明</th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((row, index) => (
              <tr key={`${row.date}-${row.subject}-${index}`} className="hover:bg-slate-50/50">
                <td className="text-slate-500 font-mono">{row.date}</td>
                <td className="font-semibold text-slate-700">{row.type}</td>
                <td>
                  <Badge tone={row.direction === "收入" ? "success" : "danger"}>
                    {row.direction}
                  </Badge>
                </td>
                <td className="font-bold text-slate-800">{row.subject}</td>
                <td className={`money ${row.direction === "支出" ? "text-rose-700" : "text-emerald-700"}`}>
                  {formatCurrency(Math.abs(row.amountRmb))}
                </td>
                <td className="text-slate-500 text-xs font-medium">{row.remark || "--"}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-cashflow", paginated.page, paginated.totalPages, paginated.total)}
      </section>
    );
  }

  function renderPurchases() {
    if (periodPurchases.length === 0) return <EmptyPanel label="当前时间范围暂无采购付款记录" />;
    const paginated = getPaginatedRows("finance-purchases", periodPurchases);
    return (
      <section className="surface-card grid gap-4 p-5">
        <FinanceTable>
          <thead>
            <tr>
              <th>采购订单单号</th>
              <th>采购日期</th>
              <th>收货目标仓库</th>
              <th>当前付款状态</th>
              <th className="number-cell">商品货款</th>
              <th className="number-cell">实付总金额</th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((purchase) => (
              <tr key={purchase.id} className="hover:bg-slate-50/50">
                <td className="font-bold text-slate-900">{purchase.order_code}</td>
                <td className="text-slate-500 font-mono">{formatDate(purchase.purchased_at)}</td>
                <td className="font-semibold text-slate-700">{purchase.warehouse_name}</td>
                <td>
                  <Badge tone={purchase.status === "received" ? "success" : purchase.status === "partially_received" ? "warning" : "info"}>
                    {purchase.status === "received" ? "已收齐" : purchase.status === "partially_received" ? "部分收货" : "未发货/挂起"}
                  </Badge>
                </td>
                <td className="money">{formatCurrency(Number(purchase.items_total_rmb || 0))}</td>
                <td className="money text-rose-700">{formatCurrency(getPurchaseTotalRmb(purchase))}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-purchases", paginated.page, paginated.totalPages, paginated.total)}
      </section>
    );
  }

  function MonthlyProfitChart() {
    const chartData = [...monthlyRows].reverse().slice(-6); // last 6 months
    if (chartData.length === 0) return null;

    const height = 180;
    const width = 500;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartHeight = height - padding.top - padding.bottom;
    const values = chartData.flatMap((d) => [d.income, d.cashProfit, d.orderProfit]);
    const rawMax = Math.max(0, ...values);
    const rawMin = Math.min(0, ...values);
    const maxVal = rawMax > 0 ? rawMax * 1.1 : 1000;
    const minVal = rawMin < 0 ? rawMin * 1.1 : 0;
    const totalRange = maxVal - minVal || 1;
    const yForValue = (value: number) => padding.top + chartHeight * ((maxVal - value) / totalRange);
    const y0 = yForValue(0);

    return (
      <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
        <h4 className="text-xs font-bold text-slate-400 mb-4 flex items-center gap-1.5">
          <TrendingUp size={14} className="text-emerald-500" />
          <span>近 6 个月利润分析趋势 (元)</span>
        </h4>
        <div className="relative w-full overflow-x-auto">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[450px]">
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const val = maxVal - totalRange * ratio;
              const y = yForValue(val);
              return (
                <g key={ratio} className="opacity-40">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                  <text x={padding.left - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px] font-medium font-mono">{val.toFixed(0)}</text>
                </g>
              );
            })}
            
            {/* Zero Line */}
            {minVal < 0 && (
               <line x1={padding.left} y1={y0} x2={width - padding.right} y2={y0} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 2" />
            )}

            {/* Bars */}
            {chartData.map((d, index) => {
              const xRange = width - padding.left - padding.right;
              const step = xRange / chartData.length;
              const x = padding.left + step * index + step / 2;

              const incomeValueY = yForValue(d.income);
              const incomeBarH = Math.abs(incomeValueY - y0);
              const incomeY = Math.min(incomeValueY, y0);

              const cashValueY = yForValue(d.cashProfit);
              const cashBarH = Math.abs(cashValueY - y0);
              const cashY = Math.min(cashValueY, y0);
              const cashFill = d.cashProfit >= 0 ? "#f59e0b" : "#fb7185";
              const cashHover = d.cashProfit >= 0 ? "hover:fill-amber-500" : "hover:fill-rose-500";

              const orderValueY = yForValue(d.orderProfit);
              const orderBarH = Math.abs(orderValueY - y0);
              const orderY = Math.min(orderValueY, y0);
              const orderFill = d.orderProfit >= 0 ? "#34d399" : "#fb7185";
              const orderHover = d.orderProfit >= 0 ? "hover:fill-emerald-500" : "hover:fill-rose-500";

              return (
                <g key={d.month} className="group">
                  {/* Revenue Bar (violet) */}
                  <rect
                    x={x - 17}
                    y={incomeY}
                    width={8}
                    height={Math.max(2, incomeBarH)}
                    fill="#818cf8"
                    rx={2}
                    className="transition-all duration-300 hover:fill-indigo-500"
                  >
                    <title>{`${d.month} 实际回款 ${formatCurrency(d.income)}`}</title>
                  </rect>
                  {/* Cash Profit Bar (amber or rose) */}
                  <rect
                    x={x - 4}
                    y={cashY}
                    width={8}
                    height={Math.max(2, cashBarH)}
                    fill={cashFill}
                    rx={2}
                    className={`transition-all duration-300 ${cashHover}`}
                  >
                    <title>{`${d.month} 实际现金利润 ${formatCurrency(d.cashProfit)}`}</title>
                  </rect>
                  {/* Order Profit Bar (emerald or rose) */}
                  <rect
                    x={x + 9}
                    y={orderY}
                    width={8}
                    height={Math.max(2, orderBarH)}
                    fill={orderFill}
                    rx={2}
                    className={`transition-all duration-300 ${orderHover}`}
                  >
                    <title>{`${d.month} 实际订单利润 ${formatCurrency(d.orderProfit)}`}</title>
                  </rect>
                  {/* Month Label */}
                  <text
                    x={x}
                    y={height - padding.bottom + 16}
                    textAnchor="middle"
                    className="fill-slate-500 text-[10px] font-bold"
                  >
                    {d.month}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex items-center gap-4 mt-2 justify-center text-xs font-semibold">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-indigo-400 block" />
            <span className="text-slate-500">实际回款</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-amber-400 block" />
            <span className="text-slate-500">实际现金利润</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-emerald-400 block" />
            <span className="text-slate-500">实际订单利润</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-rose-400 block" />
            <span className="text-slate-500">负数向下</span>
          </div>
        </div>
      </div>
    );
  }

  function renderMonthlyProfit() {
    if (monthlyRows.length === 0) return <EmptyPanel label="暂无月度利润利润表数据" />;
    const paginated = getPaginatedRows("finance-monthly-profit", monthlyRows);
    return (
      <div className="grid gap-5">
        <MonthlyProfitChart />

        <section className="surface-card grid gap-4 p-5">
          <h3 className="text-sm font-bold text-slate-800">月度实际利润与订单利润表</h3>
          <FinanceTable minWidth="min-w-[1160px]">
            <thead>
              <tr>
                <th>月份</th>
                <th className="number-cell">实际结算回款 (+)</th>
                <th className="number-cell">当月采购付款 (-)</th>
                <th className="number-cell">订单商品成本 (-)</th>
                <th className="number-cell">核算运费支出 (-)</th>
                <th className="number-cell">其他杂项费用 (-)</th>
                <th className="number-cell">实际现金利润</th>
                <th className="number-cell">实际订单利润 (不含库存)</th>
                <th className="number-cell">现金利润率</th>
                <th className="number-cell">订单利润率</th>
              </tr>
            </thead>
            <tbody>
              {paginated.rows.map((row) => {
                const cashMargin = calculateMarginRate(row.cashProfit, row.income);
                const orderMargin = calculateMarginRate(row.orderProfit, row.income);
                const cashClass = getSignedAmountClass(row.cashProfit);
                const orderClass = getSignedAmountClass(row.orderProfit);
                return (
                  <tr key={row.month} className="hover:bg-slate-50/50">
                    <td className="font-bold text-slate-900">{row.month}</td>
                    <td className="money text-emerald-700">{formatCurrency(row.income)}</td>
                    <td className="money text-rose-700">{formatCurrency(row.purchase)}</td>
                    <td className="money text-slate-700">{formatCurrency(row.productCost)}</td>
                    <td className="money text-slate-700">{formatCurrency(row.shipping)}</td>
                    <td className="money text-slate-700">{formatCurrency(row.otherExpense)}</td>
                    <td className={`money ${cashClass}`}>
                      {formatCurrency(row.cashProfit)}
                    </td>
                    <td className={`money ${orderClass}`}>
                      {formatCurrency(row.orderProfit)}
                    </td>
                    <td className={`number-cell font-bold ${cashClass}`}>
                      {cashMargin.toFixed(2)}%
                    </td>
                    <td className={`number-cell font-bold ${orderClass}`}>
                      {orderMargin.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </FinanceTable>
          {renderPaginationControls("finance-monthly-profit", paginated.page, paginated.totalPages, paginated.total)}
        </section>
      </div>
    );
  }

  function renderProductProfit() {
    if (productRows.length === 0) return <EmptyPanel label="暂无商品销售利润数据" />;
    const paginated = getPaginatedRows("finance-product-profit", filteredProductRows);

    const renderSortIcon = (field: typeof productSortField) => {
      if (productSortField !== field) return <span className="text-slate-300 ml-1">⇅</span>;
      return productSortOrder === "asc" ? <span className="text-violet-600 ml-1">▲</span> : <span className="text-violet-600 ml-1">▼</span>;
    };

    const handleSort = (field: typeof productSortField) => {
      if (productSortField === field) {
        setProductSortOrder((current) => (current === "asc" ? "desc" : "asc"));
      } else {
        setProductSortField(field);
        setProductSortOrder("desc");
      }
    };

    return (
      <section className="surface-card grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="relative flex items-center">
            <Search size={16} className="absolute left-3 text-slate-400" />
            <input
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="搜索商品编码或名称"
              className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-600 focus:ring-2 focus:ring-violet-600/10 sm:w-80"
            />
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            共计 {filteredProductRows.length} 款商品
          </span>
        </div>

        <FinanceTable minWidth="min-w-[1250px]" tableClassName="finance-freeze-product">
          <thead>
            <tr>
              <th>商品编码</th>
              <th>商品名称</th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("orderCount")}>
                订单量 {renderSortIcon("orderCount")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("quantity")}>
                销售件数 {renderSortIcon("quantity")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("productCost")}>
                采购总成本 {renderSortIcon("productCost")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("shipping")}>
                核算总运费 {renderSortIcon("shipping")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("billAmount")}>
                实际结算总回款 {renderSortIcon("billAmount")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("profit")}>
                实际毛利润 {renderSortIcon("profit")}
              </th>
              <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded" onClick={() => handleSort("margin")}>
                商品毛利率 {renderSortIcon("margin")}
              </th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((row) => {
              const profitClass = getSignedAmountClass(row.profit);
              return (
                <tr key={`${row.productCode}-${row.productName}`} className="hover:bg-slate-50/50">
                  <td className="font-bold text-slate-900">{row.productCode}</td>
                  <td className="text-slate-700 max-w-xs truncate font-medium" title={row.productName}>{row.productName}</td>
                  <td className="number-cell font-semibold">{row.orderCount}</td>
                  <td className="number-cell font-semibold">{row.quantity}</td>
                  <td className="money">{formatCurrency(row.productCost)}</td>
                  <td className="money">{formatCurrency(row.shipping)}</td>
                  <td className="money text-slate-900">{formatCurrency(row.billAmount)}</td>
                  <td className={`money ${profitClass}`}>
                    {formatCurrency(row.profit)}
                  </td>
                  <td className={`number-cell font-bold ${profitClass}`}>
                    {row.margin.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-product-profit", paginated.page, paginated.totalPages, paginated.total)}
      </section>
    );
  }

  function renderInventoryValue() {
    if (inventoryRows.length === 0) return <EmptyPanel label="暂无库存商品金额数据" />;
    const paginated = getPaginatedRows("finance-inventory-value", inventoryRows);

    return (
      <section className="surface-card grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-sm font-bold text-slate-800">库存商品金额（按商品 / SKU）</h3>
            <p className="mt-1 text-xs text-slate-500">当前库存余额，不随财务时间范围变化；金额 = SKU 库存数量 x SKU 单位成本。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
              商品 {inventoryTotals.productCount}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
              SKU {inventoryTotals.skuCount}
            </span>
            <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700">
              库存金额 {formatCurrency(inventoryTotals.inventoryValueRmb)}
            </span>
          </div>
        </div>

        <FinanceTable minWidth="min-w-[1180px]" tableClassName="finance-freeze-product">
          <thead>
            <tr>
              <th>商品编码</th>
              <th>商品名称</th>
              <th>SKU</th>
              <th>规格</th>
              <th className="number-cell">库存数量</th>
              <th className="number-cell">SKU 单位成本</th>
              <th className="number-cell">库存商品金额</th>
              <th>仓库分布</th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((row) => (
              <tr key={`${row.productId}-${row.skuId}`} className="hover:bg-slate-50/50">
                <td className="font-bold text-slate-900">{row.productCode}</td>
                <td className="max-w-xs truncate font-medium text-slate-700" title={row.productName}>{row.productName}</td>
                <td className="font-mono text-slate-600">{row.skuCode}</td>
                <td className="max-w-xs truncate text-slate-500" title={row.skuSpec}>{row.skuSpec}</td>
                <td className="number-cell font-semibold">{row.stockQuantity}</td>
                <td className="money">{formatCurrency(row.unitCostRmb)}</td>
                <td className="money text-sky-700">{formatCurrency(row.inventoryValueRmb)}</td>
                <td className="max-w-sm truncate text-xs font-medium text-slate-500" title={row.warehouseSummary}>{row.warehouseSummary}</td>
              </tr>
            ))}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-inventory-value", paginated.page, paginated.totalPages, paginated.total)}
      </section>
    );
  }

  function renderReconciliationTable(rows: FinanceOrderRow[]) {
    if (rows.length === 0) return <EmptyPanel label="暂无需要人工对账的订单数据" />;
    const paginated = getPaginatedRows("finance-reconciliation", rows);
    return (
      <>
        <FinanceTable minWidth="min-w-[1080px]" tableClassName="finance-freeze-reconciliation">
          <thead>
            <tr>
              <th>订单编号</th>
              <th>Temu SKU Code</th>
              <th>系统商品 SKU</th>
              <th>待处理问题</th>
              <th className="number-cell">核算运费</th>
              <th className="text-center">操作对账</th>
            </tr>
          </thead>
          <tbody>
            {paginated.rows.map((row) => {
              const issueTypes = getReconciliationIssues(row);
              const accountingStatus = getAccountingStatus(row);
              const issues = issueTypes.map((issue) => {
                if (issue === "unmatched") {
                  return (
                    <span key="unmatched" className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                      <AlertTriangle size={12} />
                      SKU 货号未匹配
                    </span>
                  );
                }
                return (
                  <span key="shipping-missing" className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                    <AlertTriangle size={12} />
                    运费缺失 (无法自动估算)
                  </span>
                );
              });

              return (
                <tr key={row.order.id} className="hover:bg-slate-50/50">
                <td className="font-semibold text-slate-800">{row.order.order_no}</td>
                <td className="font-mono text-slate-600 text-xs font-bold">{row.order.sku_code || "--"}</td>
                <td className="text-slate-700 font-medium">
                  {row.product ? (
                    <span>{row.product.product_name_cn}</span>
                  ) : (
                    <span className="text-slate-400 italic">
                      规格: {row.order.product_attributes || "--"}
                    </span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1.5">{issues}</div>
                </td>
                {/* Inline Shipping Fee Edit */}
                <td className="money">
                  {editingOrderId === row.order.id ? (
                    <div className="flex items-center gap-1 justify-end">
                      <input
                        type="number"
                        value={editingFeeValue}
                        onChange={(e) => setEditingFeeValue(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter") {
                            await handleSaveShippingFee(row.order.id, editingFeeValue);
                          } else if (e.key === "Escape") {
                            setEditingOrderId(null);
                          }
                        }}
                        disabled={savingOrderId === row.order.id}
                        className="h-8 w-20 rounded-xl border border-slate-350 bg-white px-2 text-xs outline-none text-right font-bold"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveShippingFee(row.order.id, editingFeeValue)}
                        disabled={savingOrderId === row.order.id}
                        className="rounded-lg bg-emerald-500 p-1.5 text-white hover:bg-emerald-600 transition"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingOrderId(null)}
                        disabled={savingOrderId === row.order.id}
                        className="rounded-lg bg-slate-200 p-1.5 text-slate-600 hover:bg-slate-300 transition"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 group justify-end">
                      {row.shippingFeeSource === "missing" ? (
                        <span className="text-rose-600 font-bold">缺失运费</span>
                      ) : (
                        <>
                          <span className={row.isShippingFeeEstimated ? "text-violet-600 font-semibold" : "font-bold text-slate-900"}>
                            {formatCurrency(row.shippingFeeRmb)}
                          </span>
                          {row.shippingFeeSource === "actual" ? (
                            <span className="rounded bg-emerald-50 border border-emerald-100 px-1 py-0.2 text-[9px] font-black text-emerald-600 cursor-help" title="已录入实际每单运费，财务核算优先使用该金额">
                              实际
                            </span>
                          ) : (
                            <span className="rounded bg-violet-50 border border-violet-100 px-1 py-0.2 text-[9px] font-black text-violet-600 cursor-help" title="已基于发货物流公式与商品重量自动估算">
                              自动估算
                            </span>
                          )}
                        </>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingOrderId(row.order.id);
                            setEditingFeeValue(row.shippingFeeRmb > 0 ? String(row.shippingFeeRmb) : "");
                          }}
                          className="rounded bg-sky-50 border border-sky-200 px-2 py-0.5 text-sky-600 hover:bg-sky-100 text-[10px] font-bold transition opacity-0 group-hover:opacity-100"
                        >
                          填实际
                        </button>
                      )}
                    </div>
                  )}
                </td>
                {/* SKU Matching Dropdown */}
                <td className="text-center">
                  {!row.matched ? (
                    matchingOrderId === row.order.id ? (
                      <div className="flex items-center gap-1.5 justify-center">
                        <select
                          value={matchingSkuId}
                          onChange={(e) => setMatchingSkuId(e.target.value)}
                          disabled={linkingOrderId === row.order.id}
                          className="h-8 w-44 rounded border border-slate-300 bg-white px-2 text-xs outline-none font-semibold text-slate-800"
                        >
                          <option value="">选择系统 SKU</option>
                          {groupedSkuOptions.map((group) => (
                            <optgroup key={group.product.id} label={`${group.product.product_code} · ${group.product.product_name_cn}`}>
                              {group.list.map((item) => (
                                <option key={item.sku.id} value={item.sku.id}>
                                  {item.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleLinkSkuCode(row.order.id, row.order.sku_code, matchingSkuId)}
                          disabled={linkingOrderId === row.order.id || !matchingSkuId}
                          className="rounded bg-violet-600 px-2.5 py-1 text-white hover:bg-violet-750 text-xs font-bold disabled:opacity-50"
                        >
                          关联
                        </button>
                        <button
                          type="button"
                          onClick={() => setMatchingOrderId(null)}
                          disabled={linkingOrderId === row.order.id}
                          className="rounded bg-slate-200 px-2.5 py-1 text-slate-700 hover:bg-slate-300 text-xs font-bold"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setMatchingOrderId(row.order.id);
                          setMatchingSkuId("");
                        }}
                        className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-1 text-violet-600 hover:bg-violet-100 text-xs font-bold transition"
                      >
                        关联商品 SKU
                      </button>
                    )
                  ) : accountingStatus.tone === "danger" ? (
                    <span className="text-rose-700 font-bold text-xs bg-rose-50 px-2 py-1 rounded border border-rose-100">{accountingStatus.label}</span>
                  ) : accountingStatus.tone === "warning" ? (
                    <span className="text-amber-700 font-bold text-xs bg-amber-50 px-2 py-1 rounded border border-amber-100">{accountingStatus.label}</span>
                  ) : (
                    <span className="text-emerald-600 font-bold text-xs bg-emerald-50 px-2 py-1 rounded border border-emerald-100">对账成功</span>
                  )}
                </td>
                </tr>
              );
            })}
          </tbody>
        </FinanceTable>
        {renderPaginationControls("finance-reconciliation", paginated.page, paginated.totalPages, paginated.total)}
      </>
    );
  }

  function renderReconciliation() {
    const unmatched = periodOrderRows.filter((row) => getReconciliationIssues(row).length > 0);
    return (
      <section className="surface-card grid gap-4 p-5">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">对账中心异常订单排查</h3>
          <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-600">
            共 {unmatched.length} 项待处理
          </span>
        </div>
        {renderReconciliationTable(unmatched)}
      </section>
    );
  }

  function renderExpenses() {
    const shippingTotal = totals.orderShippingFee;
    const totalOtherExpenses = periodOtherExpenses.reduce((sum, e) => sum + e.amount, 0);

    return (
      <div className="grid gap-5">
        {/* Stat summaries */}
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="订单核算总运费" value={formatCurrency(shippingTotal)} />
          <StatCard label="采购付款" value={formatCurrency(totals.purchasePayment)} />
          <StatCard label="其他扣减费用" value={formatCurrency(totalOtherExpenses)} />
        </div>

        <section className="surface-card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800">其他核算杂费记录</h3>
            <button
              type="button"
              onClick={() => setExpenseFormOpen(true)}
              disabled={!canEdit}
              className="btn-primary h-9 px-3 text-xs font-bold"
            >
              <Plus size={15} />
              新增费用
            </button>
          </div>
          {periodOtherExpenses.length === 0 ? (
            <EmptyPanel compact label="当前时间范围暂无其他核算杂费记录" />
          ) : (
            <FinanceTable minWidth="min-w-[720px]">
              <thead>
                <tr>
                  <th>交易日期</th>
                  <th>费用类别</th>
                  <th className="number-cell">扣减金额</th>
                  <th>备注详情说明</th>
                  <th className="text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {periodOtherExpenses.map((expense) => (
                  <tr key={expense.id} className="hover:bg-slate-50/50">
                    <td className="text-slate-500 font-mono">{expense.date}</td>
                    <td>
                      <Badge tone={expense.category === "ad" ? "info" : expense.category === "customs" ? "warning" : expense.category === "packaging" ? "success" : "neutral"}>
                        {categoryLabels[expense.category] || "其他"}
                      </Badge>
                    </td>
                    <td className="money text-rose-700">{formatCurrency(expense.amount)}</td>
                    <td className="text-slate-600 font-medium max-w-xs truncate" title={expense.remark}>{expense.remark || "--"}</td>
                    <td className="text-center">
                      <button
                        type="button"
                        onClick={() => handleDeleteExpense(expense.id)}
                        className="text-rose-600 hover:text-rose-800 font-semibold text-xs inline-flex items-center gap-1 transition"
                      >
                        <Trash2 size={12} />
                        <span>删除</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </FinanceTable>
          )}
        </section>

        {expenseFormOpen && (
          <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30">
            <button
              type="button"
              aria-label="关闭录入费用账单"
              className="absolute inset-0 h-full w-full cursor-default"
              onClick={() => setExpenseFormOpen(false)}
            />
            <section className="relative z-10 h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl sm:m-4 sm:h-[calc(100%-2rem)] sm:rounded-2xl">
              <div className="mb-5 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <Plus size={16} className="text-slate-400" />
                  <span>录入费用账单</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setExpenseFormOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
                  aria-label="关闭"
                >
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={handleAddExpense} className="grid gap-4">
                <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <span>交易日期</span>
                  <input
                    type="date"
                    required
                    value={expenseDate}
                    onChange={(e) => setExpenseDate(e.target.value)}
                    className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-violet-600 focus:bg-white"
                  />
                </label>

                <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <span>费用类别</span>
                  <select
                    value={expenseCategory}
                    onChange={(e) => setExpenseCategory(e.target.value as any)}
                    className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-violet-600 focus:bg-white"
                  >
                    <option value="ad">广告推广 (Ad Spend)</option>
                    <option value="customs">关税头程 (Customs/Freight)</option>
                    <option value="packaging">包装耗材 (Packaging)</option>
                    <option value="other">其他杂费 (Other Misc)</option>
                  </select>
                </label>

                <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <span>扣减金额 (元)</span>
                  <input
                    type="number"
                    step="0.01"
                    required
                    min="0.01"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    placeholder="请输入扣减金额"
                    className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-violet-600 focus:bg-white"
                  />
                </label>

                <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <span>费用说明 / 备注</span>
                  <textarea
                    value={expenseRemark}
                    onChange={(e) => setExpenseRemark(e.target.value)}
                    placeholder="录入费用详情备注..."
                    className="h-24 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm font-bold text-slate-750 outline-none transition focus:border-violet-600 focus:bg-white resize-none"
                  />
                </label>

                <button
                  type="submit"
                  disabled={!canEdit}
                  className="btn-primary h-10 w-full font-bold mt-2"
                >
                  录入该笔账单
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    );
  }

  function renderSettlement() {
    return (
      <div className="grid gap-5">
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="已导入文件数" value={String(settlementFiles.length)} />
          <StatCard label="总回款金额" value={formatCurrency(settlementLookup.summary.totalRevenue)} />
          <StatCard label="总包含单量" value={String(settlementLookup.summary.totalQuantity)} />
        </div>

        <section className="surface-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
            <h3 className="text-sm font-bold text-slate-800">结算文件管理</h3>
            <label className="btn-primary h-10 px-4 cursor-pointer text-xs font-bold inline-flex items-center gap-2">
              <Plus size={16} />
              {settlementImporting ? "解析中..." : "导入 Temu 结算文件"}
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                disabled={!canEdit || settlementImporting}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setSettlementImporting(true);
                  try {
                    const { readXlsxWorkbook } = await import("../lib/tabular-parser");
                    const workbook = await readXlsxWorkbook(file);
                    const sheet = workbook.worksheets[0];
                    if (!sheet || !sheet.data) throw new Error("文件为空");
                    const records = parseSettlementData(sheet.data);
                    if (records.length === 0) throw new Error("未解析到有效结算数据");
                    
                    const newFile = addSettlementFile(file.name, records);
                    const allFiles = loadSettlementFiles();
                    setSettlementFiles(allFiles);
                    alert(`成功导入 ${records.length} 条结算记录！\n总回款：${formatCurrency(newFile.totalRevenue)}`);
                  } catch (err) {
                    alert("导入失败: " + getErrorMessage(err, "请确保选择的是 SettledParentFlow 导出文件"));
                  } finally {
                    setSettlementImporting(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </div>

          {settlementFiles.length === 0 ? (
            <EmptyPanel label="暂未导入任何结算文件" />
          ) : (
            <FinanceTable minWidth="min-w-[800px]">
              <thead>
                <tr>
                  <th>导入时间</th>
                  <th>文件名</th>
                  <th>数据日期范围</th>
                  <th className="number-cell">包含记录数</th>
                  <th className="number-cell">文件总回款</th>
                  <th className="text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {settlementFiles.map((file) => (
                  <tr key={file.id} className="hover:bg-slate-50/50">
                    <td className="text-slate-500 font-mono text-xs">{new Date(file.importedAt).toLocaleString()}</td>
                    <td className="font-bold text-slate-800 text-xs">{file.fileName}</td>
                    <td className="text-slate-600 font-medium text-xs">{formatDateRange(file.dateRangeStart, file.dateRangeEnd)}</td>
                    <td className="number-cell font-semibold">{file.recordCount}</td>
                    <td className="money text-emerald-700">{formatCurrency(file.totalRevenue)}</td>
                    <td className="text-center">
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm("确定删除该结算文件？\n删除后相关的财务利润和对账状态将重新计算。")) return;
                          deleteSettlementFile(file.id);
                          setSettlementFiles(loadSettlementFiles());
                        }}
                        className="text-rose-600 hover:text-rose-800 font-semibold text-xs inline-flex items-center gap-1 transition"
                      >
                        <Trash2 size={12} />
                        <span>删除</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </FinanceTable>
          )}
        </section>
      </div>
    );
  }

  function renderLedgerWorkbench() {
    return (
      <div className="grid gap-5">
        {renderCashflow()}
        {renderPurchases()}
        {renderExpenses()}
      </div>
    );
  }

  function renderProfitWorkbench() {
    return (
      <div className="grid gap-5">
        {renderMonthlyProfit()}
        {renderProductProfit()}
        {renderInventoryValue()}
      </div>
    );
  }

  function renderSettlementWorkbench() {
    return (
      <div className="grid gap-5">
        {renderSettlement()}
        {renderReconciliation()}
        {renderOrderIncome()}
      </div>
    );
  }

  function renderCurrentView() {
    if (loading) {
      return (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm text-slate-500">
          加载中...
        </div>
      );
    }

    switch (view) {
      case "ledger":
        return renderLedgerWorkbench();
      case "profit":
        return renderProfitWorkbench();
      case "settlement":
        return renderSettlementWorkbench();
      case "overview":
      default:
        return renderOverview();
    }
  }

  return (
    <section className="grid gap-5">
      <PageHeader
        title={currentView.label}
        description={currentView.description}
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || loading}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={18} />
            刷新
          </button>
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-col items-start gap-5">
        <div className="grid w-full min-w-0 flex-1 gap-4">
          {renderPeriodControls()}
          {renderCurrentView()}
        </div>
      </div>
    </section>
  );
}
