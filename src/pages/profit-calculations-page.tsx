import type { User } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Megaphone, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  calculateAdFeeRmb,
  calculateFinalSalePriceRmb,
  calculateProfitProjection,
  PROFIT_CALCULATION_VERSION,
} from "../utils/profit-calculation";
import { Badge, PageHeader, StatCard } from "../components/ui";
import { isSameDraft, readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
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

type ProfitCalculationsDraft = {
  discountsByProductId: Record<string, DiscountFields>;
};

function getDiscountFields(summary: DiscountSummary): DiscountFields {
  return {
    trafficDiscountRate: summary.trafficDiscountRate,
    activityDiscountRate: summary.activityDiscountRate,
    couponDiscountRate: summary.couponDiscountRate,
    adRoas: summary.adRoas ?? defaultDiscounts.adRoas,
  };
}

function hasProfitCalculationsDraft(
  draft: ProfitCalculationsDraft | null | undefined,
  baseSummaries: Record<string, DiscountSummary>,
) {
  if (!draft) return false;

  return Object.entries(draft.discountsByProductId).some(([productId, discounts]) => {
    const baseSummary = baseSummaries[productId];
    return baseSummary ? !isSameDraft(discounts, getDiscountFields(baseSummary)) : false;
  });
}

type DiscountInputProps = {
  label: string;
  value: number;
  min?: string;
  max?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

type SortKey = "productCode" | "activityDiscountRate" | "profitRmb" | "profitRate";
type SortDirection = "asc" | "desc";

type SortState = {
  key: SortKey;
  direction: SortDirection;
};

type SortableHeaderProps = {
  label: string;
  sortKey: SortKey;
  sortState: SortState;
  onSort: (key: SortKey) => void;
};

const defaultDiscounts: DiscountFields = {
  trafficDiscountRate: 0,
  activityDiscountRate: 10,
  couponDiscountRate: 0,
  adRoas: 0,
};

const getSavedCalculationVersion = (calculation: { result_json?: { calculationVersion?: number } } | undefined) =>
  calculation?.result_json?.calculationVersion ?? 0;

function compareNullableNumbers(
  first: number | null | undefined,
  second: number | null | undefined,
) {
  const firstIsNumber = typeof first === "number";
  const secondIsNumber = typeof second === "number";

  if (!firstIsNumber && !secondIsNumber) return 0;
  if (!firstIsNumber) return 1;
  if (!secondIsNumber) return -1;
  return first - second;
}

function SortableHeader({ label, sortKey, sortState, onSort }: SortableHeaderProps) {
  const active = sortState.key === sortKey;
  const Icon = active ? (sortState.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-medium text-inherit transition hover:text-accent"
      aria-sort={active ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      <span>{label}</span>
      <Icon size={14} className={active ? "text-accent" : "text-slate-400"} />
    </button>
  );
}

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
    typeof displayedTemuPriceRmb === "number"
      ? calculateAdFeeRmb({
          temuPriceRmb: displayedTemuPriceRmb,
          ...discounts,
        })
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
  const draftKey = `profit-calculations-draft:v1:${user.id}`;
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
  const [sortState, setSortState] = useState<SortState>({
    key: "productCode",
    direction: "asc",
  });
  const [draftNotice, setDraftNotice] = useState("");

  const draftValue = useMemo<ProfitCalculationsDraft>(
    () => ({
      discountsByProductId: Object.fromEntries(
        Object.entries(discountSummaries).map(([productId, summary]) => [
          productId,
          {
            trafficDiscountRate: summary.trafficDiscountRate,
            activityDiscountRate: summary.activityDiscountRate,
            couponDiscountRate: summary.couponDiscountRate,
            adRoas: summary.adRoas ?? defaultDiscounts.adRoas,
          },
        ]),
      ),
    }),
    [discountSummaries],
  );

  useDraftPersistence(draftKey, draftValue, { enabled: !loading && products.length > 0 });

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
          const latestDraft = readDraft<ProfitCalculationsDraft>(draftKey);
          const shouldRestoreDraft = hasProfitCalculationsDraft(
            latestDraft,
            nextDiscountSummaries,
          );
          const restoredDiscountSummaries = shouldRestoreDraft && latestDraft
            ? Object.fromEntries(
                Object.entries(nextDiscountSummaries).map(([productId, summary]) => {
                  const discounts = latestDraft.discountsByProductId[productId];
                  return [
                    productId,
                    discounts
                      ? calculateProductDiscountSummary(
                          discounts,
                          nextTemuPrices[productId],
                          nextRuntimeCalculations[productId] ?? [],
                          settings,
                        )
                      : summary,
                  ];
                }),
              )
            : nextDiscountSummaries;
          setProducts(nextProducts);
          setTemuPrices(nextTemuPrices);
          setDiscountSummaries(restoredDiscountSummaries);
          setRuntimeCalculations(nextRuntimeCalculations);
          setSettings(settings);
          setDraftNotice(shouldRestoreDraft ? "已恢复上次未保存的利润数据分析草稿。" : "");
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
  }, [draftKey, user.id]);

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

  function handleSort(key: SortKey) {
    setSortState((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  const sortedProducts = useMemo(() => {
    return [...products].sort((first, second) => {
      let result = 0;

      if (sortState.key === "productCode") {
        result = first.product_code.localeCompare(second.product_code, "zh-Hans-CN", {
          numeric: true,
          sensitivity: "base",
        });
      } else {
        const firstSummary = discountSummaries[first.id];
        const secondSummary = discountSummaries[second.id];
        result = compareNullableNumbers(
          firstSummary?.[sortState.key],
          secondSummary?.[sortState.key],
        );
      }

      if (result === 0) {
        result = first.product_code.localeCompare(second.product_code, "zh-Hans-CN", {
          numeric: true,
          sensitivity: "base",
        });
      }

      return sortState.direction === "asc" ? result : -result;
    });
  }, [discountSummaries, products, sortState]);

  async function handleExcelExport() {
    setExporting(true);
    setErrorMessage("");

    try {
      const XLSX = await import("xlsx");
      const rows = sortedProducts.map((product) => {
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
  const validFinalPrices = summaries.flatMap((summary) =>
    typeof summary.discountedSalePriceRmb === "number" ? [summary.discountedSalePriceRmb] : [],
  );
  const negativeProfitCount = summaries.filter(
    (summary) => typeof summary.profitRmb === "number" && summary.profitRmb < 0,
  ).length;
  const warningProfitCount = summaries.filter(
    (summary) =>
      typeof summary.profitRate === "number" &&
      summary.profitRate >= 0 &&
      summary.profitRate < 0.15,
  ).length;
  const healthyProfitCount = summaries.filter(
    (summary) => typeof summary.profitRate === "number" && summary.profitRate >= 0.3,
  ).length;
  const reviewedProductCount = validProfitRates.length;
  const averageProfitRate =
    validProfitRates.length > 0
      ? `${((validProfitRates.reduce((sum, value) => sum + value, 0) / validProfitRates.length) * 100).toFixed(2)}%`
      : "--";
  const averageAdFee =
    validAdFees.length > 0
      ? formatCurrency(validAdFees.reduce((sum, value) => sum + value, 0) / validAdFees.length)
      : "--";
  const averageFinalPrice =
    validFinalPrices.length > 0
      ? formatCurrency(validFinalPrices.reduce((sum, value) => sum + value, 0) / validFinalPrices.length)
      : "--";
  const riskRows = [
    { label: "健康利润率 ≥ 30%", value: healthyProfitCount, className: "bg-emerald-500" },
    { label: "观察区间 0% - 15%", value: warningProfitCount, className: "bg-amber-500" },
    { label: "广告后亏损", value: negativeProfitCount, className: "bg-rose-500" },
  ];
  const maxRiskValue = Math.max(1, ...riskRows.map((row) => row.value));

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
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="在售商品数" value={String(products.length)} />
          <StatCard label="平均广告后利润率" value={averageProfitRate} tone="success" />
          <StatCard label="广告后亏损商品数" value={String(negativeProfitCount)} tone={negativeProfitCount > 0 ? "danger" : "default"} />
          <StatCard label="平均广告费" value={averageAdFee} />
        </div>

        <div className="erp-dashboard-panel grid gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">利润健康度</h2>
              <p className="mt-1 text-sm text-slate-500">
                已测算商品 {reviewedProductCount} / {products.length}
              </p>
            </div>
            <Badge tone={negativeProfitCount > 0 ? "danger" : "success"}>
              {negativeProfitCount > 0 ? "需复核" : "稳定"}
            </Badge>
          </div>
          <div className="grid gap-3">
            {riskRows.map((row) => (
              <div key={row.label} className="grid gap-1">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${row.className}`}
                    style={{ width: `${Math.max(4, (row.value / maxRiskValue) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="erp-dashboard-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">经营指标总览</h2>
              <p className="mt-1 text-sm text-slate-500">
                基于当前商品、折扣、ROAS 与保存的利润测算实时汇总
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-right">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">平均最终售价</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">{averageFinalPrice}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-500">测算覆盖率</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">
                {products.length > 0 ? `${((reviewedProductCount / products.length) * 100).toFixed(1)}%` : "--"}
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-500">低利润观察</p>
              <p className="mt-2 text-xl font-semibold text-amber-700">{warningProfitCount}</p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-500">健康商品</p>
              <p className="mt-2 text-xl font-semibold text-emerald-700">{healthyProfitCount}</p>
            </div>
          </div>
        </div>

        <div className="erp-dashboard-panel">
          <h2 className="text-base font-semibold text-slate-950">操作中心</h2>
          <div className="mt-3 grid gap-2">
            <button
              type="button"
              className="btn-secondary w-full justify-start"
              disabled={loading || exporting || products.length === 0}
              onClick={() => void handleExcelExport()}
            >
              <Download size={18} />
              {exporting ? "下载中" : "下载表格"}
            </button>
            <Link to="/profit-calculation/recommendations" className="btn-secondary w-full justify-start">
              <Megaphone size={18} />
              促销投放推荐
            </Link>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            表格中的折扣、ROAS 与保存操作保持原功能。下载表格仍导出当前排序后的商品利润数据。
          </p>
        </div>
      </section>

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          sortedProducts.map((product) => {
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

      <div className="erp-toolbar hidden items-center justify-between gap-3 md:flex">
        <div>
          <h2 className="text-base font-semibold text-slate-950">商品利润明细</h2>
          <p className="mt-1 text-sm text-slate-500">高密度 ERP 数据表，可排序并直接编辑折扣参数</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          成功
          <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
          观察
          <span className="inline-flex h-2 w-2 rounded-full bg-rose-500" />
          风险
        </div>
      </div>

      <div className="table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">
                  <SortableHeader
                    label="商品编号"
                    sortKey="productCode"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="product-name-col px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">核价</th>
                <th className="px-4 py-3 font-medium">总成本</th>
                <th className="px-4 py-3 font-medium">流量加速</th>
                <th className="px-4 py-3 font-medium">
                  <SortableHeader
                    label="活动折扣"
                    sortKey="activityDiscountRate"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="px-4 py-3 font-medium">优惠券价</th>
                <th className="px-4 py-3 font-medium">ROAS</th>
                <th className="px-4 py-3 font-medium">广告费</th>
                <th className="px-4 py-3 font-medium">最终售价</th>
                <th className="px-4 py-3 font-medium">PR</th>
                <th className="px-4 py-3 font-medium">临界值</th>
                <th className="px-4 py-3 font-medium">
                  <SortableHeader
                    label="利润"
                    sortKey="profitRmb"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="px-4 py-3 font-medium">
                  <SortableHeader
                    label="利润率"
                    sortKey="profitRate"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
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
                sortedProducts.map((product) => {
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
