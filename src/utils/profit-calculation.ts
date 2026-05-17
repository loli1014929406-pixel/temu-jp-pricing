import type {
  PricingResult,
  PricingSettings,
  ProfitCalculationInput,
  ProfitCalculationResult,
  ProfitLogisticsPlanKey,
} from "../types";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

const logisticsPlans: Array<{
  key: ProfitLogisticsPlanKey;
  name: string;
  getCost: (pricing: PricingResult) => number;
}> = [
  {
    key: "huaian_osaka",
    name: "淮安空运 + 大阪海外仓",
    getCost: (pricing) => pricing.planA,
  },
  {
    key: "huaian_fukuoka",
    name: "淮安空运 + 福冈海外仓",
    getCost: (pricing) => pricing.planB,
  },
  {
    key: "ocs_osaka",
    name: "OCS + 大阪海外仓",
    getCost: (pricing) => pricing.planC,
  },
  {
    key: "ocs_fukuoka",
    name: "OCS + 福冈海外仓",
    getCost: (pricing) => pricing.planD,
  },
];

export function calculateProfitProjection(
  pricing: PricingResult,
  settings: PricingSettings,
  input: ProfitCalculationInput,
): ProfitCalculationResult {
  const finalDiscountRate =
    (input.trafficDiscountRate *
      input.activityDiscountRate *
      input.couponDiscountRate) /
    100;
  const discountedSalePriceRmb = input.temuPriceRmb * (finalDiscountRate / 10);
  const isValid =
    input.temuPriceRmb > 0 &&
    input.trafficDiscountRate > 0 &&
    input.trafficDiscountRate <= 10 &&
    input.activityDiscountRate > 0 &&
    input.activityDiscountRate <= 10 &&
    input.couponDiscountRate > 0 &&
    input.couponDiscountRate <= 10 &&
    discountedSalePriceRmb > 0 &&
    settings.exchange_rate_rmb_per_jpy > 0;
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
    pricing.packagingCostRmb +
    pricing.sfCostRmb;

  return {
    calculationVersion: 3,
    isValid,
    finalDiscountRate: round(finalDiscountRate, 4),
    discountedSalePriceRmb: round(discountedSalePriceRmb),
    discountedUnitPriceJpy:
      discountedUnitPriceJpy === null ? null : round(discountedUnitPriceJpy),
    singleUnitLosesShippingSubsidy,
    freeShippingThresholdQty,
    plans: logisticsPlans.map((plan) => {
      const logisticsCostRmb = plan.getCost(pricing);
      const totalCostRmb = sharedBaseCostRmb + logisticsCostRmb;
      const realizedRevenueRmb = isValid
        ? discountedSalePriceRmb + effectiveSubsidyRmb
        : 0;
      const profitRmb = realizedRevenueRmb - totalCostRmb;
      const profitRate =
        realizedRevenueRmb > 0 ? profitRmb / realizedRevenueRmb : null;
      const maxAdSpendRmb = isValid
        ? realizedRevenueRmb * (1 - settings.target_post_ad_profit_rate) -
          totalCostRmb
        : 0;
      const breakEvenAdSpendRmb = isValid ? realizedRevenueRmb - totalCostRmb : 0;
      const recommendedMinRoas =
        maxAdSpendRmb > 0 ? discountedSalePriceRmb / maxAdSpendRmb : null;
      const breakEvenRoas =
        breakEvenAdSpendRmb > 0
          ? discountedSalePriceRmb / breakEvenAdSpendRmb
          : null;

      return {
        planKey: plan.key,
        planName: plan.name,
        logisticsCostRmb: round(logisticsCostRmb),
        totalCostRmb: round(totalCostRmb),
        effectiveSubsidyRmb: round(effectiveSubsidyRmb),
        realizedRevenueRmb: round(realizedRevenueRmb),
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
