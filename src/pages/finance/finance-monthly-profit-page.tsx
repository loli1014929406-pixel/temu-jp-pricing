import type { User } from "@supabase/supabase-js";
import { useMemo, useState } from "react";
import { TrendingUp, RefreshCw } from "lucide-react";
import { PageHeader } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  getPaginatedRows,
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
  getResolvedSettlementMetrics
} from "./shared";
import { buildSettlementLookup } from "../../lib/settlement";

type Props = {
  user: User;
};

export function FinanceMonthlyProfitPage({ user }: Props) {
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

  const [page, setPage] = useState(1);

  const monthlyRows = useMemo(() => {
    const monthlyData = new Map<
      string,
      {
        month: string;
        income: number;
        purchase: number;
        productCost: number;
        shipping: number;
        otherExpense: number;
      }
    >();

    const getMonthlyObj = (monthKey: string) => {
      if (!monthlyData.has(monthKey)) {
        monthlyData.set(monthKey, { month: monthKey, income: 0, purchase: 0, productCost: 0, shipping: 0, otherExpense: 0 });
      }
      return monthlyData.get(monthKey)!;
    };

    // Settlement Income (Actual Revenue)
    data.orders.forEach((order: any) => {
      const quantity = getOrderQuantity(order);
      const { actualSalesRevenueRmb, actualFreightRevenueRmb } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      const actualRevenueRmb = roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);

      if (actualRevenueRmb > 0) {
         // 使用订单发货时间作为收入归属月份，如果没有则使用创建时间
         const date = order.actual_ship_time || order.latest_ship_time || order.created_at;
         const obj = getMonthlyObj(getMonthKey(date));
         obj.income += actualRevenueRmb;
      }

      // Order Cost & Shipping
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      const orderQty = getOrderQuantity(order);
      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      const productCostRmb = unitCost * orderQty;
      
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const shippingFeeRmb = actualShippingFeeRmb > 0 ? actualShippingFeeRmb : estimatedShippingRmb;

      if (productCostRmb > 0 || shippingFeeRmb > 0) {
        const date = order.actual_ship_time || order.latest_ship_time || order.created_at;
        const obj = getMonthlyObj(getMonthKey(date));
        obj.productCost += productCostRmb;
        obj.shipping += shippingFeeRmb;
      }
    });

    // Purchase Payment
    data.purchases.forEach((purchase: any) => {
      const obj = getMonthlyObj(getMonthKey(formatDate(purchase.purchased_at)));
      obj.purchase += getPurchaseTotalRmb(purchase);
    });

    // Other Expenses
    expenses.forEach((expense) => {
      const obj = getMonthlyObj(getMonthKey(expense.expense_date));
      obj.otherExpense += expense.amount_rmb;
    });

    return Array.from(monthlyData.values())
      .sort((a: any, b: any) => b.month.localeCompare(a.month))
      .map((m) => {
        const cashProfit = roundMoney(m.income - m.purchase - m.shipping - m.otherExpense);
        const orderProfit = roundMoney(m.income - m.productCost - m.shipping - m.otherExpense);
        return {
          ...m,
          income: roundMoney(m.income),
          purchase: roundMoney(m.purchase),
          productCost: roundMoney(m.productCost),
          shipping: roundMoney(m.shipping),
          otherExpense: roundMoney(m.otherExpense),
          cashProfit,
          orderProfit,
        };
      });
  }, [data.orders, data.purchases, expenses, productItemsById, productsById, skuLookup, settings, settlementLookup]);

  const paginated = getPaginatedRows("finance-monthly-profit", monthlyRows, page);

  const MonthlyProfitChart = () => {
    const chartData = [...monthlyRows].reverse().slice(-6); // last 6 months
    if (chartData.length === 0) return null;

    const height = 180;
    const width = 500;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartHeight = height - padding.top - padding.bottom;
    const values = chartData.flatMap((d) => [d.income, d.orderProfit]);
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

              const orderValueY = yForValue(d.orderProfit);
              const orderBarH = Math.abs(orderValueY - y0);
              const orderY = Math.min(orderValueY, y0);
              const orderFill = d.orderProfit >= 0 ? "#34d399" : "#fb7185";
              const orderHover = d.orderProfit >= 0 ? "hover:fill-emerald-500" : "hover:fill-rose-500";

              return (
                <g key={d.month} className="group">
                  <rect x={x - 10} y={incomeY} width={10} height={Math.max(2, incomeBarH)} fill="#818cf8" rx={2} className="transition-all duration-300 hover:fill-indigo-500">
                    <title>{`${d.month} 实际回款 ${formatCurrency(d.income)}\n(现金利润: ${formatCurrency(d.cashProfit)})`}</title>
                  </rect>
                  <rect x={x + 4} y={orderY} width={10} height={Math.max(2, orderBarH)} fill={orderFill} rx={2} className={`transition-all duration-300 ${orderHover}`}>
                    <title>{`${d.month} 实际订单利润 ${formatCurrency(d.orderProfit)}`}</title>
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
          <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-emerald-400 block" /><span className="text-slate-500">实际订单利润</span></div>
          <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-rose-400 block" /><span className="text-slate-500">负数向下</span></div>
        </div>
      </div>
    );
  };

  return (
    <section className="grid gap-5">
      <PageHeader
        title="月度利润表"
        description="基于当月产生的所有收支计算的财务成果。"
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

      {loading && monthlyRows.length === 0 ? (
        <EmptyPanel label="加载中..." />
      ) : monthlyRows.length === 0 ? (
        <EmptyPanel label="暂无月度利润利润表数据" />
      ) : (
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
                {paginated.rows.map((row: any) => {
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
                      <td className={`money ${cashClass}`}>{formatCurrency(row.cashProfit)}</td>
                      <td className={`money ${orderClass}`}>{formatCurrency(row.orderProfit)}</td>
                      <td className={`number-cell font-bold ${cashClass}`}>{cashMargin.toFixed(2)}%</td>
                      <td className={`number-cell font-bold ${orderClass}`}>{orderMargin.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </FinanceTable>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-xs text-slate-500">
               <span>共 {paginated.total} 条，第 {paginated.page} / {paginated.totalPages} 页</span>
               <div className="flex items-center gap-1.5">
                  <button onClick={() => setPage(p => p - 1)} disabled={paginated.page <= 1} className="btn-secondary h-8 px-3">上一页</button>
                  <button onClick={() => setPage(p => p + 1)} disabled={paginated.page >= paginated.totalPages} className="btn-secondary h-8 px-3">下一页</button>
               </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
