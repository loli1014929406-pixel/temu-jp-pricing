import type { User } from "@supabase/supabase-js";
import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  ChartNoAxesCombined,
  CircleCheck,
  PackageCheck,
  ReceiptText,
  RefreshCw,
  TrendingUp,
  Truck,
  WalletCards,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader, Badge, StandardTable } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  EmptyPanel,
  getAccountingStatus,
  formatCurrency,
  calculateMarginRate,
  getPurchaseTotalRmb,
  getCurrentMonthInputValue,
  getMonthEnd,
  getMonthStart,
  getTodayInputValue,
  type FinancePeriod,
  type FinancePeriodMode,
} from "./shared";
import { useFinanceAnalysis } from "./use-finance-analysis";
import { useFinanceLogisticsCash } from "./use-finance-logistics-cash";
import { useFinanceOperatingOverview } from "./use-finance-operating-overview";

type Props = {
  user: User;
};

type OverviewView = "operating" | "cash";

function formatCompactCurrency(value: number) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 10000) return `${sign}¥${(absolute / 10000).toFixed(1)}万`;
  if (absolute >= 1000) return `${sign}¥${absolute.toFixed(0)}`;
  return `${sign}¥${absolute.toFixed(2)}`;
}

function MetricCard({
  label,
  value,
  note,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "default" | "positive" | "negative" | "warning";
  icon: React.ReactNode;
}) {
  const toneClass = tone === "positive"
    ? "text-emerald-600"
    : tone === "negative"
      ? "text-rose-600"
      : tone === "warning"
        ? "text-amber-600"
        : "text-slate-900";
  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-bold text-slate-500">{label}</div>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-50 text-slate-500">{icon}</span>
      </div>
      <div className={`mt-3 text-2xl font-black tabular-nums ${toneClass}`}>{value}</div>
      <p className="mt-2 text-xs font-medium text-slate-400">{note}</p>
    </div>
  );
}

export function FinanceOverviewPage({ user }: Props) {
  const [activeView, setActiveView] = useState<OverviewView>("operating");
  const [period, setPeriod] = useState<FinancePeriod>({
    mode: "all",
    start: "",
    end: "",
    label: "全部数据",
  });
  const { data, expenses, loading: baseLoading, error: baseError, reload: reloadBase } = useFinanceData(user.id, {
    purchases: true,
    expenses: true,
  });
  const allAnalysis = useFinanceAnalysis({ page: 1, pageSize: 1 });
  const issues = useFinanceAnalysis({ page: 1, pageSize: 5, issue: "reconciliation" });
  const operating = useFinanceOperatingOverview({
    dateStart: period.mode === "all" ? "" : period.start,
    dateEnd: period.mode === "all" ? "" : period.end,
  });
  const logisticsCash = useFinanceLogisticsCash();

  const purchasePayment = useMemo(
    () => data.purchases.reduce((sum, row) => sum + getPurchaseTotalRmb(row), 0),
    [data.purchases],
  );
  const totalOtherExpenses = useMemo(
    () => expenses.reduce((sum, expense) => sum + expense.amount_rmb, 0),
    [expenses],
  );
  const actualCashNet = allAnalysis.summary.actualRevenue
    - purchasePayment
    - logisticsCash.data.paidAmountRmb
    - totalOtherExpenses;
  const settledMargin = calculateMarginRate(operating.summary.settledProfit, operating.summary.actualRevenue);
  const settlementRate = operating.summary.orderCount > 0
    ? (operating.summary.settledCount / operating.summary.orderCount) * 100
    : 0;
  const periodLabel = period.mode === "all" ? "全部实际发货订单" : `${period.start} 至 ${period.end}`;
  const monthlyTrend = operating.monthly.slice(0, 6).reverse();
  const trendMaximum = Math.max(1, ...monthlyTrend.map((row) => Math.abs(row.settledProfit)));
  const pendingReconciliations = issues.rows;
  const loading = baseLoading || allAnalysis.loading || issues.loading || operating.loading || logisticsCash.loading;
  const error = baseError || allAnalysis.error || issues.error || operating.error || logisticsCash.error;

  const reload = async () => {
    await Promise.all([
      reloadBase(),
      allAnalysis.reload(),
      issues.reload(),
      operating.reload(),
      logisticsCash.reload(),
    ]);
  };

  const handlePeriodModeChange = (mode: FinancePeriodMode) => {
    if (mode === "all") {
      setPeriod({ mode, start: "", end: "", label: "全部数据" });
      return;
    }
    const currentMonth = getCurrentMonthInputValue();
    if (mode === "month") {
      setPeriod({ mode, start: getMonthStart(currentMonth), end: getMonthEnd(currentMonth), label: currentMonth });
      return;
    }
    setPeriod({ mode, start: getMonthStart(currentMonth), end: getTodayInputValue(), label: "自定义" });
  };

  return (
    <section className="page-stack">
      <PageHeader
        title="财务总览"
        description="经营核算按实际发货订单对齐，现金收支按真实发生金额汇总"
        actions={
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => void reload()}>
            <RefreshCw size={18} />
            刷新
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-2 shadow-sm">
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setActiveView("operating")}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${activeView === "operating" ? "bg-white text-accentDeep shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
          >
            经营核算
          </button>
          <button
            type="button"
            onClick={() => setActiveView("cash")}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${activeView === "cash" ? "bg-white text-accentDeep shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
          >
            现金收支
          </button>
        </div>

        {activeView === "operating" ? (
          <div className="flex flex-wrap items-center gap-2 px-1">
            <span className="flex items-center gap-1 text-xs font-semibold text-slate-500"><CalendarDays size={14} />实际发货时间</span>
            <select
              aria-label="经营核算周期类型"
              value={period.mode}
              onChange={(event) => handlePeriodModeChange(event.target.value as FinancePeriodMode)}
              className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-accent"
            >
              <option value="month">按月</option>
              <option value="custom">自定义</option>
              <option value="all">全部</option>
            </select>
            {period.mode === "month" && (
              <input
                type="month"
                aria-label="经营核算月份"
                value={period.label}
                onChange={(event) => {
                  const month = event.target.value;
                  setPeriod({ mode: "month", start: getMonthStart(month), end: getMonthEnd(month), label: month });
                }}
                className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-accent"
              />
            )}
            {period.mode === "custom" && (
              <>
                <input
                  type="date"
                  aria-label="经营核算开始日期"
                  value={period.start}
                  onChange={(event) => setPeriod({ ...period, start: event.target.value })}
                  className="h-9 rounded-lg border border-line bg-white px-3 text-xs text-slate-700 outline-none focus:border-accent"
                />
                <span className="text-slate-300">—</span>
                <input
                  type="date"
                  aria-label="经营核算结束日期"
                  value={period.end}
                  onChange={(event) => setPeriod({ ...period, end: event.target.value })}
                  className="h-9 rounded-lg border border-line bg-white px-3 text-xs text-slate-700 outline-none focus:border-accent"
                />
              </>
            )}
            {period.mode === "all" && <span className="px-2 text-xs font-medium text-slate-400">全部历史实际发货订单</span>}
          </div>
        ) : (
          <div className="px-3 text-xs font-medium text-slate-400">全部历史累计 · 沿用已确认的收付款口径</div>
        )}
      </div>

      {loading && operating.summary.orderCount === 0 && allAnalysis.summary.orderCount === 0 ? (
        <EmptyPanel label="加载中..." />
      ) : activeView === "operating" ? (
        <div className="grid gap-6">
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800"><TrendingUp size={16} className="text-accent" />同批订单经营核算</h2>
              <span className="text-xs font-medium text-slate-400">{periodLabel}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="已结算实际回款" value={formatCurrency(operating.summary.actualRevenue)} note={`${operating.summary.settledCount} 笔已结算订单`} icon={<ReceiptText size={17} />} />
              <MetricCard label="已结算商品成本" value={formatCurrency(operating.summary.settledProductCost)} note="仅统计同批已结算订单" icon={<PackageCheck size={17} />} />
              <MetricCard label="已结算核算运费" value={formatCurrency(operating.summary.settledShipping)} note="仅统计同批已结算订单" icon={<Truck size={17} />} />
              <MetricCard
                label="已结算订单毛利"
                value={formatCurrency(operating.summary.settledProfit)}
                note={`毛利率 ${settledMargin.toFixed(1)}% · 不含期间费用`}
                tone={operating.summary.settledProfit >= 0 ? "positive" : "negative"}
                icon={<ChartNoAxesCombined size={17} />}
              />
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.05fr_1.45fr]">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-bold text-slate-800">结算进度</div>
                  <p className="mt-1 text-xs text-slate-400">同一实际发货周期内的订单</p>
                </div>
                <div className="text-right">
                  <div className="text-xl font-black tabular-nums text-slate-900">{settlementRate.toFixed(1)}%</div>
                  <div className="text-xs font-semibold text-slate-400">{operating.summary.settledCount} / {operating.summary.orderCount} 笔</div>
                </div>
              </div>
              <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, settlementRate)}%` }} />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-amber-50 p-3">
                  <div className="text-xs font-semibold text-amber-700">未结算订单</div>
                  <div className="mt-1 text-lg font-black tabular-nums text-amber-700">{operating.summary.unsettledCount} 笔</div>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500">未结算成本占用</div>
                  <div className="mt-1 text-lg font-black tabular-nums text-slate-800">{formatCurrency(operating.summary.unsettledCost)}</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-400">商品 {formatCurrency(operating.summary.unsettledProductCost)} · 运费 {formatCurrency(operating.summary.unsettledShipping)}</p>
            </div>

            <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-800">近6个月已结算订单毛利</div>
                  <p className="mt-1 text-xs text-slate-400">按实际发货月份归集，不含期间费用</p>
                </div>
                <Link to="/finance/profit" className="text-xs font-bold text-accent hover:text-accentDeep">查看利润报表 <ArrowRight size={13} className="inline" /></Link>
              </div>
              <div className="mt-5 grid gap-3">
                {monthlyTrend.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">暂无可绘制数据</div>
                ) : monthlyTrend.map((row) => {
                  const width = Math.max(2, (Math.abs(row.settledProfit) / trendMaximum) * 100);
                  return (
                    <div key={row.month} className="grid grid-cols-[62px_1fr_86px] items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500">{row.month}</span>
                      <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full rounded-full ${row.settledProfit >= 0 ? "bg-emerald-500" : "bg-rose-500"}`} style={{ width: `${width}%` }} />
                      </div>
                      <span className={`text-right text-xs font-bold tabular-nums ${row.settledProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatCompactCurrency(row.settledProfit)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="grid gap-6">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><WalletCards size={16} className="text-emerald-600" />真实现金收支</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <MetricCard label="实际结算回款" value={formatCurrency(allAnalysis.summary.actualRevenue)} note="全部已上传结算记录" icon={<ReceiptText size={17} />} />
              <MetricCard label="采购付款" value={formatCurrency(purchasePayment)} note="按现有采购日期口径" icon={<PackageCheck size={17} />} />
              <MetricCard label="物流付款" value={formatCurrency(logisticsCash.data.paidAmountRmb)} note="按登记付款金额" icon={<Truck size={17} />} />
              <MetricCard label="其他支出" value={formatCurrency(totalOtherExpenses)} note="费用管理累计金额" icon={<WalletCards size={17} />} />
              <MetricCard label="净现金流" value={formatCurrency(actualCashNet)} note="实际流入减实际流出" tone={actualCashNet >= 0 ? "positive" : "negative"} icon={<ChartNoAxesCombined size={17} />} />
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <div className="text-sm font-bold text-slate-800">现金流构成</div>
              <p className="mt-1 text-xs text-slate-400">净现金流不等于利润，只反映真实资金进出</p>
              <div className="mt-5 grid gap-3">
                {[
                  { label: "结算回款", value: allAnalysis.summary.actualRevenue, color: "bg-emerald-500", direction: "+" },
                  { label: "采购付款", value: purchasePayment, color: "bg-amber-500", direction: "-" },
                  { label: "物流付款", value: logisticsCash.data.paidAmountRmb, color: "bg-blue-500", direction: "-" },
                  { label: "其他支出", value: totalOtherExpenses, color: "bg-slate-500", direction: "-" },
                ].map((item) => {
                  const maximum = Math.max(allAnalysis.summary.actualRevenue, purchasePayment, logisticsCash.data.paidAmountRmb, totalOtherExpenses, 1);
                  return (
                    <div key={item.label} className="grid grid-cols-[76px_1fr_110px] items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500">{item.label}</span>
                      <div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max(2, (item.value / maximum) * 100)}%` }} /></div>
                      <span className="text-right text-xs font-bold tabular-nums text-slate-700">{item.direction}{formatCurrency(item.value)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <Link to="/finance/settlement" className="rounded-2xl border border-line bg-white p-5 shadow-sm transition hover:border-accent">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-800">物流待付款</div>
                  <p className="mt-1 text-xs text-slate-400">已上传真实运费减已登记付款</p>
                </div>
                <ArrowRight size={18} className="text-slate-300" />
              </div>
              <div className="mt-5 text-3xl font-black tabular-nums text-amber-600">{formatCurrency(logisticsCash.data.outstandingAmountRmb)}</div>
              <div className="mt-4 flex items-center justify-between text-xs font-semibold text-slate-400"><span>应付 {formatCurrency(logisticsCash.data.payableAmountRmb)}</span><span>已付 {formatCurrency(logisticsCash.data.paidAmountRmb)}</span></div>
            </Link>
          </section>
        </div>
      )}

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><AlertCircle size={16} className="text-rose-500" />需要处理</h2>
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3">
            {operating.summary.unmatchedCount === 0
              && operating.summary.missingShippingAttentionCount === 0
              && operating.summary.missingActualShipTimeCount === 0
              && logisticsCash.data.outstandingAmountRmb <= 0 ? (
                <span className="flex items-center gap-1.5 text-sm font-bold text-emerald-600"><CircleCheck size={16} />暂无待处理财务事项</span>
              ) : (
                <>
                  <Link to="/finance/settlement" className={`rounded-full px-3 py-1 text-xs font-bold ${operating.summary.unmatchedCount > 0 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>{operating.summary.unmatchedCount} 笔 SKU 未匹配 <ArrowRight size={13} className="inline" /></Link>
                  <Link to="/finance/settlement" className={`rounded-full px-3 py-1 text-xs font-bold ${operating.summary.missingShippingAttentionCount > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{operating.summary.missingShippingAttentionCount} 笔运费缺失 <ArrowRight size={13} className="inline" /></Link>
                  {operating.summary.missingActualShipTimeCount > 0 && <Link to="/finance/settlement" className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">{operating.summary.missingActualShipTimeCount} 笔缺实际发货时间 <ArrowRight size={13} className="inline" /></Link>}
                  {logisticsCash.data.outstandingAmountRmb > 0 && <Link to="/finance/settlement" className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">物流待付款 {formatCurrency(logisticsCash.data.outstandingAmountRmb)} <ArrowRight size={13} className="inline" /></Link>}
                </>
              )}
          </div>

          {pendingReconciliations.length > 0 && (
            <StandardTable minWidth="min-w-max" tableClassName="finance-freeze-reconciliation" page={1} pageSize={5} totalPages={1} totalRecordCount={pendingReconciliations.length} onPageChange={() => {}} onPageSizeChange={() => {}}>
              <thead><tr><th className="bg-slate-50">异常订单号</th><th className="bg-slate-50">Temu SKU Code</th><th className="bg-slate-50">系统商品 SKU</th><th className="bg-slate-50 text-center">对账状态</th></tr></thead>
              <tbody>
                {pendingReconciliations.map((row) => {
                  const accountingStatus = getAccountingStatus(row);
                  return (
                    <tr key={row.order.id} className="hover:bg-slate-50/50">
                      <td className="font-semibold text-slate-800"><span className="table-cell-clamp">{row.order.order_no}</span></td>
                      <td className="font-mono text-xs font-bold text-slate-600"><span className="table-cell-clamp">{row.order.sku_code || "--"}</span></td>
                      <td className="font-medium text-slate-700"><span className="table-cell-clamp">{row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}</span></td>
                      <td className="text-center"><Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </StandardTable>
          )}
        </div>
      </section>
    </section>
  );
}
