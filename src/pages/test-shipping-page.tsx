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
import {
  calculateAdFeeRmb,
  calculateFinalSalePriceRmb,
  PROFIT_CALCULATION_VERSION,
} from "../utils/profit-calculation";
import { calculateTestShipping } from "../utils/test-shipping";
import { Badge, PageHeader } from "../components/ui";

type TestShippingPageProps = {
  user: User;
};

const defaultDiscounts = {
  trafficDiscountRate: 0,
  activityDiscountRate: 10,
  couponDiscountRate: 0,
  adRoas: 0,
};

export function TestShippingPage({ user }: TestShippingPageProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [summaries, setSummaries] = useState<
    Record<
      string,
      {
        finalSalePriceRmb: number | null;
        purchaseTotalCostRmb: number | null;
        temuShippingSubsidyRmb: number | null;
        sfCostRmb: number | null;
        canUseOcsKunshan3cm: boolean | null;
        logisticsMethod: "OCS 3cm" | "OCS 小包" | null;
        logisticsCostRmb: number | null;
        adFeeRmb: number | null;
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
        const nextSummaries = Object.fromEntries(
          nextProducts.map((product) => {
            const productTestShipping = calculateTestShipping(product, nextSettings);
            const selectedLogisticsCostRmb =
              productTestShipping.canUseOcsKunshan3cm
                ? productTestShipping.ocsKunshan3cmCostRmb
                : productTestShipping.ocsKunshanSmallParcelCostRmb;
            const selectedLogisticsMethod = productTestShipping.canUseOcsKunshan3cm
              ? "OCS 3cm"
              : "OCS 小包";
            const productSkus = skusByProductId[product.id] ?? [];
            const savedForProduct = productSkus.flatMap((sku) =>
              sku.id && savedCalculationBySkuId[sku.id]
                ? [savedCalculationBySkuId[sku.id]]
                : [],
            );
            const firstSaved = savedForProduct[0];
            const usesDiscountFormula =
              (firstSaved?.result_json?.calculationVersion ?? 0) >= 4;
            const usesAdFormula =
              (firstSaved?.result_json?.calculationVersion ?? 0) >=
              PROFIT_CALCULATION_VERSION;
            const discounts = {
              trafficDiscountRate: usesDiscountFormula
                ? firstSaved?.traffic_discount_rate ??
                  defaultDiscounts.trafficDiscountRate
                : defaultDiscounts.trafficDiscountRate,
              activityDiscountRate:
                firstSaved?.activity_discount_rate ??
                defaultDiscounts.activityDiscountRate,
              couponDiscountRate: usesDiscountFormula
                ? firstSaved?.coupon_discount_rate ??
                  defaultDiscounts.couponDiscountRate
                : defaultDiscounts.couponDiscountRate,
              adRoas: usesAdFormula
                ? firstSaved?.result_json?.adRoas ?? defaultDiscounts.adRoas
                : defaultDiscounts.adRoas,
            };
            const skuSummaries = productSkus.flatMap((sku) => {
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
              const saved = savedCalculationBySkuId[sku.id];
              const temuPriceRmb =
                saved?.temu_price_rmb ?? pricing.temuDeclarationPriceRmb;
              const finalSalePriceRmb = calculateFinalSalePriceRmb({
                temuPriceRmb,
                ...discounts,
              });
              const priceBeforeActivityDiscount =
                temuPriceRmb -
                discounts.trafficDiscountRate -
                discounts.couponDiscountRate;
              const isValid =
                temuPriceRmb > 0 &&
                discounts.trafficDiscountRate >= 0 &&
                discounts.activityDiscountRate > 0 &&
                discounts.activityDiscountRate <= 10 &&
                discounts.couponDiscountRate >= 0 &&
                priceBeforeActivityDiscount > 0 &&
                finalSalePriceRmb > 0 &&
                nextSettings.exchange_rate_rmb_per_jpy > 0;
              const discountedUnitPriceJpy =
                isValid
                  ? finalSalePriceRmb / nextSettings.exchange_rate_rmb_per_jpy
                  : null;
              const subsidyRmb =
                nextSettings.temu_shipping_subsidy_jpy *
                nextSettings.exchange_rate_rmb_per_jpy;
              const effectiveSubsidyRmb =
                isValid &&
                discountedUnitPriceJpy !== null &&
                discountedUnitPriceJpy <= 3500
                  ? subsidyRmb
                  : 0;
              const adFeeRmb =
                isValid
                  ? calculateAdFeeRmb({
                      temuPriceRmb,
                      ...discounts,
                    })
                  : 0;
              const totalCostRmb =
                pricing.purchaseCostRmb +
                pricing.purchaseShippingRmb +
                pricing.packagingCostRmb +
                pricing.sfCostRmb +
                selectedLogisticsCostRmb +
                adFeeRmb;
              const revenueRmb = isValid
                ? finalSalePriceRmb + effectiveSubsidyRmb
                : 0;

              return [
                {
                  temuPriceRmb,
                  finalSalePriceRmb,
                  purchaseTotalCostRmb:
                    pricing.purchaseCostRmb + pricing.purchaseShippingRmb,
                  temuShippingSubsidyRmb: effectiveSubsidyRmb,
                  sfCostRmb: pricing.sfCostRmb,
                  logisticsCostRmb: selectedLogisticsCostRmb,
                  adFeeRmb,
                  totalCostRmb,
                  profitRmb: isValid ? revenueRmb - totalCostRmb : null,
                },
              ];
            });
            const savedTemuPrices = productSkus.flatMap((sku) =>
              sku.id && savedCalculationBySkuId[sku.id]
                ? [savedCalculationBySkuId[sku.id].temu_price_rmb]
                : [],
            );
            const displayedTemuPrice =
              savedTemuPrices.length > 0
                ? Math.min(...savedTemuPrices)
                : skuSummaries.length > 0
                  ? Math.min(...skuSummaries.map((summary) => summary.temuPriceRmb))
                  : null;
            const displayedFinalSalePrice =
              displayedTemuPrice === null
                ? null
                : calculateFinalSalePriceRmb({
                    temuPriceRmb: displayedTemuPrice,
                    ...discounts,
                  });
            const representativeCandidates =
              displayedTemuPrice === null
                ? []
                : skuSummaries.filter(
                    (summary) => summary.temuPriceRmb === displayedTemuPrice,
                  );
            const representativeSummary =
              representativeCandidates.length > 0
                ? representativeCandidates.reduce((selected, summary) =>
                    summary.totalCostRmb > selected.totalCostRmb ? summary : selected,
                  )
                : null;

            return [
              product.id,
              {
                finalSalePriceRmb: displayedFinalSalePrice,
                purchaseTotalCostRmb:
                  representativeSummary === null
                    ? null
                    : Number(representativeSummary.purchaseTotalCostRmb.toFixed(2)),
                temuShippingSubsidyRmb:
                  representativeSummary === null
                    ? null
                    : Number(representativeSummary.temuShippingSubsidyRmb.toFixed(2)),
                sfCostRmb: representativeSummary?.sfCostRmb ?? null,
                canUseOcsKunshan3cm: productTestShipping.canUseOcsKunshan3cm,
                logisticsMethod: selectedLogisticsMethod as "OCS 3cm" | "OCS 小包",
                logisticsCostRmb: Number(selectedLogisticsCostRmb.toFixed(2)),
                adFeeRmb:
                  representativeSummary === null
                    ? null
                    : Number(representativeSummary.adFeeRmb.toFixed(2)),
                profitRmb:
                  representativeSummary === null ||
                  representativeSummary.profitRmb === null
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
          setErrorMessage(getErrorMessage(error, "加载直发物流测算失败"));
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
      <PageHeader title="直发测算" description="查看直发物流方案与利润表现" />

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
                  <div className="mobile-summary-cell">最终售价：{typeof summary?.finalSalePriceRmb === "number" ? formatCurrency(summary.finalSalePriceRmb) : "--"}</div>
                  <div className="mobile-summary-cell">采购总成本：{typeof summary?.purchaseTotalCostRmb === "number" ? formatCurrency(summary.purchaseTotalCostRmb) : "--"}</div>
                  <div className="mobile-summary-cell">Temu补贴：{typeof summary?.temuShippingSubsidyRmb === "number" ? formatCurrency(summary.temuShippingSubsidyRmb) : "--"}</div>
                  <div className="mobile-summary-cell">顺丰：{typeof summary?.sfCostRmb === "number" ? formatCurrency(summary.sfCostRmb) : "--"}</div>
                  <div className="mobile-summary-cell">物流运费：{typeof summary?.logisticsCostRmb === "number" ? formatCurrency(summary.logisticsCostRmb) : "--"}</div>
                  <div className="mobile-summary-cell">广告消耗：{typeof summary?.adFeeRmb === "number" ? formatCurrency(summary.adFeeRmb) : "--"}</div>
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
                <th className="product-name-col px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">最终售价</th>
                <th className="px-4 py-3 font-medium">采购总成本</th>
                <th className="px-4 py-3 font-medium">Temu补贴</th>
                <th className="px-4 py-3 font-medium">顺丰</th>
                <th className="px-4 py-3 font-medium">广告消耗</th>
                <th className="px-4 py-3 font-medium">3cm可用</th>
                <th className="px-4 py-3 font-medium">物流方式</th>
                <th className="px-4 py-3 font-medium">物流运费</th>
                <th className="px-4 py-3 font-medium">利润（含广告）</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => {
                  const summary = summaries[product.id];
                  return (
                    <tr key={product.id}>
                      <td className="px-4 py-3">{product.product_code}</td>
                      <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                      <td className="px-4 py-3">
                        {typeof summary?.finalSalePriceRmb === "number"
                          ? formatCurrency(summary.finalSalePriceRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.purchaseTotalCostRmb === "number"
                          ? formatCurrency(summary.purchaseTotalCostRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.temuShippingSubsidyRmb === "number"
                          ? formatCurrency(summary.temuShippingSubsidyRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.sfCostRmb === "number"
                          ? formatCurrency(summary.sfCostRmb)
                          : "--"}
                      </td>
                      <td className="px-4 py-3">
                        {typeof summary?.adFeeRmb === "number"
                          ? formatCurrency(summary.adFeeRmb)
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
                        {typeof summary?.logisticsCostRmb === "number"
                          ? formatCurrency(summary.logisticsCostRmb)
                          : "--"}
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
