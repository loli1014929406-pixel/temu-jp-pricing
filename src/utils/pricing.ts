import type { PricingResult, PricingSettings, ProductItem } from "../types";
import {
  calculatePurchaseShippingRmb,
  calculateSfCostRmb,
  calculateDynamicMethodCost,
} from "./shipping-costs";
import { resolveFirstLegMethods, resolveLastLegMethods } from "../lib/defaults";

const round = (value: number, digits = 2) =>
  Math.round((value + Number.EPSILON) * Math.pow(10, digits)) / Math.pow(10, digits);

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
    (sum, item) => sum + calculatePurchaseShippingRmb(item, item.quantity),
    0,
  );
  const packagingCostRmb = settings.packaging_cost_rmb;
  const subsidyRmb =
    settings.temu_shipping_subsidy_jpy *
    settings.exchange_rate_rmb_per_jpy;
  const packageWeightKg = packageWeightG / 1000;

  const firstLegs = resolveFirstLegMethods(settings);
  const lastLegs = resolveLastLegMethods(settings);

  const activeFirstLegs = firstLegs.filter((m) => m.isActive);
  const activeLastLegs = lastLegs.filter((m) => m.isActive);

  // sfCostRmb
  const sfMethod = activeFirstLegs.find((m) => m.formula === "sf" || m.name.includes("顺丰"));
  const sfCostRmb = sfMethod
    ? calculateDynamicMethodCost(sfMethod, packageWeightG, settings.exchange_rate_rmb_per_jpy)
    : calculateSfCostRmb(packageWeightKg, settings);

  // huaianAirCostRmb
  const huaianAirMethod = activeFirstLegs.find(
    (m) => m.name.includes("淮安空运") || m.id === "huaian-air-first-leg",
  );
  const huaianAirCostRmb = huaianAirMethod
    ? calculateDynamicMethodCost(huaianAirMethod, packageWeightG, settings.exchange_rate_rmb_per_jpy)
    : packageWeightKg * settings.huaian_air_price_per_kg_rmb;

  // ocsCostRmb
  const ocsMethod = activeFirstLegs.find(
    (m) => m.name.includes("OCS") || m.id === "ocs-first-leg",
  );
  const ocsCostRmb = ocsMethod
    ? packageWeightKg * (ocsMethod.params.price ?? 0)
    : packageWeightKg * settings.ocs_price_per_kg_rmb;

  // osakaLastmileRmb
  const osakaMethod = activeLastLegs.find(
    (m) => m.name.includes("大阪") || m.id === "osaka-jp-last-leg",
  );
  const osakaLastmileRmb = osakaMethod
    ? calculateDynamicMethodCost(osakaMethod, packageWeightG, settings.exchange_rate_rmb_per_jpy)
    : settings.osaka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;

  // fukuokaLastmileRmb
  const fukuokaMethod = activeLastLegs.find(
    (m) => m.name.includes("福冈") || m.id === "fukuoka-jp-last-leg",
  );
  const fukuokaLastmileRmb = fukuokaMethod
    ? calculateDynamicMethodCost(fukuokaMethod, packageWeightG, settings.exchange_rate_rmb_per_jpy)
    : settings.fukuoka_lastmile_jpy * settings.exchange_rate_rmb_per_jpy;

  const ocsTariffRate = ocsMethod ? (ocsMethod.params.tariffRate ?? 0) : (settings.ocs_tariff_rate ?? 0);
  const ocsTariffMultiplier = 1 + Math.max(0, ocsTariffRate);
  const planA = huaianAirCostRmb + osakaLastmileRmb;
  const planB = huaianAirCostRmb + fukuokaLastmileRmb;
  const planC = ocsCostRmb * ocsTariffMultiplier + osakaLastmileRmb;
  const planD = ocsCostRmb * ocsTariffMultiplier + fukuokaLastmileRmb;

  // Calculate logisticsCostRmb as maximum of all active pairings of (overseas first leg) + (overseas last leg)
  const overseasFirstLegs = activeFirstLegs.filter(
    (m) =>
      m.formula === "flat_rmb" ||
      m.formula === "flat_rmb_tariff" ||
      m.formula === "fixed_rmb",
  );
  const overseasLastLegs = activeLastLegs.filter(
    (m) => m.formula === "flat_jpy" || m.formula === "fixed_rmb",
  );

  let maxLogisticsCost = 0;
  let pairingsCount = 0;

  for (const fl of overseasFirstLegs) {
    for (const ll of overseasLastLegs) {
      const flCost = calculateDynamicMethodCost(
        fl,
        packageWeightG,
        settings.exchange_rate_rmb_per_jpy,
      );
      const llCost = calculateDynamicMethodCost(
        ll,
        packageWeightG,
        settings.exchange_rate_rmb_per_jpy,
      );
      maxLogisticsCost = Math.max(maxLogisticsCost, flCost + llCost);
      pairingsCount++;
    }
  }

  const logisticsCostRmb = pairingsCount > 0 ? maxLogisticsCost : Math.max(planA, planB, planC, planD);
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
