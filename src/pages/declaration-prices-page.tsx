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
import type { Product } from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency } from "../utils/pricing";
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";

type DeclarationPricesPageProps = {
  user: User;
};

export function DeclarationPricesPage({ user }: DeclarationPricesPageProps) {
  const { canEdit } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [temuDeclarationPrices, setTemuDeclarationPrices] = useState<
    Record<string, number | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

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
        const nextTemuDeclarationPrices = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const productTemuDeclarationPrices = productSkus
              .map((sku) =>
                sku.component_links.flatMap((link) => {
                  const item = itemsById[link.item_id];
                  return item ? [{ ...item, quantity: link.quantity }] : [];
                }),
              )
              .filter((skuItems) => skuItems.length > 0)
              .map(
                (skuItems) =>
                  calculatePricing(product.package_weight_g, skuItems, settings)
                    .temuDeclarationPriceRmb,
              );

            return [
              product.id,
              productTemuDeclarationPrices.length > 0
                ? Math.min(...productTemuDeclarationPrices)
                : null,
            ];
          }),
        );
        if (active) {
          setProducts(nextProducts);
          setTemuDeclarationPrices(nextTemuDeclarationPrices);
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

  return (
    <section className="grid gap-5">
      <PageHeader title="核算定价" description="查看和维护商品核算定价数据" />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          products.map((product) => (
            <article key={product.id} className="mobile-summary-card">
              <p className="mobile-summary-title">{product.product_code}</p>
              <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
              <p className="mt-3 text-sm font-medium text-ink">
                核算定价：{typeof temuDeclarationPrices[product.id] === "number"
                  ? formatCurrency(temuDeclarationPrices[product.id] as number)
                  : "--"}
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
          ))
        )}
      </div>

      <div className="table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">核算定价 (RMB)</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="px-4 py-3">{product.product_name_cn}</td>
                    <td className="money">
                      {typeof temuDeclarationPrices[product.id] === "number"
                        ? formatCurrency(temuDeclarationPrices[product.id] as number)
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
