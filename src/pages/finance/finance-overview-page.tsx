import type { User } from "@supabase/supabase-js";
import { useMemo } from "react";
import { RefreshCw, TrendingUp, AlertCircle, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader, Badge, StandardTable } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  EmptyPanel,
  getAccountingStatus,
  formatCurrency,
  calculateMarginRate,
  getPurchaseTotalRmb,
} from "./shared";
import { useFinanceAnalysis } from "./use-finance-analysis";

type Props = {
  user: User;
};

export function FinanceOverviewPage({ user }: Props) {
  const { data, expenses, loading: baseLoading, error: baseError, reload: reloadBase } = useFinanceData(user.id, {
    purchases: true,
    expenses: true,
  });
  const analysis = useFinanceAnalysis({ page: 1, pageSize: 1 });
  const issues = useFinanceAnalysis({ page: 1, pageSize: 5, issue: "reconciliation" });
  const orderRows = issues.rows;
  const purchasePayment = useMemo(() => data.purchases.reduce((sum, row) => sum + getPurchaseTotalRmb(row), 0), [data.purchases]);
  const totals = {
    estimatedBillAmount: analysis.summary.bill,
    actualRevenueAmount: analysis.summary.actualRevenue,
    orderShippingFee: analysis.summary.shipping,
    cashOrderShippingFee: analysis.summary.cashShipping,
    orderProductCost: analysis.summary.productCost,
    purchasePayment,
    missingShippingFeeCount: analysis.summary.missingShippingAttentionCount,
    unmatchedCount: analysis.summary.unmatchedCount,
    unsettledCount: analysis.summary.unsettledCount,
  };

  const totalOtherExpenses = useMemo(() => expenses.reduce((sum, e) => sum + e.amount_rmb, 0), [expenses]);
  
  const cashProfit = totals.actualRevenueAmount - totals.purchasePayment - totals.cashOrderShippingFee - totalOtherExpenses;
  const orderProfit = totals.actualRevenueAmount - totals.orderProductCost - totals.orderShippingFee - totalOtherExpenses;
  const cashMarginRate = calculateMarginRate(cashProfit, totals.actualRevenueAmount);
  
  const pendingReconciliations = orderRows;
  const loading = baseLoading || analysis.loading || issues.loading;
  const error = baseError || analysis.error || issues.error;
  const reload = async () => { await Promise.all([reloadBase(), analysis.reload(), issues.reload()]); };

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
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
          {/* Area A: Core Metrics */}
          <section>
            <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
              <TrendingUp size={16} className="text-accent" />
              本期核心指标
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">实际结算回款</div>
                <div className="text-3xl font-black tabular-nums text-slate-800">{formatCurrency(totals.actualRevenueAmount)}</div>
                <p className="mt-2 text-xs text-slate-400 font-medium">全部历史数据</p>
              </div>
              <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">发货口径利润（估算）</div>
                <div className={`text-3xl font-black tabular-nums ${orderProfit >= 0 ? "text-accent" : "text-rose-600"}`}>
                  {formatCurrency(orderProfit)}
                </div>
                <p className="mt-2 text-xs text-slate-400 font-medium">含未结算订单估算</p>
              </div>
              <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">结算口径利润率</div>
                <div className={`text-3xl font-black tabular-nums ${cashMarginRate >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {cashMarginRate.toFixed(1)}%
                </div>
                <p className="mt-2 text-xs text-slate-400 font-medium">已结算订单口径</p>
              </div>
            </div>
          </section>

          {/* Area B: Cash & Settlement Status */}
          <section>
            <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <span className="text-[10px] font-black">¥</span>
              </div>
              资金与结算状态
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-line bg-white p-6 shadow-sm flex flex-col justify-center">
                <div className="flex items-baseline gap-3 mb-2">
                  <span className="text-sm font-bold text-slate-500">现金利润</span>
                  <span className={`text-2xl font-black tabular-nums ${cashProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatCurrency(cashProfit)}
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-medium">本期采购占用资金 {formatCurrency(totals.purchasePayment - totals.orderProductCost)} （当期付款 - 订单成本）</p>
              </div>
              
              <Link to="/finance/settlement" className="rounded-2xl border border-line bg-white p-6 shadow-sm flex flex-col justify-center hover:border-accent transition-colors group">
                <div className="flex items-center justify-between mb-2">
                   <div className="text-sm font-bold text-slate-500 group-hover:text-accent transition-colors flex items-center gap-1">
                     结算进度 <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                   </div>
                   <div className="text-sm font-bold text-slate-800 tabular-nums">{analysis.summary.settledCount} / {analysis.summary.orderCount} 笔</div>
                </div>
                <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden mb-2">
                  <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${analysis.summary.orderCount > 0 ? (analysis.summary.settledCount / analysis.summary.orderCount) * 100 : 0}%` }} />
                </div>
                <p className="text-xs text-slate-400 font-medium">待回款估算 <span className="text-accent font-bold">{formatCurrency(totals.estimatedBillAmount - totals.actualRevenueAmount)}</span></p>
              </Link>
            </div>
          </section>

          {/* Area C: Action Items */}
          <section>
            <h2 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-rose-500" />
              需要处理
            </h2>
            
            <div className="rounded-2xl border border-line bg-white shadow-sm overflow-hidden">
              <div className="bg-slate-50 px-5 py-3 border-b border-slate-100 flex items-center gap-4">
                 {totals.unmatchedCount === 0 && totals.missingShippingFeeCount === 0 ? (
                    <span className="text-emerald-600 font-bold text-sm flex items-center gap-1">✓ 暂无待处理对账问题</span>
                 ) : (
                    <>
                      <Link to="/finance/settlement" className={`rounded-full px-3 py-1 text-xs font-bold flex items-center gap-1 transition-colors ${totals.unmatchedCount > 0 ? "bg-rose-100 text-rose-700 hover:bg-rose-200" : "bg-emerald-100 text-emerald-700"}`}>
                        {totals.unmatchedCount} 笔 SKU 未匹配 →
                      </Link>
                      <Link to="/finance/settlement" className={`rounded-full px-3 py-1 text-xs font-bold flex items-center gap-1 transition-colors ${totals.missingShippingFeeCount > 0 ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-emerald-100 text-emerald-700"}`}>
                        {totals.missingShippingFeeCount} 笔运费缺失 →
                      </Link>
                    </>
                 )}
              </div>
              
              {pendingReconciliations.length > 0 && (
                <StandardTable 
                  minWidth="min-w-[800px]" 
                  tableClassName="finance-freeze-reconciliation"
                  page={1}
                  pageSize={5}
                  totalPages={1}
                  totalRecordCount={pendingReconciliations.length}
                  onPageChange={() => {}}
                  onPageSizeChange={() => {}}
                >
                  <thead>
                    <tr>
                      <th className="bg-slate-50">异常订单号</th>
                      <th className="bg-slate-50">Temu SKU Code</th>
                      <th className="bg-slate-50">系统商品 SKU</th>
                      <th className="text-center bg-slate-50">对账状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingReconciliations.map((row: any) => {
                      const accountingStatus = getAccountingStatus(row);
                      return (
                        <tr key={row.order.id} className="hover:bg-slate-50/50">
                          <td className="font-semibold text-slate-800" data-full-text={row.order.order_no}>
                            <span className="table-cell-clamp">{row.order.order_no}</span>
                          </td>
                          <td className="font-mono text-slate-600 text-xs font-bold" data-full-text={row.order.sku_code || "--"}>
                            <span className="table-cell-clamp">{row.order.sku_code || "--"}</span>
                          </td>
                          <td
                            className="text-slate-700 font-medium"
                            data-full-text={row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}
                          >
                            {row.product ? (
                              <span className="table-cell-clamp">{row.product.product_name_cn}</span>
                            ) : (
                              <span className="table-cell-clamp text-slate-400 italic">
                                规格: {row.order.product_attributes || "--"}
                              </span>
                            )}
                          </td>
                          <td className="text-center">
                            <Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </StandardTable>
              )}
            </div>
          </section>

        </div>
      )}
    </section>
  );
}
