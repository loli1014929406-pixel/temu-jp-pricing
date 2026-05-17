import type { User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { calculateProfitProjection } from "../utils/profit-calculation";

type ProfitCalculationsPageProps = {
  user: User;
};

export function ProfitCalculationsPage({ user }: ProfitCalculationsPageProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [temuPrices, setTemuPrices] = useState<Record<string, number | null>>({});
  const [discountSummaries, setDiscountSummaries] = useState<
    Record<
      string,
      {
        trafficDiscountRate: number;
        activityDiscountRate: number;
        couponDiscountRate: number;
        finalDiscountRate: number;
        discountedSalePriceRmb: number | null;
        profitRmb: number | null;
        profitRate: number | null;
        recommendedMinRoas: number | null;
        breakEvenRoas: number | null;
        freeShippingThresholdQty: number | null;
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
        const [items, skus, settings] = await Promise.all([
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
        const savedCalculationBySkuId = Object.fromEntries(
          savedCalculations.map((calculation) => [calculation.sku_id, calculation]),
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
        const nextTemuPrices = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const savedTemuPrices = productSkus.flatMap((sku) =>
              sku.id && typeof savedPricesBySkuId[sku.id] === "number"
                ? [savedPricesBySkuId[sku.id]]
                : [],
            );
            const productTemuPrices = productSkus
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
              savedTemuPrices.length > 0
                ? Math.min(...savedTemuPrices)
                : productTemuPrices.length > 0
                  ? Math.min(...productTemuPrices)
                  : null,
            ];
          }),
        );
        const nextDiscountSummaries = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const savedForProduct = productSkus.flatMap((sku) =>
              sku.id && savedCalculationBySkuId[sku.id]
                ? [savedCalculationBySkuId[sku.id]]
                : [],
            );
            const firstSaved = savedForProduct[0];
            const trafficDiscountRate = firstSaved?.traffic_discount_rate ?? 10;
            const activityDiscountRate = firstSaved?.activity_discount_rate ?? 10;
            const couponDiscountRate = firstSaved?.coupon_discount_rate ?? 10;
            const finalDiscountRate =
              (trafficDiscountRate * activityDiscountRate * couponDiscountRate) / 100;
            const temuPrice = nextTemuPrices[product.id];
            const runtimeCalculations = productSkus.flatMap((sku) => {
              if (!sku.id) return [];
              const skuItems = sku.component_links.flatMap((link) => {
                const item = itemsById[link.item_id];
                return item ? [{ ...item, quantity: link.quantity }] : [];
              });
              if (skuItems.length === 0) return [];
              const pricing = calculatePricing(product.package_weight_g, skuItems, settings);
              const saved = savedCalculationBySkuId[sku.id];
              const temuPriceRmb = saved?.temu_price_rmb ?? pricing.temuDeclarationPriceRmb;
              const input = {
                temuPriceRmb,
                trafficDiscountRate,
                activityDiscountRate,
                couponDiscountRate,
              };
              return [
                {
                  skuId: sku.id,
                  temuPriceRmb,
                  result:
                    saved?.result_json?.isValid &&
                    saved.result_json.calculationVersion === 3
                      ? saved.result_json
                      : calculateProfitProjection(pricing, settings, input),
                },
              ];
            });
            const validRuntimeCalculations = runtimeCalculations.filter(
              (calculation) => calculation.result.isValid,
            );
            const lowestTemuPrice =
              validRuntimeCalculations.length > 0
                ? Math.min(...validRuntimeCalculations.map((calculation) => calculation.temuPriceRmb))
                : null;
            const lowestPriceCandidates =
              lowestTemuPrice === null
                ? []
                : validRuntimeCalculations.filter(
                    (calculation) => calculation.temuPriceRmb === lowestTemuPrice,
                  );
            const representativeCalculation =
              lowestPriceCandidates.length > 0
                ? lowestPriceCandidates.reduce((selected, calculation) => {
                    const selectedMaxCost = Math.max(
                      ...selected.result.plans.map((plan) => plan.totalCostRmb),
                    );
                    const currentMaxCost = Math.max(
                      ...calculation.result.plans.map((plan) => plan.totalCostRmb),
                    );
                    return currentMaxCost > selectedMaxCost ? calculation : selected;
                  })
                : null;
            const representativePlan =
              representativeCalculation &&
              representativeCalculation.result.plans.length > 0
                ? representativeCalculation.result.plans.reduce((selected, plan) =>
                    plan.totalCostRmb > selected.totalCostRmb ? plan : selected,
                  )
                : null;

            return [
              product.id,
              {
                trafficDiscountRate,
                activityDiscountRate,
                couponDiscountRate,
                finalDiscountRate,
                discountedSalePriceRmb:
                  typeof temuPrice === "number"
                    ? temuPrice * (finalDiscountRate / 10)
                    : null,
                profitRmb: representativePlan?.profitRmb ?? null,
                profitRate: representativePlan?.profitRate ?? null,
                recommendedMinRoas: representativePlan?.recommendedMinRoas ?? null,
                breakEvenRoas: representativePlan?.breakEvenRoas ?? null,
                freeShippingThresholdQty:
                  representativeCalculation?.result.freeShippingThresholdQty ?? null,
              },
            ];
          }),
        );

        if (active) {
          setProducts(nextProducts);
          setTemuPrices(nextTemuPrices);
          setDiscountSummaries(nextDiscountSummaries);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载利润测算商品失败"));
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
      <div>
        <h1 className="text-2xl font-semibold text-ink">利润测算</h1>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-white shadow-panel">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">Temu 核价 RMB</th>
                <th className="px-4 py-3 font-medium">流量曝光折扣</th>
                <th className="px-4 py-3 font-medium">Temu 活动折扣</th>
                <th className="px-4 py-3 font-medium">优惠券折扣</th>
                <th className="px-4 py-3 font-medium">最终折扣系数</th>
                <th className="px-4 py-3 font-medium">折后售价 RMB</th>
                <th className="px-4 py-3 font-medium">利润 RMB</th>
                <th className="px-4 py-3 font-medium">利润率</th>
                <th className="px-4 py-3 font-medium">建议最低 ROAS</th>
                <th className="px-4 py-3 font-medium">保本 ROAS</th>
                <th className="px-4 py-3 font-medium">3500日元免邮临界件数</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={14} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={14} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id} className="border-t border-line">
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">
                      {typeof temuPrices[product.id] === "number"
                        ? formatCurrency(temuPrices[product.id] as number)
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {discountSummaries[product.id]?.trafficDiscountRate ?? 10}
                    </td>
                    <td className="px-4 py-3">
                      {discountSummaries[product.id]?.activityDiscountRate ?? 10}
                    </td>
                    <td className="px-4 py-3">
                      {discountSummaries[product.id]?.couponDiscountRate ?? 10}
                    </td>
                    <td className="px-4 py-3">
                      {(discountSummaries[product.id]?.finalDiscountRate ?? 10).toFixed(4)}
                    </td>
                    <td className="px-4 py-3">
                      {typeof discountSummaries[product.id]?.discountedSalePriceRmb ===
                      "number"
                        ? formatCurrency(
                            discountSummaries[product.id]
                              ?.discountedSalePriceRmb as number,
                          )
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {typeof discountSummaries[product.id]?.profitRmb === "number"
                        ? formatCurrency(discountSummaries[product.id]?.profitRmb as number)
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {typeof discountSummaries[product.id]?.profitRate === "number"
                        ? `${(
                            (discountSummaries[product.id]?.profitRate as number) * 100
                          ).toFixed(2)}%`
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {typeof discountSummaries[product.id]?.recommendedMinRoas === "number"
                        ? (
                            discountSummaries[product.id]
                              ?.recommendedMinRoas as number
                          ).toFixed(2)
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {typeof discountSummaries[product.id]?.breakEvenRoas === "number"
                        ? (discountSummaries[product.id]?.breakEvenRoas as number).toFixed(2)
                        : "--"}
                    </td>
                    <td className="px-4 py-3">
                      {discountSummaries[product.id]?.freeShippingThresholdQty ?? "--"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        className="text-accent"
                        to={`/products/${product.id}/profit-calculation`}
                      >
                        查看利润测算
                      </Link>
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
