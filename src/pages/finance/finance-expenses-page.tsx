import type { User } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Edit2, X, RefreshCw, Upload } from "lucide-react";
import { PageHeader, StandardTable, TableCellPreview } from "../../components/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { useFinanceData } from "./use-finance-data";
import { addExpense, addExpensesBulk, updateExpense, deleteExpense } from "../../lib/expenses";
import { readTabularFileObjects } from "../../lib/excel";
import { EmptyPanel, getTodayInputValue } from "./shared";
import { formatCurrency } from "../../utils/pricing";
import type { FinanceExpense } from "../../types";
import { confirmAction, confirmCancelEdit, confirmDelete, confirmSave } from "../../utils/confirmations";
import { getErrorMessage } from "../../utils/errors";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notifications";
import { TABLE_COLUMN_WIDTH } from "../../components/ui/table-layout";

type Props = {
  user: User;
};

type FinanceExpenseInput = Omit<FinanceExpense, "id" | "user_id" | "created_at" | "updated_at">;

type AdPaymentImportAction = "skip" | "overwrite";

type AdPaymentImportRecord = {
  expense_date: string;
  amount_rmb: number;
  service_fee_rmb: number;
  tax_rmb: number;
  remark: string;
  settlementNos: string[];
  paymentMethods: string[];
  rowCount: number;
};

type PendingAdPaymentImport = {
  fileName: string;
  records: AdPaymentImportRecord[];
  invalidRows: string[];
  existingByDate: Record<string, FinanceExpense[]>;
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
  { key: "date", width: TABLE_COLUMN_WIDTH.short },
  { key: "category", width: TABLE_COLUMN_WIDTH.actions },
  { key: "amount", width: TABLE_COLUMN_WIDTH.actions },
  { key: "remark", width: TABLE_COLUMN_WIDTH.wide },
  { key: "actions", width: TABLE_COLUMN_WIDTH.actions },
] as const;

const adPaymentRequiredColumns = [
  "付款时间",
  "结算单号",
  "站点",
  "结算方式",
  "流水类型",
  "交易金额",
  "服务费",
  "税费金额",
  "状态",
] as const;

function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeCellText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getColumnValue(row: Record<string, unknown>, column: string) {
  const key = Object.keys(row).find((candidate) => candidate.trim() === column);
  return key ? row[key] : "";
}

function hasColumn(row: Record<string, unknown>, column: string) {
  return Object.keys(row).some((candidate) => candidate.trim() === column);
}

function parsePaymentDate(value: unknown) {
  const text = normalizeCellText(value);
  const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  return [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
}

function parseMoneyValue(value: unknown) {
  if (typeof value === "number") return roundMoney(value);
  const text = normalizeCellText(value);
  if (!text || text === "-") return 0;
  const numericText = text.replace(/[¥￥,\s]/g, "").replace(/[^0-9.-]/g, "");
  const amount = Number(numericText);
  return Number.isFinite(amount) ? roundMoney(amount) : Number.NaN;
}

function getMissingAdPaymentColumns(rows: Record<string, unknown>[]) {
  const firstRow = rows[0] ?? {};
  return adPaymentRequiredColumns.filter((column) => !hasColumn(firstRow, column));
}

function buildAdPaymentRemark(
  _date: string,
  _details: Array<{
    settlementNo: string;
    site: string;
    paymentMethod: string;
    transactionAmount: number;
    serviceFee: number;
    taxAmount: number;
  }>,
) {
  return "广告费支付";
}

function parseAdPaymentImportRows(rows: Record<string, unknown>[]) {
  const invalidRows: string[] = [];
  const grouped = new Map<
    string,
    {
      details: Array<{
        settlementNo: string;
        site: string;
        paymentMethod: string;
        transactionAmount: number;
        serviceFee: number;
        taxAmount: number;
      }>;
    }
  >();

  rows.forEach((row, index) => {
    const lineNumber = index + 2;
    const date = parsePaymentDate(getColumnValue(row, "付款时间"));
    const settlementNo = normalizeCellText(getColumnValue(row, "结算单号"));
    const site = normalizeCellText(getColumnValue(row, "站点"));
    const paymentMethod = normalizeCellText(getColumnValue(row, "结算方式"));
    const flowType = normalizeCellText(getColumnValue(row, "流水类型"));
    const status = normalizeCellText(getColumnValue(row, "状态"));
    const transactionAmount = parseMoneyValue(getColumnValue(row, "交易金额"));
    const serviceFee = parseMoneyValue(getColumnValue(row, "服务费"));
    const taxAmount = parseMoneyValue(getColumnValue(row, "税费金额"));

    if (!date) {
      invalidRows.push(`第 ${lineNumber} 行付款时间无效`);
      return;
    }
    if (!settlementNo) {
      invalidRows.push(`第 ${lineNumber} 行缺少结算单号`);
      return;
    }
    if (flowType !== "支出") {
      invalidRows.push(`第 ${lineNumber} 行不是支出流水，已跳过`);
      return;
    }
    if (status !== "成功") {
      invalidRows.push(`第 ${lineNumber} 行状态不是成功，已跳过`);
      return;
    }
    if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) {
      invalidRows.push(`第 ${lineNumber} 行交易金额无效，已跳过`);
      return;
    }
    if (!Number.isFinite(serviceFee) || !Number.isFinite(taxAmount)) {
      invalidRows.push(`第 ${lineNumber} 行服务费或税费金额无效，已跳过`);
      return;
    }

    const group = grouped.get(date) ?? { details: [] };
    group.details.push({
      settlementNo,
      site,
      paymentMethod,
      transactionAmount,
      serviceFee,
      taxAmount,
    });
    grouped.set(date, group);
  });

  const records = Array.from(grouped.entries())
    .map(([date, group]) => {
      const amount = roundMoney(
        group.details.reduce((sum, detail) => sum + detail.transactionAmount, 0),
      );
      const serviceFee = roundMoney(
        group.details.reduce((sum, detail) => sum + detail.serviceFee, 0),
      );
      const taxAmount = roundMoney(
        group.details.reduce((sum, detail) => sum + detail.taxAmount, 0),
      );

      return {
        expense_date: date,
        amount_rmb: amount,
        service_fee_rmb: serviceFee,
        tax_rmb: taxAmount,
        remark: buildAdPaymentRemark(date, group.details),
        settlementNos: group.details.map((detail) => detail.settlementNo),
        paymentMethods: Array.from(new Set(group.details.map((detail) => detail.paymentMethod).filter(Boolean))),
        rowCount: group.details.length,
      };
    })
    .sort((left, right) => right.expense_date.localeCompare(left.expense_date));

  return { records, invalidRows };
}

function buildExistingAdExpensesByDate(expenses: FinanceExpense[]) {
  return expenses.reduce<Record<string, FinanceExpense[]>>((grouped, expense) => {
    if (expense.category !== "ad") return grouped;
    const rows = grouped[expense.expense_date] ?? [];
    rows.push(expense);
    grouped[expense.expense_date] = rows;
    return grouped;
  }, {});
}

function toFinanceExpenseInput(record: AdPaymentImportRecord): FinanceExpenseInput {
  return {
    expense_date: record.expense_date,
    category: "ad",
    amount_rmb: record.amount_rmb,
    remark: record.remark,
  };
}

function removeSourceFileFromRemark(remark: string | null | undefined) {
  const text = normalizeCellText(remark);
  if (!text) return "";
  if (text.startsWith("广告费支付")) return "广告费支付";
  return text
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("来源文件"))
    .join("；");
}

function formatExpenseRemarkForDisplay(remark: string | null | undefined) {
  return removeSourceFileFromRemark(remark) || "--";
}

export function FinanceExpensesPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { expenses, loading, error, reload } = useFinanceData(user.id, { expenses: true });
  const adPaymentFileInputRef = useRef<HTMLInputElement | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form State
  const [expenseDate, setExpenseDate] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<FinanceExpense["category"]>("ad");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseRemark, setExpenseRemark] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [adImporting, setAdImporting] = useState(false);
  const [pendingAdImport, setPendingAdImport] = useState<PendingAdPaymentImport | null>(null);
  const [adImportActions, setAdImportActions] = useState<Record<string, AdPaymentImportAction>>({});

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
            notifySuccess(`成功将 ${parsed.length} 条本地缓存的费用记录迁移至云端数据库！`);
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
  }, [reload]);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setExpenseDate(getTodayInputValue());
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
    setExpenseRemark(removeSourceFileFromRemark(expense.remark));
    setFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(expenseAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      notifyWarning("请输入有效的费用金额");
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
      notifyError("保存失败: " + err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirmDelete("该笔费用记录")) return;
    try {
      await deleteExpense(id);
      await reload();
    } catch (err: any) {
      notifyError("删除失败: " + err.message);
    }
  };

  const handleAdPaymentFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!canEdit) {
      notifyWarning("当前账号没有编辑权限，不能导入广告费。");
      event.target.value = "";
      return;
    }

    setAdImporting(true);
    setPendingAdImport(null);
    setAdImportActions({});

    try {
      const rows = await readTabularFileObjects(file);
      if (rows.length === 0) {
        throw new Error("文件里没有可读取的广告费支付记录");
      }

      const missingColumns = getMissingAdPaymentColumns(rows);
      if (missingColumns.length > 0) {
        throw new Error(`缺少必要列：${missingColumns.join("、")}`);
      }

      const { records, invalidRows } = parseAdPaymentImportRows(rows);
      if (records.length === 0) {
        throw new Error("不存在可导入的广告费支付记录");
      }

      const existingByDate = buildExistingAdExpensesByDate(expenses);
      const defaultActions = Object.fromEntries(
        records
          .filter((record) => (existingByDate[record.expense_date] ?? []).length === 1)
          .map((record) => [record.expense_date, "skip" as AdPaymentImportAction]),
      );
      setPendingAdImport({
        fileName: file.name,
        records,
        invalidRows,
        existingByDate,
      });
      setAdImportActions(defaultActions);
    } catch (err) {
      notifyError("解析失败: " + getErrorMessage(err, "请确认上传的是广告费支付明细表格"));
    } finally {
      setAdImporting(false);
      event.target.value = "";
    }
  };

  const handleConfirmAdImport = async () => {
    if (!pendingAdImport) return;

    const toInsert: FinanceExpenseInput[] = [];
    const toOverwrite: Array<{ existing: FinanceExpense; record: AdPaymentImportRecord }> = [];
    let skippedCount = 0;

    pendingAdImport.records.forEach((record) => {
      const existingRows = pendingAdImport.existingByDate[record.expense_date] ?? [];
      if (existingRows.length === 0) {
        toInsert.push(toFinanceExpenseInput(record));
        return;
      }
      if (existingRows.length === 1 && adImportActions[record.expense_date] === "overwrite") {
        toOverwrite.push({ existing: existingRows[0], record });
        return;
      }
      skippedCount += 1;
    });

    if (toInsert.length === 0 && toOverwrite.length === 0) {
      notifyWarning("没有需要导入的广告费记录");
      return;
    }

    if (
      !(await confirmAction(
        [
          "确认导入广告费吗？",
          `新增 ${toInsert.length} 条`,
          `覆盖 ${toOverwrite.length} 条`,
          `跳过 ${skippedCount} 条`,
        ].join("\n"),
      ))
    ) {
      return;
    }

    setAdImporting(true);
    try {
      if (toInsert.length > 0) {
        await addExpensesBulk(toInsert);
      }

      for (const item of toOverwrite) {
        await updateExpense(item.existing.id, toFinanceExpenseInput(item.record));
      }

      setPendingAdImport(null);
      setAdImportActions({});
      setPage(1);
      await reload();
      notifySuccess(`广告费导入完成：新增 ${toInsert.length} 条，覆盖 ${toOverwrite.length} 条，跳过 ${skippedCount} 条。`);
    } catch (err) {
      notifyError("导入失败: " + getErrorMessage(err, "未知错误"));
    } finally {
      setAdImporting(false);
    }
  };

  const handleCancelAdImport = async () => {
    if (!(await confirmCancelEdit("确认取消本次广告费导入吗？未导入的内容将不会保留。"))) return;
    setPendingAdImport(null);
    setAdImportActions({});
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

  const adImportStats = useMemo(() => {
    if (!pendingAdImport) return null;
    const stats = {
      totalCount: pendingAdImport.records.length,
      totalAmount: 0,
      newCount: 0,
      newAmount: 0,
      overwriteCount: 0,
      overwriteAmount: 0,
      skipCount: 0,
      conflictCount: 0,
    };

    pendingAdImport.records.forEach((record) => {
      stats.totalAmount = roundMoney(stats.totalAmount + record.amount_rmb);
      const existingRows = pendingAdImport.existingByDate[record.expense_date] ?? [];
      if (existingRows.length === 0) {
        stats.newCount += 1;
        stats.newAmount = roundMoney(stats.newAmount + record.amount_rmb);
      } else if (existingRows.length === 1 && adImportActions[record.expense_date] === "overwrite") {
        stats.overwriteCount += 1;
        stats.overwriteAmount = roundMoney(stats.overwriteAmount + record.amount_rmb);
      } else {
        stats.skipCount += 1;
        if (existingRows.length > 1) stats.conflictCount += 1;
      }
    });

    return stats;
  }, [adImportActions, pendingAdImport]);

  return (
    <section className="page-stack">
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

      {pendingAdImport && adImportStats && (
        <div className="surface-card grid gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">广告费导入预览</h3>
              <p className="mt-1 text-xs text-slate-500">
                {pendingAdImport.fileName} · 解析 {pendingAdImport.records.length} 个付款日期 · 总交易金额 {formatCurrency(adImportStats.totalAmount)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCancelAdImport()}
              className="btn-secondary h-9 px-3 text-xs font-bold"
              disabled={adImporting}
            >
              取消导入
            </button>
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs font-semibold text-slate-500">可新增</div>
              <div className="mt-1 font-bold text-slate-900">{adImportStats.newCount} 条 · {formatCurrency(adImportStats.newAmount)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500">待覆盖</div>
              <div className="mt-1 font-bold text-slate-900">{adImportStats.overwriteCount} 条 · {formatCurrency(adImportStats.overwriteAmount)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500">将跳过</div>
              <div className="mt-1 font-bold text-slate-900">{adImportStats.skipCount} 条</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500">多条冲突</div>
              <div className="mt-1 font-bold text-slate-900">{adImportStats.conflictCount} 天</div>
            </div>
          </div>

          {pendingAdImport.invalidRows.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="font-semibold">已跳过 {pendingAdImport.invalidRows.length} 行异常数据</div>
              <div className="mt-1 text-xs">{pendingAdImport.invalidRows.slice(0, 5).join("；")}</div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-bold text-slate-500">
                  <th className="py-2 pr-3">付款日期</th>
                  <th className="py-2 pr-3 text-right">交易金额</th>
                  <th className="py-2 pr-3 text-right">服务费 / 税费</th>
                  <th className="py-2 pr-3">结算方式</th>
                  <th className="py-2 pr-3">现有记录</th>
                  <th className="py-2 pr-3">处理</th>
                </tr>
              </thead>
              <tbody>
                {pendingAdImport.records.map((record) => {
                  const existingRows = pendingAdImport.existingByDate[record.expense_date] ?? [];
                  const action = adImportActions[record.expense_date] ?? "skip";
                  return (
                    <tr key={record.expense_date} className="border-b border-slate-50">
                      <td className="py-2 pr-3 font-mono text-slate-600">{record.expense_date}</td>
                      <td className="money py-2 pr-3 text-right text-rose-700">{formatCurrency(record.amount_rmb)}</td>
                      <td className="money py-2 pr-3 text-right text-slate-600">
                        {formatCurrency(record.service_fee_rmb)} / {formatCurrency(record.tax_rmb)}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">{record.paymentMethods.join("、") || "--"}</td>
                      <td className="py-2 pr-3 text-slate-600">
                        {existingRows.length === 0
                          ? "无，新增"
                          : existingRows.length === 1
                            ? `已有 1 条：${formatCurrency(existingRows[0].amount_rmb)}`
                            : `已有 ${existingRows.length} 条，需手动整理`}
                      </td>
                      <td className="py-2 pr-3">
                        {existingRows.length === 0 ? (
                          <span className="text-xs font-semibold text-emerald-700">新增</span>
                        ) : existingRows.length === 1 ? (
                          <select
                            value={action}
                            onChange={(event) =>
                              setAdImportActions((current) => ({
                                ...current,
                                [record.expense_date]: event.target.value as AdPaymentImportAction,
                              }))
                            }
                            className="h-8 rounded-lg border border-line bg-white px-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-accent"
                          >
                            <option value="skip">跳过</option>
                            <option value="overwrite">覆盖</option>
                          </select>
                        ) : (
                          <span className="text-xs font-semibold text-amber-700">跳过</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => void handleCancelAdImport()}
              className="btn-secondary h-10 px-4 text-xs font-bold"
              disabled={adImporting}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmAdImport()}
              className="btn-primary h-10 px-4 text-xs font-bold"
              disabled={adImporting || (adImportStats.newCount === 0 && adImportStats.overwriteCount === 0)}
            >
              确认导入
            </button>
          </div>
        </div>
      )}

      <div className="surface-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-sm font-bold text-slate-800">其他核算杂费记录</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => adPaymentFileInputRef.current?.click()}
              disabled={!canEdit || adImporting}
              className="btn-secondary h-9 px-3 text-xs font-bold"
            >
              <Upload size={15} />
              {adImporting ? "解析中..." : "上传广告费"}
            </button>
            <input
              ref={adPaymentFileInputRef}
              type="file"
              aria-label="选择广告费支付明细文件"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => void handleAdPaymentFileChange(event)}
              className="hidden"
            />
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
              layout="auto"
              minWidth="min-w-max"
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
                {paginated.rows.map((expense) => {
                  const displayRemark = formatExpenseRemarkForDisplay(expense.remark);
                  return (
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
                          value={displayRemark}
                          lines={2}
                          alwaysShowDetail={displayRemark !== "--"}
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
                  );
                })}
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
