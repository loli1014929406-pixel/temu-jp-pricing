import type { User } from "@supabase/supabase-js";
import { Download, Megaphone, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
  getProductRoutePath,
} from "../lib/products";
import { fetchProfitCalculationsBySkuIds, saveProfitCalculation } from "../lib/profit-calculations";
import { fetchSettings } from "../lib/settings";
import type {
  PricingResult,
  PricingSettings,
  Product,
  ProfitCalculationInput,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency } from "../utils/pricing";
import {
  calculateFinalSalePriceRmb,
  calculateProfitProjection,
  PROFIT_CALCULATION_VERSION,
} from "../utils/profit-calculation";
import { Badge, PageHeader, StatCard } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";

type ProfitCalculationsPageProps = {
  user: User;
};

type DiscountFields = Required<
  Pick<
    ProfitCalculationInput,
    "trafficDiscountRate" | "activityDiscountRate" | "couponDiscountRate" | "adRoas"
  >
>;

type ProductRuntimeCalculation = {
  skuId: string;
  pricing: PricingResult;
  temuPriceRmb: number;
};

type DiscountSummary = DiscountFields & {
  discountedSalePriceRmb: number | null;
  adFeeRmb: number | null;
  totalCostRmb: number | null;
  profitRmb: number | null;
  profitRate: number | null;
  costProfitRate: number | null;
  criticalValue: number | null;
  freeShippingThresholdQty: number | null;
};

type DiscountInputProps = {
  label: string;
  value: number;
  min?: string;
  max?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

const defaultDiscounts: DiscountFields = {
  trafficDiscountRate: 0,
  activityDiscountRate: 10,
  couponDiscountRate: 0,
  adRoas: 0,
};

const getSavedCalculationVersion = (calculation: { result_json?: { calculationVersion?: number } } | undefined) =>
  calculation?.result_json?.calculationVersion ?? 0;

function calculateProductDiscountSummary(
  discounts: DiscountFields,
  displayedTemuPriceRmb: number | null,
  runtimeCalculations: ProductRuntimeCalculation[],
  settings: PricingSettings | null,
): DiscountSummary {
  const displayedFinalSalePriceRmb =
    typeof displayedTemuPriceRmb === "number"
      ? calculateFinalSalePriceRmb({
          temuPriceRmb: displayedTemuPriceRmb,
          ...discounts,
        })
      : null;
  const displayedAdFeeRmb =
    displayedFinalSalePriceRmb !== null && (discounts.adRoas ?? 0) > 0
      ? displayedFinalSalePriceRmb / (discounts.adRoas ?? 0)
      : 0;
  const baseSummary: DiscountSummary = {
    ...discounts,
    discountedSalePriceRmb: displayedFinalSalePriceRmb,
    adFeeRmb: displayedFinalSalePriceRmb === null ? null : Number(displayedAdFeeRmb.toFixed(2)),
    totalCostRmb: null,
    profitRmb: null,
    profitRate: null,
    costProfitRate: null,
    criticalValue: null,
    freeShippingThresholdQty: null,
  };

  if (!settings) return baseSummary;

  const calculatedRows = runtimeCalculations.map((calculation) => {
    const input = {
      temuPriceRmb: calculation.temuPriceRmb,
      ...discounts,
    };

    return {
      ...calculation,
      result: calculateProfitProjection(calculation.pricing, settings, input),
    };
  });
  const validRows = calculatedRows.filter((calculation) => calculation.result.isValid);
  const lowestTemuPrice =
    validRows.length > 0
      ? Math.min(...validRows.map((calculation) => calculation.temuPriceRmb))
      : null;
  const lowestPriceCandidates =
    lowestTemuPrice === null
      ? []
      : validRows.filter((calculation) => calculation.temuPriceRmb === lowestTemuPrice);
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
    representativeCalculation && representativeCalculation.result.plans.length > 0
      ? representativeCalculation.result.plans.reduce((selected, plan) =>
          plan.totalCostRmb > selected.totalCostRmb ? plan : selected,
        )
      : null;
  const costProfitRate =
    representativePlan && representativePlan.totalCostRmb > 0
      ? representativePlan.profitRmb / representativePlan.totalCostRmb
      : null;
  const criticalValueDenominator =
    representativePlan && displayedFinalSalePriceRmb !== null
      ? representativePlan.profitRmb +
        representativePlan.adFeeRmb -
        representativePlan.totalCostRmb * 0.3
      : null;
  const criticalValue =
    displayedFinalSalePriceRmb !== null &&
    criticalValueDenominator !== null &&
    criticalValueDenominator > 0
      ? displayedFinalSalePriceRmb / criticalValueDenominator
      : null;

  return {
    ...baseSummary,
    totalCostRmb: representativePlan?.totalCostRmb ?? null,
    profitRmb: representativePlan?.profitRmb ?? null,
    profitRate: representativePlan?.profitRate ?? null,
    costProfitRate:
      costProfitRate === null ? null : Number(costProfitRate.toFixed(4)),
    criticalValue: criticalValue === null ? null : Number(criticalValue.toFixed(2)),
    adFeeRmb: representativePlan?.adFeeRmb ?? baseSummary.adFeeRmb,
    freeShippingThresholdQty:
      representativeCalculation?.result.freeShippingThresholdQty ?? null,
  };
}

function DiscountInput({
  label,
  value,
  min = "0",
  max,
  disabled = false,
  onChange,
}: DiscountInputProps) {
  return (
    <input
      aria-label={label}
      className="h-8 w-16 rounded-md border border-line bg-white px-1.5 text-left text-sm tabular-nums outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
      disabled={disabled}
      min={min}
      max={max}
      step="0.01"
      type="number"
      value={value}
      onChange={(event) => onChange(Number(event.target.value || 0))}
    />
  );
}

export function ProfitCalculationsPage({ user }: ProfitCalculationsPageProps) {
  const { canEdit } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [temuPrices, setTemuPrices] = useState<Record<string, number | null>>({});
  const [discountSummaries, setDiscountSummaries] = useState<Record<string, DiscountSummary>>({});
  const [runtimeCalculations, setRuntimeCalculations] = useState<
    Record<string, ProductRuntimeCalculation[]>
  >({});
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProductId, setSavingProductId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [savedProductId, setSavedProductId] = useState("");

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
        const nextRuntimeCalculations = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const productCalculations = productSkus.flatMap((sku) => {
              if (!sku.id) return [];

              const skuItems = sku.component_links.flatMap((link) => {
                const item = itemsById[link.item_id];
                return item ? [{ ...item, quantity: link.quantity }] : [];
              });
              if (skuItems.length === 0) return [];

              const pricing = calculatePricing(product.package_weight_g, skuItems, settings);
              const saved = savedCalculationBySkuId[sku.id];

              return [
                {
                  skuId: sku.id,
                  pricing,
                  temuPriceRmb: saved?.temu_price_rmb ?? pricing.temuDeclarationPriceRmb,
                },
              ];
            });

            return [product.id, productCalculations];
          }),
        );
        const nextTemuPrices = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const savedTemuPrices = productSkus.flatMap((sku) =>
              sku.id && typeof savedPricesBySkuId[sku.id] === "number"
                ? [savedPricesBySkuId[sku.id]]
                : [],
            );
            const productTemuPrices = (nextRuntimeCalculations[product.id] ?? []).map(
              (calculation) => calculation.pricing.temuDeclarationPriceRmb,
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
            const savedVersion = getSavedCalculationVersion(firstSaved);
            const usesDiscountFormula = savedVersion >= 4;
            const usesAdFormula = savedVersion >= PROFIT_CALCULATION_VERSION;
            const discounts = {
              trafficDiscountRate: usesDiscountFormula
                ? firstSaved?.traffic_discount_rate ?? defaultDiscounts.trafficDiscountRate
                : defaultDiscounts.trafficDiscountRate,
              activityDiscountRate:
                firstSaved?.activity_discount_rate ?? defaultDiscounts.activityDiscountRate,
              couponDiscountRate: usesDiscountFormula
                ? firstSaved?.coupon_discount_rate ?? defaultDiscounts.couponDiscountRate
                : defaultDiscounts.couponDiscountRate,
              adRoas: usesAdFormula
                ? firstSaved?.result_json?.adRoas ?? defaultDiscounts.adRoas
                : defaultDiscounts.adRoas,
            };

            return [
              product.id,
              calculateProductDiscountSummary(
                discounts,
                nextTemuPrices[product.id],
                nextRuntimeCalculations[product.id] ?? [],
                settings,
              ),
            ];
          }),
        );

        if (active) {
          setProducts(nextProducts);
          setTemuPrices(nextTemuPrices);
          setDiscountSummaries(nextDiscountSummaries);
          setRuntimeCalculations(nextRuntimeCalculations);
          setSettings(settings);
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

  function updateProductDiscount(
    productId: string,
    field: keyof DiscountFields,
    value: number,
  ) {
    if (!settings || Number.isNaN(value) || value < 0) return;
    if (field === "activityDiscountRate" && value > 10) return;

    setSavedProductId("");
    setDiscountSummaries((state) => {
      const current = state[productId];
      if (!current) return state;

      const discounts = {
        trafficDiscountRate: current.trafficDiscountRate,
        activityDiscountRate: current.activityDiscountRate,
        couponDiscountRate: current.couponDiscountRate,
        adRoas: current.adRoas ?? defaultDiscounts.adRoas,
        [field]: value,
      };

      return {
        ...state,
        [productId]: calculateProductDiscountSummary(
          discounts,
          temuPrices[productId] ?? null,
          runtimeCalculations[productId] ?? [],
          settings,
        ),
      };
    });
  }

  async function handleSaveProduct(product: Product) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存利润测算。");
      return;
    }

    if (!settings) return;

    const summary = discountSummaries[product.id];
    const productCalculations = runtimeCalculations[product.id] ?? [];
    if (!summary || productCalculations.length === 0) {
      setErrorMessage("当前商品没有可保存的 SKU 测算");
      return;
    }
    if (
      summary.trafficDiscountRate < 0 ||
      summary.activityDiscountRate <= 0 ||
      summary.activityDiscountRate > 10 ||
      summary.couponDiscountRate < 0 ||
      (summary.adRoas ?? 0) < 0
    ) {
      setErrorMessage("流量加速、优惠券价和 ROAS 不能小于 0，活动折扣必须大于 0 且不超过 10");
      return;
    }

    setSavingProductId(product.id);
    setSavedProductId("");
    setErrorMessage("");

    const discounts = {
      trafficDiscountRate: summary.trafficDiscountRate,
      activityDiscountRate: summary.activityDiscountRate,
      couponDiscountRate: summary.couponDiscountRate,
      adRoas: summary.adRoas ?? defaultDiscounts.adRoas,
    };

    try {
      await Promise.all(
        productCalculations.map((calculation) => {
          const input = {
            temuPriceRmb: calculation.temuPriceRmb,
            ...discounts,
          };

          return saveProfitCalculation(
            product.id,
            calculation.skuId,
            input,
            calculateProfitProjection(calculation.pricing, settings, input),
          );
        }),
      );
      setSavedProductId(product.id);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存利润测算失败"));
    } finally {
      setSavingProductId("");
    }
  }

  async function handleExcelExport() {
    setExporting(true);
    setErrorMessage("");

    try {
      const XLSX = await import("xlsx");
      const rows = products.map((product) => {
        const summary = discountSummaries[product.id];
        const temuPrice = temuPrices[product.id];

        return {
          商品编号: product.product_code,
          产品名称: product.product_name_cn,
          核价: typeof temuPrice === "number" ? temuPrice : "",
          总成本: typeof summary?.totalCostRmb === "number" ? summary.totalCostRmb : "",
          流量加速: summary?.trafficDiscountRate ?? "",
          活动折扣: summary?.activityDiscountRate ?? "",
          优惠券价: summary?.couponDiscountRate ?? "",
          ROAS: summary?.adRoas ?? "",
          广告费: typeof summary?.adFeeRmb === "number" ? summary.adFeeRmb : "",
          最终售价:
            typeof summary?.discountedSalePriceRmb === "number"
              ? summary.discountedSalePriceRmb
              : "",
          PR:
            typeof summary?.costProfitRate === "number"
              ? `${(summary.costProfitRate * 100).toFixed(2)}%`
              : "",
          临界值:
            typeof summary?.criticalValue === "number" ? summary.criticalValue : "",
          利润: typeof summary?.profitRmb === "number" ? summary.profitRmb : "",
          利润率:
            typeof summary?.profitRate === "number"
              ? `${(summary.profitRate * 100).toFixed(2)}%`
              : "",
          免邮件数: summary?.freeShippingThresholdQty ?? "",
        };
      });
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "利润数据分析");
      XLSX.writeFile(workbook, `profit-calculation-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "下载表格失败"));
    } finally {
      setExporting(false);
    }
  }

  const summaries = Object.values(discountSummaries);
  const validProfitRates = summaries.flatMap((summary) =>
    typeof summary.profitRate === "number" ? [summary.profitRate] : [],
  );
  const validAdFees = summaries.flatMap((summary) =>
    typeof summary.adFeeRmb === "number" ? [summary.adFeeRmb] : [],
  );
  const negativeProfitCount = summaries.filter(
    (summary) => typeof summary.profitRmb === "number" && summary.profitRmb < 0,
  ).length;
  const averageProfitRate =
    validProfitRates.length > 0
      ? `${((validProfitRates.reduce((sum, value) => sum + value, 0) / validProfitRates.length) * 100).toFixed(2)}%`
      : "--";
  const averageAdFee =
    validAdFees.length > 0
      ? formatCurrency(validAdFees.reduce((sum, value) => sum + value, 0) / validAdFees.length)
      : "--";

  return (
    <section className="grid gap-5">
      <PageHeader
        title="利润数据分析"
        description="实时分析利润率、最终售价及广告投放安全边际"
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={loading || exporting || products.length === 0}
              onClick={() => void handleExcelExport()}
            >
              <Download size={18} />
              {exporting ? "下载中" : "下载表格"}
            </button>
            <Link to="/profit-calculation/recommendations" className="btn-secondary">
              <Megaphone size={18} />
              促销投放推荐
            </Link>
          </>
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="在售商品数" value={String(products.length)} />
        <StatCard label="平均广告后利润率" value={averageProfitRate} tone="success" />
        <StatCard label="广告后亏损商品数" value={String(negativeProfitCount)} tone={negativeProfitCount > 0 ? "danger" : "default"} />
        <StatCard label="平均广告费" value={averageAdFee} />
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
            const costProfitRate = summary?.costProfitRate;
            const criticalValue = summary?.criticalValue;
            return (
              <article key={product.id} className="mobile-summary-card">
                <p className="mobile-summary-title">{product.product_code}</p>
                <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                <div className="mobile-summary-grid">
                  <div className="mobile-summary-cell">
                    核价：{typeof temuPrices[product.id] === "number" ? formatCurrency(temuPrices[product.id] as number) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    总成本：{typeof summary?.totalCostRmb === "number" ? formatCurrency(summary.totalCostRmb) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    最终售价：{typeof summary?.discountedSalePriceRmb === "number" ? formatCurrency(summary.discountedSalePriceRmb) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    广告费：{typeof summary?.adFeeRmb === "number" ? formatCurrency(summary.adFeeRmb) : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    PR：{typeof costProfitRate === "number" ? `${(costProfitRate * 100).toFixed(2)}%` : "--"}
                  </div>
                  <div className="mobile-summary-cell">
                    临界值：{typeof criticalValue === "number" ? criticalValue.toFixed(2) : "--"}
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
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
                  <label className="grid gap-1">
                    <span>流量加速</span>
                    <DiscountInput
                      label={`${product.product_code} 流量加速`}
                      disabled={!canEdit}
                      value={summary?.trafficDiscountRate ?? defaultDiscounts.trafficDiscountRate}
                      onChange={(value) =>
                        updateProductDiscount(product.id, "trafficDiscountRate", value)
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span>活动折扣</span>
                    <DiscountInput
                      label={`${product.product_code} 活动折扣`}
                      min="0.01"
                      max="10"
                      disabled={!canEdit}
                      value={summary?.activityDiscountRate ?? defaultDiscounts.activityDiscountRate}
                      onChange={(value) =>
                        updateProductDiscount(product.id, "activityDiscountRate", value)
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span>优惠券价</span>
                    <DiscountInput
                      label={`${product.product_code} 优惠券价`}
                      disabled={!canEdit}
                      value={summary?.couponDiscountRate ?? defaultDiscounts.couponDiscountRate}
                      onChange={(value) =>
                        updateProductDiscount(product.id, "couponDiscountRate", value)
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span>ROAS</span>
                    <DiscountInput
                      label={`${product.product_code} ROAS`}
                      disabled={!canEdit}
                      value={summary?.adRoas ?? defaultDiscounts.adRoas}
                      onChange={(value) =>
                        updateProductDiscount(product.id, "adRoas", value)
                      }
                    />
                  </label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {typeof profitRate === "number" ? (
                    <Badge tone={profitRate > 0.3 ? "success" : profitRate >= 0.15 ? "warning" : "danger"}>
                      {(profitRate * 100).toFixed(2)}%
                    </Badge>
                  ) : null}
                </div>
                <div className="mobile-summary-actions">
                  {canEdit && (
                    <button
                      className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-accent disabled:opacity-50"
                      type="button"
                      disabled={savingProductId === product.id}
                      onClick={() => void handleSaveProduct(product)}
                    >
                      <Save size={14} />
                      {savingProductId === product.id
                        ? "保存中"
                        : savedProductId === product.id
                          ? "已保存"
                          : "保存"}
                    </button>
                  )}
                  <Link className="text-action whitespace-nowrap" to={getProductRoutePath(product, "/profit-calculation")}>
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
                <th className="product-name-col px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">核价</th>
                <th className="px-4 py-3 font-medium">总成本</th>
                <th className="px-4 py-3 font-medium">流量加速</th>
                <th className="px-4 py-3 font-medium">活动折扣</th>
                <th className="px-4 py-3 font-medium">优惠券价</th>
                <th className="px-4 py-3 font-medium">ROAS</th>
                <th className="px-4 py-3 font-medium">广告费</th>
                <th className="px-4 py-3 font-medium">最终售价</th>
                <th className="px-4 py-3 font-medium">PR</th>
                <th className="px-4 py-3 font-medium">临界值</th>
                <th className="px-4 py-3 font-medium">利润</th>
                <th className="px-4 py-3 font-medium">利润率</th>
                <th className="px-4 py-3 font-medium">免邮件数</th>
                <th className="min-w-20 px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={16} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={16} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => {
                  const summary = discountSummaries[product.id];

                  return (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                    <td className="money">
                      {typeof temuPrices[product.id] === "number"
                        ? formatCurrency(temuPrices[product.id] as number)
                        : "--"}
                    </td>
                    <td className="money">
                      {typeof summary?.totalCostRmb === "number"
                        ? formatCurrency(summary.totalCostRmb)
                        : "--"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <DiscountInput
                        label={`${product.product_code} 流量加速`}
                        disabled={!canEdit}
                        value={summary?.trafficDiscountRate ?? defaultDiscounts.trafficDiscountRate}
                        onChange={(value) =>
                          updateProductDiscount(product.id, "trafficDiscountRate", value)
                        }
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <DiscountInput
                        label={`${product.product_code} 活动折扣`}
                        min="0.01"
                        max="10"
                        disabled={!canEdit}
                        value={summary?.activityDiscountRate ?? defaultDiscounts.activityDiscountRate}
                        onChange={(value) =>
                          updateProductDiscount(product.id, "activityDiscountRate", value)
                        }
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <DiscountInput
                        label={`${product.product_code} 优惠券价`}
                        disabled={!canEdit}
                        value={summary?.couponDiscountRate ?? defaultDiscounts.couponDiscountRate}
                        onChange={(value) =>
                          updateProductDiscount(product.id, "couponDiscountRate", value)
                        }
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <DiscountInput
                        label={`${product.product_code} ROAS`}
                        disabled={!canEdit}
                        value={summary?.adRoas ?? defaultDiscounts.adRoas}
                        onChange={(value) =>
                          updateProductDiscount(product.id, "adRoas", value)
                        }
                      />
                    </td>
                    <td className="money">
                      {typeof summary?.adFeeRmb === "number"
                        ? formatCurrency(summary.adFeeRmb)
                        : "--"}
                    </td>
                    <td className="money">
                      {typeof summary?.discountedSalePriceRmb === "number"
                        ? formatCurrency(summary.discountedSalePriceRmb)
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {typeof summary?.costProfitRate === "number"
                        ? `${(summary.costProfitRate * 100).toFixed(2)}%`
                        : "--"}
                    </td>
                    <td className="number-cell">
                      {typeof summary?.criticalValue === "number"
                        ? summary.criticalValue.toFixed(2)
                        : "--"}
                    </td>
                    <td className="px-4 py-4">
                      {typeof summary?.profitRmb === "number"
                        ? (
                          <span
                            className={`money ${
                              summary.profitRmb < 0
                                ? "text-rose-700"
                                : summary.profitRmb < 1
                                  ? "text-amber-700"
                                  : "text-emerald-700"
                            }`}
                          >
                            {formatCurrency(summary.profitRmb)}
                          </span>
                        )
                        : "--"}
                    </td>
                    <td className="px-4 py-4">
                      {typeof summary?.profitRate === "number"
                        ? (() => {
                            const profitRate = summary.profitRate;
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
                      {summary?.freeShippingThresholdQty ?? "--"}
                    </td>
                    <td className="min-w-20 px-4 py-3">
                      <div className="flex flex-col items-start gap-2">
                        {canEdit && (
                          <button
                            className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-accent transition hover:underline disabled:opacity-50"
                            type="button"
                            disabled={savingProductId === product.id}
                            onClick={() => void handleSaveProduct(product)}
                          >
                            <Save size={14} />
                            {savingProductId === product.id
                              ? "保存中"
                              : savedProductId === product.id
                                ? "已保存"
                                : "保存"}
                          </button>
                        )}
                        <Link
                          className="text-action whitespace-nowrap"
                          to={getProductRoutePath(product, "/profit-calculation")}
                        >
                          查看利润
                        </Link>
                      </div>
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
