import type { User } from "@supabase/supabase-js";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, BackToParentAction, PageHeader, StatCard } from "../components/ui";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
} from "../lib/products";
import { fetchProfitCalculationsBySkuIds } from "../lib/profit-calculations";
import { fetchSettings } from "../lib/settings";
import type {
  PricingResult,
  PricingSettings,
  Product,
  ProductItem,
  ProductSku,
  ProfitCalculationInput,
  ProfitLogisticsPlanResult,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { calculatePricing, formatCurrency, formatPercent } from "../utils/pricing";
import {
  calculateAdFeeRmb,
  calculateProfitProjection,
} from "../utils/profit-calculation";

type PromotionRecommendationsPageProps = {
  user: User;
};

type Decision = {
  enabled: boolean;
  value: number | null;
  label: string;
  reason: string;
  manuallyDisabled?: boolean;
};

type RecommendationFeatureKey = "traffic" | "coupon" | "activity" | "ad";

type RecommendationFeatureToggles = Record<RecommendationFeatureKey, boolean>;

type RecommendationRow = {
  product: Product;
  sku: ProductSku;
  featureToggles: RecommendationFeatureToggles;
  temuPriceRmb: number;
  totalCostRmb: number;
  baseProfitRmb: number;
  baseProfitRate: number | null;
  baseAdSpaceRmb: number;
  measuredAdSpendRmb: number;
  measuredProfitRmb: number;
  measuredProfitRate: number | null;
  traffic: Decision;
  coupon: Decision & {
    quantity: number | null;
    durationDays: number | null;
  };
  activity: Decision & {
    minimumSafeRate: number | null;
  };
  ad: Decision & {
    minimumRoas: number | null;
  };
  finalSalePriceRmb: number;
  finalProfitRmb: number;
  finalProfitRate: number | null;
  mainAdvice: string;
  mainAdviceItems: string[];
};

type MissingRow = {
  product: Product;
  reason: string;
};

type RecommendationCandidate = {
  product: Product;
  sku: ProductSku;
  pricing: PricingResult;
  settings: PricingSettings;
  temuPriceRmb: number;
  baseAdSpaceRmb: number;
};

const TRAFFIC_MIN_RATE = 0.05;
const TRAFFIC_MAX_RATE = 0.1;
const COUPON_MIN_RMB = 1.4;
const COUPON_MAX_RATE = 0.909;
const COUPON_MIN_QUANTITY = 200;
const DEFAULT_ACTIVITY_RATE = 9;
const ROAS_SAFETY_MULTIPLIER = 1.2;
const DEFAULT_FEATURE_TOGGLES: RecommendationFeatureToggles = {
  traffic: true,
  coupon: true,
  activity: true,
  ad: true,
};
const featureKeys: RecommendationFeatureKey[] = ["traffic", "coupon", "activity", "ad"];
const featureLabels: Record<RecommendationFeatureKey, string> = {
  traffic: "流量加速",
  coupon: "优惠券",
  activity: "活动折扣",
  ad: "ROAS",
};

function getFeatureToggleStorageKey(userId: string) {
  return `temu-promotion-recommendation-toggles:${userId}`;
}

function normalizeFeatureToggles(value: unknown): RecommendationFeatureToggles {
  const source =
    value && typeof value === "object"
      ? (value as Partial<Record<RecommendationFeatureKey, unknown>>)
      : {};

  return {
    traffic:
      typeof source.traffic === "boolean"
        ? source.traffic
        : DEFAULT_FEATURE_TOGGLES.traffic,
    coupon:
      typeof source.coupon === "boolean"
        ? source.coupon
        : DEFAULT_FEATURE_TOGGLES.coupon,
    activity:
      typeof source.activity === "boolean"
        ? source.activity
        : DEFAULT_FEATURE_TOGGLES.activity,
    ad: typeof source.ad === "boolean" ? source.ad : DEFAULT_FEATURE_TOGGLES.ad,
  };
}

function readStoredFeatureToggles(userId: string) {
  if (typeof window === "undefined") {
    return {} as Record<string, RecommendationFeatureToggles>;
  }

  try {
    const stored = window.localStorage.getItem(getFeatureToggleStorageKey(userId));
    if (!stored) return {} as Record<string, RecommendationFeatureToggles>;
    const parsed = JSON.parse(stored) as Record<string, unknown>;

    return Object.fromEntries(
      Object.entries(parsed).map(([productId, toggles]) => [
        productId,
        normalizeFeatureToggles(toggles),
      ]),
    );
  } catch {
    return {} as Record<string, RecommendationFeatureToggles>;
  }
}

function writeStoredFeatureToggles(
  userId: string,
  togglesByProductId: Record<string, RecommendationFeatureToggles>,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      getFeatureToggleStorageKey(userId),
      JSON.stringify(togglesByProductId),
    );
  } catch {
    // Local persistence is best-effort; the page should keep working if storage is blocked.
  }
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function roundRate(value: number) {
  return Number(value.toFixed(1));
}

function ceilToStep(value: number, step: number) {
  return Number((Math.ceil(value / step) * step).toFixed(2));
}

function pickConservativePlan(plans: ProfitLogisticsPlanResult[]) {
  return plans.reduce((selected, plan) =>
    plan.maxAdSpendRmb < selected.maxAdSpendRmb ? plan : selected,
  );
}

function getAdRecommendation({
  pricing,
  settings,
  input,
}: {
  pricing: PricingResult;
  settings: PricingSettings;
  input: ProfitCalculationInput;
}) {
  const result = calculateProfitProjection(pricing, settings, input);
  if (!result.isValid || result.plans.length === 0) {
    return {
      result,
      plan: null,
      minimumRoas: null,
      roasValue: null,
      enabled: false,
    };
  }

  const plan = pickConservativePlan(result.plans);
  const minimumRoas = plan.recommendedMinRoas;
  const roasValue =
    minimumRoas === null ? null : ceilToStep(minimumRoas * ROAS_SAFETY_MULTIPLIER, 0.01);
  const enabled = roasValue !== null && plan.maxAdSpendRmb > 0;

  return {
    result,
    plan,
    minimumRoas,
    roasValue,
    enabled,
  };
}

function keepsPromotionSafe({
  pricing,
  settings,
  input,
  requireAdSpace,
}: {
  pricing: PricingResult;
  settings: PricingSettings;
  input: ProfitCalculationInput;
  requireAdSpace: boolean;
}) {
  const recommendation = getAdRecommendation({ pricing, settings, input });
  if (!recommendation.plan) return false;

  return requireAdSpace ? recommendation.enabled : recommendation.plan.profitRmb > 0;
}

function findMaxSafeAmount({
  min,
  max,
  pricing,
  settings,
  buildInput,
  requireAdSpace,
}: {
  min: number;
  max: number;
  pricing: PricingResult;
  settings: PricingSettings;
  buildInput: (value: number) => ProfitCalculationInput;
  requireAdSpace: boolean;
}) {
  const start = Math.floor(max * 100);
  const end = Math.ceil(min * 100);
  if (start < end) return null;

  for (let cents = start; cents >= end; cents -= 1) {
    const value = cents / 100;
    if (
      keepsPromotionSafe({
        pricing,
        settings,
        input: buildInput(value),
        requireAdSpace,
      })
    ) {
      return roundMoney(value);
    }
  }

  return null;
}

function findMinimumSafeActivityRate({
  pricing,
  settings,
  buildInput,
  requireAdSpace,
}: {
  pricing: PricingResult;
  settings: PricingSettings;
  buildInput: (activityRate: number) => ProfitCalculationInput;
  requireAdSpace: boolean;
}) {
  for (let tenths = 10; tenths <= 100; tenths += 1) {
    const activityRate = tenths / 10;
    if (
      keepsPromotionSafe({
        pricing,
        settings,
        input: buildInput(activityRate),
        requireAdSpace,
      })
    ) {
      return roundRate(activityRate);
    }
  }

  return null;
}

function getSkuItems(sku: ProductSku, itemsById: Record<string, ProductItem>) {
  return sku.component_links.flatMap((link) => {
    const item = itemsById[link.item_id];
    return item ? [{ ...item, quantity: link.quantity }] : [];
  });
}

function buildRecommendation({
  product,
  sku,
  featureToggles,
  pricing,
  settings,
  temuPriceRmb,
}: {
  product: Product;
  sku: ProductSku;
  featureToggles: RecommendationFeatureToggles;
  pricing: PricingResult;
  settings: PricingSettings;
  temuPriceRmb: number;
}): RecommendationRow | null {
  const baseInput: ProfitCalculationInput = {
    temuPriceRmb,
    trafficDiscountRate: 0,
    activityDiscountRate: 10,
    couponDiscountRate: 0,
  };
  const baseResult = calculateProfitProjection(pricing, settings, baseInput);
  if (!baseResult.isValid || baseResult.plans.length === 0) return null;

  const basePlan = pickConservativePlan(baseResult.plans);
  const trafficMin = roundMoney(temuPriceRmb * TRAFFIC_MIN_RATE);
  const trafficMax = roundMoney(temuPriceRmb * TRAFFIC_MAX_RATE);
  const couponMax = roundMoney(temuPriceRmb * COUPON_MAX_RATE);
  const requireAdSpace = featureToggles.ad;

  const trafficValue = featureToggles.traffic
    ? findMaxSafeAmount({
        min: trafficMin,
        max: trafficMax,
        pricing,
        settings,
        buildInput: (value) => ({
          ...baseInput,
          trafficDiscountRate: value,
        }),
        requireAdSpace,
      })
    : null;
  const traffic: Decision = !featureToggles.traffic
    ? {
        enabled: false,
        value: null,
        label: "未启用",
        reason: "流量加速未计入本行测算",
        manuallyDisabled: true,
      }
    : trafficValue === null
      ? {
          enabled: false,
          value: null,
          label: "不参加",
          reason: requireAdSpace
            ? `利润和广告空间不足，无法承受最低 ${formatCurrency(trafficMin)}`
            : `利润空间不足，无法承受最低 ${formatCurrency(trafficMin)}`,
        }
      : {
          enabled: true,
          value: trafficValue,
          label: `让价 ${formatCurrency(trafficValue)}`,
          reason: `符合 ${formatCurrency(trafficMin)} - ${formatCurrency(trafficMax)} 范围`,
        };

  const currentTrafficDiscount = traffic.value ?? 0;
  let couponValue: number | null = null;
  let couponReason = "";

  if (!featureToggles.coupon) {
    couponReason = "优惠券未计入本行测算";
  } else if (couponMax < COUPON_MIN_RMB) {
    couponReason = `核价过低，最高券额 ${formatCurrency(couponMax)} 低于 ${formatCurrency(COUPON_MIN_RMB)}`;
  } else {
    const minimumCouponInput = {
      ...baseInput,
      trafficDiscountRate: currentTrafficDiscount,
      couponDiscountRate: COUPON_MIN_RMB,
    };
    couponValue = keepsPromotionSafe({
      pricing,
      settings,
      input: minimumCouponInput,
      requireAdSpace,
    })
      ? COUPON_MIN_RMB
      : null;
    couponReason =
      couponValue === null
        ? requireAdSpace
          ? `优先保证广告，最低券额 ${formatCurrency(COUPON_MIN_RMB)} 会压缩广告空间`
          : `最低券额 ${formatCurrency(COUPON_MIN_RMB)} 会压缩利润空间`
        : requireAdSpace
          ? `优先广告，仅用最低券额；可设范围 ${formatCurrency(COUPON_MIN_RMB)} - ${formatCurrency(couponMax)}`
          : `仅用最低券额；可设范围 ${formatCurrency(COUPON_MIN_RMB)} - ${formatCurrency(couponMax)}`;
  }

  const coupon = {
    enabled: featureToggles.coupon && couponValue !== null,
    value: couponValue,
    label: !featureToggles.coupon
      ? "未启用"
      : couponValue === null
        ? "不发券"
        : `券额 ${formatCurrency(couponValue)}`,
    reason: couponReason,
    quantity: couponValue === null ? null : COUPON_MIN_QUANTITY,
    durationDays: couponValue === null ? null : 7,
    manuallyDisabled: !featureToggles.coupon,
  };

  const currentCouponDiscount = coupon.value ?? 0;
  const buildActivityInput = (activityRate: number) => ({
    ...baseInput,
    trafficDiscountRate: currentTrafficDiscount,
    couponDiscountRate: currentCouponDiscount,
    activityDiscountRate: activityRate,
  });
  const minimumSafeActivityRate = featureToggles.activity
    ? findMinimumSafeActivityRate({
        pricing,
        settings,
        buildInput: buildActivityInput,
        requireAdSpace,
      })
    : null;
  const defaultActivitySafe =
    featureToggles.activity &&
    keepsPromotionSafe({
      pricing,
      settings,
      input: buildActivityInput(DEFAULT_ACTIVITY_RATE),
      requireAdSpace,
    });
  const activityValue = !featureToggles.activity
    ? null
    : minimumSafeActivityRate === null
      ? null
      : defaultActivitySafe
        ? DEFAULT_ACTIVITY_RATE
        : minimumSafeActivityRate < 10
          ? minimumSafeActivityRate
          : null;
  const activity = {
    enabled: featureToggles.activity && activityValue !== null,
    value: activityValue,
    label: !featureToggles.activity
      ? "未启用"
      : activityValue === null
        ? "不参加"
        : `${activityValue.toFixed(1)} 折`,
    reason: !featureToggles.activity
      ? "活动折扣未计入本行测算"
      : minimumSafeActivityRate === null
        ? "当前价格与成本下没有安全活动折扣"
        : activityValue === null
          ? requireAdSpace
            ? "低于 10 折会压缩广告空间"
            : "低于 10 折会压缩利润空间"
          : requireAdSpace
            ? `广告优先，最低安全 ${minimumSafeActivityRate.toFixed(1)} 折`
            : `最低安全 ${minimumSafeActivityRate.toFixed(1)} 折`,
    minimumSafeRate: minimumSafeActivityRate,
    manuallyDisabled: !featureToggles.activity,
  };

  const finalInput: ProfitCalculationInput = {
    ...baseInput,
    trafficDiscountRate: currentTrafficDiscount,
    couponDiscountRate: currentCouponDiscount,
    activityDiscountRate: activity.value ?? 10,
  };
  const adRecommendation = getAdRecommendation({
    pricing,
    settings,
    input: finalInput,
  });
  if (!adRecommendation.plan) return null;
  const finalResult = adRecommendation.result;
  const finalPlan = adRecommendation.plan;
  const minimumRoas = adRecommendation.minimumRoas;
  const roasValue = adRecommendation.roasValue;
  const adEnabled = featureToggles.ad && adRecommendation.enabled;
  const ad = {
    enabled: adEnabled,
    value: adEnabled ? roasValue : null,
    label: !featureToggles.ad
      ? "未启用"
      : adEnabled && roasValue !== null
        ? `ROAS ${roasValue.toFixed(2)}`
        : "不开广告",
    reason: !featureToggles.ad
      ? "ROAS 未计入本行测算"
      : !adEnabled || minimumRoas === null
        ? "促销后广告承受空间不足"
        : `最低安全 ROAS ${minimumRoas.toFixed(2)}`,
    minimumRoas,
    manuallyDisabled: !featureToggles.ad,
  };

  const enabledActions = [
    traffic.enabled ? "流量加速" : "",
    coupon.enabled ? "优惠券" : "",
    activity.enabled ? "活动" : "",
    ad.enabled ? "广告" : "",
  ].filter(Boolean);
  const fallbackAdvice = basePlan.maxAdSpendRmb > 0 ? "保留原价观察" : "先完善利润空间";
  const mainAdviceItems = enabledActions.length > 0 ? enabledActions : [fallbackAdvice];
  const measuredAdSpendRmb =
    ad.enabled && ad.value !== null
      ? roundMoney(calculateAdFeeRmb({ ...finalInput, adRoas: ad.value }))
      : 0;
  const measuredProfitRmb = roundMoney(finalPlan.profitRmb - measuredAdSpendRmb);
  const measuredProfitRate =
    finalPlan.realizedRevenueRmb > 0
      ? Number((measuredProfitRmb / finalPlan.realizedRevenueRmb).toFixed(4))
      : null;

  return {
    product,
    sku,
    featureToggles,
    temuPriceRmb,
    totalCostRmb: basePlan.totalCostRmb,
    baseProfitRmb: basePlan.profitRmb,
    baseProfitRate: basePlan.profitRate,
    baseAdSpaceRmb: basePlan.maxAdSpendRmb,
    measuredAdSpendRmb,
    measuredProfitRmb,
    measuredProfitRate,
    traffic,
    coupon,
    activity,
    ad,
    finalSalePriceRmb: finalResult.discountedSalePriceRmb,
    finalProfitRmb: finalPlan.profitRmb,
    finalProfitRate: finalPlan.profitRate,
    mainAdvice: mainAdviceItems.join(" + "),
    mainAdviceItems,
  };
}

function DecisionBadge({ decision }: { decision: Decision }) {
  if (decision.manuallyDisabled) {
    return <Badge tone="neutral">关闭</Badge>;
  }

  return (
    <Badge tone={decision.enabled ? "success" : "neutral"}>
      {decision.enabled ? "建议" : "不建议"}
    </Badge>
  );
}

function DecisionBlock({
  decision,
  children,
}: {
  decision: Decision;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <DecisionBadge decision={decision} />
        <span className="font-medium text-ink">{decision.label}</span>
      </div>
      <p className="text-xs leading-4 text-slate-500">{decision.reason}</p>
      {children}
    </div>
  );
}

function FeatureToggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border transition ${
        checked ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      title={label}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-emerald-600"
      />
    </label>
  );
}

function DecisionWithToggle({
  checked,
  label,
  decision,
  children,
  onChange,
}: {
  checked: boolean;
  label: string;
  decision: Decision;
  children?: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2">
      <FeatureToggle checked={checked} label={label} onChange={onChange} />
      <DecisionBlock decision={decision}>{children}</DecisionBlock>
    </div>
  );
}

function BulkFeatureToggle({
  checked,
  disabled,
  feature,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  feature: RecommendationFeatureKey;
  onChange: (checked: boolean) => void;
}) {
  const label = featureLabels[feature];

  return (
    <label
      className={`flex min-h-11 items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm transition ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-emerald-200"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={`统一勾选${label}`}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-emerald-600"
      />
      <span className="font-medium text-ink">{label}</span>
      <span className="text-xs text-slate-500">{checked ? "全开" : "未全开"}</span>
    </label>
  );
}

function AdviceChips({ row }: { row: RecommendationRow }) {
  const shortLabels: Record<string, string> = {
    流量加速: "加速",
    优惠券: "券",
    活动: "活动",
    广告: "广告",
    保留原价观察: "观察",
    先完善利润空间: "利润不足",
  };

  return (
    <div className="flex max-w-[110px] flex-wrap gap-1.5">
      {row.mainAdviceItems.map((item) => (
        <span
          key={item}
          className={`inline-flex h-7 items-center rounded-md px-2 text-xs font-medium ring-1 ${
            row.baseAdSpaceRmb > 0
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : "bg-amber-50 text-amber-700 ring-amber-200"
          }`}
          title={item}
        >
          {shortLabels[item] ?? item}
        </span>
      ))}
    </div>
  );
}

export function PromotionRecommendationsPage({
  user,
}: PromotionRecommendationsPageProps) {
  const [candidates, setCandidates] = useState<RecommendationCandidate[]>([]);
  const [featureTogglesByProductId, setFeatureTogglesByProductId] = useState<
    Record<string, RecommendationFeatureToggles>
  >(() => readStoredFeatureToggles(user.id));
  const [missingRows, setMissingRows] = useState<MissingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    writeStoredFeatureToggles(user.id, featureTogglesByProductId);
  }, [featureTogglesByProductId, user.id]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const [products, settings] = await Promise.all([
          fetchProducts(),
          fetchSettings(user.id),
        ]);
        const [items, skus] = await Promise.all([
          fetchProductItemsByProductIds(products.map((product) => product.id)),
          fetchProductSkusByProductIds(products.map((product) => product.id)),
        ]);
        const savedCalculations = await fetchProfitCalculationsBySkuIds(
          skus.flatMap((sku) => (sku.id ? [sku.id] : [])),
        );
        const itemsById = Object.fromEntries(
          items.flatMap((item) => (item.id ? [[item.id, item]] : [])),
        );
        const skusByProductId = skus.reduce<Record<string, ProductSku[]>>(
          (groups, sku) => {
            if (!sku.product_id) return groups;
            groups[sku.product_id] ??= [];
            groups[sku.product_id].push(sku);
            return groups;
          },
          {},
        );
        const savedCalculationBySkuId = Object.fromEntries(
          savedCalculations.map((calculation) => [calculation.sku_id, calculation]),
        );
        const nextCandidates: RecommendationCandidate[] = [];
        const nextMissingRows: MissingRow[] = [];

        for (const product of products) {
          const productSkus = skusByProductId[product.id] ?? [];
          const skuCandidates = productSkus.flatMap((sku) => {
            if (!sku.id) return [];
            const skuItems = getSkuItems(sku, itemsById);
            if (skuItems.length === 0) return [];

            const pricing = calculatePricing(product.package_weight_g, skuItems, settings);
            const saved = savedCalculationBySkuId[sku.id];
            const temuPriceRmb = saved?.temu_price_rmb ?? pricing.temuDeclarationPriceRmb;
            const baseResult = calculateProfitProjection(pricing, settings, {
              temuPriceRmb,
              trafficDiscountRate: 0,
              activityDiscountRate: 10,
              couponDiscountRate: 0,
            });
            if (!baseResult.isValid || baseResult.plans.length === 0) return [];
            const basePlan = pickConservativePlan(baseResult.plans);

            return [
              {
                sku,
                pricing,
                temuPriceRmb,
                baseAdSpaceRmb: basePlan.maxAdSpendRmb,
              },
            ];
          });

          if (skuCandidates.length === 0) {
            nextMissingRows.push({
              product,
              reason: "缺少可计算的 SKU、配件或核价",
            });
            continue;
          }

          const representative = skuCandidates.reduce((selected, current) =>
            current.baseAdSpaceRmb < selected.baseAdSpaceRmb ? current : selected,
          );
          nextCandidates.push({
            product,
            sku: representative.sku,
            pricing: representative.pricing,
            settings,
            temuPriceRmb: representative.temuPriceRmb,
            baseAdSpaceRmb: representative.baseAdSpaceRmb,
          });
        }

        if (active) {
          setCandidates(nextCandidates);
          setMissingRows(nextMissingRows);
          setFeatureTogglesByProductId((current) => {
            const next = { ...current };
            for (const candidate of nextCandidates) {
              next[candidate.product.id] ??= { ...DEFAULT_FEATURE_TOGGLES };
            }
            return next;
          });
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载促销投放推荐失败"));
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

  const rows = useMemo(
    () =>
      candidates.flatMap((candidate) => {
        const featureToggles =
          featureTogglesByProductId[candidate.product.id] ?? DEFAULT_FEATURE_TOGGLES;
        const recommendation = buildRecommendation({
          ...candidate,
          featureToggles,
        });
        return recommendation ? [recommendation] : [];
      }),
    [candidates, featureTogglesByProductId],
  );
  const candidateProductIds = useMemo(
    () => candidates.map((candidate) => candidate.product.id),
    [candidates],
  );

  function updateFeatureToggle(
    productId: string,
    feature: RecommendationFeatureKey,
    enabled: boolean,
  ) {
    setFeatureTogglesByProductId((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] ?? DEFAULT_FEATURE_TOGGLES),
        [feature]: enabled,
      },
    }));
  }

  function updateAllFeatureToggles(
    feature: RecommendationFeatureKey,
    enabled: boolean,
  ) {
    setFeatureTogglesByProductId((current) => {
      const next = { ...current };

      for (const productId of candidateProductIds) {
        next[productId] = {
          ...(current[productId] ?? DEFAULT_FEATURE_TOGGLES),
          [feature]: enabled,
        };
      }

      return next;
    });
  }

  function isFeatureEnabledForAll(feature: RecommendationFeatureKey) {
    return (
      candidateProductIds.length > 0 &&
      candidateProductIds.every(
        (productId) =>
          (featureTogglesByProductId[productId] ?? DEFAULT_FEATURE_TOGGLES)[feature],
      )
    );
  }

  const summary = useMemo(
    () => ({
      trafficCount: rows.filter((row) => row.traffic.enabled).length,
      couponCount: rows.filter((row) => row.coupon.enabled).length,
      activityCount: rows.filter((row) => row.activity.enabled).length,
      adCount: rows.filter((row) => row.ad.enabled).length,
    }),
    [rows],
  );

  return (
    <section className="grid gap-5">
      <PageHeader
        title="促销投放推荐"
        description="按现有核价、成本和利润设置，给出每个商品的促销与广告建议"
        actions={
          <BackToParentAction fallbackTo="/profit-calculation" />
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="建议流量加速" value={String(summary.trafficCount)} />
        <StatCard label="建议发优惠券" value={String(summary.couponCount)} />
        <StatCard label="建议参加活动" value={String(summary.activityCount)} />
        <StatCard label="建议开广告" value={String(summary.adCount)} />
      </div>

      <section className="surface-card grid gap-3 p-4">
        <h2 className="text-base font-semibold text-ink">统一勾选</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {featureKeys.map((feature) => (
            <BulkFeatureToggle
              key={feature}
              checked={isFeatureEnabledForAll(feature)}
              disabled={candidateProductIds.length === 0}
              feature={feature}
              onChange={(checked) => updateAllFeatureToggles(feature, checked)}
            />
          ))}
        </div>
      </section>

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">暂无可推荐商品</div>
        ) : (
          rows.map((row) => (
            <article key={row.product.id} className="mobile-summary-card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="mobile-summary-title">{row.product.product_code}</p>
                  <p className="mobile-summary-subtitle">{row.product.product_name_cn}</p>
                </div>
                <AdviceChips row={row} />
              </div>
              <div className="mobile-summary-grid">
                <div className="mobile-summary-cell">核价：{formatCurrency(row.temuPriceRmb)}</div>
                <div className="mobile-summary-cell">成本：{formatCurrency(row.totalCostRmb)}</div>
                <div className="mobile-summary-cell">
                  利润测算：{formatCurrency(row.measuredProfitRmb)}
                  <span className="ml-1 text-slate-400">
                    原始 {formatCurrency(row.baseProfitRmb)}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid gap-3 text-sm">
                <DecisionWithToggle
                  checked={row.featureToggles.traffic}
                  label={`启用流量加速：${row.product.product_code}`}
                  decision={row.traffic}
                  onChange={(checked) => updateFeatureToggle(row.product.id, "traffic", checked)}
                />
                <DecisionWithToggle
                  checked={row.featureToggles.coupon}
                  label={`启用优惠券：${row.product.product_code}`}
                  decision={row.coupon}
                  onChange={(checked) => updateFeatureToggle(row.product.id, "coupon", checked)}
                >
                  {row.coupon.enabled && (
                    <p className="text-xs text-slate-500">
                      {row.coupon.durationDays} 天，{row.coupon.quantity} 张
                    </p>
                  )}
                </DecisionWithToggle>
                <DecisionWithToggle
                  checked={row.featureToggles.activity}
                  label={`启用活动折扣：${row.product.product_code}`}
                  decision={row.activity}
                  onChange={(checked) => updateFeatureToggle(row.product.id, "activity", checked)}
                />
                <DecisionWithToggle
                  checked={row.featureToggles.ad}
                  label={`启用 ROAS：${row.product.product_code}`}
                  decision={row.ad}
                  onChange={(checked) => updateFeatureToggle(row.product.id, "ad", checked)}
                />
              </div>
            </article>
          ))
        )}
      </div>

      <div className="table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="data-table min-w-[1260px] table-fixed [&_td]:px-3 [&_td]:py-4 [&_th]:px-3 [&_th]:py-3">
            <colgroup>
              <col className="w-[100px]" />
              <col className="w-[78px]" />
              <col className="w-[86px]" />
              <col className="w-[94px]" />
              <col className="w-[200px]" />
              <col className="w-[230px]" />
              <col className="w-[180px]" />
              <col className="w-[175px]" />
              <col className="w-[160px]" />
              <col className="w-[115px]" />
            </colgroup>
            <thead>
              <tr>
                <th>商品编号</th>
                <th>核价</th>
                <th>总成本</th>
                <th>利润</th>
                <th>流量加速</th>
                <th>优惠券</th>
                <th>活动折扣</th>
                <th>ROAS</th>
                <th>促销后利润</th>
                <th>主建议</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                    暂无可推荐商品
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.product.id}>
                    <td>
                      <div className="grid gap-1">
                        <span className="font-medium text-ink">{row.product.product_code}</span>
                        <span className="text-xs text-slate-500">
                          {row.product.product_name_cn}
                        </span>
                      </div>
                    </td>
                    <td className="money">{formatCurrency(row.temuPriceRmb)}</td>
                    <td className="money">{formatCurrency(row.totalCostRmb)}</td>
                    <td>
                      <div className="grid gap-1">
                        <span className="money">{formatCurrency(row.measuredProfitRmb)}</span>
                        <span className="text-xs text-slate-500">
                          {row.measuredProfitRate === null
                            ? "--"
                            : formatPercent(row.measuredProfitRate)}
                        </span>
                        <span className="text-xs text-slate-400">
                          原始 {formatCurrency(row.baseProfitRmb)}
                        </span>
                        {row.measuredAdSpendRmb > 0 && (
                          <span className="text-xs text-slate-400">
                            含广告 {formatCurrency(row.measuredAdSpendRmb)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <DecisionWithToggle
                        checked={row.featureToggles.traffic}
                        label={`启用流量加速：${row.product.product_code}`}
                        decision={row.traffic}
                        onChange={(checked) =>
                          updateFeatureToggle(row.product.id, "traffic", checked)
                        }
                      />
                    </td>
                    <td>
                      <DecisionWithToggle
                        checked={row.featureToggles.coupon}
                        label={`启用优惠券：${row.product.product_code}`}
                        decision={row.coupon}
                        onChange={(checked) =>
                          updateFeatureToggle(row.product.id, "coupon", checked)
                        }
                      >
                        {row.coupon.enabled && (
                          <p className="text-xs text-slate-500">
                            {row.coupon.durationDays} 天，{row.coupon.quantity} 张
                          </p>
                        )}
                      </DecisionWithToggle>
                    </td>
                    <td>
                      <DecisionWithToggle
                        checked={row.featureToggles.activity}
                        label={`启用活动折扣：${row.product.product_code}`}
                        decision={row.activity}
                        onChange={(checked) =>
                          updateFeatureToggle(row.product.id, "activity", checked)
                        }
                      />
                    </td>
                    <td>
                      <DecisionWithToggle
                        checked={row.featureToggles.ad}
                        label={`启用 ROAS：${row.product.product_code}`}
                        decision={row.ad}
                        onChange={(checked) => updateFeatureToggle(row.product.id, "ad", checked)}
                      />
                    </td>
                    <td>
                      <div className="grid gap-1">
                        <span className="money">{formatCurrency(row.finalProfitRmb)}</span>
                        <span className="text-xs text-slate-500">
                          最终售价 {formatCurrency(row.finalSalePriceRmb)}
                          {row.finalProfitRate === null
                            ? ""
                            : `，利润率 ${formatPercent(row.finalProfitRate)}`}
                        </span>
                      </div>
                    </td>
                    <td>
                      <AdviceChips row={row} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && missingRows.length > 0 && (
        <section className="surface-card p-4">
          <h2 className="text-base font-semibold text-ink">暂不可推荐</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            {missingRows.map((row) => (
              <div key={row.product.id} className="flex flex-wrap gap-2">
                <span className="font-medium text-ink">{row.product.product_code}</span>
                <span>{row.product.product_name_cn}</span>
                <span className="text-slate-400">-</span>
                <span>{row.reason}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
