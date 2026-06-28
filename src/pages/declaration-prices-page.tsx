import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
  getProductRoutePath,
} from "../lib/products";
import { fetchSettings } from "../lib/settings";
import type { PricingResult, Product } from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency } from "../utils/pricing";
import { PageHeader } from "../components/ui";
import { StandardTable } from "../components/ui/StandardTable";
import { usePermissions } from "../hooks/use-permissions";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";

type DeclarationPricesPageProps = {
  user: User;
};

type PricingSummary = Pick<
  PricingResult,
  | "purchaseCostRmb"
  | "logisticsCostRmb"
  | "totalCostRmb"
  | "temuDeclarationPriceRmb"
  | "profitRmb"
>;

function formatPricingValue(
  summary: PricingSummary | null | undefined,
  field: keyof PricingSummary,
) {
  const value = summary?.[field];
  return typeof value === "number" ? formatCurrency(value) : "--";
}

export function DeclarationPricesPage({ user }: DeclarationPricesPageProps) {
  const { canEdit } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [pricingSummaries, setPricingSummaries] = useState<
    Record<string, PricingSummary | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useAutoDismiss(errorMessage, () => setErrorMessage(""));

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const nextProducts = await fetchProducts();
        const [items, skus, settings] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchSettings(user.id),
        ]);
        const itemsById = Object.fromEntries(
          items.flatMap((item) => (item.id ? [[item.id, item]] : [])),
        );
        const skusByProductId = skus.reduce<Record<string, typeof skus>>(
          (groups, sku) => {
            if (!sku.product_id) return groups;
            groups[sku.product_id] ??= [];
            groups[sku.product_id].push(sku);
            return groups;
          },
          {},
        );
        const nextPricingSummaries = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const productPricingResults = productSkus
              .map((sku) =>
                sku.component_links.flatMap((link) => {
                  const item = itemsById[link.item_id];
                  return item ? [{ ...item, quantity: link.quantity }] : [];
                }),
              )
              .filter((skuItems) => skuItems.length > 0)
              .map(
                (skuItems) =>
                  calculatePricing(product.package_weight_g, skuItems, settings),
              );

            const highestTotalCostResult = productPricingResults.reduce<
              PricingSummary | null
            >(
              (selected, result) =>
                selected === null ||
                result.totalCostRmb > selected.totalCostRmb
                  ? result
                  : selected,
              null,
            );

            return [
              product.id,
              highestTotalCostResult,
            ];
          }),
        ) as Record<string, PricingSummary | null>;
        if (active) {
          setProducts(nextProducts);
          setPricingSummaries(nextPricingSummaries);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载申报价格商品失败"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [user.id]);

  const paginatedProducts = products.slice((page - 1) * pageSize, page * pageSize);

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader title="核算定价" description="查看和维护商品核算定价数据" />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : paginatedProducts.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          paginatedProducts.map((product) => {
            const summary = pricingSummaries[product.id];

            return (
              <article key={product.id} className="mobile-summary-card">
                <p className="mobile-summary-title">{product.product_code}</p>
                <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                <div className="mobile-summary-grid">
                  <div className="mobile-summary-cell">
                    采购成本：{formatPricingValue(summary, "purchaseCostRmb")}
                  </div>
                  <div className="mobile-summary-cell">
                    物流成本：{formatPricingValue(summary, "logisticsCostRmb")}
                  </div>
                  <div className="mobile-summary-cell">
                    总成本：{formatPricingValue(summary, "totalCostRmb")}
                  </div>
                  <div className="mobile-summary-cell">
                    利润：{formatPricingValue(summary, "profitRmb")}
                  </div>
                </div>
                <p className="mt-3 text-sm font-medium text-ink">
                  核算定价：{formatPricingValue(summary, "temuDeclarationPriceRmb")}
                </p>
                <div className="mobile-summary-actions">
                  <Link className="text-action" to={getProductRoutePath(product, "/pricing")}>
                    查看核算定价
                  </Link>
                  {canEdit && (
                    <Link className="text-sm font-medium text-slate-600 hover:underline" to={getProductRoutePath(product, "/edit")}>
                      编辑
                    </Link>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="rounded-lg bg-panel shadow-soft overflow-hidden hidden md:block">
        <div className="overflow-x-auto">
          <StandardTable
            page={page}
            pageSize={pageSize}
            totalPages={Math.max(1, Math.ceil(products.length / pageSize))}
            totalRecordCount={products.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          >
            <thead>
              <tr>
                <th className="px-3 py-2 font-medium">商品编号</th>
                <th className="product-name-col px-3 py-2 font-medium">产品名称</th>
                <th className="px-3 py-2 font-medium">采购成本</th>
                <th className="px-3 py-2 font-medium">物流成本</th>
                <th className="px-3 py-2 font-medium">总成本</th>
                <th className="px-3 py-2 font-medium">利润</th>
                <th className="px-3 py-2 font-medium">核算定价</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : paginatedProducts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                paginatedProducts.map((product) => {
                  const summary = pricingSummaries[product.id];

                  return (
                    <tr key={product.id}>
                      <td className="px-3 py-2">{product.product_code}</td>
                      <td
                        className="product-name-col px-3 py-2"
                        data-full-text={product.product_name_cn}
                      >
                        <span className="table-cell-clamp" title={product.product_name_cn}>
                          {product.product_name_cn}
                        </span>
                      </td>
                      <td className="money px-3 py-2">
                        {formatPricingValue(summary, "purchaseCostRmb")}
                      </td>
                      <td className="money px-3 py-2">
                        {formatPricingValue(summary, "logisticsCostRmb")}
                      </td>
                      <td className="money px-3 py-2">
                        {formatPricingValue(summary, "totalCostRmb")}
                      </td>
                      <td className="money px-3 py-2">
                        {formatPricingValue(summary, "profitRmb")}
                      </td>
                      <td className="money px-3 py-2">
                        {formatPricingValue(summary, "temuDeclarationPriceRmb")}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-5">
                          <Link className="text-action" to={getProductRoutePath(product, "/pricing")}>
                            查看核算定价
                          </Link>
                          {canEdit && (
                            <Link className="text-sm font-medium text-slate-600 hover:underline" to={getProductRoutePath(product, "/edit")}>
                              编辑
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </StandardTable>
        </div>
      </div>
    </section>
  );
}
