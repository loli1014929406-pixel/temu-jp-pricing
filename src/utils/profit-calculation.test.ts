import { describe, expect, it } from "vitest";
import type {
  LogisticsMethodConfig,
  PricingSettings,
  ProfitCalculationResult,
  ProfitLogisticsPlanResult,
} from "../types";
import {
  getProfitSummaryPlanKey,
  selectProfitSummaryProjection,
} from "./profit-calculation";

const firstLegMethod: LogisticsMethodConfig = {
  id: "current-ocs-first-leg",
  db_method_id: "287baa57-4cab-46e3-8cfe-d00dc274bedd",
  name: "已重命名的 OCS 头程",
  type: "first_leg",
  formula: "flat_rmb_tariff",
  params: { price: 20 },
  isActive: true,
};

const lastLegMethod: LogisticsMethodConfig = {
  id: "current-kobe-yamato-3cm",
  db_method_id: "4712d2ae-5d3d-42fd-ae7a-d5468a375e22",
  name: "已重命名的神户尾程",
  type: "last_leg",
  formula: "quantity_tier",
  params: { quantityPrices: [225, 269] },
  isActive: true,
};

function buildSettings(): PricingSettings {
  return {
    packaging_cost_rmb: 0,
    exchange_rate_rmb_per_jpy: 0.05,
    temu_shipping_subsidy_jpy: 0,
    sf_first_weight_kg: 1,
    sf_first_price_rmb: 0,
    sf_extra_price_per_kg_rmb: 0,
    huaian_air_price_per_kg_rmb: 0,
    ocs_price_per_kg_rmb: 0,
    ocs_tariff_rate: 0,
    osaka_lastmile_jpy: 0,
    fukuoka_lastmile_jpy: 0,
    test_ocs_3cm_first_price_rmb: 0,
    test_ocs_3cm_extra_price_per_100g_rmb: 0,
    test_ocs_small_parcel_first_price_rmb: 0,
    test_ocs_small_parcel_extra_price_per_500g_rmb: 0,
    target_profit_rate: 0.2,
    target_post_ad_profit_rate: 0.1,
    first_leg_methods: [firstLegMethod],
    last_leg_methods: [lastLegMethod],
  };
}

function buildPlan(planKey: string, totalCostRmb: number): ProfitLogisticsPlanResult {
  return {
    planKey,
    planName: planKey,
    logisticsCostRmb: totalCostRmb,
    totalCostRmb,
    effectiveSubsidyRmb: 0,
    realizedRevenueRmb: 100,
    grossProfitRmb: 100 - totalCostRmb,
    adFeeRmb: 0,
    profitRmb: 100 - totalCostRmb,
    profitRate: (100 - totalCostRmb) / 100,
    maxAdSpendRmb: 100 - totalCostRmb,
    breakEvenAdSpendRmb: 100 - totalCostRmb,
    recommendedMinRoas: null,
    breakEvenRoas: null,
  };
}

function buildResult(plans: ProfitLogisticsPlanResult[]): ProfitCalculationResult {
  return {
    calculationVersion: 6,
    isValid: true,
    finalDiscountRate: 1,
    adRoas: 0,
    adFeeRmb: 0,
    discountedSalePriceRmb: 100,
    discountedUnitPriceJpy: 2000,
    singleUnitLosesShippingSubsidy: false,
    freeShippingThresholdQty: 2,
    plans,
  };
}

describe("profit analysis summary plan", () => {
  it("resolves OCS plus Kobe Yamato 3cm by stable database ids", () => {
    expect(getProfitSummaryPlanKey(buildSettings())).toBe(
      "current-ocs-first-leg_current-kobe-yamato-3cm",
    );
  });

  it("uses the configured plan instead of the highest-cost logistics plan", () => {
    const preferredPlanKey = getProfitSummaryPlanKey(buildSettings());
    expect(preferredPlanKey).not.toBeNull();

    const selected = selectProfitSummaryProjection(
      [
        {
          skuId: "sku-with-highest-other-plan",
          result: buildResult([
            buildPlan(preferredPlanKey!, 18),
            buildPlan("highest-cost-logistics-plan", 99),
          ]),
        },
        {
          skuId: "sku-with-highest-preferred-plan-cost",
          result: buildResult([buildPlan(preferredPlanKey!, 20)]),
        },
      ],
      buildSettings(),
    );

    expect(selected?.calculation.skuId).toBe("sku-with-highest-preferred-plan-cost");
    expect(selected?.plan.planKey).toBe(preferredPlanKey);
    expect(selected?.plan.totalCostRmb).toBe(20);
  });
});
