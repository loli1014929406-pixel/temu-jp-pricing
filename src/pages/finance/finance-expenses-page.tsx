import type { User } from "@supabase/supabase-js";
import { useEffect, useState, useMemo } from "react";
import { Plus, Trash2, Edit2, X, Check, RefreshCw } from "lucide-react";
import { PageHeader, StandardTable, TableCellPreview } from "../../components/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { useFinanceData } from "./use-finance-data";
import { addExpense, addExpensesBulk, updateExpense, deleteExpense } from "../../lib/expenses";
import { EmptyPanel, getPaginatedRows } from "./shared";
import { formatCurrency } from "../../utils/pricing";
import type { FinanceExpense } from "../../types";
import { confirmAction, confirmCancelEdit, confirmDelete, confirmSave } from "../../utils/confirmations";

type Props = {
  user: User;
};

const categoryLabels: Record<FinanceExpense["category"], string> = {
  ad: "广告推广",
  customs: "关税头程",
  packaging: "包装耗材",
  platform_commission: "平台佣金",
  refund_loss: "退款损失",
  other: "其他杂费",
};

const expenseTableColumns = [
  { key: "date", width: "8rem" },
  { key: "category", width: "9rem" },
  { key: "amount", width: "9rem" },
  { key: "remark", width: "22rem" },
  { key: "actions", width: "9rem" },
] as const;

export function FinanceExpensesPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { expenses, loading, error, reload } = useFinanceData(user.id, { expenses: true });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  // Form State
  const [expenseDate, setExpenseDate] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<FinanceExpense["category"]>("ad");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseRemark, setExpenseRemark] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  // LocalStorage Migration
  useEffect(() => {
    const migrateLocalData = async () => {
      const localData = localStorage.getItem("codex_finance_other_expenses");
      if (localData) {
        try {
          const parsed = JSON.parse(localData);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const toInsert = parsed.map((p: any) => ({
              expense_date: p.date,
              category: (p.category === "platform_commission" || p.category === "refund_loss" ? p.category : p.category || "other"),
              amount_rmb: Number(p.amount || 0),
              remark: p.remark || "",
            }));
            if (!confirmAction(`检测到 ${parsed.length} 条本地缓存费用记录，确认迁移到云端数据库吗？`)) {
              return;
            }
            await addExpensesBulk(toInsert);
            localStorage.removeItem("codex_finance_other_expenses");
            alert(`成功将 ${parsed.length} 条本地缓存的费用记录迁移至云端数据库！`);
            await reload();
          } else {
             localStorage.removeItem("codex_finance_other_expenses");
          }
        } catch (e) {
          console.error("Migration failed", e);
        }
      }
    };
    void migrateLocalData();
  }, []);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setExpenseDate(new Date().toISOString().slice(0, 10));
    setExpenseCategory("ad");
    setExpenseAmount("");
    setExpenseRemark("");
  };

  const handleCancelForm = () => {
    if (!confirmCancelEdit()) return;
    resetForm();
  };

  const handleEdit = (expense: FinanceExpense) => {
    setEditingId(expense.id);
    setExpenseDate(expense.expense_date);
    setExpenseCategory(expense.category);
    setExpenseAmount(String(expense.amount_rmb));
    setExpenseRemark(expense.remark || "");
    setFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(expenseAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      alert("请输入有效的费用金额");
      return;
    }
    if (!confirmSave()) return;

    try {
      if (editingId) {
        await updateExpense(editingId, {
          expense_date: expenseDate,
          category: expenseCategory,
          amount_rmb: amount,
          remark: expenseRemark.trim(),
        });
      } else {
        await addExpense({
          expense_date: expenseDate,
          category: expenseCategory,
          amount_rmb: amount,
          remark: expenseRemark.trim(),
        });
      }
      resetForm();
      await reload();
    } catch (err: any) {
      alert("保存失败: " + err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirmDelete("该笔费用记录")) return;
    try {
      await deleteExpense(id);
      await reload();
    } catch (err: any) {
      alert("删除失败: " + err.message);
    }
  };

  const paginated = useMemo(() => {
    const total = expenses.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const startIndex = (safePage - 1) * pageSize;
    return {
      page: safePage,
      total,
      totalPages,
      rows: expenses.slice(startIndex, startIndex + pageSize),
    };
  }, [expenses, page, pageSize]);

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="费用管理"
        description="记录和管理各项杂费，如平台佣金、广告推广、关税头程等。"
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={loading}
            onClick={() => void reload()}
          >
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

      <div className="surface-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-sm font-bold text-slate-800">其他核算杂费记录</h3>
          <button
            type="button"
            onClick={() => { resetForm(); setFormOpen(true); }}
            disabled={!canEdit}
            className="btn-primary h-9 px-3 text-xs font-bold"
          >
            <Plus size={15} />
            新增费用
          </button>
        </div>

        {loading && expenses.length === 0 ? (
          <EmptyPanel label="加载中..." />
        ) : expenses.length === 0 ? (
          <EmptyPanel label="暂无费用记录" />
        ) : (
          <>
            <StandardTable
              page={paginated.page}
              pageSize={pageSize}
              totalPages={paginated.totalPages}
              totalRecordCount={paginated.total}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              columns={expenseTableColumns}
              layout="fixed"
              minWidth="min-w-[760px]"
            >
              <thead>
                <tr>
                  <th className="bg-slate-50">记录日期</th>
                  <th className="bg-slate-50">费用归类</th>
                  <th className="number-cell bg-slate-50">扣减金额</th>
                  <th className="bg-slate-50">备注说明</th>
                  <th className="text-center bg-slate-50">操作</th>
                </tr>
              </thead>
              <tbody>
                {paginated.rows.map((expense) => (
                  <tr key={expense.id} className="hover:bg-slate-50/50">
                    <td className="text-slate-500 font-mono">{expense.expense_date}</td>
                    <td>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {categoryLabels[expense.category] || expense.category}
                      </span>
                    </td>
                    <td className="money text-rose-700">{formatCurrency(expense.amount_rmb)}</td>
                    <td className="text-slate-600 font-medium">
                      <TableCellPreview
                        label="备注说明"
                        value={expense.remark || "--"}
                        lines={2}
                        alwaysShowDetail={Boolean(expense.remark)}
                        detailTitle="费用备注说明"
                        detailSubtitle={expense.expense_date}
                      />
                    </td>
                    <td className="text-center">
                      <div className="flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleEdit(expense)}
                          disabled={!canEdit}
                          className="text-accent hover:text-accentDeep font-semibold text-xs inline-flex items-center gap-1 transition disabled:opacity-50"
                        >
                          <Edit2 size={12} />
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(expense.id)}
                          disabled={!canEdit}
                          className="text-rose-600 hover:text-rose-800 font-semibold text-xs inline-flex items-center gap-1 transition disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </StandardTable>
          </>
        )}
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={handleCancelForm}
          />
          <section className="relative z-10 h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl sm:m-4 sm:h-[calc(100%-2rem)] sm:rounded-2xl">
            <div className="mb-5 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <Plus size={16} className="text-slate-400" />
                <span>{editingId ? "编辑费用账单" : "录入费用账单"}</span>
              </h3>
              <button
                type="button"
                onClick={handleCancelForm}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <span>交易日期</span>
                <input
                  type="date"
                  required
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  className="h-10 rounded-xl border border-line bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <span>费用类别</span>
                <select
                  value={expenseCategory}
                  onChange={(e) => setExpenseCategory(e.target.value as any)}
                  className="h-10 rounded-xl border border-line bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-accent focus:bg-white"
                >
                  <option value="platform_commission">平台佣金</option>
                  <option value="refund_loss">退款损失</option>
                  <option value="ad">广告推广</option>
                  <option value="customs">关税头程</option>
                  <option value="packaging">包装耗材</option>
                  <option value="other">其他杂费</option>
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
                  className="h-10 rounded-xl border border-line bg-slate-50 px-3 text-sm font-bold text-slate-750 outline-none transition focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <span>费用说明 / 备注</span>
                <textarea
                  value={expenseRemark}
                  onChange={(e) => setExpenseRemark(e.target.value)}
                  className="h-24 rounded-xl border border-line bg-slate-50 p-3 text-sm font-bold text-slate-750 outline-none transition focus:border-accent focus:bg-white resize-none"
                />
              </label>
              <button type="submit" disabled={!canEdit} className="btn-primary h-10 w-full font-bold mt-2">
                保存
              </button>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
