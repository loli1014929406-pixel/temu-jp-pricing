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
import {
  calculateFinalSalePriceRmb,
  calculateProfitProjection,
  PROFIT_CALCULATION_VERSION,
} from "../utils/profit-calculation";
import { Badge, PageHeader, StatCard } from "../components/ui";

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
            const usesCurrentFormula =
              firstSaved?.result_json?.calculationVersion === PROFIT_CALCULATION_VERSION;
            const trafficDiscountRate = usesCurrentFormula
              ? firstSaved?.traffic_discount_rate ?? 0
              : 0;
            const activityDiscountRate = firstSaved?.activity_discount_rate ?? 10;
            const couponDiscountRate = usesCurrentFormula
              ? firstSaved?.coupon_discount_rate ?? 0
              : 0;
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
                    saved.result_json.calculationVersion === PROFIT_CALCULATION_VERSION
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
                discountedSalePriceRmb:
                  typeof temuPrice === "number"
                    ? calculateFinalSalePriceRmb({
                        temuPriceRmb: temuPrice,
                        trafficDiscountRate,
                        activityDiscountRate,
                        couponDiscountRate,
                      })
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

  const summaries = Object.values(discountSummaries);
  const validProfitRates = summaries.flatMap((summary) =>
    typeof summary.profitRate === "number" ? [summary.profitRate] : [],
  );
  const validRoas = summaries.flatMap((summary) =>
    typeof summary.recommendedMinRoas === "number" ? [summary.recommendedMinRoas] : [],
  );
  const negativeProfitCount = summaries.filter(
    (summary) => typeof summary.profitRmb === "number" && summary.profitRmb < 0,
  ).length;
  const averageProfitRate =
    validProfitRates.length > 0
      ? `${((validProfitRates.reduce((sum, value) => sum + value, 0) / validProfitRates.length) * 100).toFixed(2)}%`
      : "--";
  const averageRoas =
    validRoas.length > 0
      ? (validRoas.reduce((sum, value) => sum + value, 0) / validRoas.length).toFixed(2)
      : "--";

  return (
    <section className="grid gap-5">
      <PageHeader title="利润数据分析" description="实时分析利润率、最终售价及广告投放安全边际" />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="在售商品数" value={String(products.length)} />
        <StatCard label="平均利润率" value={averageProfitRate} tone="success" />
        <StatCard label="亏损商品数" value={String(negativeProfitCount)} tone={negativeProfitCount > 0 ? "danger" : "default"} />
        <StatCard label="平均建议最低 ROAS" value={averageRoas} />
      </div>

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          products.map((product) => {
            const summary = discountSummaries[product.id];
            const profitRmb = summary?.profitRmb;
            const profitRate = summary?.profitRate;
            return (
              <article key={product.id} className="mobile-summary-card">
                <p className="mobile-summary-title">{product.product_code}</p>
                <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                <div className="mobile-summary-grid">
                  <div className="mobile-summary-cell">
                    核定供货价：{typeof temuPrices[product.id] === "number" ? formatCurrency(temuPrices[product.id] as number) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    最终售价：{typeof summary?.discountedSalePriceRmb === "number" ? formatCurrency(summary.discountedSalePriceRmb) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    利润：
                    {typeof profitRmb === "number" ? (
                      <span className={`money ${profitRmb < 0 ? "text-rose-700" : profitRmb < 1 ? "text-amber-700" : "text-emerald-700"}`}> {formatCurrency(profitRmb)}</span>
                    ) : " --"}
                  </div>
                  <div className="mobile-summary-cell">
                    利润率：{typeof profitRate === "number" ? `${(profitRate * 100).toFixed(2)}%` : "--"}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {typeof profitRate === "number" ? (
                    <Badge tone={profitRate > 0.3 ? "success" : profitRate >= 0.15 ? "warning" : "danger"}>
                      {(profitRate * 100).toFixed(2)}%
                    </Badge>
                  ) : null}
                  <span className="text-xs text-slate-500">
                    建议最低 ROAS：{typeof summary?.recommendedMinRoas === "number" ? summary.recommendedMinRoas.toFixed(2) : "--"}
                  </span>
                </div>
                <div className="mt-3">
                  <Link className="text-action" to={`/products/${product.id}/profit-calculation`}>
                    查看利润
                  </Link>
                </div>
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
                <th className="px-4 py-3 font-medium">流量加速</th>
                <th className="px-4 py-3 font-medium">活动折扣</th>
                <th className="px-4 py-3 font-medium">优惠券价</th>
                <th className="px-4 py-3 font-medium">最终售价(RMB)</th>
                <th className="px-4 py-3 font-medium">利润 RMB</th>
                <th className="px-4 py-3 font-medium">利润率</th>
                <th className="px-4 py-3 font-medium">建议最低 ROAS</th>
                <th className="px-4 py-3 font-medium">保本 ROAS</th>
                <th className="px-4 py-3 font-medium">免邮起送件数 (3500円)</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={13} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="px-4 py-3">{product.product_name_cn}</td>
                    <td className="money">
                      {typeof temuPrices[product.id] === "number"
                        ? formatCurrency(temuPrices[product.id] as number)
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {discountSummaries[product.id]?.trafficDiscountRate ?? 0}
                    </td>
                    <td className="number-cell">
                      {discountSummaries[product.id]?.activityDiscountRate ?? 10}
                    </td>
                    <td className="number-cell">
                      {discountSummaries[product.id]?.couponDiscountRate ?? 0}
                    </td>
                    <td className="money">
                      {typeof discountSummaries[product.id]?.discountedSalePriceRmb ===
                      "number"
                        ? formatCurrency(
                            discountSummaries[product.id]
                              ?.discountedSalePriceRmb as number,
                          )
                        : "--"}
                    </td>
                    <td className="px-4 py-4">
                      {typeof discountSummaries[product.id]?.profitRmb === "number"
                        ? (
                          <span
                            className={`money ${
                              (discountSummaries[product.id]?.profitRmb as number) < 0
                                ? "text-rose-700"
                                : (discountSummaries[product.id]?.profitRmb as number) < 1
                                  ? "text-amber-700"
                                  : "text-emerald-700"
                            }`}
                          >
                            {formatCurrency(discountSummaries[product.id]?.profitRmb as number)}
                          </span>
                        )
                        : "--"}
                    </td>
                    <td className="px-4 py-4">
                      {typeof discountSummaries[product.id]?.profitRate === "number"
                        ? (() => {
                            const profitRate = discountSummaries[product.id]?.profitRate as number;
                            return (
                              <Badge
                                tone={
                                  profitRate > 0.3
                                    ? "success"
                                    : profitRate >= 0.15
                                      ? "warning"
                                      : "danger"
                                }
                              >
                                {(profitRate * 100).toFixed(2)}%
                              </Badge>
                            );
                          })()
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {typeof discountSummaries[product.id]?.recommendedMinRoas === "number"
                        ? (
                            discountSummaries[product.id]
                              ?.recommendedMinRoas as number
                          ).toFixed(2)
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {typeof discountSummaries[product.id]?.breakEvenRoas === "number"
                        ? (discountSummaries[product.id]?.breakEvenRoas as number).toFixed(2)
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {discountSummaries[product.id]?.freeShippingThresholdQty ?? "--"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        className="text-action"
                        to={`/products/${product.id}/profit-calculation`}
                      >
                        查看利润
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
