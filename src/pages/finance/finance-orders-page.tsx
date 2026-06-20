import type { User } from "@supabase/supabase-js";
import { useMemo, useState } from "react";
import { Search, RefreshCw, Edit2, X, Check } from "lucide-react";
import { PageHeader, Badge } from "../../components/ui";
import { usePermissions } from "../../hooks/use-permissions";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  getPaginatedRows,
  formatCurrency,
  getAccountingStatus,
  getOrderSku,
  getOrderQuantity,
  getSkuUnitCostRmb,
  estimateOrderShippingFee,
  buildSkuLookup,
  roundMoney
} from "./shared";
import { buildSettlementLookup, loadSettlementFiles } from "../../lib/settlement";
import { updateTemuOrder } from "../../lib/orders";
import { getErrorMessage } from "../../utils/errors";

type Props = {
  user: User;
};

export function FinanceOrdersPage({ user }: Props) {
  const { canEdit } = usePermissions();
  const { data, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    products: true,
  });

  const settlementFiles = useMemo(() => loadSettlementFiles(), []);
  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles), [settlementFiles]);

  const productItemsById = useMemo(() => new Map<string, any>(data.productItems.map((item: any) => [item.id!, item])), [data.productItems]);
  const productsById = useMemo(() => new Map<string, any>(data.products.map((product: any) => [product.id, product])), [data.products]);
  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);

  const [orderSearch, setOrderSearch] = useState("");
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingFeeValue, setEditingFeeValue] = useState("");
  const [savingOrderId, setSavingOrderId] = useState<string | null>(null);

  const orderRows = useMemo(() => {
    return data.orders.map((order: any) => {
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      const quantity = getOrderQuantity(order);
      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      const productCostRmb = roundMoney(unitCost * quantity);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const shippingFeeSource = actualShippingFeeRmb > 0 ? "actual" : estimatedShippingRmb > 0 ? "estimated" : "missing";
      const shippingFeeRmb = roundMoney(shippingFeeSource === "actual" ? actualShippingFeeRmb : estimatedShippingRmb);
      
      let actualSalesRevenueRmb = 0;
      let actualFreightRevenueRmb = 0;
      let isSettled = false;

      const poKey = order.order_no.trim();
      const skuCodeKey = order.sku_code.trim().toLowerCase();
      if (poKey && settlementLookup.byPO.has(poKey)) {
        const matchingRecords = settlementLookup.byPO.get(poKey)!;
        let matchedRecord = matchingRecords.find(r => r.skuCode.toLowerCase() === skuCodeKey);
        if (!matchedRecord && matchingRecords.length === 1) {
          matchedRecord = matchingRecords[0];
        }
        if (matchedRecord) {
          actualSalesRevenueRmb = matchedRecord.salesRevenue;
          actualFreightRevenueRmb = matchedRecord.freightRevenue;
          isSettled = true;
        }
      }

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
  }, [data.orders, productItemsById, productsById, skuLookup, settings, settlementLookup]);

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

  const paginated = getPaginatedRows("finance-orders", filteredOrderRows, page);

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

  return (
    <section className="grid gap-5">
      <PageHeader
        title="订单级财务明细"
        description="查看每一笔订单的商品成本、预估运费、实际结算回款情况。"
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

      <section className="surface-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={orderSearch}
                onChange={(e) => { setOrderSearch(e.target.value); setPage(1); }}
                placeholder="搜索订单/单号/商品..."
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-600 sm:w-64"
              />
            </div>
            <select
              value={orderStatusFilter}
              onChange={(e) => { setOrderStatusFilter(e.target.value); setPage(1); }}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold outline-none focus:border-violet-600"
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
            <FinanceTable minWidth="min-w-[1450px]" tableClassName="finance-freeze-order">
              <thead>
                <tr>
                  <th>订单编号</th>
                  <th>Temu SKU Code</th>
                  <th>系统匹配商品</th>
                  <th className="number-cell">订单商品成本</th>
                  <th className="number-cell">订单核算运费</th>
                  <th className="number-cell">总预估账单</th>
                  <th className="number-cell">实际结算回款</th>
                  <th>发货方式</th>
                  <th>结算状态</th>
                  <th>财务对账</th>
                </tr>
              </thead>
              <tbody>
                {paginated.rows.map((row: any) => {
                  const accountingStatus = getAccountingStatus(row as any);
                  return (
                    <tr key={row.order.id} className="hover:bg-slate-50/50">
                      <td className="font-semibold text-slate-800">{row.order.order_no}</td>
                      <td className="font-mono text-slate-600 text-xs">{row.order.sku_code || "--"}</td>
                      <td className="text-slate-700 font-medium max-w-xs truncate" title={row.product?.product_name_cn}>
                        {row.product ? row.product.product_name_cn : <span className="text-slate-400 italic">规格: {row.order.product_attributes || "--"}</span>}
                      </td>
                      <td className="money text-slate-500">{formatCurrency(row.productCostRmb)}</td>
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
                              disabled={savingOrderId === row.order.id}
                              className="h-8 w-16 rounded border border-slate-300 px-1 text-xs outline-none text-right font-bold"
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
                                <span className={row.isShippingFeeEstimated ? "text-violet-600 font-semibold" : "font-bold text-slate-900"}>{formatCurrency(row.shippingFeeRmb)}</span>
                                {row.shippingFeeSource === "actual" ? (
                                  <span className="rounded bg-emerald-50 px-1 py-0.2 text-[9px] font-black text-emerald-600">实际</span>
                                ) : (
                                  <span className="rounded bg-violet-50 px-1 py-0.2 text-[9px] font-black text-violet-600">估算</span>
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
                      <td className="money text-slate-500">{formatCurrency(row.billAmountRmb)}</td>
                      <td className="money">
                        {row.isSettled ? <span className="font-bold text-indigo-700">{formatCurrency(row.actualRevenueRmb)}</span> : <span className="text-slate-400 font-medium">未结算</span>}
                      </td>
                      <td>
                        <div className="flex flex-col">
                          <span className="font-semibold text-slate-700">{row.order.logistics_method || "--"}</span>
                          <span className="text-[10px] text-slate-400 font-mono mt-0.5">{row.order.logistics_tracking_no}</span>
                        </div>
                      </td>
                      <td>
                        <Badge tone={row.isSettled ? "success" : "neutral"}>{row.isSettled ? "已结算" : "未结算"}</Badge>
                      </td>
                      <td>
                        <Badge tone={accountingStatus.tone}>{accountingStatus.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </FinanceTable>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-xs text-slate-500">
               <span>共 {paginated.total} 条，第 {paginated.page} / {paginated.totalPages} 页</span>
               <div className="flex items-center gap-1.5">
                  <button onClick={() => setPage(p => p - 1)} disabled={paginated.page <= 1} className="btn-secondary h-8 px-3">上一页</button>
                  <button onClick={() => setPage(p => p + 1)} disabled={paginated.page >= paginated.totalPages} className="btn-secondary h-8 px-3">下一页</button>
               </div>
            </div>
          </>
        )}
      </section>
    </section>
  );
}
