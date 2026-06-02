import type { PricingResult, PricingSettings, ProductItem } from "../types";

const round = (value: number, digits = 2) =>
  Number(value.toFixed(digits));

function calculatePurchaseShippingRmb(item: ProductItem) {
  const weightG = Math.max(0, item.item_weight_g * item.quantity);
  if (weightG === 0 || item.purchase_shipping_fee_per_500g_rmb <= 0) return 0;
  return Math.ceil(weightG / 500) * item.purchase_shipping_fee_per_500g_rmb;
}

function calculateSfCostRmb(packageWeightKg: number, settings: PricingSettings) {
  if (packageWeightKg <= 0) return 0;

  const firstWeightKg = Math.max(0, settings.sf_first_weight_kg);
  if (firstWeightKg === 0 || packageWeightKg <= firstWeightKg) {
    return settings.sf_first_price_rmb;
  }

  return (
    settings.sf_first_price_rmb +
    (packageWeightKg - firstWeightKg) * settings.sf_extra_price_per_kg_rmb
  );
}

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
    (sum, item) => sum + calculatePurchaseShippingRmb(item),
    0,
  );
  const packagingCostRmb = settings.packaging_cost_rmb;
  const subsidyRmb =
    settings.temu_shipping_subsidy_jpy *
    settings.exchange_rate_rmb_per_jpy;
  const packageWeightKg = packageWeightG / 1000;
  const sfCostRmb = calculateSfCostRmb(packageWeightKg, settings);
  const huaianAirCostRmb =
    packageWeightKg * settings.huaian_air_price_per_kg_rmb;
  const ocsCostRmb = packageWeightKg * settings.ocs_price_per_kg_rmb;
  const ocsTariffMultiplier = 1 + Math.max(0, settings.ocs_tariff_rate ?? 0);
  const osakaLastmileRmb =
    settings.osaka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;
  const fukuokaLastmileRmb =
    settings.fukuoka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;
  const planA = huaianAirCostRmb + osakaLastmileRmb;
  const planB = huaianAirCostRmb + fukuokaLastmileRmb;
  const planC = ocsCostRmb * ocsTariffMultiplier + osakaLastmileRmb;
  const planD = ocsCostRmb * ocsTariffMultiplier + fukuokaLastmileRmb;
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
