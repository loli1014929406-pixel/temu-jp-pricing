import type { User } from "@supabase/supabase-js";
import { useMemo } from "react";
import { RefreshCw, TrendingUp, AlertCircle, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
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
      
      const { actualSalesRevenueRmb, actualFreightRevenueRmb, isSettled } = getResolvedSettlementMetrics(order, quantity, settlementLookup);

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
  
  const pendingReconciliations = useMemo(() => {
    return orderRows.filter((row: any) => getReconciliationIssues(row).length > 0).slice(0, 5);
  }, [orderRows]);

  return (
    <section className="grid gap-6">
      <PageHeader
        title="财务总览"
        description="集中查看核心指标、资金健康状态和待处理财务事项"
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
        <div className="grid gap-6">
          {/* Level 1: Core Metrics */}
          <section>
            <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
              <TrendingUp size={16} className="text-violet-600" />
              核心财务指标
            </h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard label="总销售结算回款" value={formatCurrency(totals.actualRevenueAmount)} />
              <StatCard label="订单商品总成本" value={formatCurrency(totals.orderProductCost)} />
              <StatCard label="订单核算总运费" value={formatCurrency(totals.orderShippingFee)} />
              <StatCard label="其他扣减杂费" value={formatCurrency(totalOtherExpenses)} />
            </div>
          </section>

          {/* Level 2: Cash Health */}
          <section>
            <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <span className="text-[10px] font-black">¥</span>
              </div>
              资金与利润健康
            </h2>
            <div className="grid gap-4 lg:grid-cols-3">
              {/* Cash Flow Profit */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">整体现金利润</div>
                <div className={`text-3xl font-black tabular-nums ${cashProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {formatCurrency(cashProfit)}
                </div>
                <div className="mt-3 text-xs font-medium text-slate-500 space-y-1">
                  <div className="flex justify-between"><span>+ 销售回款</span> <span className="text-slate-800">{formatCurrency(totals.actualRevenueAmount)}</span></div>
                  <div className="flex justify-between"><span>- 采购付款</span> <span className="text-slate-800">{formatCurrency(totals.purchasePayment)}</span></div>
                  <div className="flex justify-between"><span>- 核算运费</span> <span className="text-slate-800">{formatCurrency(totals.orderShippingFee)}</span></div>
                  <div className="flex justify-between"><span>- 其他杂费</span> <span className="text-slate-800">{formatCurrency(totalOtherExpenses)}</span></div>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-100 flex justify-between items-center text-xs">
                  <span className="text-slate-500 font-semibold">现金回款率</span>
                  <span className={`font-bold ${cashProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{cashMarginRate.toFixed(2)}%</span>
                </div>
              </div>

              {/* Order Based Profit */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">订单核算利润</div>
                <div className={`text-3xl font-black tabular-nums ${orderProfit >= 0 ? "text-violet-600" : "text-rose-600"}`}>
                  {formatCurrency(orderProfit)}
                </div>
                <div className="mt-3 text-xs font-medium text-slate-500 space-y-1">
                  <div className="flex justify-between"><span>+ 销售回款</span> <span className="text-slate-800">{formatCurrency(totals.actualRevenueAmount)}</span></div>
                  <div className="flex justify-between"><span>- 商品成本</span> <span className="text-slate-800">{formatCurrency(totals.orderProductCost)}</span></div>
                  <div className="flex justify-between"><span>- 核算运费</span> <span className="text-slate-800">{formatCurrency(totals.orderShippingFee)}</span></div>
                  <div className="flex justify-between"><span>- 其他杂费</span> <span className="text-slate-800">{formatCurrency(totalOtherExpenses)}</span></div>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-100 flex justify-between items-center text-xs">
                  <span className="text-slate-500 font-semibold">订单利润率</span>
                  <span className={`font-bold ${orderProfit >= 0 ? "text-violet-600" : "text-rose-600"}`}>{orderMarginRate.toFixed(2)}%</span>
                </div>
              </div>

              {/* Assets & Settlement Status */}
              <div className="grid grid-rows-2 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-center">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">当前存货资产估值</div>
                  <div className="text-2xl font-black tabular-nums text-slate-800">{formatCurrency(inventoryValueRmb)}</div>
                  <p className="text-[10px] text-slate-400 mt-1">基于当前实时库存及入库批次成本加权计算</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-center">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">预估待结金额</div>
                  <div className="text-2xl font-black tabular-nums text-indigo-600">{formatCurrency(totals.estimatedBillAmount - totals.actualRevenueAmount)}</div>
                  <div className="mt-2 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${orderRows.length > 0 ? ((orderRows.length - totals.unsettledCount) / orderRows.length) * 100 : 0}%` }} />
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1 text-right">{orderRows.length - totals.unsettledCount} / {orderRows.length} 笔订单已结</p>
                </div>
              </div>
            </div>
          </section>

          {/* Level 3: Action Items */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <AlertCircle size={16} className="text-rose-500" />
                待处理行动项
              </h2>
              <Link to="/finance/settlement" className="text-xs font-semibold text-violet-600 hover:text-violet-700 flex items-center gap-1 transition-colors">
                前往对账中心处理 <ArrowRight size={14} />
              </Link>
            </div>
            
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="bg-slate-50 px-5 py-3 border-b border-slate-100 flex items-center gap-4">
                 <Badge tone={totals.unmatchedCount > 0 ? "danger" : "success"}>未匹配商品: {totals.unmatchedCount} 单</Badge>
                 <Badge tone={totals.missingShippingFeeCount > 0 ? "warning" : "success"}>缺失运费: {totals.missingShippingFeeCount} 单</Badge>
              </div>
              
              {pendingReconciliations.length === 0 ? (
                 <div className="p-8 text-center text-slate-500 font-semibold text-sm">
                   太棒了！所有订单对账正常，暂无需要处理的异常。
                 </div>
              ) : (
                <FinanceTable minWidth="min-w-[800px]" tableClassName="finance-freeze-reconciliation">
                  <thead>
                    <tr>
                      <th>异常订单号</th>
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
            </div>
          </section>

        </div>
      )}
    </section>
  );
}
