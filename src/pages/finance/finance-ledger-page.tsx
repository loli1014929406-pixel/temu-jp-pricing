import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, Badge, StandardTable, TableCellPreview } from "../../components/ui";
import {
  EmptyPanel,
  formatCurrency,
} from "./shared";
import { fetchFinanceLedgerPage, type FinanceLedgerRow } from "../../lib/finance-queries";
import { getErrorMessage } from "../../utils/errors";

type Props = {
  user: User;
};

const ledgerTableColumns = [
  { key: "date", width: "8rem" },
  { key: "type", width: "8rem" },
  { key: "direction", width: "7rem" },
  { key: "subject", width: "18rem" },
  { key: "amount", width: "10rem" },
  { key: "remark", width: "24rem" },
] as const;

export function FinanceLedgerPage({ user }: Props) {
  const [activeTab, setActiveTab] = useState<"all" | "订单回款" | "采购付款" | "其他费用">("all");
  const [cashflowMonth, setCashflowMonth] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<FinanceLedgerRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalIncome, setTotalIncome] = useState(0);
  const [totalExpense, setTotalExpense] = useState(0);
  const [uniqueMonths, setUniqueMonths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setPage(1);
  }, [pageSize, cashflowMonth, activeTab]);

  const load = useCallback(async () => {
    if (!user.id) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetchFinanceLedgerPage({
        page,
        pageSize,
        type: activeTab,
        month: cashflowMonth,
      });
      setRows(result.rows);
      setTotalCount(result.totalCount);
      setTotalIncome(result.totalIncome);
      setTotalExpense(result.totalExpense);
      setUniqueMonths(result.months);
    } catch (err) {
      setError(getErrorMessage(err, "加载收支流水失败"));
    } finally {
      setLoading(false);
    }
  }, [activeTab, cashflowMonth, page, pageSize, user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const reload = load;

  return (
    <section className="page-stack">
      <PageHeader
        title="收支流水"
        description="查看全部业务的资金流入和流出明细"
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
          onClick={() => { setActiveTab("all"); setPage(1); }}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "all" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          全部流水
        </button>
        <button
          onClick={() => { setActiveTab("订单回款"); setPage(1); }}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "订单回款" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          订单回款
        </button>
        <button
          onClick={() => { setActiveTab("采购付款"); setPage(1); }}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "采购付款" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          采购付款
        </button>
        <button
          onClick={() => { setActiveTab("其他费用"); setPage(1); }}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "其他费用" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          其他费用
        </button>
      </div>

      <div className="surface-card p-5">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 pb-4 mb-4">
          <select
            aria-label="流水月份"
            value={cashflowMonth}
            onChange={(e) => { setCashflowMonth(e.target.value); setPage(1); }}
            className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="all">全部月份</option>
            {uniqueMonths.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <div className="ml-auto flex gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
              共 {totalCount} 条记录
            </span>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <EmptyPanel label="加载中..." />
        ) : rows.length === 0 ? (
          <EmptyPanel label="暂无收支流水数据" />
        ) : (
          <>
            <StandardTable
              page={page}
              pageSize={pageSize}
              totalPages={totalPages}
              totalRecordCount={totalCount}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              columns={ledgerTableColumns}
              layout="fixed"
              minWidth="min-w-[980px]"
            >
              <thead>
                <tr>
                  <th className="bg-slate-50">交易日期</th>
                  <th className="bg-slate-50">流水类型</th>
                  <th className="bg-slate-50">收支流向</th>
                  <th className="bg-slate-50">流水对象 / 单号</th>
                  <th className="number-cell bg-slate-50">流出/流入金额</th>
                  <th className="bg-slate-50">流水详情说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.stableId} className="hover:bg-slate-50/50">
                    <td className="text-slate-500 font-mono">{row.date}</td>
                    <td className="font-semibold text-slate-700">{row.type}</td>
                    <td>
                      <Badge tone={row.direction === "收入" ? "success" : "danger"}>
                        {row.direction}
                      </Badge>
                    </td>
                    <td className="font-bold text-slate-800">
                      <TableCellPreview
                        label="流水对象 / 单号"
                        value={row.subject}
                        alwaysShowDetail={row.subject.length > 18}
                        detailTitle="流水对象 / 单号"
                        detailSubtitle={row.date}
                      />
                    </td>
                    <td className={`money ${row.direction === "支出" ? "text-rose-700" : "text-emerald-700"}`}>
                      {formatCurrency(Math.abs(row.amountRmb))}
                    </td>
                    <td className="text-slate-500 font-medium">
                      <TableCellPreview
                        label="流水详情说明"
                        value={row.remark || "--"}
                        lines={2}
                        alwaysShowDetail={Boolean(row.remark)}
                        detailTitle="流水详情说明"
                        detailSubtitle={row.subject}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 font-bold border-t-2 border-line">
                  <td colSpan={4} className="text-slate-600 pr-4">筛选汇总 (净额: <span className={totalIncome - totalExpense >= 0 ? "text-emerald-600" : "text-rose-600"}>{formatCurrency(totalIncome - totalExpense)}</span>)</td>
                  <td className="number-cell text-xs leading-5">
                    <div className="text-emerald-700">+ {formatCurrency(totalIncome)}</div>
                    <div className="text-rose-700">- {formatCurrency(totalExpense)}</div>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </StandardTable>
          </>
        )}
      </div>
    </section>
  );
}
