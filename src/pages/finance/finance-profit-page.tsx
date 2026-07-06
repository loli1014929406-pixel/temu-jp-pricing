import type { User } from "@supabase/supabase-js";
import { useMemo, useState, useEffect } from "react";
import { TrendingUp, RefreshCw, Search, Truck, ReceiptText, PackageCheck } from "lucide-react";
import { PageHeader, StandardTable, TableCellPreview } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  EmptyPanel,
  FinanceTable,
  getPaginatedRows,
  formatCurrency,
  calculateMarginRate,
  getSignedAmountClass,
  getOrderSku,
  getOrderQuantity,
  getSkuUnitCostRmb,
  estimateOrderShippingBreakdown,
  roundMoney,
  getMonthKey,
  formatDate,
  getPurchaseTotalRmb,
  buildSkuLookup,
  getResolvedSettlementMetrics,
  isDateInPeriod,
  type FinancePeriod,
  type FinancePeriodMode,
  getCurrentMonthInputValue,
  getMonthStart,
  getMonthEnd,
  getTodayInputValue
} from "./shared";
import { buildSettlementLookup } from "../../lib/settlement";

type Props = {
  user: User;
};

const PROFIT_CHART_TARGET_TICKS = 5;
const PROFIT_CHART_MIN_PADDING = 100;

type ProfitSeriesKey = "cashProfit" | "orderProfit";

const profitChartSeries: Array<{
  key: ProfitSeriesKey;
  label: string;
  color: string;
}> = [
  { key: "cashProfit", label: "结算口径现金利润", color: "#6366f1" },
  { key: "orderProfit", label: "发货口径利润", color: "#10b981" },
];

type ShippingMethodRow = {
  method: string;
  orderCount: number;
  quantity: number;
  actualShipping: number;
  estimatedShipping: number;
  totalShipping: number;
  missingShippingCount: number;
  averagePerOrder: number;
  averagePerItem: number;
};

const financeProductProfitColumns = [
  { key: "product_code", width: "9rem" },
  { key: "product_name", width: "18rem" },
  { key: "order_count", width: "8rem" },
  { key: "quantity", width: "8rem" },
  { key: "product_cost", width: "10rem" },
  { key: "shipping", width: "10rem" },
  { key: "revenue", width: "11rem" },
  { key: "profit", width: "10rem" },
  { key: "margin", width: "9rem" },
] as const;

function normalizeAxisValue(value: number) {
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  return Number(normalized.toFixed(10));
}

function getNiceAxisStep(roughStep: number) {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2.5) return 2.5 * magnitude;
  if (normalized <= 6) return 5 * magnitude;
  return 10 * magnitude;
}

function buildProfitChartAxis(values: number[]) {
  const finiteValues = values.filter(Number.isFinite);
  const dataMin = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const dataMax = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;
  const hasNegative = dataMin < 0;
  const hasPositive = dataMax > 0;

  const span = Math.max(dataMax - dataMin, Math.abs(dataMax), Math.abs(dataMin), 1);
  const padding = Math.max(span * 0.1, PROFIT_CHART_MIN_PADDING);
  const paddedMin = hasNegative ? dataMin - padding : hasPositive ? 0 : -padding;
  const paddedMax = hasPositive ? dataMax + padding : hasNegative ? 0 : padding;
  const roughStep = (paddedMax - paddedMin) / Math.max(1, PROFIT_CHART_TARGET_TICKS - 1);
  const step = getNiceAxisStep(roughStep);
  const minVal = normalizeAxisValue(Math.floor(paddedMin / step) * step);
  const maxVal = normalizeAxisValue(Math.ceil(paddedMax / step) * step);
  const ticks: number[] = [];

  for (let tick = minVal; tick <= maxVal + step / 2; tick += step) {
    ticks.push(normalizeAxisValue(tick));
  }

  if (!ticks.includes(0)) {
    ticks.push(0);
    ticks.sort((a, b) => a - b);
  }

  return { minVal, maxVal, ticks };
}

function formatChartTick(value: number) {
  if (Math.abs(value) < 1e-9) return "0";
  if (Math.abs(value) >= 100 || Number.isInteger(value)) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatCompactCurrency(value: number) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 10000) return `${sign}¥${(abs / 10000).toFixed(1)}万`;
  if (abs >= 1000) return `${sign}¥${abs.toFixed(0)}`;
  if (abs >= 100) return `${sign}¥${abs.toFixed(0)}`;
  return `${sign}¥${abs.toFixed(2)}`;
}

function formatShare(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return "0.00%";
  return `${((value / total) * 100).toFixed(2)}%`;
}

function getShippingMethodLabel(value: unknown) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ");
  return label || "未填写发货方式";
}

export function FinanceProfitPage({ user }: Props) {
  const { data, expenses, settlementFiles, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    purchases: true,
    products: true,
    expenses: true,
    settlements: true,
    logistics: true,
  });

  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles || []), [settlementFiles]);

  const productItemsById = useMemo(() => new Map<string, any>(data.productItems.map((item: any) => [item.id!, item])), [data.productItems]);
  const productsById = useMemo(() => new Map<string, any>(data.products.map((product: any) => [product.id, product])), [data.products]);
  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);

  const [activeTab, setActiveTab] = useState<"monthly" | "product">("monthly");

  // Pagination states
  const [monthlyPage, setMonthlyPage] = useState(1);
  const [monthlyPageSize, setMonthlyPageSize] = useState(20);

  const [productPage, setProductPage] = useState(1);
  const [productPageSize, setProductPageSize] = useState(20);

  useEffect(() => {
    setMonthlyPage(1);
  }, [monthlyPageSize]);

  useEffect(() => {
    setProductPage(1);
  }, [productPageSize]);

  // Period controls
  const [period, setPeriod] = useState<FinancePeriod>({
    mode: "month",
    start: getMonthStart(getCurrentMonthInputValue()),
    end: getMonthEnd(getCurrentMonthInputValue()),
    label: getCurrentMonthInputValue(),
  });

  const handlePeriodModeChange = (mode: FinancePeriodMode) => {
    if (mode === "all") {
      setPeriod({ mode, start: "", end: "", label: "全部数据" });
    } else if (mode === "month") {
      const month = getCurrentMonthInputValue();
      setPeriod({ mode, start: getMonthStart(month), end: getMonthEnd(month), label: month });
    } else {
      setPeriod({ mode, start: getMonthStart(getCurrentMonthInputValue()), end: getTodayInputValue(), label: "自定义" });
    }
    setMonthlyPage(1);
    setProductPage(1);
  };

  const renderPeriodControls = () => {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => handlePeriodModeChange("month")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${period.mode === "month" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            按月
          </button>
          <button
            onClick={() => handlePeriodModeChange("custom")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${period.mode === "custom" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            自定义
          </button>
          <button
            onClick={() => handlePeriodModeChange("all")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${period.mode === "all" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            全部
          </button>
        </div>

        {period.mode === "month" && (
          <input
            type="month"
            value={period.label}
            onChange={(e) => {
              const month = e.target.value;
              setPeriod({ mode: "month", start: getMonthStart(month), end: getMonthEnd(month), label: month });
            }}
            className="h-8 rounded-md border border-line bg-white px-3 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        )}

        {period.mode === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={period.start}
              onChange={(e) => setPeriod({ ...period, start: e.target.value })}
              className="h-8 rounded-md border border-line bg-white px-3 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <span className="text-slate-400">-</span>
            <input
              type="date"
              value={period.end}
              onChange={(e) => setPeriod({ ...period, end: e.target.value })}
              className="h-8 rounded-md border border-line bg-white px-3 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
        )}

        {period.mode === "all" && (
          <span className="text-xs text-slate-400 font-medium px-2">统计全部历史数据</span>
        )}
      </div>
    );
  };

  // Monthly Profit Logic
  const monthlyRows = useMemo(() => {
    const monthlyData = new Map<
      string,
      {
        month: string;
        settledIncome: number;
        estimatedIncome: number;
        purchase: number;
        productCost: number;
        shipping: number;
        cashShipping: number;
        otherExpense: number;
      }
    >();

    const getMonthlyObj = (monthKey: string) => {
      if (!monthlyData.has(monthKey)) {
        monthlyData.set(monthKey, { month: monthKey, settledIncome: 0, estimatedIncome: 0, purchase: 0, productCost: 0, shipping: 0, cashShipping: 0, otherExpense: 0 });
      }
      return monthlyData.get(monthKey)!;
    };

    data.orders.forEach((order: any) => {
      const date = order.actual_ship_time || order.latest_ship_time || order.created_at;
      if (period.mode !== "all" && !isDateInPeriod(date, period)) return;

      const quantity = getOrderQuantity(order);
      const { actualSalesRevenueRmb, actualFreightRevenueRmb, isSettled } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      const actualRevenueRmb = roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);

      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      const productCostRmb = unitCost * quantity;
      const shipping = estimateOrderShippingBreakdown({
        order,
        product,
        settings,
        logisticsMethods: data.logisticsMethods,
        warehouseLogisticsMethods: data.warehouseLogisticsMethods,
      });

      const billAmountRmb = roundMoney(productCostRmb + shipping.shippingFeeRmb); // Simplified billAmount for estimation
      
      const obj = getMonthlyObj(getMonthKey(date));
      obj.settledIncome += actualRevenueRmb;
      obj.estimatedIncome += isSettled ? actualRevenueRmb : billAmountRmb;

      if (productCostRmb > 0 || shipping.shippingFeeRmb > 0) {
        obj.productCost += productCostRmb;
        obj.shipping += shipping.shippingFeeRmb;
        obj.cashShipping += shipping.cashShippingFeeRmb;
      }
    });

    data.purchases.forEach((purchase: any) => {
      const date = formatDate(purchase.purchased_at);
      if (period.mode !== "all" && !isDateInPeriod(date, period)) return;
      const obj = getMonthlyObj(getMonthKey(date));
      obj.purchase += getPurchaseTotalRmb(purchase);
    });

    expenses.forEach((expense) => {
      const date = expense.expense_date;
      if (period.mode !== "all" && !isDateInPeriod(date, period)) return;
      const obj = getMonthlyObj(getMonthKey(date));
      obj.otherExpense += expense.amount_rmb;
    });

    return Array.from(monthlyData.values())
      .sort((a: any, b: any) => b.month.localeCompare(a.month))
      .map((m) => {
        const cashProfit = roundMoney(m.settledIncome - m.purchase - m.cashShipping - m.otherExpense);
        const orderProfit = roundMoney(m.estimatedIncome - m.productCost - m.shipping - m.otherExpense);
        return {
          ...m,
          settledIncome: roundMoney(m.settledIncome),
          estimatedIncome: roundMoney(m.estimatedIncome),
          purchase: roundMoney(m.purchase),
          productCost: roundMoney(m.productCost),
          shipping: roundMoney(m.shipping),
          cashShipping: roundMoney(m.cashShipping),
          otherExpense: roundMoney(m.otherExpense),
          cashProfit,
          orderProfit,
        };
      });
  }, [
    data.orders,
    data.purchases,
    data.logisticsMethods,
    data.warehouseLogisticsMethods,
    expenses,
    productItemsById,
    productsById,
    skuLookup,
    settings,
    settlementLookup,
    period,
  ]);

  const shippingMethodRows = useMemo<ShippingMethodRow[]>(() => {
    const shippingData = new Map<string, ShippingMethodRow>();

    const getShippingObj = (method: string) => {
      if (!shippingData.has(method)) {
        shippingData.set(method, {
          method,
          orderCount: 0,
          quantity: 0,
          actualShipping: 0,
          estimatedShipping: 0,
          totalShipping: 0,
          missingShippingCount: 0,
          averagePerOrder: 0,
          averagePerItem: 0,
        });
      }
      return shippingData.get(method)!;
    };

    data.orders.forEach((order: any) => {
      const date = order.actual_ship_time || order.latest_ship_time || order.created_at;
      if (period.mode !== "all" && !isDateInPeriod(date, period)) return;

      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      const quantity = getOrderQuantity(order);
      const shipping = estimateOrderShippingBreakdown({
        order,
        product,
        settings,
        logisticsMethods: data.logisticsMethods,
        warehouseLogisticsMethods: data.warehouseLogisticsMethods,
      });
      const method = getShippingMethodLabel(order.logistics_method);
      const obj = getShippingObj(method);

      obj.orderCount += 1;
      obj.quantity += quantity;

      if (shipping.shippingFeeSource === "actual") {
        obj.actualShipping += shipping.lastLegShippingRmb;
        obj.estimatedShipping += shipping.firstLegShippingRmb;
        obj.totalShipping += shipping.shippingFeeRmb;
      } else if (shipping.shippingFeeSource === "estimated") {
        obj.estimatedShipping += shipping.shippingFeeRmb;
        obj.totalShipping += shipping.shippingFeeRmb;
      } else {
        obj.estimatedShipping += shipping.firstLegShippingRmb;
        obj.totalShipping += shipping.firstLegShippingRmb;
        obj.missingShippingCount += 1;
      }
    });

    return Array.from(shippingData.values())
      .map((row) => {
        const totalShipping = roundMoney(row.totalShipping);
        const actualShipping = roundMoney(row.actualShipping);
        const estimatedShipping = roundMoney(row.estimatedShipping);
        return {
          ...row,
          quantity: roundMoney(row.quantity),
          actualShipping,
          estimatedShipping,
          totalShipping,
          averagePerOrder: row.orderCount > 0 ? roundMoney(totalShipping / row.orderCount) : 0,
          averagePerItem: row.quantity > 0 ? roundMoney(totalShipping / row.quantity) : 0,
        };
      })
      .sort((a, b) => b.totalShipping - a.totalShipping);
  }, [
    data.orders,
    data.logisticsMethods,
    data.warehouseLogisticsMethods,
    productsById,
    settings,
    skuLookup,
    period,
  ]);

  const shippingMethodSummary = useMemo(() => {
    return shippingMethodRows.reduce(
      (summary, row) => ({
        totalShipping: roundMoney(summary.totalShipping + row.totalShipping),
        actualShipping: roundMoney(summary.actualShipping + row.actualShipping),
        estimatedShipping: roundMoney(summary.estimatedShipping + row.estimatedShipping),
        orderCount: summary.orderCount + row.orderCount,
        quantity: roundMoney(summary.quantity + row.quantity),
        missingShippingCount: summary.missingShippingCount + row.missingShippingCount,
      }),
      {
        totalShipping: 0,
        actualShipping: 0,
        estimatedShipping: 0,
        orderCount: 0,
        quantity: 0,
        missingShippingCount: 0,
      },
    );
  }, [shippingMethodRows]);

  const paginatedMonthly = getPaginatedRows("finance-monthly-profit", monthlyRows, monthlyPage, monthlyPageSize);

  // Product Profit Logic
  const [productSearch, setProductSearch] = useState("");
  const [productSortField, setProductSortField] = useState<"orderCount" | "quantity" | "productCost" | "shipping" | "actualRevenue" | "profit" | "margin">("profit");
  const [productSortOrder, setProductSortOrder] = useState<"asc" | "desc">("desc");

  const productRows = useMemo(() => {
    const productData = new Map<
      string,
      {
        productCode: string;
        productName: string;
        orderCount: number;
        quantity: number;
        productCost: number;
        shipping: number;
        actualRevenue: number;
      }
    >();

    const getProductObj = (productCode: string, productName: string) => {
      const key = `${productCode}-${productName}`;
      if (!productData.has(key)) {
        productData.set(key, {
          productCode: productCode || "未知商品",
          productName: productName || "未匹配商品",
          orderCount: 0,
          quantity: 0,
          productCost: 0,
          shipping: 0,
          actualRevenue: 0,
        });
      }
      return productData.get(key)!;
    };

    data.orders.forEach((order: any) => {
      const date = order.actual_ship_time || order.latest_ship_time || order.created_at;
      if (period.mode !== "all" && !isDateInPeriod(date, period)) return;

      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      
      const pCode = product?.product_code ?? order.sku_code;
      const pName = product?.product_name_cn ?? order.product_attributes;
      const obj = getProductObj(pCode, pName);

      obj.orderCount += 1;
      const quantity = getOrderQuantity(order);
      obj.quantity += quantity;

      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      obj.productCost += unitCost * quantity;

      const shipping = estimateOrderShippingBreakdown({
        order,
        product,
        settings,
        logisticsMethods: data.logisticsMethods,
        warehouseLogisticsMethods: data.warehouseLogisticsMethods,
      });
      obj.shipping += shipping.shippingFeeRmb;

      const { actualSalesRevenueRmb, actualFreightRevenueRmb } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      obj.actualRevenue += roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);
    });

    return Array.from(productData.values()).map((p: any) => {
      const profit = p.actualRevenue - p.productCost - p.shipping;
      const margin = calculateMarginRate(profit, p.actualRevenue);
      return { ...p, profit, margin };
    });
  }, [
    data.orders,
    data.logisticsMethods,
    data.warehouseLogisticsMethods,
    productItemsById,
    productsById,
    skuLookup,
    settings,
    settlementLookup,
    period,
  ]);

  const filteredProductRows = useMemo(() => {
    let result = productRows;
    if (productSearch.trim()) {
      const q = productSearch.toLowerCase();
      result = result.filter(
        (r: any) => r.productCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q),
      );
    }
    result.sort((a: any, b: any) => {
      const vA = a[productSortField];
      const vB = b[productSortField];
      if (typeof vA === "number" && typeof vB === "number") {
        return productSortOrder === "asc" ? vA - vB : vB - vA;
      }
      return 0;
    });
    return result;
  }, [productRows, productSearch, productSortField, productSortOrder]);

  const paginatedProduct = getPaginatedRows("finance-product-profit", filteredProductRows, productPage, productPageSize);

  const MonthlyProfitChart = () => {
    const chartData = [...monthlyRows].reverse().slice(-6);
    if (chartData.length === 0) return null;

    const latest = chartData[chartData.length - 1];
    const height = 260;
    const width = 720;
    const padding = { top: 34, right: 28, bottom: 48, left: 72 };
    const chartHeight = height - padding.top - padding.bottom;
    const values = chartData.flatMap((d) => [d.cashProfit, d.orderProfit]);
    const { minVal, maxVal, ticks } = buildProfitChartAxis(values);
    const totalRange = maxVal - minVal || 1;
    const yForValue = (value: number) => padding.top + chartHeight * ((maxVal - value) / totalRange);
    const y0 = yForValue(0);
    const title = chartData.length > 1 ? "近 6 个月利润分析趋势 (元)" : "所选月份利润分析 (元)";
    const latestCashMargin = calculateMarginRate(latest.cashProfit, latest.settledIncome);
    const latestOrderMargin = calculateMarginRate(latest.orderProfit, latest.estimatedIncome);

    return (
      <div className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
              <TrendingUp size={16} className="text-accent" />
              <span>{title}</span>
            </h4>
            <p className="mt-1 text-xs text-slate-400">柱子低于 0 轴即为亏损，颜色仍对应原利润口径。</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-semibold">
            {profitChartSeries.map((series) => (
              <div key={series.key} className="flex items-center gap-1.5">
                <span className="block h-3 w-3 rounded-sm" style={{ backgroundColor: series.color }} />
                <span className="text-slate-600">{series.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid border-y border-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-slate-100">
          <div className="py-3 sm:pr-4">
            <div className="text-xs font-semibold text-slate-500">结算口径现金利润</div>
            <div className={`mt-1 text-xl font-bold ${getSignedAmountClass(latest.cashProfit)}`}>
              {formatCurrency(latest.cashProfit)}
            </div>
            <div className="mt-1 text-xs text-slate-400">利润率 {latestCashMargin.toFixed(2)}%</div>
          </div>
          <div className="border-t border-slate-100 py-3 sm:border-t-0 sm:pl-4">
            <div className="text-xs font-semibold text-slate-500">发货口径利润</div>
            <div className={`mt-1 text-xl font-bold ${getSignedAmountClass(latest.orderProfit)}`}>
              {formatCurrency(latest.orderProfit)}
            </div>
            <div className="mt-1 text-xs text-slate-400">利润率 {latestOrderMargin.toFixed(2)}%</div>
          </div>
        </div>

        <div className="relative mt-4 w-full overflow-x-auto">
          <svg viewBox={`0 0 ${width} ${height}`} className="h-[330px] min-w-[680px] w-full">
            {ticks.map((val) => {
              const y = yForValue(val);
              return (
                <g key={val} className="opacity-40">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                  <text x={padding.left - 10} y={y + 4} textAnchor="end" className="fill-slate-400 text-[11px] font-medium font-mono">
                    {formatChartTick(val)}
                  </text>
                </g>
              );
            })}
            <line x1={padding.left} y1={y0} x2={width - padding.right} y2={y0} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="3 3" />

            {chartData.map((d, index) => {
              const xRange = width - padding.left - padding.right;
              const step = xRange / chartData.length;
              const x = padding.left + step * index + step / 2;
              const barWidth = Math.min(26, Math.max(14, step / 7));
              const gap = Math.max(6, barWidth * 0.45);

              return (
                <g key={d.month}>
                  {profitChartSeries.map((series, seriesIndex) => {
                    const value = series.key === "cashProfit" ? d.cashProfit : d.orderProfit;
                    const revenue = series.key === "cashProfit" ? d.settledIncome : d.estimatedIncome;
                    const primaryCost = series.key === "cashProfit" ? d.purchase : d.productCost;
                    const primaryCostLabel = series.key === "cashProfit" ? "当月采购付款" : "订单商品成本";
                    const valueY = yForValue(value);
                    const barHeight = Math.abs(valueY - y0);
                    const barY = Math.min(valueY, y0);
                    const barX = x + (seriesIndex === 0 ? -barWidth - gap / 2 : gap / 2);
                    const labelY = value >= 0 ? Math.max(12, barY - 6) : Math.min(height - padding.bottom - 4, barY + barHeight + 14);

                    return (
                      <g key={series.key}>
                        <rect
                          x={barX}
                          y={barY}
                          width={barWidth}
                          height={Math.max(3, barHeight)}
                          fill={series.color}
                          opacity={value < 0 ? 0.68 : 0.92}
                          stroke={value < 0 ? "#e11d48" : "transparent"}
                          strokeWidth={value < 0 ? 1 : 0}
                          rx={3}
                          className="transition-opacity hover:opacity-100"
                        >
                          <title>{`${d.month} ${series.label}: ${formatCurrency(value)}
收入: ${formatCurrency(revenue)}
${primaryCostLabel}: ${formatCurrency(primaryCost)}
核算运费支出: ${formatCurrency(d.shipping)}
其他杂项费用: ${formatCurrency(d.otherExpense)}`}</title>
                        </rect>
                        <text
                          x={barX + barWidth / 2}
                          y={labelY}
                          textAnchor="middle"
                          className="fill-slate-500 text-[10px] font-semibold"
                        >
                          {formatCompactCurrency(value)}
                        </text>
                      </g>
                    );
                  })}
                  <text x={x} y={height - padding.bottom + 28} textAnchor="middle" className="fill-slate-600 text-[12px] font-bold">
                    {d.month}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    );
  };

  const ShippingMethodAnalysis = () => {
    if (shippingMethodRows.length === 0) return null;

    const topRows = shippingMethodRows.slice(0, 6);
    const maxShipping = Math.max(...topRows.map((row) => row.totalShipping), 1);

    return (
      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
              <Truck size={16} className="text-accent" />
              <span>发货方式运费分析</span>
            </h4>
            <p className="mt-1 text-xs text-slate-400">按当前时间范围统计，实际运费优先；没有实际运费时使用页面核算估算值。</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            共 {shippingMethodRows.length} 种发货方式
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 border-y border-slate-100 py-3">
            <ReceiptText size={18} className="text-indigo-500" />
            <div>
              <div className="text-xs font-semibold text-slate-500">当月总运费</div>
              <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(shippingMethodSummary.totalShipping)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 border-y border-slate-100 py-3">
            <PackageCheck size={18} className="text-emerald-500" />
            <div>
              <div className="text-xs font-semibold text-slate-500">实际录入运费</div>
              <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(shippingMethodSummary.actualShipping)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 border-y border-slate-100 py-3">
            <Truck size={18} className="text-amber-500" />
            <div>
              <div className="text-xs font-semibold text-slate-500">自动估算运费</div>
              <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(shippingMethodSummary.estimatedShipping)}</div>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(320px,0.85fr)_minmax(560px,1.15fr)]">
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between text-xs font-bold text-slate-500">
              <span>运费占比 Top {topRows.length}</span>
              <span>实际 / 估算</span>
            </div>
            <div className="grid gap-3">
              {topRows.map((row) => {
                const totalWidth = row.totalShipping > 0 ? Math.max(2, (row.totalShipping / maxShipping) * 100) : 0;
                const actualShare = row.totalShipping > 0 ? (row.actualShipping / row.totalShipping) * 100 : 0;
                const estimatedShare = row.totalShipping > 0 ? (row.estimatedShipping / row.totalShipping) * 100 : 0;
                return (
                  <div key={row.method} className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate font-semibold text-slate-700" title={row.method}>{row.method}</span>
                      <span className="money shrink-0 font-bold text-slate-900">{formatCurrency(row.totalShipping)}</span>
                    </div>
                    <div className="h-4 overflow-hidden rounded bg-slate-100">
                      <div className="flex h-full rounded" style={{ width: `${totalWidth}%` }}>
                        <span className="h-full bg-indigo-500" style={{ width: `${actualShare}%` }} />
                        <span className="h-full bg-amber-400" style={{ width: `${estimatedShare}%` }} />
                      </div>
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>{formatShare(row.totalShipping, shippingMethodSummary.totalShipping)}</span>
                      <span>{row.orderCount} 单 / {row.quantity} 件</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <FinanceTable minWidth="min-w-[860px]">
            <thead>
              <tr>
                <th>发货方式</th>
                <th className="number-cell px-3 py-2">订单数</th>
                <th className="number-cell px-3 py-2">件数</th>
                <th className="number-cell px-3 py-2">实际运费</th>
                <th className="number-cell px-3 py-2">估算运费</th>
                <th className="number-cell px-3 py-2">总运费</th>
                <th className="number-cell px-3 py-2">单均</th>
                <th className="number-cell px-3 py-2">件均</th>
                <th className="number-cell px-3 py-2">缺失</th>
              </tr>
            </thead>
            <tbody>
              {shippingMethodRows.map((row) => (
                <tr key={row.method} className="hover:bg-slate-50/50">
                  <td className="font-semibold text-slate-800" data-full-text={row.method}>
                    <TableCellPreview
                      label="发货方式"
                      value={row.method}
                      lines={1}
                      alwaysShowDetail
                      detailTitle="发货方式"
                    />
                  </td>
                  <td className="number-cell font-semibold px-3 py-2">{row.orderCount}</td>
                  <td className="number-cell font-semibold px-3 py-2">{row.quantity}</td>
                  <td className="money px-3 py-2 text-indigo-700">{formatCurrency(row.actualShipping)}</td>
                  <td className="money px-3 py-2 text-amber-700">{formatCurrency(row.estimatedShipping)}</td>
                  <td className="money px-3 py-2 font-bold text-slate-900">{formatCurrency(row.totalShipping)}</td>
                  <td className="money px-3 py-2">{formatCurrency(row.averagePerOrder)}</td>
                  <td className="money px-3 py-2">{formatCurrency(row.averagePerItem)}</td>
                  <td className={`number-cell px-3 py-2 font-semibold ${row.missingShippingCount > 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {row.missingShippingCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </FinanceTable>
        </div>
      </section>
    );
  };

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="利润报表"
        description="基于收支结算数据与业务核算逻辑的财务利润。"
        actions={
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => void reload()}>
            <RefreshCw size={18} />
            刷新
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b border-line px-1">
        <button
          onClick={() => setActiveTab("monthly")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "monthly" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          月度利润
        </button>
        <button
          onClick={() => setActiveTab("product")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "product" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          商品利润
        </button>
      </div>

      <div className="surface-card p-5">
        <div className="mb-4">
          {renderPeriodControls()}
        </div>

        {activeTab === "monthly" && (
          loading && monthlyRows.length === 0 ? (
            <EmptyPanel label="加载中..." />
          ) : monthlyRows.length === 0 ? (
            <EmptyPanel label="该时间段内暂无月度利润利润表数据" />
          ) : (
            <div className="grid gap-5">
              <MonthlyProfitChart />
              <ShippingMethodAnalysis />

              <section className="grid gap-4">
                <h3 className="text-sm font-bold text-slate-800">月度实际利润与订单利润表</h3>
                <StandardTable 
                  minWidth="min-w-[1160px]"
                  page={paginatedMonthly.page}
                  pageSize={monthlyPageSize}
                  totalPages={paginatedMonthly.totalPages}
                  totalRecordCount={paginatedMonthly.total}
                  onPageChange={setMonthlyPage}
                  onPageSizeChange={setMonthlyPageSize}
                >
                  <thead>
                    <tr>
                      <th className="bg-slate-50">月份</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">实际结算回款 (+)</th>
                      <th className="number-cell bg-slate-50 px-3 py-2" title="对未结算订单使用核算账单金额进行收入估算，对齐所有已发出订单成本。">
                        订单口径预估回款 (+)
                      </th>
                      <th className="number-cell bg-slate-50 px-3 py-2">当月采购付款 (-)</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">订单商品成本 (-)</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">核算运费支出 (-)</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">其他杂项费用 (-)</th>
                      <th className="number-cell px-3 py-2" title="仅统计已导入结算文件匹配到的订单的(实际回款 - 采购 - 运费 - 杂费)">结算口径现金利润</th>
                      <th className="number-cell px-3 py-2" title="所有已发出订单的(估算回款 - 商品成本 - 运费 - 杂费)">
                        发货口径利润
                      </th>
                      <th className="number-cell px-3 py-2">结算口径现金利润率</th>
                      <th className="number-cell px-3 py-2">发货口径利润率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMonthly.rows.map((row: any) => {
                      const cashMargin = calculateMarginRate(row.cashProfit, row.settledIncome);
                      const orderMargin = calculateMarginRate(row.orderProfit, row.estimatedIncome);
                      const cashClass = getSignedAmountClass(row.cashProfit);
                      const orderClass = getSignedAmountClass(row.orderProfit);
                      return (
                        <tr key={row.month} className="hover:bg-slate-50/50">
                          <td className="font-bold text-slate-900">{row.month}</td>
                          <td className="money text-emerald-700 px-3 py-2">{formatCurrency(row.settledIncome)}</td>
                          <td className="money text-indigo-700 px-3 py-2">{formatCurrency(row.estimatedIncome)}</td>
                          <td className="money text-rose-700 px-3 py-2">{formatCurrency(row.purchase)}</td>
                          <td className="money text-slate-700 px-3 py-2">{formatCurrency(row.productCost)}</td>
                          <td className="money text-slate-700 px-3 py-2">{formatCurrency(row.shipping)}</td>
                          <td className="money text-slate-700 px-3 py-2">{formatCurrency(row.otherExpense)}</td>
                          <td className={`money ${cashClass} px-3 py-2`}>{formatCurrency(row.cashProfit)}</td>
                          <td className={`money ${orderClass} px-3 py-2`}>{formatCurrency(row.orderProfit)}</td>
                          <td className={`number-cell font-bold ${cashClass} px-3 py-2`}>{cashMargin.toFixed(2)}%</td>
                          <td className={`number-cell font-bold ${orderClass} px-3 py-2`}>{orderMargin.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </StandardTable>
              </section>
            </div>
          )
        )}

        {activeTab === "product" && (
          loading && productRows.length === 0 ? (
            <EmptyPanel label="加载中..." />
          ) : productRows.length === 0 ? (
            <EmptyPanel label="该时间段内暂无商品销售利润数据" />
          ) : (
            <section className="flex flex-col gap-4 min-h-[350px]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-2">
                <div className="relative flex items-center">
                  <Search size={16} className="absolute left-3 text-slate-400" />
                  <input
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setProductPage(1); }}
                    placeholder="搜索商品编码或名称"
                    className="h-9 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:w-80"
                  />
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
                  共计 {filteredProductRows.length} 款商品
                </span>
              </div>
              <StandardTable 
                minWidth="min-w-[1250px]"
                columns={financeProductProfitColumns}
                layout="fixed"
                page={paginatedProduct.page}
                pageSize={productPageSize}
                totalPages={paginatedProduct.totalPages}
                totalRecordCount={paginatedProduct.total}
                onPageChange={setProductPage}
                onPageSizeChange={setProductPageSize}
              >
                <thead>
                  <tr>
                    <th>商品编码</th>
                    <th>商品名称</th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("orderCount"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      订单量 {productSortField === "orderCount" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("quantity"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      销售件数 {productSortField === "quantity" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("productCost"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      采购总成本 {productSortField === "productCost" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("shipping"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      核算总运费 {productSortField === "shipping" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("actualRevenue"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      实际结算总回款 {productSortField === "actualRevenue" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("profit"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      实际毛利润 {productSortField === "profit" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none px-3 py-2" onClick={() => { setProductSortField("margin"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      商品毛利率 {productSortField === "margin" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedProduct.rows.map((row: any) => {
                    const profitClass = getSignedAmountClass(row.profit);
                    return (
                      <tr key={`${row.productCode}-${row.productName}`} className="hover:bg-slate-50/50">
                        <td className="font-bold text-slate-900">{row.productCode}</td>
                        <td className="text-slate-700 font-medium" data-full-text={row.productName}>
                          <TableCellPreview
                            label="商品名称"
                            value={row.productName}
                            lines={2}
                            alwaysShowDetail
                            detailTitle="商品利润详情名称"
                            detailSubtitle={row.productCode}
                          />
                        </td>
                        <td className="number-cell font-semibold px-3 py-2">{row.orderCount}</td>
                        <td className="number-cell font-semibold px-3 py-2">{row.quantity}</td>
                        <td className="money px-3 py-2">{formatCurrency(row.productCost)}</td>
                        <td className="money px-3 py-2">{formatCurrency(row.shipping)}</td>
                        <td className="money text-slate-900 px-3 py-2">{formatCurrency(row.actualRevenue)}</td>
                        <td className={`money ${profitClass} px-3 py-2`}>{formatCurrency(row.profit)}</td>
                        <td className={`number-cell font-bold ${profitClass} px-3 py-2`}>{row.margin.toFixed(2)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </StandardTable>
            </section>
          )
        )}
      </div>
    </section>
  );
}
