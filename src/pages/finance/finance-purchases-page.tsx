import type { User } from "@supabase/supabase-js";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader, Badge } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  formatCurrency,
  formatDate,
  getPurchaseTotalRmb,
  getPaginatedRows,
} from "./shared";

type Props = {
  user: User;
};

export function FinancePurchasesPage({ user }: Props) {
  const { data, loading, error, reload } = useFinanceData(user.id, {
    purchases: true,
  });

  const [page, setPage] = useState(1);
  
  // Sort purchases by date descending
  const sortedPurchases = [...data.purchases].sort((a: any, b: any) => 
     new Date(b.purchased_at).getTime() - new Date(a.purchased_at).getTime()
  );

  const paginated = getPaginatedRows("finance-purchases", sortedPurchases, page);

  return (
    <section className="grid gap-5">
      <PageHeader
        title="采购付款明细"
        description="查看历史所有采购付款单与入库信息。"
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
          <h3 className="text-sm font-bold text-slate-800">采购订单流水</h3>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            共 {sortedPurchases.length} 条记录
          </span>
        </div>

        {loading && sortedPurchases.length === 0 ? (
          <EmptyPanel label="加载中..." />
        ) : sortedPurchases.length === 0 ? (
          <EmptyPanel label="暂无采购付款记录" />
        ) : (
          <>
            <FinanceTable>
              <thead>
                <tr>
                  <th>采购订单单号</th>
                  <th>采购日期</th>
                  <th>收货目标仓库</th>
                  <th>当前付款状态</th>
                  <th className="number-cell">商品货款</th>
                  <th className="number-cell">实付总金额</th>
                </tr>
              </thead>
              <tbody>
                {paginated.rows.map((purchase: any) => (
                  <tr key={purchase.id} className="hover:bg-slate-50/50">
                    <td className="font-bold text-slate-900">{purchase.order_code}</td>
                    <td className="text-slate-500 font-mono">{formatDate(purchase.purchased_at)}</td>
                    <td className="font-semibold text-slate-700">{purchase.warehouse_name}</td>
                    <td>
                      <Badge tone={purchase.status === "received" ? "success" : purchase.status === "partially_received" ? "warning" : "info"}>
                        {purchase.status === "received" ? "已收齐" : purchase.status === "partially_received" ? "部分收货" : "未发货/挂起"}
                      </Badge>
                    </td>
                    <td className="money">{formatCurrency(Number(purchase.items_total_rmb || 0))}</td>
                    <td className="money text-rose-700">{formatCurrency(getPurchaseTotalRmb(purchase))}</td>
                  </tr>
                ))}
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
