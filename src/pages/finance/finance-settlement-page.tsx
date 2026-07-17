import type { User } from "@supabase/supabase-js";
import { useState, useMemo, useEffect } from "react";
import { Plus, Trash2, AlertTriangle, Check, X, RefreshCw, Edit2, Search } from "lucide-react";
import { PageHeader, Badge, StandardTable, TableCellPreview } from "../../components/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { useFinanceData } from "./use-finance-data";
import {
  EmptyPanel,
  getReconciliationIssues,
  getAccountingStatus,
  formatCurrency,
  roundMoney,
  type FinanceOrderRow,
} from "./shared";
import { 
  parseSettlementData, 
  deleteSettlementFile, 
  addSettlementFile, 
  formatImportedAt,
} from "../../lib/settlement";
import { getErrorMessage } from "../../utils/errors";
import { updateSkuCode } from "../../lib/products";
import { updateTemuOrder } from "../../lib/orders";
import {
  getLogisticsMethodIdByName,
  getWarehouseLogisticsMethodNames,
  normalizeLogisticsMethodName,
} from "../../lib/logistics-methods";
import { confirmAction, confirmDelete, confirmSave } from "../../utils/confirmations";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notifications";
import { ActualShippingFeesPanel } from "../../components/finance/ActualShippingFeesPanel";

type Props = {
  user: User;
};

import {
  IncomeDateFilterMode,
  IncomeShippingMethodRow,
  settlementReconColumns,
  settlementIncomeColumns,
  getReconciliationIssueLabel,
  getCurrentMonthValue,
} from "./finance-settlement-helpers";
import { useFinanceAnalysis } from "./use-finance-analysis";


export function FinanceSettlementPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { data, settlementFiles, loading: baseLoading, error: baseError, reload: reloadBase } = useFinanceData(user.id, {
    products: true,
    settlements: true,
    logistics: true,
  });

  const [activeTab, setActiveTab] = useState<"files" | "shipping" | "recon" | "income">("files");

  const [importing, setImporting] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(false);
  
  // Pagination states
  const [reconPage, setReconPage] = useState(1);
  const [reconPageSize, setReconPageSize] = useState(20);

  const [incomePage, setIncomePage] = useState(1);
  const [incomePageSize, setIncomePageSize] = useState(20);

  // Income Tab states
  const [orderSearch, setOrderSearch] = useState("");
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [incomeDateFilterMode, setIncomeDateFilterMode] = useState<IncomeDateFilterMode>("all");
  const [incomeMonth, setIncomeMonth] = useState(getCurrentMonthValue());
  const [incomeStartDate, setIncomeStartDate] = useState("");
  const [incomeEndDate, setIncomeEndDate] = useState("");

  useEffect(() => {
    setReconPage(1);
  }, [reconPageSize]);

  useEffect(() => {
    setIncomePage(1);
  }, [incomePageSize, orderSearch, orderStatusFilter, incomeDateFilterMode, incomeMonth, incomeStartDate, incomeEndDate]);

  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingFeeValue, setEditingFeeValue] = useState("");
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);
  const [editingLogisticsOrderId, setEditingLogisticsOrderId] = useState<string | null>(null);
  const [editingLogisticsValue, setEditingLogisticsValue] = useState("");
  const [savingLogisticsOrderId, setSavingLogisticsOrderId] = useState<string | null>(null);

  const [matchingOrderId, setMatchingOrderId] = useState<string | null>(null);
  const [matchingSkuId, setMatchingSkuId] = useState("");

  // SKU Selection options
  const groupedSkuOptions = useMemo(() => {
    const skusByProduct = new Map<string, Array<{ id: string; label: string }>>();
    data.productSkus.forEach((sku) => {
      if (!sku.product_id) return;
      const list = skusByProduct.get(sku.product_id) ?? [];
      const entries = Object.entries(sku.attributes).map(([n, v]) => `${n}:${v}`).join("/");
      list.push({ id: sku.id!, label: `${sku.sku_code || "无货号"} (${entries || "无规格"})` });
      skusByProduct.set(sku.product_id, list);
    });
    return data.products.map((product) => {
      const list = skusByProduct.get(product.id) ?? [];
      return { product, list };
    }).filter((item) => item.list.length > 0);
  }, [data.products, data.productSkus]);

  const incomeDateStart = incomeDateFilterMode === "month" && incomeMonth
    ? `${incomeMonth}-01`
    : incomeDateFilterMode === "custom" ? incomeStartDate : "";
  const incomeDateEnd = incomeDateFilterMode === "month" && incomeMonth
    ? new Date(Date.UTC(Number(incomeMonth.slice(0, 4)), Number(incomeMonth.slice(5, 7)), 0)).toISOString().slice(0, 10)
    : incomeDateFilterMode === "custom" ? incomeEndDate : "";
  const incomeStatus = orderStatusFilter === "settled" || orderStatusFilter === "unsettled" ? orderStatusFilter : "all";
  const incomeIssue = orderStatusFilter === "settlement-overdue" || orderStatusFilter === "missing-shipping" || orderStatusFilter === "unmatched"
    ? orderStatusFilter : "all";
  const reconAnalysis = useFinanceAnalysis({
    page: reconPage, pageSize: reconPageSize,
    issue: showAllOrders ? "all" : "reconciliation",
  }, activeTab === "recon");
  const issueCountAnalysis = useFinanceAnalysis({ page: 1, pageSize: 1, issue: "reconciliation" });
  const incomeAnalysis = useFinanceAnalysis({
    page: incomePage, pageSize: incomePageSize, search: orderSearch,
    dateStart: incomeDateStart, dateEnd: incomeDateEnd,
    status: incomeStatus, issue: incomeIssue,
  }, activeTab === "income");
  const displayOrders = reconAnalysis.rows;
  const filteredOrderRows = incomeAnalysis.rows;
  const reconPaginated = { page: reconPage, rows: displayOrders, total: reconAnalysis.totalCount, totalPages: Math.max(1, Math.ceil(reconAnalysis.totalCount / reconPageSize)) };
  const incomePaginated = { page: incomePage, rows: filteredOrderRows, total: incomeAnalysis.totalCount, totalPages: Math.max(1, Math.ceil(incomeAnalysis.totalCount / incomePageSize)) };
  const incomeSummary = incomeAnalysis.summary;
  const incomeShippingMethodRows = incomeAnalysis.shippingMethods.map((row) => ({
    method: String(row.method ?? "未填写发货方式"),
    orderCount: Number(row.order_count ?? 0), quantity: Number(row.quantity ?? 0),
    actualShipping: Number(row.actual_shipping ?? 0), estimatedShipping: Number(row.estimated_shipping ?? 0),
    totalShipping: Number(row.total_shipping ?? 0), missingShippingCount: Number(row.missing_shipping_count ?? 0),
    averagePerOrder: Number(row.order_count ?? 0) > 0 ? roundMoney(Number(row.total_shipping ?? 0) / Number(row.order_count)) : 0,
  })) as IncomeShippingMethodRow[];
  const loading = baseLoading || reconAnalysis.loading || incomeAnalysis.loading || issueCountAnalysis.loading;
  const error = baseError || reconAnalysis.error || incomeAnalysis.error || issueCountAnalysis.error;
  const reload = async () => { await Promise.all([reloadBase(), reconAnalysis.reload(), incomeAnalysis.reload(), issueCountAnalysis.reload()]); };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!confirmAction(`确认导入结算文件 "${file.name}" 吗？已有订单结算记录会自动跳过，不会覆盖。`)) {
      e.target.value = "";
      return;
    }

    setImporting(true);
    try {
      const { readXlsxWorkbook } = await import("../../lib/tabular-parser");
      const workbook = await readXlsxWorkbook(file);
      const sheet = workbook.worksheets[0];
      if (!sheet || !sheet.data) throw new Error("文件为空");
      const records = parseSettlementData(sheet.data);
      if (records.length === 0) throw new Error("未解析到有效结算数据");
      
      const result = await addSettlementFile(user.id, file.name, records);
      if (result.importedRecordCount === 0) {
        notifyWarning(`没有新增结算记录。\n解析 ${result.parsedRecordCount} 条，已有数据跳过 ${result.skippedRecordCount} 条。`);
      } else {
        notifySuccess(
          `成功导入 ${result.importedRecordCount} 条结算记录！\n` +
          `已有数据跳过 ${result.skippedRecordCount} 条。\n` +
          `总回款（销售回款+销售冲回+运费回款+运费冲回）：${formatCurrency(result.totalRevenue)}`,
        );
      }
      await reload();
    } catch (err) {
      notifyError("导入失败: " + getErrorMessage(err, "请确保选择的是 SettledParentFlow 导出文件"));
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const handleDeleteFile = async (id: string) => {
    if (!confirmDelete("该结算文件")) return;
    try {
       await deleteSettlementFile(id);
       await reload();
    } catch (err) {
       notifyError("删除失败: " + getErrorMessage(err, "未知错误"));
    }
  };

  const handleSaveShippingFee = async (orderId: string, feeStr: string) => {
    const fee = Number(feeStr);
    if (Number.isNaN(fee) || fee < 0) {
      notifyWarning("金额无效");
      return;
    }
    if (!confirmSave()) return;
    setSavingOrderId(orderId);
    try {
      await updateTemuOrder(orderId, { actual_shipping_fee_rmb: fee });
      setEditingOrderId(null);
      await reload();
    } catch (err) {
      notifyError("更新失败: " + getErrorMessage(err, "未知错误"));
    } finally {
      setSavingOrderId(null);
    }
  };

  const getOrderLogisticsOptions = (row: FinanceOrderRow) => {
    const warehouseId = row.order.warehouse_id ?? "";
    const options = warehouseId
      ? getWarehouseLogisticsMethodNames(
          warehouseId,
          data.logisticsMethods,
          data.warehouseLogisticsMethods,
        )
      : [];
    const current = normalizeLogisticsMethodName(row.order.logistics_method || "");
    return current && !options.includes(current) ? [...options, current] : options;
  };

  const startEditingLogisticsMethod = (row: FinanceOrderRow) => {
    setEditingLogisticsOrderId(row.order.id);
    setEditingLogisticsValue(normalizeLogisticsMethodName(row.order.logistics_method || ""));
  };

  const handleSaveLogisticsMethod = async (orderId: string, methodValue: string) => {
    const logisticsMethod = normalizeLogisticsMethodName(methodValue);
    if (!logisticsMethod) {
      notifyWarning("请选择发货方式");
      return;
    }
    if (!confirmSave()) return;
    setSavingLogisticsOrderId(orderId);
    try {
      await updateTemuOrder(orderId, {
        logistics_method_id: getLogisticsMethodIdByName(
          logisticsMethod,
          data.logisticsMethods,
        ),
        logistics_method: logisticsMethod,
      });
      setEditingLogisticsOrderId(null);
      await reload();
    } catch (err) {
      notifyError("更新发货方式失败: " + getErrorMessage(err, "未知错误"));
    } finally {
      setSavingLogisticsOrderId(null);
    }
  };

  const renderLogisticsMethodCell = (row: FinanceOrderRow) => {
    const options = getOrderLogisticsOptions(row);
    const current = normalizeLogisticsMethodName(row.order.logistics_method || "");
    const isEditing = editingLogisticsOrderId === row.order.id;
    const isSaving = savingLogisticsOrderId === row.order.id;

    if (isEditing) {
      return (
        <div className="flex items-center gap-1.5">
          <select
            value={editingLogisticsValue}
            onChange={(event) => setEditingLogisticsValue(event.target.value)}
            disabled={isSaving || options.length === 0}
            className="h-8 w-36 rounded border border-line bg-white px-2 text-xs font-semibold outline-none focus:border-accent disabled:bg-slate-50 disabled:text-slate-400"
            autoFocus
          >
            <option value="">选择发货方式</option>
            {options.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => handleSaveLogisticsMethod(row.order.id, editingLogisticsValue)}
            disabled={!editingLogisticsValue || isSaving}
            className="rounded-lg bg-emerald-500 p-1 text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            onClick={() => setEditingLogisticsOrderId(null)}
            className="rounded-lg bg-slate-200 p-1 text-slate-600 hover:bg-slate-300"
          >
            <X size={12} />
          </button>
        </div>
      );
    }

    if (row.order.logistics_method_is_unmatched) {
      return (
        <span className="text-xs font-semibold text-amber-700">
          未匹配物流方式（{current}）
        </span>
      );
    }

    return (
      <div className="group flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate font-semibold ${current ? "text-slate-700" : "text-rose-600"}`}>
            {current || "缺发货方式"}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => startEditingLogisticsMethod(row)}
              disabled={!row.order.warehouse_id || options.length === 0}
              className={`rounded bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-600 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
                current ? "opacity-0 group-hover:opacity-100" : ""
              }`}
            >
              {current ? "修改" : "补发货方式"}
            </button>
          )}
        </div>
        <span className="truncate font-mono text-[10px] text-slate-400">
          {row.order.logistics_tracking_no || (options.length === 0 ? "当前仓库未配置发货方式" : "--")}
        </span>
      </div>
    );
  };

  const handleLinkSkuCode = async (temuSkuCode: string, skuId: string) => {
    if (!confirmAction(`确认将 SKU 货号关联为 ${temuSkuCode} 吗？`)) return;
    try {
      await updateSkuCode(skuId, temuSkuCode);
      setMatchingOrderId(null);
      notifySuccess(`已成功将 SKU 货号关联为: ${temuSkuCode}`);
      await reload();
    } catch (err) {
      notifyError("关联失败: " + getErrorMessage(err, "未知错误"));
    }
  };

  return (
    <section className="page-stack">
      <PageHeader
        title="结算与对账"
        description="管理 Temu 结算文件、排查对账异常、查看订单收入明细。"
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

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b border-line px-1">
        <button
          onClick={() => setActiveTab("files")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "files" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          结算文件
        </button>
        <button
          onClick={() => { setActiveTab("recon"); setReconPage(1); }}
          className={`pb-3 text-sm font-bold transition-colors flex items-center gap-1.5 ${
            activeTab === "recon" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          对账排查
          {issueCountAnalysis.totalCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
              {issueCountAnalysis.totalCount > 99 ? '99+' : issueCountAnalysis.totalCount}
            </span>
          )}
        </button>
        <button
          onClick={() => { setActiveTab("income"); setIncomePage(1); }}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "income" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          收入明细
        </button>
        <button
          onClick={() => setActiveTab("shipping")}
          className={`pb-3 text-sm font-bold transition-colors ${
            activeTab === "shipping" ? "border-b-2 border-accent text-accentDeep" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          物流商月结
        </button>
      </div>

      <div className="surface-card p-5">
        {(activeTab === "recon" || activeTab === "income") && settlementFiles.length === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-5 flex items-start gap-3">
            <AlertTriangle className="text-amber-500 mt-0.5" size={20} />
            <div>
              <h4 className="text-sm font-bold text-amber-800">尚未导入结算文件，请先在「结算文件」Tab 导入 Temu SettledParentFlow 文件</h4>
              <p className="text-xs text-amber-700 mt-1">系统当前无法对订单的实际回款进行准确核算。订单签收超过一个月仍无结算数据时，会进入对账排查。</p>
            </div>
          </div>
        )}

        {/* Tab 1: 结算文件 */}
        {activeTab === "files" && (
          <div className="animate-in fade-in duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
              <h3 className="text-sm font-bold text-slate-800">结算文件管理</h3>
              <label className="btn-primary h-10 px-4 cursor-pointer text-xs font-bold inline-flex items-center gap-2">
                <Plus size={16} />
                {importing ? "解析中..." : "导入 Temu 结算文件"}
                <input type="file" accept=".xlsx" className="hidden" disabled={!canEdit || importing} onChange={handleImport} />
              </label>
            </div>

            {settlementFiles.length === 0 ? (
              <EmptyPanel label="暂未导入任何结算文件" />
            ) : (
              <StandardTable 
                minWidth="min-w-max"
                page={1}
                pageSize={100}
                totalPages={1}
                totalRecordCount={settlementFiles.length}
                onPageChange={() => {}}
                onPageSizeChange={() => {}}
              >
                <thead>
                  <tr>
                    <th className="bg-slate-50">上传时间</th>
                    <th className="bg-slate-50">文件名</th>
                    <th className="number-cell bg-slate-50 px-3 py-2">导入记录数</th>
                    <th className="number-cell bg-slate-50 px-3 py-2">结算总金额</th>
                    <th className="text-center bg-slate-50">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {settlementFiles.map((file) => (
                    <tr key={file.id} className="hover:bg-slate-50/50">
                      <td className="text-slate-500 font-mono text-xs">{formatImportedAt(file.importedAt)}</td>
                      <td className="font-bold text-slate-800 text-xs">{file.fileName}</td>
                      <td className="number-cell font-semibold px-3 py-2">{file.recordCount}</td>
                      <td className="money text-emerald-700 px-3 py-2">{formatCurrency(file.totalRevenue)}</td>
                      <td className="text-center">
                        <button
                          type="button"
                          onClick={() => handleDeleteFile(file.id)}
                          className="text-rose-600 hover:text-rose-800 font-semibold text-xs inline-flex items-center gap-1 transition"
                        >
                          <Trash2 size={12} /> 删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </StandardTable>
            )}
          </div>
        )}

        {activeTab === "shipping" && (
          <ActualShippingFeesPanel canEdit={canEdit} onImported={reload} />
        )}

        {/* Tab 2: 对账排查 */}
        {activeTab === "recon" && (
          <div className="animate-in fade-in duration-300">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold text-slate-800">异常订单排查</h3>
                {!showAllOrders && (
                  <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-600">
                    共 {reconAnalysis.totalCount} 项待处理
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={showAllOrders} onChange={(e) => { setShowAllOrders(e.target.checked); setReconPage(1); }} className="rounded border-line text-accent focus:ring-accent/20" />
                  <span className="text-slate-700">显示所有订单</span>
                </label>
              </div>
            </div>
            
            {loading && displayOrders.length === 0 ? (
              <EmptyPanel label="加载中..." />
            ) : displayOrders.length === 0 ? (
              <EmptyPanel label={showAllOrders ? "暂无订单数据" : "太棒了！所有订单已自动对账完成，暂无异常记录。"} />
            ) : (
              <>
                <StandardTable 
                  minWidth="min-w-max"
                  columns={settlementReconColumns}
                  layout="auto"
                  page={reconPaginated.page}
                  pageSize={reconPageSize}
                  totalPages={reconPaginated.totalPages}
                  totalRecordCount={reconPaginated.total}
                  onPageChange={setReconPage}
                  onPageSizeChange={setReconPageSize}
                >
                  <thead>
                    <tr>
                      <th className="bg-slate-50">订单号</th>
                      <th className="bg-slate-50">Temu SKU Code</th>
                      <th className="bg-slate-50">系统匹配商品 / 订单规格</th>
                      <th className="bg-slate-50">异常状态</th>
                      <th className="bg-slate-50">发货方式</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">核算运费</th>
                      <th className="text-center bg-slate-50">操作对账</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconPaginated.rows.map((row) => {
                      const issueTypes = getReconciliationIssues(row);
                      const accountingStatus = getAccountingStatus(row);
                      return (
                        <tr key={row.order.id} className="hover:bg-slate-50/50">
                        <td
                          className="font-semibold text-slate-800"
                          data-full-text={row.order.order_no}
                        >
                          <span className="table-cell-clamp">{row.order.order_no}</span>
                        </td>
                        <td
                          className="font-mono text-slate-600 text-xs font-bold"
                          data-full-text={row.order.sku_code || "--"}
                        >
                          <span className="table-cell-clamp">{row.order.sku_code || "--"}</span>
                        </td>
                        <td
                          className="text-slate-700 font-medium"
                          data-full-text={row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}
                        >
                          <TableCellPreview
                            label={row.product ? "系统匹配商品" : "订单规格"}
                            value={row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}
                            lines={2}
                            alwaysShowDetail
                            detailTitle={row.product ? "系统匹配商品" : "订单规格"}
                            detailSubtitle={row.order.order_no}
                          />
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            {issueTypes.length === 0 ? (
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-600">
                                <Check size={12} /> 无异常
                              </span>
                            ) : (
                              issueTypes.map((issue) => (
                                <span key={issue} className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                                  <AlertTriangle size={12} /> {getReconciliationIssueLabel(issue)}
                                </span>
                              ))
                            )}
                          </div>
                          {row.warehouseLogisticsIssue && (
                            <p className="mt-1 text-xs font-semibold text-amber-600">
                              {row.warehouseLogisticsIssue}
                            </p>
                          )}
                        </td>
                        <td>{renderLogisticsMethodCell(row)}</td>
                        <td className="money px-3 py-2">
                          {editingOrderId === row.order.id ? (
                            <div className="flex items-center gap-1 justify-end">
                              <input
                                type="number"
                                value={editingFeeValue}
                                onChange={(e) => setEditingFeeValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveShippingFee(row.order.id, editingFeeValue);
                                  else if (e.key === "Escape") setEditingOrderId(null);
                                }}
                                className="h-8 w-20 rounded-xl border border-slate-350 bg-white px-2 text-xs outline-none text-right font-bold"
                                autoFocus
                              />
                              <button onClick={() => handleSaveShippingFee(row.order.id, editingFeeValue)} className="rounded-lg bg-emerald-500 p-1 text-white hover:bg-emerald-600"><Check size={12}/></button>
                              <button onClick={() => setEditingOrderId(null)} className="rounded-lg bg-slate-200 p-1 text-slate-600 hover:bg-slate-300"><X size={12}/></button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 group justify-end">
                              {row.shippingFeeSource === "missing" ? (
                                <span className="text-rose-600 font-bold">缺失运费</span>
                              ) : (
                                <>
                                  <span className={row.isShippingFeeEstimated ? "text-accent font-semibold" : "font-bold text-slate-900"}>{formatCurrency(row.shippingFeeRmb)}</span>
                                  <span className={`rounded px-1 py-0.2 text-[9px] font-black ${row.shippingFeeSource === "actual" ? "bg-emerald-50 text-emerald-600" : "bg-accentSoft text-accent"}`}>
                                    {row.shippingFeeSource === "actual" ? "实际" : "自动估算"}
                                  </span>
                                </>
                              )}
                              {canEdit && (
                                <button onClick={() => { setEditingOrderId(row.order.id); setEditingFeeValue(row.lastLegShippingRmb > 0 ? String(row.lastLegShippingRmb) : ""); }} className="rounded bg-sky-50 px-2 py-0.5 text-sky-600 text-[10px] font-bold opacity-0 group-hover:opacity-100">
                                  填实际
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-center">
                          {!row.matched ? (
                            matchingOrderId === row.order.id ? (
                              <div className="flex items-center gap-1.5 justify-center">
                                <select value={matchingSkuId} onChange={(e) => setMatchingSkuId(e.target.value)} className="h-8 w-44 rounded border border-line bg-white px-2 text-xs font-semibold">
                                  <option value="">选择系统 SKU</option>
                                  {groupedSkuOptions.map((group) => (
                                    <optgroup key={group.product.id} label={`${group.product.product_code} · ${group.product.product_name_cn}`}>
                                      {group.list.map((item) => (
                                        <option key={item.id} value={item.id}>{item.label}</option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                                <button onClick={() => handleLinkSkuCode(row.order.sku_code, matchingSkuId)} disabled={!matchingSkuId} className="rounded bg-accent px-2 py-1 text-white text-xs font-bold disabled:opacity-50">关联</button>
                                <button onClick={() => setMatchingOrderId(null)} className="rounded bg-slate-200 px-2 py-1 text-slate-700 text-xs font-bold">取消</button>
                              </div>
                            ) : (
                              <button onClick={() => { setMatchingOrderId(row.order.id); setMatchingSkuId(""); }} className="rounded-lg bg-accentSoft px-3 py-1 text-accent hover:bg-accentSoft text-xs font-bold">
                                关联商品 SKU
                              </button>
                            )
                          ) : (
                            <span className={`font-bold text-xs px-2 py-1 rounded border ${accountingStatus.tone === "danger" ? "bg-rose-50 text-rose-700 border-rose-100" : accountingStatus.tone === "warning" ? "bg-amber-50 text-amber-700 border-amber-100" : "bg-emerald-50 text-emerald-600 border-emerald-100"}`}>
                                {accountingStatus.label}
                            </span>
                          )}
                        </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </StandardTable>
              </>
            )}
          </div>
        )}

        {/* Tab 3: 收入明细 */}
        {activeTab === "income" && (
          <div className="animate-in fade-in duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    value={orderSearch}
                    onChange={(e) => { setOrderSearch(e.target.value); setIncomePage(1); }}
                    placeholder="搜索订单/单号/商品..."
                    className="h-9 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm outline-none focus:border-accent sm:w-64"
                  />
                </div>
                <select
                  value={orderStatusFilter}
                  onChange={(e) => { setOrderStatusFilter(e.target.value); setIncomePage(1); }}
                  className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent"
                >
                  <option value="all">全部订单</option>
                  <option value="unsettled">未结算订单</option>
                  <option value="settled">已结算订单</option>
                  <option value="settlement-overdue">异常: 签收超期未结算</option>
                  <option value="unmatched">异常: 未匹配SKU</option>
                  <option value="missing-shipping">异常: 缺发货方式/运费</option>
                </select>
                <select
                  value={incomeDateFilterMode}
                  onChange={(e) => {
                    setIncomeDateFilterMode(e.target.value as IncomeDateFilterMode);
                    setIncomePage(1);
                  }}
                  className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent"
                >
                  <option value="all">全部时间</option>
                  <option value="month">按月筛选</option>
                  <option value="custom">自定义时间段</option>
                </select>
                {incomeDateFilterMode === "month" && (
                  <input
                    type="month"
                    value={incomeMonth}
                    onChange={(e) => { setIncomeMonth(e.target.value); setIncomePage(1); }}
                    className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent"
                  />
                )}
                {incomeDateFilterMode === "custom" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={incomeStartDate}
                      onChange={(e) => { setIncomeStartDate(e.target.value); setIncomePage(1); }}
                      className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent"
                    />
                    <span className="text-xs font-semibold text-slate-400">至</span>
                    <input
                      type="date"
                      value={incomeEndDate}
                      onChange={(e) => { setIncomeEndDate(e.target.value); setIncomePage(1); }}
                      className="h-9 rounded-lg border border-line bg-white px-3 text-xs font-semibold outline-none focus:border-accent"
                    />
                  </div>
                )}
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
                筛选后共 {incomeAnalysis.totalCount} 单
              </span>
            </div>

            {loading && filteredOrderRows.length === 0 ? (
              <EmptyPanel label="加载中..." />
            ) : filteredOrderRows.length === 0 ? (
              <EmptyPanel label="未找到匹配的订单记录" />
            ) : (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">订单商品成本</div>
                    <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(incomeSummary.productCost)}</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">头程运费</div>
                    <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(incomeSummary.firstLegShipping)}</div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-400">合计核算运费 {formatCurrency(incomeSummary.shipping)}</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">尾程运费</div>
                    <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(incomeSummary.lastLegShipping)}</div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-400">缺失 {incomeSummary.missingShippingCount} 单</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">总预估账单</div>
                    <div className="money mt-1 text-lg font-bold text-slate-900">{formatCurrency(incomeSummary.bill)}</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">实际结算回款</div>
                    <div className="money mt-1 text-lg font-bold text-[#0c5132]">{formatCurrency(incomeSummary.actualRevenue)}</div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-400">已结算 {incomeSummary.settledCount} / {incomeSummary.orderCount} 单</div>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <div className="text-xs font-semibold text-slate-500">已结算利润</div>
                    <div className={`money mt-1 text-lg font-bold ${incomeSummary.profit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatCurrency(incomeSummary.profit)}</div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-400">仅统计已结算订单</div>
                  </div>
                </div>

                <div className="mb-5 rounded-lg border border-slate-100 bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5">
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">发货方式运费明细</h4>
                      <p className="mt-0.5 text-xs text-slate-400">按当前筛选结果统计；实际运费优先，没有实际运费时使用自动估算运费。</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
                      共 {incomeShippingMethodRows.length} 种发货方式
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[780px] text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 text-left text-xs font-bold text-slate-500">
                          <th className="py-2 pl-3 pr-3">发货方式</th>
                          <th className="py-2 pr-3 text-right">订单数</th>
                          <th className="py-2 pr-3 text-right">件数</th>
                          <th className="py-2 pr-3 text-right">实际运费</th>
                          <th className="py-2 pr-3 text-right">估算运费</th>
                          <th className="py-2 pr-3 text-right">总运费</th>
                          <th className="py-2 pr-3 text-right">单均</th>
                          <th className="py-2 pr-3 text-right">缺失</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incomeShippingMethodRows.map((row) => (
                          <tr key={row.method} className="border-b border-slate-50 last:border-0">
                            <td className="py-2 pl-3 pr-3 font-semibold text-slate-800">
                              <TableCellPreview
                                label="发货方式"
                                value={row.method}
                                lines={1}
                                alwaysShowDetail={row.method.length > 18}
                                detailTitle="发货方式"
                              />
                            </td>
                            <td className="py-2 pr-3 text-right font-semibold text-slate-700">{row.orderCount}</td>
                            <td className="py-2 pr-3 text-right font-semibold text-slate-700">{row.quantity}</td>
                            <td className="money py-2 pr-3 text-right text-emerald-700">{formatCurrency(row.actualShipping)}</td>
                            <td className="money py-2 pr-3 text-right text-amber-700">{formatCurrency(row.estimatedShipping)}</td>
                            <td className="money py-2 pr-3 text-right font-bold text-slate-900">{formatCurrency(row.totalShipping)}</td>
                            <td className="money py-2 pr-3 text-right text-slate-700">{formatCurrency(row.averagePerOrder)}</td>
                            <td className={`py-2 pr-3 text-right font-semibold ${row.missingShippingCount > 0 ? "text-rose-700" : "text-slate-400"}`}>
                              {row.missingShippingCount}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <StandardTable 
                  minWidth="min-w-max"
                  tableClassName="finance-freeze-order"
                  columns={settlementIncomeColumns}
                  layout="auto"
                  page={incomePaginated.page}
                  pageSize={incomePageSize}
                  totalPages={incomePaginated.totalPages}
                  totalRecordCount={incomePaginated.total}
                  onPageChange={setIncomePage}
                  onPageSizeChange={setIncomePageSize}
                >
                  <thead>
                    <tr>
                      <th className="number-cell bg-slate-50 w-16 px-3 py-2">序号</th>
                      <th className="bg-slate-50">订单编号</th>
                      <th className="bg-slate-50">Temu SKU Code</th>
                      <th className="bg-slate-50">系统匹配商品</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">订单商品成本</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">头程运费</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">尾程运费</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">总预估账单</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">实际结算回款</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">利润</th>
                      <th className="bg-slate-50">发货方式</th>
                      <th className="bg-slate-50">结算状态</th>
                      <th className="bg-slate-50">财务对账</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomePaginated.rows.map((row, index) => {
                      const accountingStatus = getAccountingStatus(row);
                      return (
                        <tr key={row.order.id} className="hover:bg-slate-50/50">
                          <td className="number-cell text-slate-400 font-mono text-xs px-3 py-2">
                            {(incomePaginated.page - 1) * incomePageSize + index + 1}
                          </td>
                          <td
                            className="font-semibold text-slate-800"
                            data-full-text={row.order.order_no}
                          >
                            <span className="table-cell-clamp">{row.order.order_no}</span>
                          </td>
                          <td
                            className="font-mono text-slate-600 text-xs"
                            data-full-text={row.order.sku_code || "--"}
                          >
                            <span className="table-cell-clamp">{row.order.sku_code || "--"}</span>
                          </td>
                          <td
                            className="text-slate-700 font-medium"
                            data-full-text={row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}
                          >
                            <TableCellPreview
                              label={row.product ? "系统匹配商品" : "订单规格"}
                              value={row.product ? row.product.product_name_cn : `规格: ${row.order.product_attributes || "--"}`}
                              lines={2}
                              alwaysShowDetail
                              detailTitle={row.product ? "系统匹配商品" : "订单规格"}
                              detailSubtitle={row.order.order_no}
                            />
                          </td>
                          <td className="money text-slate-500 px-3 py-2">{formatCurrency(row.productCostRmb)}</td>
                          {/* 头程运费 */}
                          <td className="money px-3 py-2">
                            {row.firstLegShippingRmb > 0 ? (
                              <span className="font-semibold text-slate-700">{formatCurrency(row.firstLegShippingRmb)}</span>
                            ) : (
                              <span className="text-slate-300">--</span>
                            )}
                          </td>
                          {/* 尾程运费 */}
                          <td className="px-3 py-2 text-right">
                            {editingOrderId === row.order.id ? (
                              <div className="inline-flex items-center gap-1 justify-end">
                                <input
                                  type="number"
                                  value={editingFeeValue}
                                  onChange={(e) => setEditingFeeValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSaveShippingFee(row.order.id, editingFeeValue);
                                    else if (e.key === "Escape") setEditingOrderId(null);
                                  }}
                                  disabled={savingOrderId === row.order.id}
                                  className="h-8 w-16 rounded border border-line px-1 text-xs outline-none text-right font-bold"
                                  autoFocus
                                />
                                <button onClick={() => handleSaveShippingFee(row.order.id, editingFeeValue)} className="text-emerald-600"><Check size={14}/></button>
                                <button onClick={() => setEditingOrderId(null)} className="text-slate-400"><X size={14}/></button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1 group justify-end">
                                {row.shippingFeeSource === "missing" ? (
                                  <span className="money text-rose-600 font-bold">缺失</span>
                                ) : (
                                  <>
                                    <span className={`money ${row.shippingFeeSource === "actual" ? "font-bold text-slate-900" : "text-accent font-semibold"}`}>{formatCurrency(row.lastLegShippingRmb)}</span>
                                    {row.shippingFeeSource === "actual" ? (
                                      <span className="rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-black text-emerald-600">实际</span>
                                    ) : (
                                      <span className="rounded bg-accentSoft px-1 py-0.5 text-[9px] font-black text-accent">估算</span>
                                    )}
                                  </>
                                )}
                                {canEdit && (
                                  <button onClick={() => { setEditingOrderId(row.order.id); setEditingFeeValue(row.lastLegShippingRmb > 0 ? String(row.lastLegShippingRmb) : ""); }} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 p-1">
                                    <Edit2 size={12} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="money text-slate-500 px-3 py-2">{formatCurrency(row.billAmountRmb)}</td>
                          <td className="money px-3 py-2">
                            {row.isSettled ? <span className="font-bold text-[#0c5132]">{formatCurrency(row.actualRevenueRmb)}</span> : <span className="text-slate-400 font-medium">未结算</span>}
                          </td>
                          {/* 利润 */}
                          <td className="money px-3 py-2">
                            {row.isSettled ? (() => {
                              const profit = roundMoney(row.actualRevenueRmb - row.billAmountRmb);
                              return <span className={`font-bold ${profit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatCurrency(profit)}</span>;
                            })() : <span className="text-slate-300 text-xs">--</span>}
                          </td>
                          <td>{renderLogisticsMethodCell(row)}</td>
                          <td>
                            <Badge tone={row.isSettled ? "success" : "neutral"}>
                              {row.isSettled ? "已结算" : "未结算"}
                            </Badge>
                          </td>
                          <td>
                            <Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line bg-slate-50 font-bold">
                      <td colSpan={4} className="px-3 py-2 text-slate-600">当前筛选合计</td>
                      <td className="money px-3 py-2 text-slate-700">{formatCurrency(incomeSummary.productCost)}</td>
                      <td className="money px-3 py-2 text-slate-700">{formatCurrency(incomeSummary.firstLegShipping)}</td>
                      <td className="money px-3 py-2 text-slate-700">{formatCurrency(incomeSummary.lastLegShipping)}</td>
                      <td className="money px-3 py-2 text-slate-700">{formatCurrency(incomeSummary.bill)}</td>
                      <td className="money px-3 py-2 text-[#0c5132]">{formatCurrency(incomeSummary.actualRevenue)}</td>
                      <td className={`money px-3 py-2 ${incomeSummary.profit >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatCurrency(incomeSummary.profit)}</td>
                      <td colSpan={3} className="px-3 py-2 text-xs text-slate-500">
                        {incomeSummary.orderCount} 单，{incomeSummary.quantity} 件，缺失运费 {incomeSummary.missingShippingCount} 单
                      </td>
                    </tr>
                  </tfoot>
                </StandardTable>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
