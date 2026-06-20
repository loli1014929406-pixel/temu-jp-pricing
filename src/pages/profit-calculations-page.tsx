import type { User } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp, ArrowUpDown, Calculator, Download, Megaphone, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
  getProductRoutePath,
} from "../lib/products";
import { fetchTemuOrders } from "../lib/orders";
import { fetchProfitCalculationsBySkuIds, saveProfitCalculation } from "../lib/profit-calculations";
import { fetchSettings } from "../lib/settings";
import type {
  PricingResult,
  PricingSettings,
  Product,
  ProductSku,
  TemuOrderRecord,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency } from "../utils/pricing";
import {
  calculateAdFeeRmb,
  calculateFinalSalePriceRmb,
  calculateProfitProjection,
  PROFIT_CALCULATION_VERSION,
} from "../utils/profit-calculation";
import {
  getProfitCalculationsDraftKey,
  writeProductDiscountDraft,
  type ProfitCalculationsDraft,
  type ProfitDiscountFields,
} from "../utils/profit-discount-drafts";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { Badge, PageHeader } from "../components/ui";
import { isSameDraft, readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import { addObjectSheet, createWorkbook, downloadWorkbook } from "../lib/excel";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";

import { getPaginatedRows } from "./finance/shared";
import { StandardTable } from "../components/ui";

type ProfitCalculationsPageProps = {
  user: User;
};

type DiscountFields = ProfitDiscountFields;

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

type SortKey =
  | "productCode"
  | "salesQuantity"
  | "activityDiscountRate"
  | "profitRmb"
  | "profitRate";
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

function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

function getOrderFulfillmentQuantity(order: TemuOrderRecord) {
  return Math.max(1, Math.trunc(order.fulfillment_quantity || 0));
}

function buildProductSalesQuantities(
  products: Product[],
  skus: ProductSku[],
  orders: TemuOrderRecord[],
) {
  const productsById = Object.fromEntries(products.map((product) => [product.id, product]));
  const skuByCode = new Map<string, ProductSku>();
  const skuBySalesSpec = new Map<string, ProductSku>();
  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
    if (!sku.product_id) return groups;
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});

  Object.entries(skusByProductId).forEach(([productId, productSkus]) => {
    const product = productsById[productId];

    productSkus.forEach((sku, index) => {
      const salesSpecKey = normalizeSalesSpec(formatSkuSalesSpec(sku));
      if (salesSpecKey && !skuBySalesSpec.has(salesSpecKey)) {
        skuBySalesSpec.set(salesSpecKey, sku);
      }

      [
        sku.sku_code,
        product && isLegacyDefaultSkuCode(sku.sku_code)
          ? buildDefaultSkuCode(product.product_code, index)
          : "",
      ].forEach((skuCode) => {
        const key = normalizeSkuCode(skuCode);
        if (key) skuByCode.set(key, sku);
      });
    });
  });

  return orders.reduce<Record<string, number>>((totals, order) => {
    const skuCode = normalizeSkuCode(order.sku_code);
    const sku = skuCode
      ? skuByCode.get(skuCode)
      : skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes));
    if (!sku?.product_id) return totals;

    totals[sku.product_id] =
      (totals[sku.product_id] ?? 0) + getOrderFulfillmentQuantity(order);
    return totals;
  }, {});
}

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

function selectHighestTotalCostCalculation(
  calculations: ProductRuntimeCalculation[],
) {
  return calculations.reduce<ProductRuntimeCalculation | null>(
    (selected, calculation) =>
      selected === null ||
      calculation.pricing.totalCostRmb > selected.pricing.totalCostRmb
        ? calculation
        : selected,
    null,
  );
}

function matchesActivityDiscountFilter(
  summary: DiscountSummary | undefined,
  customMin: string,
  customMax: string,
) {
  if (customMin.trim() === "" && customMax.trim() === "") return true;
  if (!summary || typeof summary.activityDiscountRate !== "number") return false;

  const discount = summary.activityDiscountRate;
  const min = customMin.trim() === "" ? null : Number(customMin);
  const max = customMax.trim() === "" ? null : Number(customMax);
  if (min !== null && (Number.isNaN(min) || discount < min)) return false;
  if (max !== null && (Number.isNaN(max) || discount > max)) return false;
  return true;
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
  const representativeCalculation =
    validRows.length > 0
      ? validRows.reduce((selected, calculation) => {
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

type MetricTileProps = {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger";
};

function MetricTile({ label, value, tone = "default" }: MetricTileProps) {
  const valueClass =
    tone === "success"
      ? "text-emerald-700"
      : tone === "warning"
        ? "text-amber-700"
        : tone === "danger"
          ? "text-rose-700"
          : "text-slate-950";

  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

export function ProfitCalculationsPage({ user }: ProfitCalculationsPageProps) {
  const { canEdit } = usePermissions();
  const draftKey = getProfitCalculationsDraftKey(user.id);
  const [products, setProducts] = useState<Product[]>([]);
  const [temuPrices, setTemuPrices] = useState<Record<string, number | null>>({});
  const [discountSummaries, setDiscountSummaries] = useState<Record<string, DiscountSummary>>({});
  const [salesQuantities, setSalesQuantities] = useState<Record<string, number>>({});
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
    key: "salesQuantity",
    direction: "desc",
  });
  const [productSearchTerm, setProductSearchTerm] = useState("");
  const [customActivityDiscountMin, setCustomActivityDiscountMin] = useState("");
  const [customActivityDiscountMax, setCustomActivityDiscountMax] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(savedProductId, () => setSavedProductId(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    setPage(1);
  }, [pageSize, productSearchTerm, sortState]);

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
        const [items, skus, settings, orders] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchSettings(user.id),
          fetchTemuOrders(),
        ]);
        const nextSalesQuantities = buildProductSalesQuantities(
          nextProducts,
          skus,
          orders,
        );
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
            const representativeCalculation = selectHighestTotalCostCalculation(
              nextRuntimeCalculations[product.id] ?? [],
            );

            return [
              product.id,
              representativeCalculation?.temuPriceRmb ?? null,
            ];
          }),
        );
        const nextDiscountSummaries = Object.fromEntries(
          nextProducts.map((product) => {
            const productSkus = skusByProductId[product.id] ?? [];
            const representativeCalculation = selectHighestTotalCostCalculation(
              nextRuntimeCalculations[product.id] ?? [],
            );
            const savedForProduct = productSkus.flatMap((sku) =>
              sku.id && savedCalculationBySkuId[sku.id]
                ? [savedCalculationBySkuId[sku.id]]
                : [],
            );
            const firstSaved =
              (representativeCalculation
                ? savedCalculationBySkuId[representativeCalculation.skuId]
                : undefined) ?? savedForProduct[0];
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
          setSalesQuantities(nextSalesQuantities);
          setRuntimeCalculations(nextRuntimeCalculations);
          setSettings(settings);
          setDraftNotice(shouldRestoreDraft ? "已恢复上次未保存的利润分析草稿。" : "");
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

    const current = discountSummaries[productId];
    if (!current) return;

    const discounts = {
      trafficDiscountRate: current.trafficDiscountRate,
      activityDiscountRate: current.activityDiscountRate,
      couponDiscountRate: current.couponDiscountRate,
      adRoas: current.adRoas ?? defaultDiscounts.adRoas,
      [field]: value,
    };
    const nextSummary = calculateProductDiscountSummary(
      discounts,
      temuPrices[productId] ?? null,
      runtimeCalculations[productId] ?? [],
      settings,
    );

    setSavedProductId("");
    setDiscountSummaries((state) => ({
      ...state,
      [productId]: nextSummary,
    }));
    writeProductDiscountDraft(user.id, productId, discounts);
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
    setPage(1);
  }

  const filteredProducts = useMemo(() => {
    const normalizedSearchTerm = productSearchTerm.trim().toLowerCase();

    return products.filter((product) => {
      const matchesProductSearch =
        !normalizedSearchTerm ||
        product.product_code.toLowerCase().includes(normalizedSearchTerm) ||
        product.product_name_cn.toLowerCase().includes(normalizedSearchTerm);

      return (
        matchesProductSearch &&
        matchesActivityDiscountFilter(
          discountSummaries[product.id],
          customActivityDiscountMin,
          customActivityDiscountMax,
        )
      );
    });
  }, [
    customActivityDiscountMax,
    customActivityDiscountMin,
    discountSummaries,
    productSearchTerm,
    products,
  ]);

  const sortedProducts = useMemo(() => {
    return [...filteredProducts].sort((first, second) => {
      let result = 0;

      if (sortState.key === "productCode") {
        result = first.product_code.localeCompare(second.product_code, "zh-Hans-CN", {
          numeric: true,
          sensitivity: "base",
        });
      } else if (sortState.key === "salesQuantity") {
        result = (salesQuantities[first.id] ?? 0) - (salesQuantities[second.id] ?? 0);
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
  }, [discountSummaries, filteredProducts, salesQuantities, sortState]);

  const paginatedProducts = useMemo(() => {
    return getPaginatedRows("profit-calculations", sortedProducts, page, pageSize);
  }, [sortedProducts, page, pageSize]);

  async function handleExcelExport() {
    setExporting(true);
    setErrorMessage("");

    try {
      const rows = sortedProducts.map((product) => {
        const summary = discountSummaries[product.id];
        const temuPrice = temuPrices[product.id];

        return {
          商品编号: product.product_code,
          产品名称: product.product_name_cn,
          销量: salesQuantities[product.id] ?? 0,
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
      const workbook = await createWorkbook();
      addObjectSheet(workbook, "利润分析", rows);
      await downloadWorkbook(
        workbook,
        `profit-calculation-${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "下载表格失败"));
    } finally {
      setExporting(false);
    }
  }

  const {
    averageAdFee,
    averageFinalPrice,
    averageProfitRate,
    healthyProfitCount,
    maxRiskValue,
    negativeProfitCount,
    reviewedProductCount,
    riskRows,
    warningProfitCount,
  } = useMemo(() => {
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

    return {
      averageAdFee,
      averageFinalPrice,
      averageProfitRate,
      healthyProfitCount,
      maxRiskValue,
      negativeProfitCount,
      reviewedProductCount,
      riskRows,
      warningProfitCount,
    };
  }, [discountSummaries]);

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="利润分析"
        description="实时分析利润率、最终售价及广告投放安全边际"
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

      <section className="surface-card grid gap-4 p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-950">利润总览</h2>
              <Badge tone={negativeProfitCount > 0 ? "danger" : "success"}>
                {negativeProfitCount > 0 ? "需复核" : "稳定"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              已测算商品 {reviewedProductCount} / {products.length}，基于当前折扣、ROAS 与保存的利润测算实时汇总
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap lg:justify-end">
            <button
              type="button"
              className="btn-secondary h-10 px-3"
              disabled={loading || exporting || products.length === 0}
              onClick={() => void handleExcelExport()}
            >
              <Download size={18} />
              {exporting ? "下载中" : "下载表格"}
            </button>
            <Link to="/profit-calculation/recommendations" className="btn-secondary h-10 px-3">
              <Megaphone size={18} />
              促销投放推荐
            </Link>
            <Link to="/profit-calculation/standard-shipping" className="btn-secondary h-10 px-3">
              <Calculator size={18} />
              多件发货测算
            </Link>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <MetricTile label="在售商品" value={String(products.length)} />
            <MetricTile label="平均利润率" value={averageProfitRate} tone="success" />
            <MetricTile
              label="广告后亏损"
              value={String(negativeProfitCount)}
              tone={negativeProfitCount > 0 ? "danger" : "default"}
            />
            <MetricTile label="平均广告费" value={averageAdFee} />
            <MetricTile label="平均最终售价" value={averageFinalPrice} />
            <MetricTile
              label="测算覆盖率"
              value={
                products.length > 0
                  ? `${((reviewedProductCount / products.length) * 100).toFixed(1)}%`
                  : "--"
              }
            />
            <MetricTile label="低利润观察" value={String(warningProfitCount)} tone="warning" />
            <MetricTile label="健康商品" value={String(healthyProfitCount)} tone="success" />
          </div>

          <div className="grid content-start gap-3 rounded-lg bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-950">利润健康度</h3>
              <span className="text-xs font-semibold text-slate-500">
                {reviewedProductCount} / {products.length}
              </span>
            </div>
            {riskRows.map((row) => (
              <div key={row.label} className="grid gap-1">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white">
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

      <section className="grid gap-3 rounded-lg border border-line bg-white p-3 md:hidden">
        <p className="text-sm font-semibold text-slate-700">商品筛选</p>
        <input
          aria-label="商品编号或商品名筛选"
          className="h-10 rounded-md border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15"
          type="search"
          placeholder="输入商品编号或商品名"
          value={productSearchTerm}
          onChange={(event) => setProductSearchTerm(event.target.value)}
        />
        <p className="text-sm font-semibold text-slate-700">活动折扣筛选</p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <input
            aria-label="活动折扣最小值"
            className="h-10 rounded-md border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15"
            min="0"
            max="10"
            step="0.01"
            type="number"
            placeholder="最小"
            value={customActivityDiscountMin}
            onChange={(event) => setCustomActivityDiscountMin(event.target.value)}
          />
          <span className="text-sm text-slate-500">到</span>
          <input
            aria-label="活动折扣最大值"
            className="h-10 rounded-md border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15"
            min="0"
            max="10"
            step="0.01"
            type="number"
            placeholder="最大"
            value={customActivityDiscountMax}
            onChange={(event) => setCustomActivityDiscountMax(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-500">
            显示 {sortedProducts.length} / {products.length}
          </span>
          {(productSearchTerm || customActivityDiscountMin || customActivityDiscountMax) && (
            <button
              type="button"
              className="btn-secondary h-9 px-3"
              onClick={() => {
                setProductSearchTerm("");
                setCustomActivityDiscountMin("");
                setCustomActivityDiscountMax("");
              }}
            >
              清除筛选
            </button>
          )}
        </div>
      </section>

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : sortedProducts.length === 0 ? (
          <div className="empty-state">没有符合当前筛选条件的商品</div>
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
                    销量：{salesQuantities[product.id] ?? 0}
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

      <section className="surface-card hidden gap-3 p-4 md:grid">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div>
            <h2 className="text-base font-semibold text-slate-950">商品利润明细</h2>
            <p className="mt-1 text-sm text-slate-500">
              可排序、筛选并直接编辑折扣参数，当前显示 {sortedProducts.length} / {products.length}
            </p>
          </div>
          <div className="grid gap-2 lg:grid-cols-[minmax(240px,320px)_auto_auto] lg:items-end">
            <label className="grid gap-1 text-xs font-semibold text-slate-600">
              <span>商品筛选</span>
              <input
                aria-label="商品编号或商品名筛选"
                className="h-10 rounded-xl border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                type="search"
                placeholder="商品编号或商品名"
                value={productSearchTerm}
                onChange={(event) => { setProductSearchTerm(event.target.value); setPage(1); }}
              />
            </label>
            <div className="grid gap-1">
              <span className="text-xs font-semibold text-slate-600">活动折扣</span>
              <div className="grid grid-cols-[88px_auto_88px] items-center gap-2">
                <input
                  aria-label="活动折扣最小值"
                  className="h-10 rounded-xl border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  min="0"
                  max="10"
                  step="0.01"
                  type="number"
                  placeholder="最小"
                  value={customActivityDiscountMin}
                  onChange={(event) => { setCustomActivityDiscountMin(event.target.value); setPage(1); }}
                />
                <span className="text-xs font-semibold text-slate-500">到</span>
                <input
                  aria-label="活动折扣最大值"
                  className="h-10 rounded-xl border border-line bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  min="0"
                  max="10"
                  step="0.01"
                  type="number"
                  placeholder="最大"
                  value={customActivityDiscountMax}
                  onChange={(event) => { setCustomActivityDiscountMax(event.target.value); setPage(1); }}
                />
              </div>
            </div>
            {(productSearchTerm || customActivityDiscountMin || customActivityDiscountMax) && (
              <button
                type="button"
                className="btn-secondary h-10 px-3"
                onClick={() => {
                  setProductSearchTerm("");
                  setCustomActivityDiscountMin("");
                  setCustomActivityDiscountMax("");
                  setPage(1);
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="table-card hidden md:block rounded-lg shadow-soft overflow-hidden bg-panel">
        <div className="overflow-x-auto">
          <StandardTable 
            minWidth="min-w-[1200px]"
            page={paginatedProducts.page}
            pageSize={pageSize}
            totalPages={paginatedProducts.totalPages}
            totalRecordCount={paginatedProducts.total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          >
            <thead>
              <tr>
                <th className="bg-slate-50 px-4 py-3 font-medium">
                  <SortableHeader
                    label="商品编号"
                    sortKey="productCode"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="bg-slate-50 px-4 py-3 text-left font-medium text-slate-500">产品名称</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">
                  <SortableHeader
                    label="销量"
                    sortKey="salesQuantity"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="bg-slate-50 px-4 py-3 font-medium text-slate-500">核价</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">总成本</th>
                <th className="bg-slate-50 px-4 py-3 font-medium text-slate-500">流量加速</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">
                  <SortableHeader
                    label="活动折扣"
                    sortKey="activityDiscountRate"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">优惠券价</th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">ROAS</th>
                <th className="bg-slate-50 px-4 py-3 text-right font-medium text-slate-500">广告费</th>
                <th className="bg-slate-50 px-4 py-3 text-right font-medium text-slate-500">最终售价</th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">PR</th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">临界值</th>
                <th className="bg-slate-50 px-4 py-3 font-medium">
                  <SortableHeader
                    label="利润"
                    sortKey="profitRmb"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="bg-slate-50 px-4 py-3 font-medium">
                  <SortableHeader
                    label="利润率"
                    sortKey="profitRate"
                    sortState={sortState}
                    onSort={handleSort}
                  />
                </th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">
                  包邮数量
                </th>
                <th className="bg-slate-50 px-4 py-3 text-center font-medium text-slate-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-white">
              {paginatedProducts.rows.map((product) => {
                  const summary = discountSummaries[product.id];

                  return (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                    <td className="number-cell">{salesQuantities[product.id] ?? 0}</td>
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
                })}
            </tbody>
          </StandardTable>
        </div>
      </div>
    </section>
  );
}
