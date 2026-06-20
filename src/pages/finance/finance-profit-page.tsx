import type { User } from "@supabase/supabase-js";
import { useMemo, useState } from "react";
import { TrendingUp, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  getPaginatedRows,
  renderPaginationControls,
  formatCurrency,
  calculateMarginRate,
  getSignedAmountClass,
  getOrderSku,
  getOrderQuantity,
  getSkuUnitCostRmb,
  estimateOrderShippingFee,
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

export function FinanceProfitPage({ user }: Props) {
  const { data, expenses, settlementFiles, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    purchases: true,
    products: true,
    expenses: true,
    settlements: true,
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
            className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600 focus:ring-1 focus:ring-violet-600"
          />
        )}

        {period.mode === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={period.start}
              onChange={(e) => setPeriod({ ...period, start: e.target.value })}
              className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600 focus:ring-1 focus:ring-violet-600"
            />
            <span className="text-slate-400">-</span>
            <input
              type="date"
              value={period.end}
              onChange={(e) => setPeriod({ ...period, end: e.target.value })}
              className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs outline-none focus:border-violet-600 focus:ring-1 focus:ring-violet-600"
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
        otherExpense: number;
      }
    >();

    const getMonthlyObj = (monthKey: string) => {
      if (!monthlyData.has(monthKey)) {
        monthlyData.set(monthKey, { month: monthKey, settledIncome: 0, estimatedIncome: 0, purchase: 0, productCost: 0, shipping: 0, otherExpense: 0 });
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
      
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const shippingFeeRmb = actualShippingFeeRmb > 0 ? actualShippingFeeRmb : estimatedShippingRmb;

      const billAmountRmb = roundMoney(productCostRmb + shippingFeeRmb); // Simplified billAmount for estimation
      
      const obj = getMonthlyObj(getMonthKey(date));
      obj.settledIncome += actualRevenueRmb;
      obj.estimatedIncome += isSettled ? actualRevenueRmb : billAmountRmb;

      if (productCostRmb > 0 || shippingFeeRmb > 0) {
        obj.productCost += productCostRmb;
        obj.shipping += shippingFeeRmb;
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
        const cashProfit = roundMoney(m.settledIncome - m.purchase - m.shipping - m.otherExpense);
        const orderProfit = roundMoney(m.estimatedIncome - m.productCost - m.shipping - m.otherExpense);
        return {
          ...m,
          settledIncome: roundMoney(m.settledIncome),
          estimatedIncome: roundMoney(m.estimatedIncome),
          purchase: roundMoney(m.purchase),
          productCost: roundMoney(m.productCost),
          shipping: roundMoney(m.shipping),
          otherExpense: roundMoney(m.otherExpense),
          cashProfit,
          orderProfit,
        };
      });
  }, [data.orders, data.purchases, expenses, productItemsById, productsById, skuLookup, settings, settlementLookup, period]);

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

      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      obj.shipping += actualShippingFeeRmb > 0 ? actualShippingFeeRmb : estimatedShippingRmb;

      const { actualSalesRevenueRmb, actualFreightRevenueRmb } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      obj.actualRevenue += roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);
    });

    return Array.from(productData.values()).map((p: any) => {
      const profit = p.actualRevenue - p.productCost - p.shipping;
      const margin = calculateMarginRate(profit, p.actualRevenue);
      return { ...p, profit, margin };
    });
  }, [data.orders, productItemsById, productsById, skuLookup, settings, settlementLookup, period]);

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
    const chartData = [...monthlyRows].reverse().slice(-6); // last 6 months
    if (chartData.length === 0) return null;

    const height = 180;
    const width = 500;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartHeight = height - padding.top - padding.bottom;
    const values = chartData.flatMap((d) => [d.settledIncome, d.orderProfit]);
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

              const incomeValueY = yForValue(d.settledIncome);
              const incomeBarH = Math.abs(incomeValueY - y0);
              const incomeY = Math.min(incomeValueY, y0);

              const orderValueY = yForValue(d.orderProfit);
              const orderBarH = Math.abs(orderValueY - y0);
              const orderY = Math.min(orderValueY, y0);
              const orderFill = d.orderProfit >= 0 ? "#34d399" : "#fb7185";
              const orderHover = d.orderProfit >= 0 ? "hover:fill-emerald-500" : "hover:fill-rose-500";

              return (
                <g key={d.month} className="group">
                  <rect x={x - 10} y={incomeY} width={10} height={Math.max(2, incomeBarH)} fill="#818cf8" rx={2} className="transition-all duration-300 hover:fill-indigo-500">
                    <title>{`${d.month} 实际回款 ${formatCurrency(d.settledIncome)}\n(现金利润: ${formatCurrency(d.cashProfit)})`}</title>
                  </rect>
                  <rect x={x + 4} y={orderY} width={10} height={Math.max(2, orderBarH)} fill={orderFill} rx={2} className={`transition-all duration-300 ${orderHover}`}>
                    <title>{`${d.month} 订单口径利润 ${formatCurrency(d.orderProfit)}`}</title>
                  </rect>
                  <text x={x} y={height - padding.bottom + 16} textAnchor="middle" className="fill-slate-500 text-[10px] font-bold">
                    {d.month}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex items-center gap-4 mt-2 justify-center text-xs font-semibold">
          <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-indigo-400 block" /><span className="text-slate-500">实际回款</span></div>
          <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-emerald-400 block" /><span className="text-slate-500">订单口径利润</span></div>
          <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-rose-400 block" /><span className="text-slate-500">负数向下</span></div>
        </div>
      </div>
    );
  };

  return (
    <section className="grid gap-5">
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
      <div className="flex items-center gap-6 border-b border-slate-200 px-1">
        <button
          onClick={() => setActiveTab("monthly")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "monthly" ? "border-b-2 border-violet-600 text-violet-700" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          月度利润
        </button>
        <button
          onClick={() => setActiveTab("product")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "product" ? "border-b-2 border-violet-600 text-violet-700" : "text-slate-500 hover:text-slate-800"
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

              <section className="grid gap-4">
                <h3 className="text-sm font-bold text-slate-800">月度实际利润与订单利润表</h3>
                <FinanceTable minWidth="min-w-[1160px]">
                  <thead>
                    <tr>
                      <th>月份</th>
                      <th className="number-cell">实际结算回款 (+)</th>
                      <th className="number-cell" title="对未结算订单使用核算账单金额进行收入估算，对齐所有已发出订单成本。">
                        订单口径预估回款 (+)
                      </th>
                      <th className="number-cell">当月采购付款 (-)</th>
                      <th className="number-cell">订单商品成本 (-)</th>
                      <th className="number-cell">核算运费支出 (-)</th>
                      <th className="number-cell">其他杂项费用 (-)</th>
                      <th className="number-cell">实际现金利润</th>
                      <th className="number-cell" title="所有已发出订单的(估算回款 - 商品成本 - 运费 - 杂费)">
                        订单口径利润
                      </th>
                      <th className="number-cell">现金利润率</th>
                      <th className="number-cell">订单利润率</th>
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
                          <td className="money text-emerald-700">{formatCurrency(row.settledIncome)}</td>
                          <td className="money text-indigo-700">{formatCurrency(row.estimatedIncome)}</td>
                          <td className="money text-rose-700">{formatCurrency(row.purchase)}</td>
                          <td className="money text-slate-700">{formatCurrency(row.productCost)}</td>
                          <td className="money text-slate-700">{formatCurrency(row.shipping)}</td>
                          <td className="money text-slate-700">{formatCurrency(row.otherExpense)}</td>
                          <td className={`money ${cashClass}`}>{formatCurrency(row.cashProfit)}</td>
                          <td className={`money ${orderClass}`}>{formatCurrency(row.orderProfit)}</td>
                          <td className={`number-cell font-bold ${cashClass}`}>{cashMargin.toFixed(2)}%</td>
                          <td className={`number-cell font-bold ${orderClass}`}>{orderMargin.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </FinanceTable>
                {renderPaginationControls(
                  "monthly",
                  paginatedMonthly.page,
                  paginatedMonthly.totalPages,
                  paginatedMonthly.total,
                  setMonthlyPage,
                  monthlyPageSize,
                  setMonthlyPageSize
                )}
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
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-2">
                <div className="relative flex items-center">
                  <Search size={16} className="absolute left-3 text-slate-400" />
                  <input
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setProductPage(1); }}
                    placeholder="搜索商品编码或名称"
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-600 focus:ring-1 focus:ring-violet-600 sm:w-80"
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
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("orderCount"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      订单量 {productSortField === "orderCount" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("quantity"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      销售件数 {productSortField === "quantity" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("productCost"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      采购总成本 {productSortField === "productCost" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("shipping"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      核算总运费 {productSortField === "shipping" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("actualRevenue"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      实际结算总回款 {productSortField === "actualRevenue" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("profit"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
                      实际毛利润 {productSortField === "profit" ? (productSortOrder === "asc" ? "▲" : "▼") : "⇅"}
                    </th>
                    <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => { setProductSortField("margin"); setProductSortOrder(o => o === "asc" ? "desc" : "asc"); setProductPage(1); }}>
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
                        <td className="text-slate-700 max-w-xs truncate font-medium" title={row.productName}>{row.productName}</td>
                        <td className="number-cell font-semibold">{row.orderCount}</td>
                        <td className="number-cell font-semibold">{row.quantity}</td>
                        <td className="money">{formatCurrency(row.productCost)}</td>
                        <td className="money">{formatCurrency(row.shipping)}</td>
                        <td className="money text-slate-900">{formatCurrency(row.actualRevenue)}</td>
                        <td className={`money ${profitClass}`}>{formatCurrency(row.profit)}</td>
                        <td className={`number-cell font-bold ${profitClass}`}>{row.margin.toFixed(2)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </FinanceTable>
              {renderPaginationControls(
                "product",
                paginatedProduct.page,
                paginatedProduct.totalPages,
                paginatedProduct.total,
                setProductPage,
                productPageSize,
                setProductPageSize
              )}
            </div>
          )
        )}
      </div>
    </section>
  );
}
