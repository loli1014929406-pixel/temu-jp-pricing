import type { User } from "@supabase/supabase-js";
import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, StatCard, Badge } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  getReconciliationIssues,
  getAccountingStatus,
  calculateFinanceTotals,
  formatCurrency,
  calculateMarginRate,
  getOrderSku,
  getOrderQuantity,
  getSkuUnitCostRmb,
  estimateOrderShippingFee,
  roundMoney,
  buildSkuLookup,
  getResolvedSettlementMetrics,
} from "./shared";
import { buildSettlementLookup } from "../../lib/settlement";

type Props = {
  user: User;
};

export function FinanceOverviewPage({ user }: Props) {
  const { data, expenses, settlementFiles, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    purchases: true,
    products: true,
    inventory: true,
    expenses: true,
    settlements: true,
  });

  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles), [settlementFiles]);

  const productItemsById = useMemo(() => new Map<string, any>(data.productItems.map((item: any) => [item.id!, item])), [data.productItems]);
  const productsById = useMemo(() => new Map<string, any>(data.products.map((product: any) => [product.id, product])), [data.products]);
  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);
  const skusById = useMemo(() => new Map(data.productSkus.map((sku: any) => [sku.id!, sku])), [data.productSkus]);

  const orderRows = useMemo(() => {
    return data.orders.map((order: any) => {
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      const quantity = getOrderQuantity(order);
      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      const productCostRmb = roundMoney(unitCost * quantity);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const shippingFeeSource = (actualShippingFeeRmb > 0 ? "actual" : estimatedShippingRmb > 0 ? "estimated" : "missing") as "actual" | "estimated" | "missing";
      const shippingFeeRmb = roundMoney(shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedShippingRmb);
      
      const { actualSalesRevenueRmb, actualFreightRevenueRmb, isSettled, matchType } = getResolvedSettlementMetrics(order, quantity, settlementLookup);

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
    });
  }, [data.orders, productItemsById, productsById, skuLookup, settings, settlementLookup]);

  const totals = useMemo(() => calculateFinanceTotals(orderRows, data.purchases), [orderRows, data.purchases]);

  const totalOtherExpenses = useMemo(() => expenses.reduce((sum, e) => sum + e.amount_rmb, 0), [expenses]);
  
  const inventoryValueRmb = useMemo(() => {
    return data.warehouseSkus.reduce((sum: any, stock: any) => {
      const quantity = Math.max(0, Number(stock.stock_quantity || 0));
      if (quantity <= 0) return sum;
      const sku = skusById.get(stock.sku_id);
      if (!sku) return sum;
      return sum + quantity * roundMoney(getSkuUnitCostRmb(sku, productItemsById));
    }, 0);
  }, [data.warehouseSkus, skusById, productItemsById]);

  const cashProfit = totals.actualRevenueAmount - totals.purchasePayment - totals.orderShippingFee - totalOtherExpenses;
  const orderProfit = totals.actualRevenueAmount - totals.orderProductCost - totals.orderShippingFee - totalOtherExpenses;
  const cashMarginRate = calculateMarginRate(cashProfit, totals.actualRevenueAmount);
  const orderMarginRate = calculateMarginRate(orderProfit, totals.actualRevenueAmount);
  const isCashLoss = cashProfit < 0;
  const isOrderLoss = orderProfit < 0;

  const pendingReconciliations = useMemo(() => {
    return orderRows.filter((row: any) => getReconciliationIssues(row).length > 0).slice(0, 5);
  }, [orderRows]);

  return (
    <section className="grid gap-5">
      <PageHeader
        title="财务总览"
        description="集中查看回款、成本、费用、利润和待处理对账风险"
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

      {loading && orderRows.length === 0 ? (
        <EmptyPanel label="加载中..." />
      ) : (
        <div className="flex flex-col items-start gap-5">
          <div className="grid w-full min-w-0 flex-1 gap-4">
            
            {/* Stat Cards Grid */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
              <StatCard label="实际结算总回款" value={formatCurrency(totals.actualRevenueAmount)} />
              <StatCard label="订单核算总运费" value={formatCurrency(totals.orderShippingFee)} />
              <StatCard label="订单商品成本" value={formatCurrency(totals.orderProductCost)} />
              <StatCard label="当前库存商品金额" value={formatCurrency(inventoryValueRmb)} />
              <StatCard label="期间采购付款" value={formatCurrency(totals.purchasePayment)} />
              <StatCard label="其他扣减费用" value={formatCurrency(totalOtherExpenses)} />
            </div>

            {/* Net Profit and Margin overview */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className={`col-span-1 md:col-span-2 rounded-2xl border border-slate-100 p-6 text-white shadow-lg ${
                isOrderLoss ? "bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/20" : "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/20"
              }`}>
                <div className={`text-xs font-bold uppercase tracking-wider ${isOrderLoss ? "text-rose-100" : "text-emerald-100"}`}>实际订单利润（经营层）</div>
                <div className="mt-2 text-3xl font-black tabular-nums">{formatCurrency(orderProfit)}</div>
                <div className={`mt-3 border-t ${isOrderLoss ? "border-rose-400/30" : "border-emerald-400/30"} pt-3 flex items-center gap-2`}>
                   <span className="text-sm font-semibold">本期采购占用资金 {formatCurrency(totals.purchasePayment)}</span>
                   <span className={`px-2 py-0.5 rounded text-xs font-bold ${isOrderLoss ? "bg-rose-400/20 text-rose-50" : "bg-emerald-400/20 text-emerald-50"}`}>
                     现金利润 {formatCurrency(cashProfit)}
                   </span>
                </div>
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
                    <span className="text-3xl font-black tabular-nums text-slate-800">{orderRows.length - totals.unsettledCount}</span>
                    <span className="text-sm font-semibold text-slate-400">/ {orderRows.length} 笔已结算</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">预估待结金额</span>
                    <span className="font-bold text-slate-700">{formatCurrency(totals.estimatedBillAmount - totals.actualRevenueAmount)}</span>
                  </div>
                  <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-violet-500 rounded-full" style={{ width: `${orderRows.length > 0 ? ((orderRows.length - totals.unsettledCount) / orderRows.length) * 100 : 0}%` }} />
                  </div>
                </div>
              </div>
            </div>

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
                      />
                      <div
                        style={{ width: `${(totals.orderShippingFee / totals.actualRevenueAmount) * 100}%` }}
                        className="bg-sky-400 transition-all duration-300"
                      />
                      <div
                        style={{ width: `${(totalOtherExpenses / totals.actualRevenueAmount) * 100}%` }}
                        className="bg-rose-400 transition-all duration-300"
                      />
                      {orderProfit > 0 && (
                        <div
                          style={{ width: `${(orderProfit / totals.actualRevenueAmount) * 100}%` }}
                          className="bg-emerald-500 transition-all duration-300"
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
              
              {pendingReconciliations.length === 0 ? (
                 <EmptyPanel label="暂无需要人工对账的订单数据" />
              ) : (
                <FinanceTable minWidth="min-w-[800px]" tableClassName="finance-freeze-reconciliation">
                  <thead>
                    <tr>
                      <th>订单编号</th>
                      <th>Temu SKU Code</th>
                      <th>系统商品 SKU</th>
                      <th className="text-center">对账状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingReconciliations.map((row: any) => {
                      const accountingStatus = getAccountingStatus(row);
                      return (
                        <tr key={row.order.id} className="hover:bg-slate-50/50">
                          <td className="font-semibold text-slate-800">{row.order.order_no}</td>
                          <td className="font-mono text-slate-600 text-xs font-bold">{row.order.sku_code || "--"}</td>
                          <td className="text-slate-700 font-medium">
                            {row.product ? row.product.product_name_cn : <span className="text-slate-400 italic">规格: {row.order.product_attributes || "--"}</span>}
                          </td>
                          <td className="text-center">
                            <Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </FinanceTable>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
