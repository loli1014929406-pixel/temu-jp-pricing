import type { User } from "@supabase/supabase-js";
import { useState, useMemo } from "react";
import { Plus, Trash2, AlertTriangle, Check, X, RefreshCw } from "lucide-react";
import { PageHeader, Badge } from "../../components/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
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
} from "./shared";
import { 
  parseSettlementData, 
  loadSettlementFiles, 
  deleteSettlementFile, 
  addSettlementFile, 
  formatDateRange,
  type SettlementFile
} from "../../lib/settlement";
import { getErrorMessage } from "../../utils/errors";
import { updateSkuCode } from "../../lib/products";
import { updateTemuOrder } from "../../lib/orders";

type Props = {
  user: User;
};

export function FinanceSettlementPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { data, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    products: true,
  });

  const [settlementFiles, setSettlementFiles] = useState<SettlementFile[]>(loadSettlementFiles());
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(1);
  const [reconPage, setReconPage] = useState(1);

  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingFeeValue, setEditingFeeValue] = useState("");
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);

  const [matchingOrderId, setMatchingOrderId] = useState<string | null>(null);
  const [matchingSkuId, setMatchingSkuId] = useState("");
  const [linkingOrderId, setLinkingOrderId] = useState<string | null>(null);
  
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

  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);
  
  const orderRows = useMemo(() => {
    return data.orders.map((order: any) => {
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? data.products.find(p => p.id === sku.product_id) ?? null : null;
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const shippingFeeSource = actualShippingFeeRmb > 0 ? "actual" : estimatedShippingRmb > 0 ? "estimated" : "missing";
      const shippingFeeRmb = roundMoney(shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedShippingRmb);
      
      return {
        order,
        sku,
        product,
        shippingFeeRmb,
        shippingFeeSource,
        isShippingFeeEstimated: shippingFeeSource === "estimated",
        matched: Boolean(sku && product),
      };
    });
  }, [data.orders, skuLookup, data.products, settings]);

  const unmatched = useMemo(() => orderRows.filter((row: any) => getReconciliationIssues(row as any).length > 0), [orderRows]);
  const reconPaginated = getPaginatedRows("finance-recon", unmatched, reconPage);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // 检查是否覆盖
    const existing = settlementFiles.find(f => f.fileName === file.name);
    if (existing) {
       if (!window.confirm(`文件 "${file.name}" 已存在。继续导入将覆盖原有数据。是否继续？`)) {
          e.target.value = "";
          return;
       }
    }

    setImporting(true);
    try {
      const { readXlsxWorkbook } = await import("../../lib/tabular-parser");
      const workbook = await readXlsxWorkbook(file);
      const sheet = workbook.worksheets[0];
      if (!sheet || !sheet.data) throw new Error("文件为空");
      const records = parseSettlementData(sheet.data);
      if (records.length === 0) throw new Error("未解析到有效结算数据");
      
      const newFile = addSettlementFile(file.name, records as any);
      setSettlementFiles(loadSettlementFiles());
      alert(`成功导入 ${records.length} 条结算记录！\n总回款：${formatCurrency(newFile.totalRevenue)}`);
    } catch (err) {
      alert("导入失败: " + getErrorMessage(err, "请确保选择的是 SettledParentFlow 导出文件"));
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const handleDeleteFile = (id: string) => {
    if (!window.confirm("确定删除该结算文件？\n删除后相关的财务利润和对账状态将重新计算。")) return;
    deleteSettlementFile(id);
    setSettlementFiles(loadSettlementFiles());
  };

  const handleSaveShippingFee = async (orderId: string, feeStr: string) => {
    const fee = Number(feeStr);
    if (Number.isNaN(fee) || fee < 0) return alert("金额无效");
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
    <section className="grid gap-5">
      <PageHeader
        title="对账中心"
        description="管理结算文件导入与异常订单对账排查。"
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

      {/* 结算文件管理 */}
      <section className="surface-card p-5">
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
          <FinanceTable minWidth="min-w-[800px]">
            <thead>
              <tr>
                <th>导入时间</th>
                <th>文件名</th>
                <th>数据日期范围</th>
                <th className="number-cell">包含记录数</th>
                <th className="number-cell">文件总回款</th>
                <th className="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {settlementFiles.map((file) => (
                <tr key={file.id} className="hover:bg-slate-50/50">
                  <td className="text-slate-500 font-mono text-xs">{new Date(file.importedAt).toLocaleString()}</td>
                  <td className="font-bold text-slate-800 text-xs">{file.fileName}</td>
                  <td className="text-slate-600 font-medium text-xs">{formatDateRange(file.dateRangeStart, file.dateRangeEnd)}</td>
                  <td className="number-cell font-semibold">{file.recordCount}</td>
                  <td className="money text-emerald-700">{formatCurrency(file.totalRevenue)}</td>
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
          </FinanceTable>
        )}
      </section>

      {/* 异常对账 */}
      <section className="surface-card grid gap-4 p-5">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">对账中心异常订单排查</h3>
          <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-600">
            共 {unmatched.length} 项待处理
          </span>
        </div>
        
        {loading && unmatched.length === 0 ? (
           <EmptyPanel label="加载中..." />
        ) : unmatched.length === 0 ? (
           <EmptyPanel label="暂无需要人工对账的订单数据" />
        ) : (
          <>
            <FinanceTable minWidth="min-w-[1080px]">
              <thead>
                <tr>
                  <th>订单编号</th>
                  <th>Temu SKU Code</th>
                  <th>系统商品 SKU</th>
                  <th>待处理问题</th>
                  <th className="number-cell">核算运费</th>
                  <th className="text-center">操作对账</th>
                </tr>
              </thead>
              <tbody>
                {reconPaginated.rows.map((row: any) => {
                  const issueTypes = getReconciliationIssues(row as any);
                  const accountingStatus = getAccountingStatus(row as any);
                  return (
                    <tr key={row.order.id} className="hover:bg-slate-50/50">
                    <td className="font-semibold text-slate-800">{row.order.order_no}</td>
                    <td className="font-mono text-slate-600 text-xs font-bold">{row.order.sku_code || "--"}</td>
                    <td className="text-slate-700 font-medium">
                      {row.product ? (
                        <span>{row.product.product_name_cn}</span>
                      ) : (
                        <span className="text-slate-400 italic">规格: {row.order.product_attributes || "--"}</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                         {issueTypes.map((issue) => (
                           <span key={issue} className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                             <AlertTriangle size={12} /> {issue === "unmatched" ? "SKU 货号未匹配" : "运费缺失 (无法估算)"}
                           </span>
                         ))}
                      </div>
                    </td>
                    <td className="money">
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
                              <span className={row.isShippingFeeEstimated ? "text-violet-600 font-semibold" : "font-bold text-slate-900"}>{formatCurrency(row.shippingFeeRmb)}</span>
                              <span className={`rounded px-1 py-0.2 text-[9px] font-black ${row.shippingFeeSource === "actual" ? "bg-emerald-50 text-emerald-600" : "bg-violet-50 text-violet-600"}`}>
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
                            <select value={matchingSkuId} onChange={(e) => setMatchingSkuId(e.target.value)} className="h-8 w-44 rounded border border-slate-300 bg-white px-2 text-xs font-semibold">
                              <option value="">选择系统 SKU</option>
                              {groupedSkuOptions.map((group: any) => (
                                <optgroup key={group.product.id} label={`${group.product.product_code} · ${group.product.product_name_cn}`}>
                                  {group.list.map((item: any) => (
                                    <option key={item.id} value={item.id}>{item.label}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            <button onClick={() => handleLinkSkuCode(row.order.id, row.order.sku_code, matchingSkuId)} disabled={!matchingSkuId} className="rounded bg-violet-600 px-2 py-1 text-white text-xs font-bold disabled:opacity-50">关联</button>
                            <button onClick={() => setMatchingOrderId(null)} className="rounded bg-slate-200 px-2 py-1 text-slate-700 text-xs font-bold">取消</button>
                          </div>
                        ) : (
                          <button onClick={() => { setMatchingOrderId(row.order.id); setMatchingSkuId(""); }} className="rounded-lg bg-violet-50 px-3 py-1 text-violet-600 hover:bg-violet-100 text-xs font-bold">
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
            </FinanceTable>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-xs text-slate-500">
               <span>共 {reconPaginated.total} 条，第 {reconPaginated.page} / {reconPaginated.totalPages} 页</span>
               <div className="flex items-center gap-1.5">
                  <button onClick={() => setReconPage(p => p - 1)} disabled={reconPaginated.page <= 1} className="btn-secondary h-8 px-3">上一页</button>
                  <button onClick={() => setReconPage(p => p + 1)} disabled={reconPaginated.page >= reconPaginated.totalPages} className="btn-secondary h-8 px-3">下一页</button>
               </div>
            </div>
          </>
        )}
      </section>
    </section>
  );
}
