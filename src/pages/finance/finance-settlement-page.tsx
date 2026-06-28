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
  buildSkuLookup,
  getOrderSku,
  estimateOrderShippingFee,
  roundMoney,
  getPaginatedRows,
  renderPaginationControls,
  getOrderQuantity,
  getSkuUnitCostRmb,
  getResolvedSettlementMetrics,
} from "./shared";
import { 
  parseSettlementData, 
  deleteSettlementFile, 
  addSettlementFile, 
  formatDateRange,
} from "../../lib/settlement";
import { buildSettlementLookup } from "../../lib/settlement";
import { getErrorMessage } from "../../utils/errors";
import { updateSkuCode } from "../../lib/products";
import { updateTemuOrder } from "../../lib/orders";
import { confirmAction, confirmDelete, confirmSave } from "../../utils/confirmations";

type Props = {
  user: User;
};

const settlementReconColumns = [
  { key: "status", width: "9rem" },
  { key: "order_no", width: "13rem" },
  { key: "sku_code", width: "13rem" },
  { key: "suggestion", width: "20rem" },
  { key: "shipping_fee", width: "10rem" },
  { key: "actions", width: "14rem" },
] as const;

const settlementIncomeColumns = [
  { key: "index", width: "4rem" },
  { key: "order_no", width: "13rem" },
  { key: "sku_code", width: "13rem" },
  { key: "product", width: "18rem" },
  { key: "product_cost", width: "10rem" },
  { key: "shipping_fee", width: "10rem" },
  { key: "bill", width: "10rem" },
  { key: "revenue", width: "10rem" },
  { key: "logistics", width: "13rem" },
  { key: "settlement", width: "8rem" },
  { key: "accounting", width: "8rem" },
] as const;

export function FinanceSettlementPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { data, settlementFiles, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    products: true,
    settlements: true,
  });

  const [activeTab, setActiveTab] = useState<"files" | "recon" | "income">("files");

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

  useEffect(() => {
    setReconPage(1);
  }, [reconPageSize]);

  useEffect(() => {
    setIncomePage(1);
  }, [incomePageSize, orderSearch, orderStatusFilter]);

  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingFeeValue, setEditingFeeValue] = useState("");
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);

  const [matchingOrderId, setMatchingOrderId] = useState<string | null>(null);
  const [matchingSkuId, setMatchingSkuId] = useState("");
  const [linkingOrderId, setLinkingOrderId] = useState<string | null>(null);

  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles || []), [settlementFiles]);
  
  // SKU Selection options
  const groupedSkuOptions = useMemo(() => {
    const skusByProduct = new Map<string, Array<{ id: string; label: string }>>();
    data.productSkus.forEach((sku: any) => {
      if (!sku.product_id) return;
      const list = skusByProduct.get(sku.product_id) ?? [];
      const entries = Object.entries(sku.attributes).map(([n, v]) => `${n}:${v}`).join("/");
      list.push({ id: sku.id!, label: `${sku.sku_code || "无货号"} (${entries || "无规格"})` });
      skusByProduct.set(sku.product_id, list);
    });
    return data.products.map((product: any) => {
      const list = skusByProduct.get(product.id) ?? [];
      return { product, list };
    }).filter((item: any) => item.list.length > 0);
  }, [data.products, data.productSkus]);

  const productItemsById = useMemo(() => new Map<string, any>(data.productItems.map((item: any) => [item.id!, item])), [data.productItems]);
  const productsById = useMemo(() => new Map<string, any>(data.products.map((product: any) => [product.id, product])), [data.products]);
  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);
  
  const orderRows = useMemo(() => {
    return data.orders.map((order: any) => {
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? data.products.find((p: any) => p.id === sku.product_id) ?? null : null;
      const quantity = getOrderQuantity(order);
      
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const shippingFeeSource = actualShippingFeeRmb > 0 ? "actual" : estimatedShippingRmb > 0 ? "estimated" : "missing";
      const shippingFeeRmb = roundMoney(shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedShippingRmb);
      
      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      const productCostRmb = roundMoney(unitCost * quantity);

      const { actualSalesRevenueRmb, actualFreightRevenueRmb, isSettled } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      const actualRevenueRmb = roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);

      return {
        order,
        sku,
        product,
        productCostRmb,
        shippingFeeRmb,
        shippingFeeSource,
        isShippingFeeEstimated: shippingFeeSource === "estimated",
        billAmountRmb: roundMoney(productCostRmb + shippingFeeRmb),
        actualRevenueRmb,
        isSettled,
        matched: Boolean(sku && product),
      };
    });
  }, [data.orders, skuLookup, data.products, settings, productItemsById, settlementLookup]);

  // Reconciliation data
  const displayOrders = useMemo(() => {
    if (showAllOrders) return orderRows;
    return orderRows.filter((row: any) => getReconciliationIssues(row as any).length > 0);
  }, [orderRows, showAllOrders]);

  const reconPaginated = getPaginatedRows("finance-recon", displayOrders, reconPage, reconPageSize);

  // Income data
  const filteredOrderRows = useMemo(() => {
    let result = orderRows;
    if (orderStatusFilter === "unsettled") result = result.filter((r: any) => !r.isSettled);
    else if (orderStatusFilter === "settled") result = result.filter((r: any) => r.isSettled);
    else if (orderStatusFilter === "missing-shipping") result = result.filter((r: any) => r.shippingFeeSource === "missing");
    else if (orderStatusFilter === "unmatched") result = result.filter((r: any) => !r.matched);

    if (orderSearch.trim()) {
      const q = orderSearch.toLowerCase();
      result = result.filter((r: any) => {
        const str = [
          r.order.order_no, r.order.sub_order_no, r.order.sku_code, r.order.product_attributes,
          r.order.logistics_tracking_no, r.product?.product_code, r.product?.product_name_cn
        ].join(" ").toLowerCase();
        return str.includes(q);
      });
    }
    return result.sort((a: any, b: any) => new Date(b.order.created_at || 0).getTime() - new Date(a.order.created_at || 0).getTime());
  }, [orderRows, orderSearch, orderStatusFilter]);

  const incomePaginated = getPaginatedRows("finance-income", filteredOrderRows, incomePage, incomePageSize);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // 检查是否覆盖
    const existing = settlementFiles.find(f => f.fileName === file.name);
    if (existing) {
       if (!confirmAction(`文件 "${file.name}" 已存在。继续导入将覆盖原有数据。是否继续？`)) {
          e.target.value = "";
          return;
       }
    }
    if (!confirmAction(`确认导入结算文件 "${file.name}" 吗？`)) {
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
      
      const newFile = await addSettlementFile(user.id, file.name, records as any);
      alert(`成功导入 ${records.length} 条结算记录！\n总回款：${formatCurrency(newFile.totalRevenue)}`);
      await reload();
    } catch (err) {
      alert("导入失败: " + getErrorMessage(err, "请确保选择的是 SettledParentFlow 导出文件"));
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
       alert("删除失败: " + getErrorMessage(err, "未知错误"));
    }
  };

  const handleSaveShippingFee = async (orderId: string, feeStr: string) => {
    const fee = Number(feeStr);
    if (Number.isNaN(fee) || fee < 0) return alert("金额无效");
    if (!confirmSave()) return;
    setSavingOrderId(orderId);
    try {
      await updateTemuOrder(orderId, { actual_shipping_fee_rmb: fee });
      setEditingOrderId(null);
      await reload();
    } catch (err) {
      alert("更新失败: " + getErrorMessage(err, "未知错误"));
    } finally {
      setSavingOrderId(null);
    }
  };

  const handleLinkSkuCode = async (orderId: string, temuSkuCode: string, skuId: string) => {
    if (!confirmAction(`确认将 SKU 货号关联为 ${temuSkuCode} 吗？`)) return;
    setLinkingOrderId(orderId);
    try {
      await updateSkuCode(skuId, temuSkuCode);
      setMatchingOrderId(null);
      alert(`已成功将 SKU 货号关联为: ${temuSkuCode}`);
      await reload();
    } catch (err) {
      alert("关联失败: " + getErrorMessage(err, "未知错误"));
    } finally {
      setLinkingOrderId(null);
    }
  };

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
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
          {orderRows.filter((r: any) => getReconciliationIssues(r).length > 0).length > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
              {orderRows.filter((r: any) => getReconciliationIssues(r).length > 0).length > 99 ? '99+' : orderRows.filter((r: any) => getReconciliationIssues(r).length > 0).length}
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
      </div>

      <div className="surface-card p-5">
        {(activeTab === "recon" || activeTab === "income") && settlementFiles.length === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-5 flex items-start gap-3">
            <AlertTriangle className="text-amber-500 mt-0.5" size={20} />
            <div>
              <h4 className="text-sm font-bold text-amber-800">尚未导入结算文件，请先在「结算文件」Tab 导入 Temu SettledParentFlow 文件</h4>
              <p className="text-xs text-amber-700 mt-1">系统当前无法对订单的实际回款进行准确核算和对账，目前的所有回款金额均为 0，且所有订单都将显示为“异常”状态。</p>
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
                minWidth="min-w-[800px]"
                page={1}
                pageSize={100}
                totalPages={1}
                totalRecordCount={settlementFiles.length}
                onPageChange={() => {}}
                onPageSizeChange={() => {}}
              >
                <thead>
                  <tr>
                    <th className="bg-slate-50">结算账期 / 时间段</th>
                    <th className="bg-slate-50">文件名</th>
                    <th className="number-cell bg-slate-50 px-3 py-2">解析记录数</th>
                    <th className="number-cell bg-slate-50 px-3 py-2">结算总金额</th>
                    <th className="text-center bg-slate-50">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {settlementFiles.map((file) => (
                    <tr key={file.id} className="hover:bg-slate-50/50">
                      <td className="text-slate-500 font-mono text-xs">{formatDateRange(file.dateRangeStart, file.dateRangeEnd)}</td>
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

        {/* Tab 2: 对账排查 */}
        {activeTab === "recon" && (
          <div className="animate-in fade-in duration-300">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold text-slate-800">异常订单排查</h3>
                {!showAllOrders && (
                  <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-600">
                    共 {displayOrders.length} 项待处理
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
                  minWidth="min-w-[1080px]"
                  columns={settlementReconColumns}
                  layout="fixed"
                  page={reconPaginated.page}
                  pageSize={reconPageSize}
                  totalPages={reconPaginated.totalPages}
                  totalRecordCount={reconPaginated.total}
                  onPageChange={setReconPage}
                  onPageSizeChange={setReconPageSize}
                >
                  <thead>
                    <tr>
                      <th className="bg-slate-50">异常状态</th>
                      <th className="bg-slate-50">订单号</th>
                      <th className="bg-slate-50">Temu SKU Code</th>
                      <th className="bg-slate-50">排查建议操作</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">核算运费</th>
                      <th className="text-center bg-slate-50">操作对账</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconPaginated.rows.map((row: any) => {
                      const issueTypes = getReconciliationIssues(row as any);
                      const accountingStatus = getAccountingStatus(row as any);
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
                                  <AlertTriangle size={12} /> {issue === "unmatched" ? "SKU 货号未匹配" : "运费缺失 (无法估算)"}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
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
                                <button onClick={() => { setEditingOrderId(row.order.id); setEditingFeeValue(row.shippingFeeRmb > 0 ? String(row.shippingFeeRmb) : ""); }} className="rounded bg-sky-50 px-2 py-0.5 text-sky-600 text-[10px] font-bold opacity-0 group-hover:opacity-100">
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
                                  {groupedSkuOptions.map((group: any) => (
                                    <optgroup key={group.product.id} label={`${group.product.product_code} · ${group.product.product_name_cn}`}>
                                      {group.list.map((item: any) => (
                                        <option key={item.id} value={item.id}>{item.label}</option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                                <button onClick={() => handleLinkSkuCode(row.order.id, row.order.sku_code, matchingSkuId)} disabled={!matchingSkuId} className="rounded bg-accent px-2 py-1 text-white text-xs font-bold disabled:opacity-50">关联</button>
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
              <div className="flex items-center gap-3">
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
                  <option value="unmatched">异常: 未匹配SKU</option>
                  <option value="missing-shipping">异常: 缺失运费</option>
                </select>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
                筛选后共 {filteredOrderRows.length} 单
              </span>
            </div>

            {loading && orderRows.length === 0 ? (
              <EmptyPanel label="加载中..." />
            ) : filteredOrderRows.length === 0 ? (
              <EmptyPanel label="未找到匹配的订单记录" />
            ) : (
              <>
                <StandardTable 
                  minWidth="min-w-[1450px]" 
                  tableClassName="finance-freeze-order"
                  columns={settlementIncomeColumns}
                  layout="fixed"
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
                      <th className="number-cell bg-slate-50 px-3 py-2">订单核算运费</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">总预估账单</th>
                      <th className="number-cell bg-slate-50 px-3 py-2">实际结算回款</th>
                      <th className="bg-slate-50">发货方式</th>
                      <th className="bg-slate-50">结算状态</th>
                      <th className="bg-slate-50">财务对账</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomePaginated.rows.map((row: any, index: number) => {
                      const accountingStatus = getAccountingStatus(row as any);
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
                                  disabled={savingOrderId === row.order.id}
                                  className="h-8 w-16 rounded border border-line px-1 text-xs outline-none text-right font-bold"
                                  autoFocus
                                />
                                <button onClick={() => handleSaveShippingFee(row.order.id, editingFeeValue)} className="text-emerald-600"><Check size={14}/></button>
                                <button onClick={() => setEditingOrderId(null)} className="text-slate-400"><X size={14}/></button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 group justify-end">
                                {row.shippingFeeSource === "missing" ? (
                                  <span className="text-rose-600 font-bold">缺失</span>
                                ) : (
                                  <>
                                    <span className={row.isShippingFeeEstimated ? "text-accent font-semibold" : "font-bold text-slate-900"}>{formatCurrency(row.shippingFeeRmb)}</span>
                                    {row.shippingFeeSource === "actual" ? (
                                      <span className="rounded bg-emerald-50 px-1 py-0.2 text-[9px] font-black text-emerald-600">实际</span>
                                    ) : (
                                      <span className="rounded bg-accentSoft px-1 py-0.2 text-[9px] font-black text-accent">估算</span>
                                    )}
                                  </>
                                )}
                                {canEdit && (
                                  <button onClick={() => { setEditingOrderId(row.order.id); setEditingFeeValue(row.shippingFeeRmb > 0 ? String(row.shippingFeeRmb) : ""); }} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 p-1">
                                    <Edit2 size={12} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="money text-slate-500 px-3 py-2">{formatCurrency(row.billAmountRmb)}</td>
                          <td className="money px-3 py-2">
                            {row.isSettled ? <span className="font-bold text-indigo-700">{formatCurrency(row.actualRevenueRmb)}</span> : <span className="text-slate-400 font-medium">未结算</span>}
                          </td>
                          <td>
                            <div className="flex flex-col">
                              <span className="font-semibold text-slate-700">{row.order.logistics_method || "--"}</span>
                              <span className="text-[10px] text-slate-400 font-mono mt-0.5">{row.order.logistics_tracking_no}</span>
                            </div>
                          </td>
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
                </StandardTable>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
