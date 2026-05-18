import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
} from "../lib/products";
import { fetchProfitCalculationsBySkuIds } from "../lib/profit-calculations";
import { fetchSettings } from "../lib/settings";
import type { Product } from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency } from "../utils/pricing";
import { calculateTestShipping } from "../utils/test-shipping";
import { Badge, PageHeader } from "../components/ui";

type TestShippingPageProps = {
  user: User;
};

export function TestShippingPage({ user }: TestShippingPageProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [summaries, setSummaries] = useState<
    Record<
      string,
      {
        temuPriceRmb: number | null;
        sfCostRmb: number | null;
        canUseOcsKunshan3cm: boolean | null;
        logisticsMethod: "OCS 昆山 3cm" | "OCS 昆山小包" | null;
        profitRmb: number | null;
      }
    >
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
        const [items, skus, nextSettings] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchSettings(user.id),
        ]);
        const savedCalculations = await fetchProfitCalculationsBySkuIds(
          skus.flatMap((sku) => (sku.id ? [sku.id] : [])),
        );
        const savedPricesBySkuId = Object.fromEntries(
          savedCalculations.map((calculation) => [
            calculation.sku_id,
            calculation.temu_price_rmb,
          ]),
        );
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
        const nextSummaries = Object.fromEntries(
          nextProducts.map((product) => {
            const productTestShipping = calculateTestShipping(product, nextSettings);
            const skuSummaries = (skusByProductId[product.id] ?? []).flatMap((sku) => {
              if (!sku.id) return [];
              const skuItems = sku.component_links.flatMap((link) => {
                const item = itemsById[link.item_id];
                return item ? [{ ...item, quantity: link.quantity }] : [];
              });
              if (skuItems.length === 0) return [];

              const pricing = calculatePricing(
                product.package_weight_g,
                skuItems,
                nextSettings,
              );
              const temuPriceRmb =
                savedPricesBySkuId[sku.id] ?? pricing.temuDeclarationPriceRmb;
              const selectedLogisticsCostRmb =
                productTestShipping.canUseOcsKunshan3cm
                  ? productTestShipping.ocsKunshan3cmCostRmb
                  : productTestShipping.ocsKunshanSmallParcelCostRmb;
              const totalCostRmb =
                pricing.purchaseCostRmb +
                pricing.purchaseShippingRmb +
                pricing.packagingCostRmb +
                pricing.sfCostRmb +
                selectedLogisticsCostRmb;
              const revenueRmb = temuPriceRmb + pricing.subsidyRmb;

              return [
                {
                  temuPriceRmb,
                  sfCostRmb: pricing.sfCostRmb,
                  totalCostRmb,
                  profitRmb: revenueRmb - totalCostRmb,
                },
              ];
            });
            const lowestTemuPrice =
              skuSummaries.length > 0
                ? Math.min(...skuSummaries.map((summary) => summary.temuPriceRmb))
                : null;
            const representativeSummary =
              lowestTemuPrice === null
                ? null
                : skuSummaries
                    .filter((summary) => summary.temuPriceRmb === lowestTemuPrice)
                    .reduce((selected, summary) =>
                      summary.totalCostRmb > selected.totalCostRmb ? summary : selected,
                    );

            return [
              product.id,
              {
                temuPriceRmb: lowestTemuPrice,
                sfCostRmb: representativeSummary?.sfCostRmb ?? null,
                canUseOcsKunshan3cm: productTestShipping.canUseOcsKunshan3cm,
                logisticsMethod: (productTestShipping.canUseOcsKunshan3cm
                  ? "OCS 昆山 3cm"
                  : "OCS 昆山小包") as
                  | "OCS 昆山 3cm"
                  | "OCS 昆山小包",
                profitRmb:
                  representativeSummary === null
                    ? null
                    : Number(representativeSummary.profitRmb.toFixed(2)),
              },
            ];
          }),
        );
        if (active) {
          setProducts(nextProducts);
          setSummaries(nextSummaries);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载测试阶段发货失败"));
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
      <PageHeader title="测试发货" description="查看测试发货物流方案与利润表现" />

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
          products.map((product) => {
            const summary = summaries[product.id];
            return (
              <article key={product.id} className="mobile-summary-card">
                <p className="mobile-summary-title">{product.product_code}</p>
                <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                <div className="mobile-summary-grid">
                  <div className="mobile-summary-cell">核定供货价：{typeof summary?.temuPriceRmb === "number" ? formatCurrency(summary.temuPriceRmb) : "--"}</div>
                  <div className="mobile-summary-cell">顺丰：{typeof summary?.sfCostRmb === "number" ? formatCurrency(summary.sfCostRmb) : "--"}</div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {summary?.canUseOcsKunshan3cm === null ||
                  typeof summary?.canUseOcsKunshan3cm === "undefined"
                    ? <span className="text-xs text-slate-500">3cm：--</span>
                    : summary.canUseOcsKunshan3cm
                      ? <Badge tone="success">3cm 可用</Badge>
                      : <Badge tone="danger">3cm 不可用</Badge>}
                  {summary?.logisticsMethod ? <Badge tone="info">{summary.logisticsMethod}</Badge> : null}
                </div>
                <p className="mt-2 text-sm">
                  利润：
                  {typeof summary?.profitRmb === "number"
                    ? <span className={summary.profitRmb >= 0 ? "money text-emerald-700" : "money text-rose-700"}> {formatCurrency(summary.profitRmb)}</span>
                    : " --"}
                </p>
              </article>
            );
          })
        )}
      </div>

      <div className="table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">核定供货价 (RMB)</th>
                <th className="px-4 py-3 font-medium">顺丰 RMB</th>
                <th className="px-4 py-3 font-medium">3cm 是否可用</th>
                <th className="px-4 py-3 font-medium">物流方式</th>
                <th className="px-4 py-3 font-medium">利润 RMB</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => {
                  const summary = summaries[product.id];
                  return (
                    <tr key={product.id}>
                      <td className="px-4 py-3">{product.product_code}</td>
                      <td className="px-4 py-3">{product.product_name_cn}</td>
                      <td className="px-4 py-3">
                        {typeof summary?.temuPriceRmb === "number"
                          ? formatCurrency(summary.temuPriceRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.sfCostRmb === "number"
                          ? formatCurrency(summary.sfCostRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {summary?.canUseOcsKunshan3cm === null ||
                        typeof summary?.canUseOcsKunshan3cm === "undefined"
                          ? "--"
                          : summary.canUseOcsKunshan3cm
                            ? <Badge tone="success">可用</Badge>
                            : <Badge tone="danger">不可用</Badge>}
                      </td>
                      <td className="px-4 py-3">
                        {summary?.logisticsMethod ? <Badge tone="info">{summary.logisticsMethod}</Badge> : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.profitRmb === "number"
                          ? <span className={summary.profitRmb >= 0 ? "money text-emerald-700" : "money text-rose-700"}>{formatCurrency(summary.profitRmb)}</span>
                          : "--"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
