import type {
  LogisticsMethodConfig,
  PricingResult,
  PricingSettings,
  ProfitCalculationInput,
  ProfitCalculationResult,
  SavedProfitCalculation,
} from "../types";
import { calculateDynamicMethodCost } from "./shipping-costs";
import { resolveFirstLegMethods, resolveLastLegMethods } from "../lib/defaults";

const round = (value: number, digits = 2) =>
  Math.round((value + Number.EPSILON) * Math.pow(10, digits)) / Math.pow(10, digits);

export const PROFIT_CALCULATION_VERSION = 6;

const profitSummaryFirstLegMethodDbId = "287baa57-4cab-46e3-8cfe-d00dc274bedd";
const profitSummaryLastLegMethodDbId = "4712d2ae-5d3d-42fd-ae7a-d5468a375e22";

function normalizeLogisticsMethodName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function findProfitSummaryMethod(
  methods: LogisticsMethodConfig[],
  dbMethodId: string,
  fallbackName: string,
) {
  const normalizedFallbackName = normalizeLogisticsMethodName(fallbackName);

  return (
    methods.find((method) => method.isActive && method.db_method_id === dbMethodId) ??
    methods.find(
      (method) =>
        method.isActive &&
        normalizeLogisticsMethodName(method.name) === normalizedFallbackName,
    )
  );
}

export function getProfitSummaryPlanKey(settings: PricingSettings) {
  const firstLegMethod = findProfitSummaryMethod(
    resolveFirstLegMethods(settings),
    profitSummaryFirstLegMethodDbId,
    "OCS RMB/kg",
  );
  const lastLegMethod = findProfitSummaryMethod(
    resolveLastLegMethods(settings),
    profitSummaryLastLegMethodDbId,
    "神户 Yamato3cm",
  );

  return firstLegMethod && lastLegMethod
    ? `${firstLegMethod.id}_${lastLegMethod.id}`
    : null;
}

export function selectProfitSummaryProjection<
  TCalculation extends { result: ProfitCalculationResult },
>(calculations: TCalculation[], settings: PricingSettings) {
  const planKey = getProfitSummaryPlanKey(settings);
  if (!planKey) return null;

  return calculations.reduce<{
    calculation: TCalculation;
    plan: ProfitCalculationResult["plans"][number];
  } | null>((selected, calculation) => {
    if (!calculation.result.isValid) return selected;

    const plan = calculation.result.plans.find(
      (candidate) => candidate.planKey === planKey,
    );
    if (!plan) return selected;

    return selected === null || plan.totalCostRmb > selected.plan.totalCostRmb
      ? { calculation, plan }
      : selected;
  }, null);
}

type SavedProfitCalculationSnapshot = Pick<
  SavedProfitCalculation,
  | "temu_price_rmb"
  | "traffic_discount_rate"
  | "activity_discount_rate"
  | "coupon_discount_rate"
  | "result_json"
>;

export function getSavedProfitCalculationVersion(
  calculation: Pick<SavedProfitCalculation, "result_json"> | undefined,
) {
  return calculation?.result_json?.calculationVersion ?? 0;
}

export function buildProfitCalculationInputFromSaved(
  saved: SavedProfitCalculationSnapshot | undefined,
  fallbackTemuPriceRmb: number,
): ProfitCalculationInput {
  if (!saved) {
    return {
      temuPriceRmb: fallbackTemuPriceRmb,
      trafficDiscountRate: 0,
      activityDiscountRate: 10,
      couponDiscountRate: 0,
      adRoas: 0,
    };
  }

  const savedVersion = getSavedProfitCalculationVersion(saved);
  const usesDiscountFormula = savedVersion >= 4;
  const usesAdFormula = savedVersion >= PROFIT_CALCULATION_VERSION;

  return {
    temuPriceRmb: saved.temu_price_rmb,
    trafficDiscountRate: usesDiscountFormula ? saved.traffic_discount_rate : 0,
    activityDiscountRate: saved.activity_discount_rate,
    couponDiscountRate: usesDiscountFormula ? saved.coupon_discount_rate ?? 0 : 0,
    adRoas: usesAdFormula ? saved.result_json?.adRoas ?? 0 : 0,
  };
}

export function calculateFinalSalePriceRmb(input: ProfitCalculationInput) {
  const activityDiscountCoefficient = input.activityDiscountRate / 10;
  return Math.max(
    0,
    (input.temuPriceRmb - input.trafficDiscountRate - input.couponDiscountRate) *
      activityDiscountCoefficient,
  );
}

export function calculateAdFeeRmb(input: ProfitCalculationInput) {
  const adRoas = input.adRoas ?? 0;
  if (adRoas <= 0) return 0;

  return Math.max(0, input.temuPriceRmb - input.trafficDiscountRate) / adRoas;
}

export function calculateProfitProjection(
  pricing: PricingResult,
  settings: PricingSettings,
  input: ProfitCalculationInput,
): ProfitCalculationResult {
  const finalDiscountRate = input.activityDiscountRate / 10;
  const adRoas = input.adRoas ?? 0;
  const priceBeforeActivityDiscount =
    input.temuPriceRmb - input.trafficDiscountRate - input.couponDiscountRate;
  const discountedSalePriceRmb = calculateFinalSalePriceRmb(input);
  const isValid =
    input.temuPriceRmb > 0 &&
    input.trafficDiscountRate >= 0 &&
    input.activityDiscountRate > 0 &&
    input.activityDiscountRate <= 10 &&
    input.couponDiscountRate >= 0 &&
    adRoas >= 0 &&
    priceBeforeActivityDiscount > 0 &&
    discountedSalePriceRmb > 0 &&
    settings.exchange_rate_rmb_per_jpy > 0;
  const adSpendBaseRmb = Math.max(0, input.temuPriceRmb - input.trafficDiscountRate);
  const adFeeRmb = isValid ? calculateAdFeeRmb(input) : 0;
  const discountedUnitPriceJpy =
    isValid
      ? discountedSalePriceRmb / settings.exchange_rate_rmb_per_jpy
      : null;
  const singleUnitLosesShippingSubsidy =
    discountedUnitPriceJpy !== null && discountedUnitPriceJpy > 3500;
  const freeShippingThresholdQty =
    discountedUnitPriceJpy && discountedUnitPriceJpy > 0
      ? Math.ceil(3500 / discountedUnitPriceJpy)
      : null;
  const subsidyRmb =
    settings.temu_shipping_subsidy_jpy * settings.exchange_rate_rmb_per_jpy;
  const effectiveSubsidyRmb =
    isValid && !singleUnitLosesShippingSubsidy ? subsidyRmb : 0;

  const sharedBaseCostRmb =
    pricing.purchaseCostRmb +
    pricing.purchaseShippingRmb +
    pricing.packagingCostRmb;

  const firstLegs = resolveFirstLegMethods(settings);
  const lastLegs = resolveLastLegMethods(settings);

  const activeFirstLegs = firstLegs.filter(
    (m) =>
      m.isActive &&
      (m.formula === "flat_rmb" ||
        m.formula === "flat_rmb_tariff" ||
        m.formula === "fixed_rmb"),
  );
  const activeLastLegs = lastLegs.filter(
    (m) =>
      m.isActive &&
      (m.formula === "flat_jpy" ||
        m.formula === "fixed_rmb" ||
        m.formula === "quantity_tier"),
  );

  const plansList = [];
  if (activeFirstLegs.length > 0 && activeLastLegs.length > 0) {
    for (const fl of activeFirstLegs) {
      for (const ll of activeLastLegs) {
        plansList.push({
          key: `${fl.id}_${ll.id}`,
          name: `${fl.name} + ${ll.name}`,
          getCost: () => {
            const flCost = calculateDynamicMethodCost(
              fl,
              pricing.packageWeightKg * 1000,
              settings.exchange_rate_rmb_per_jpy,
            );
            const llCost = calculateDynamicMethodCost(
              ll,
              pricing.packageWeightKg * 1000,
              settings.exchange_rate_rmb_per_jpy,
            );
            return flCost + llCost;
          },
        });
      }
    }
  } else {
    plansList.push(
      {
        key: "huaian_osaka",
        name: "淮安空运 + 大阪海外仓",
        getCost: () => pricing.planA,
      },
      {
        key: "huaian_fukuoka",
        name: "淮安空运 + 福冈海外仓",
        getCost: () => pricing.planB,
      },
      {
        key: "ocs_osaka",
        name: "OCS + 大阪海外仓",
        getCost: () => pricing.planC,
      },
      {
        key: "ocs_fukuoka",
        name: "OCS + 福冈海外仓",
        getCost: () => pricing.planD,
      },
    );
  }

  return {
    calculationVersion: PROFIT_CALCULATION_VERSION,
    isValid,
    finalDiscountRate: round(finalDiscountRate, 4),
    adRoas: round(adRoas, 4),
    adFeeRmb: round(adFeeRmb),
    discountedSalePriceRmb: round(discountedSalePriceRmb),
    discountedUnitPriceJpy:
      discountedUnitPriceJpy === null ? null : round(discountedUnitPriceJpy),
    singleUnitLosesShippingSubsidy,
    freeShippingThresholdQty,
    plans: plansList.map((plan) => {
      const logisticsCostRmb = plan.getCost();
      const totalCostRmb = sharedBaseCostRmb + logisticsCostRmb;
      const realizedRevenueRmb = isValid
        ? discountedSalePriceRmb + effectiveSubsidyRmb
        : 0;
      const grossProfitRmb = realizedRevenueRmb - totalCostRmb;
      const profitRmb = grossProfitRmb - adFeeRmb;
      const profitRate =
        realizedRevenueRmb > 0 ? profitRmb / realizedRevenueRmb : null;
      const maxAdSpendRmb = isValid
        ? realizedRevenueRmb * (1 - settings.target_post_ad_profit_rate) -
          totalCostRmb
        : 0;
      const breakEvenAdSpendRmb = isValid ? realizedRevenueRmb - totalCostRmb : 0;
      const recommendedMinRoas =
        maxAdSpendRmb > 0 ? adSpendBaseRmb / maxAdSpendRmb : null;
      const breakEvenRoas =
        breakEvenAdSpendRmb > 0
          ? adSpendBaseRmb / breakEvenAdSpendRmb
          : null;

      return {
        planKey: plan.key,
        planName: plan.name,
        logisticsCostRmb: round(logisticsCostRmb),
        totalCostRmb: round(totalCostRmb),
        effectiveSubsidyRmb: round(effectiveSubsidyRmb),
        realizedRevenueRmb: round(realizedRevenueRmb),
        grossProfitRmb: round(grossProfitRmb),
        adFeeRmb: round(adFeeRmb),
        profitRmb: round(profitRmb),
        profitRate: profitRate === null ? null : round(profitRate, 4),
        maxAdSpendRmb: round(maxAdSpendRmb),
        breakEvenAdSpendRmb: round(breakEvenAdSpendRmb),
        recommendedMinRoas:
          recommendedMinRoas === null ? null : round(recommendedMinRoas, 4),
        breakEvenRoas: breakEvenRoas === null ? null : round(breakEvenRoas, 4),
      };
    }),
  };
}

export function resolveProfitCalculationResult(
  pricing: PricingResult,
  settings: PricingSettings,
  input: ProfitCalculationInput,
  savedResult: ProfitCalculationResult | undefined,
) {
  if (
    savedResult?.calculationVersion === PROFIT_CALCULATION_VERSION &&
    typeof savedResult.isValid === "boolean"
  ) {
    return savedResult;
  }

  return calculateProfitProjection(pricing, settings, input);
}
