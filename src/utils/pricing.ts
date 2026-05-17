import type { PricingResult, PricingSettings, ProductItem } from "../types";

const round = (value: number, digits = 2) =>
  Number(value.toFixed(digits));

export function calculatePricing(
  packageWeightG: number,
  items: ProductItem[],
  settings: PricingSettings,
): PricingResult {
  const purchaseCostRmb = items.reduce(
    (sum, item) => sum + item.purchase_price_rmb * item.quantity,
    0,
  );
  const purchaseShippingRmb = items.reduce(
    (sum, item) =>
      sum +
      ((item.item_weight_g * item.quantity) / 500) *
        item.purchase_shipping_fee_per_500g_rmb,
    0,
  );
  const packagingCostRmb = settings.packaging_cost_rmb;
  const subsidyRmb =
    settings.temu_shipping_subsidy_jpy *
    settings.exchange_rate_rmb_per_jpy;
  const packageWeightKg = packageWeightG / 1000;
  const sfPricePerKg =
    settings.sf_first_weight_kg > 0
      ? settings.sf_first_price_rmb / settings.sf_first_weight_kg
      : 0;
  const sfCostRmb = packageWeightKg * sfPricePerKg;
  const huaianAirCostRmb =
    packageWeightKg * settings.huaian_air_price_per_kg_rmb;
  const ocsCostRmb = packageWeightKg * settings.ocs_price_per_kg_rmb;
  const osakaLastmileRmb =
    settings.osaka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;
  const fukuokaLastmileRmb =
    settings.fukuoka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;
  const planA = huaianAirCostRmb + osakaLastmileRmb;
  const planB = huaianAirCostRmb + fukuokaLastmileRmb;
  const planC = ocsCostRmb + osakaLastmileRmb;
  const planD = ocsCostRmb + fukuokaLastmileRmb;
  const logisticsCostRmb = Math.max(planA, planB, planC, planD);
  const totalCostRmb =
    purchaseCostRmb +
    purchaseShippingRmb +
    packagingCostRmb +
    sfCostRmb +
    logisticsCostRmb;
  const temuDeclarationPriceRmb =
    totalCostRmb / (1 - settings.target_profit_rate) - subsidyRmb;
  const profitRmb = temuDeclarationPriceRmb + subsidyRmb - totalCostRmb;
  const profitRate =
    profitRmb / Math.max(temuDeclarationPriceRmb + subsidyRmb, Number.EPSILON);

  return {
    purchaseCostRmb: round(purchaseCostRmb),
    purchaseShippingRmb: round(purchaseShippingRmb),
    packagingCostRmb: round(packagingCostRmb),
    subsidyRmb: round(subsidyRmb),
    packageWeightKg: round(packageWeightKg, 3),
    sfCostRmb: round(sfCostRmb),
    huaianAirCostRmb: round(huaianAirCostRmb),
    ocsCostRmb: round(ocsCostRmb),
    osakaLastmileRmb: round(osakaLastmileRmb),
    fukuokaLastmileRmb: round(fukuokaLastmileRmb),
    planA: round(planA),
    planB: round(planB),
    planC: round(planC),
    planD: round(planD),
    logisticsCostRmb: round(logisticsCostRmb),
    totalCostRmb: round(totalCostRmb),
    temuDeclarationPriceRmb: round(temuDeclarationPriceRmb),
    profitRmb: round(profitRmb),
    profitRate: round(profitRate, 4),
  };
}

export function formatCurrency(value: number) {
  return `¥${value.toFixed(2)}`;
}

export function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}
