import type { User } from "@supabase/supabase-js";
import { useMemo, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { PageHeader } from "../../components/ui";
import { useFinanceData } from "./use-finance-data";
import {
  FinanceTable,
  EmptyPanel,
  getPaginatedRows,
  formatCurrency,
  calculateMarginRate,
  getSignedAmountClass,
  getOrderSku,
  getOrderQuantity,
  getSkuUnitCostRmb,
  estimateOrderShippingFee,
  buildSkuLookup,
  getResolvedSettlementMetrics,
  roundMoney
} from "./shared";
import { buildSettlementLookup } from "../../lib/settlement";

type Props = {
  user: User;
};

export function FinanceProductProfitPage({ user }: Props) {
  const { data, settlementFiles, settings, loading, error, reload } = useFinanceData(user.id, {
    orders: true,
    products: true,
    settlements: true,
  });

  const settlementLookup = useMemo(() => buildSettlementLookup(settlementFiles || []), [settlementFiles]);

  const productItemsById = useMemo(() => new Map<string, any>(data.productItems.map((item: any) => [item.id!, item])), [data.productItems]);
  const productsById = useMemo(() => new Map<string, any>(data.products.map((product: any) => [product.id, product])), [data.products]);
  const skuLookup = useMemo(() => buildSkuLookup(data.products, data.productSkus), [data.products, data.productSkus]);

  const [productSearch, setProductSearch] = useState("");
  const [productSortField, setProductSortField] = useState<"orderCount" | "quantity" | "productCost" | "shipping" | "actualRevenue" | "profit" | "margin">("profit");
  const [productSortOrder, setProductSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const productRows = useMemo(() => {
    const productData = new Map<
      string,
      {
        productCode: string;
        productName: string;
        orderCount: number;
        quantity: number;
        productCost: number;
        shipping: number;
        actualRevenue: number;
      }
    >();

    const getProductObj = (productCode: string, productName: string) => {
      const key = `${productCode}-${productName}`;
      if (!productData.has(key)) {
        productData.set(key, {
          productCode: productCode || "未知商品",
          productName: productName || "未匹配商品",
          orderCount: 0,
          quantity: 0,
          productCost: 0,
          shipping: 0,
          actualRevenue: 0,
        });
      }
      return productData.get(key)!;
    };

    data.orders.forEach((order: any) => {
      const sku = getOrderSku(order, skuLookup);
      const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
      
      const pCode = product?.product_code ?? order.sku_code;
      const pName = product?.product_name_cn ?? order.product_attributes;
      const obj = getProductObj(pCode, pName);

      obj.orderCount += 1;
      const quantity = getOrderQuantity(order);
      obj.quantity += quantity;

      const unitCost = sku ? getSkuUnitCostRmb(sku, productItemsById) : 0;
      obj.productCost += unitCost * quantity;

      const actualShippingFeeRmb = Number(order.actual_shipping_fee_rmb || 0);
      const estimatedShippingRmb = estimateOrderShippingFee(order, product, settings);
      obj.shipping += actualShippingFeeRmb > 0 ? actualShippingFeeRmb : estimatedShippingRmb;

      const { actualSalesRevenueRmb, actualFreightRevenueRmb } = getResolvedSettlementMetrics(order, quantity, settlementLookup);
      obj.actualRevenue += roundMoney(actualSalesRevenueRmb + actualFreightRevenueRmb);
    });

    return Array.from(productData.values()).map((p: any) => {
      const profit = p.actualRevenue - p.productCost - p.shipping;
      const margin = calculateMarginRate(profit, p.actualRevenue);
      return { ...p, profit, margin };
    });
  }, [data.orders, productItemsById, productsById, skuLookup, settings, settlementLookup]);

  const filteredProductRows = useMemo(() => {
    let result = productRows;
    if (productSearch.trim()) {
      const q = productSearch.toLowerCase();
      result = result.filter(
        (r: any) => r.productCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q),
      );
    }
    result.sort((a: any, b: any) => {
      const vA = a[productSortField];
      const vB = b[productSortField];
      if (typeof vA === "number" && typeof vB === "number") {
        return productSortOrder === "asc" ? vA - vB : vB - vA;
      }
      return 0;
    });
    return result;
  }, [productRows, productSearch, productSortField, productSortOrder]);

  const paginated = getPaginatedRows("finance-product-profit", filteredProductRows, page);

  const renderSortIcon = (field: typeof productSortField) => {
    if (productSortField !== field) return <span className="text-slate-300 ml-1">⇅</span>;
    return productSortOrder === "asc" ? <span className="text-violet-600 ml-1">▲</span> : <span className="text-violet-600 ml-1">▼</span>;
  };

  const handleSort = (field: typeof productSortField) => {
    if (productSortField === field) {
      setProductSortOrder((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setProductSortField(field);
      setProductSortOrder("desc");
    }
    setPage(1);
  };

  return (
    <section className="grid gap-5">
      <PageHeader
        title="商品利润报表"
        description="按商品维度聚合计算的销售业绩与真实利润率。"
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
          <div className="relative flex items-center">
            <Search size={16} className="absolute left-3 text-slate-400" />
            <input
              value={productSearch}
              onChange={(e) => { setProductSearch(e.target.value); setPage(1); }}
              placeholder="搜索商品编码或名称"
              className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-violet-600 focus:ring-2 focus:ring-violet-600/10 sm:w-80"
            />
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
            共计 {filteredProductRows.length} 款商品
          </span>
        </div>

        {loading && productRows.length === 0 ? (
          <EmptyPanel label="加载中..." />
        ) : productRows.length === 0 ? (
          <EmptyPanel label="暂无商品销售利润数据" />
        ) : (
          <>
            <FinanceTable minWidth="min-w-[1250px]" tableClassName="finance-freeze-product">
              <thead>
                <tr>
                  <th>商品编码</th>
                  <th>商品名称</th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("orderCount")}>
                    订单量 {renderSortIcon("orderCount")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("quantity")}>
                    销售件数 {renderSortIcon("quantity")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("productCost")}>
                    采购总成本 {renderSortIcon("productCost")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("shipping")}>
                    核算总运费 {renderSortIcon("shipping")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("actualRevenue")}>
                    实际结算总回款 {renderSortIcon("actualRevenue")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("profit")}>
                    实际毛利润 {renderSortIcon("profit")}
                  </th>
                  <th className="number-cell cursor-pointer hover:bg-slate-100 transition rounded select-none" onClick={() => handleSort("margin")}>
                    商品毛利率 {renderSortIcon("margin")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginated.rows.map((row: any) => {
                  const profitClass = getSignedAmountClass(row.profit);
                  return (
                    <tr key={`${row.productCode}-${row.productName}`} className="hover:bg-slate-50/50">
                      <td className="font-bold text-slate-900">{row.productCode}</td>
                      <td className="text-slate-700 max-w-xs truncate font-medium" title={row.productName}>{row.productName}</td>
                      <td className="number-cell font-semibold">{row.orderCount}</td>
                      <td className="number-cell font-semibold">{row.quantity}</td>
                      <td className="money">{formatCurrency(row.productCost)}</td>
                      <td className="money">{formatCurrency(row.shipping)}</td>
                      <td className="money text-slate-900">{formatCurrency(row.actualRevenue)}</td>
                      <td className={`money ${profitClass}`}>{formatCurrency(row.profit)}</td>
                      <td className={`number-cell font-bold ${profitClass}`}>{row.margin.toFixed(2)}%</td>
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
