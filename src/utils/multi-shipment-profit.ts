import type {
  PricingSettings,
  Product,
  ProductItem,
  ProfitCalculationInput,
} from "../types";
import { calculateAdFeeRmb, calculateFinalSalePriceRmb } from "./profit-calculation";
import { calculatePricing } from "./pricing";
import {
  calculateOcsSmallParcelCostRmb,
  calculateOcsThreeCmCostRmb,
  calculatePurchaseShippingRmb,
  calculateSfCostRmb,
  getThreeCmDimensionIssue as getSharedThreeCmDimensionIssue,
  getThreeCmUnavailableReason,
  THREE_CM_WEIGHT_LIMIT_G,
  calculateDynamicMethodCost,
} from "./shipping-costs";
import { resolveFirstLegMethods, resolveLastLegMethods } from "../lib/defaults";

export type MultiShipmentMode = "direct" | "standard";

function getFirstLegs(settings: PricingSettings) {
  return resolveFirstLegMethods(settings);
}

function getLastLegs(settings: PricingSettings) {
  return resolveLastLegMethods(settings);
}

export type ShipmentMethodCandidate = {
  key: string;
  name: string;
  available: boolean;
  logisticsCostRmb: number | null;
  packageCount: number | null;
  unavailableReason?: string;
};

export type MultiShipmentProfitRow = {
  quantity: number;
  isValid: boolean;
  finalUnitSalePriceRmb: number;
  orderSalePriceRmb: number;
  orderSalePriceJpy: number | null;
  losesShippingSubsidy: boolean;
  subsidyRmb: number;
  purchaseCostRmb: number;
  purchaseShippingRmb: number;
  packagingCostRmb: number;
  inboundSfCostRmb: number;
  adFeeRmb: number;
  logisticsCostRmb: number;
  totalCostRmb: number;
  revenueRmb: number;
  profitRmb: number;
  profitRate: number | null;
  selectedMethodName: string;
  selectedPackageCount: number | null;
  candidates: ShipmentMethodCandidate[];
};

const FREE_SHIPPING_THRESHOLD_JPY = 3500;

const round = (value: number, digits = 2) =>
  Math.round((value + Number.EPSILON) * Math.pow(10, digits)) / Math.pow(10, digits);

export function getThreeCmDimensionIssue(product: Product) {
  return getSharedThreeCmDimensionIssue(product);
}

export function getProductThreeCmUnavailableReason(product: Product) {
  return getThreeCmUnavailableReason(product);
}

function getEffectiveThreeCmCapacity(product: Product) {
  const configuredCapacity = Math.max(
    1,
    Math.trunc(Number(product.max_units_per_parcel) || 1),
  );
  const unitWeightG = Math.max(0, product.package_weight_g);

  if (unitWeightG <= 0) return configuredCapacity;
  if (unitWeightG > THREE_CM_WEIGHT_LIMIT_G) return 0;

  return Math.max(
    1,
    Math.min(
      configuredCapacity,
      Math.floor(THREE_CM_WEIGHT_LIMIT_G / unitWeightG),
    ),
  );
}

function buildParcelUnitCounts(product: Product, quantity: number) {
  const capacity = getEffectiveThreeCmCapacity(product);
  if (capacity <= 0) return [];

  const parcelUnitCounts: number[] = [];
  let remainingQuantity = quantity;

  while (remainingQuantity > 0) {
    const parcelQuantity = Math.min(capacity, remainingQuantity);
    parcelUnitCounts.push(parcelQuantity);
    remainingQuantity -= parcelQuantity;
  }

  return parcelUnitCounts;
}

function buildDirectThreeCmCandidate(
  product: Product,
  quantity: number,
  settings: PricingSettings,
): ShipmentMethodCandidate {
  const lastLegs = getLastLegs(settings);
  const ocs3cmMethod = lastLegs.find((m) => m.formula === "ocs_3cm");

  const name = ocs3cmMethod?.name || "OCS Yamato";
  const isActive = ocs3cmMethod ? ocs3cmMethod.isActive : true;

  if (!isActive) {
    return {
      key: "direct_ocs_3cm",
      name,
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: "发货方式未启用",
    };
  }

  const dimensionIssue = getThreeCmDimensionIssue(product);
  if (dimensionIssue) {
    return {
      key: "direct_ocs_3cm",
      name,
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: dimensionIssue,
    };
  }

  const parcelUnitCounts = buildParcelUnitCounts(product, quantity);
  if (parcelUnitCounts.length === 0) {
    return {
      key: "direct_ocs_3cm",
      name,
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: "单件重量超过 1kg",
    };
  }

  const logisticsCostRmb = parcelUnitCounts.reduce((sum, parcelQuantity) => {
    const weightG = product.package_weight_g * parcelQuantity;
    const cost = ocs3cmMethod
      ? calculateDynamicMethodCost(ocs3cmMethod, weightG, settings.exchange_rate_rmb_per_jpy)
      : calculateOcsThreeCmCostRmb(weightG, settings);
    return sum + cost;
  }, 0);

  return {
    key: "direct_ocs_3cm",
    name,
    available: true,
    logisticsCostRmb: round(logisticsCostRmb),
    packageCount: parcelUnitCounts.length,
  };
}

function getHighestNormalLogisticsCostRmb(
  product: Product,
  skuItems: ProductItem[],
  settings: PricingSettings,
) {
  const pricing = calculatePricing(product.package_weight_g, skuItems, settings);
  return pricing.logisticsCostRmb;
}

function buildStandardReferencedLogisticsCandidate(
  product: Product,
  skuItems: ProductItem[],
  quantity: number,
  settings: PricingSettings,
): ShipmentMethodCandidate {
  const dimensionIssue = getThreeCmDimensionIssue(product);
  if (dimensionIssue) {
    return {
      key: "standard_referenced_logistics",
      name: "利润页物流成本",
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: `${dimensionIssue}，改用 OCS 小包`,
    };
  }

  const parcelUnitCounts = buildParcelUnitCounts(product, quantity);
  if (parcelUnitCounts.length === 0) {
    return {
      key: "standard_referenced_logistics",
      name: "利润页物流成本",
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: "单件重量超过 1kg，改用 OCS 小包",
    };
  }

  const referencedLogisticsCostRmb = getHighestNormalLogisticsCostRmb(
    product,
    skuItems,
    settings,
  );

  return {
    key: "standard_referenced_logistics",
    name: "利润页物流成本",
    available: true,
    logisticsCostRmb: round(parcelUnitCounts.length * referencedLogisticsCostRmb),
    packageCount: parcelUnitCounts.length,
  };
}

function buildOcsSmallParcelCandidate(
  product: Product,
  quantity: number,
  settings: PricingSettings,
): ShipmentMethodCandidate {
  const lastLegs = getLastLegs(settings);
  const ocsSmallMethod = lastLegs.find((m) => m.formula === "ocs_small");

  const name = ocsSmallMethod?.name || "OCS 小包";
  const isActive = ocsSmallMethod ? ocsSmallMethod.isActive : true;

  if (!isActive) {
    return {
      key: "ocs_small_parcel",
      name,
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: "发货方式未启用",
    };
  }

  const weightG = product.package_weight_g * quantity;
  const cost = ocsSmallMethod
    ? calculateDynamicMethodCost(ocsSmallMethod, weightG, settings.exchange_rate_rmb_per_jpy)
    : calculateOcsSmallParcelCostRmb(weightG, settings);

  return {
    key: "ocs_small_parcel",
    name,
    available: true,
    logisticsCostRmb: round(cost),
    packageCount: 1,
  };
}

function buildShipmentCandidates(
  mode: MultiShipmentMode,
  product: Product,
  skuItems: ProductItem[],
  quantity: number,
  settings: PricingSettings,
) {
  if (mode === "direct") {
    return [
      buildDirectThreeCmCandidate(product, quantity, settings),
      buildOcsSmallParcelCandidate(product, quantity, settings),
    ];
  }

  const referencedCandidate = buildStandardReferencedLogisticsCandidate(
    product,
    skuItems,
    quantity,
    settings,
  );

  return referencedCandidate.available
    ? [referencedCandidate]
    : [
        referencedCandidate,
        buildOcsSmallParcelCandidate(product, quantity, settings),
      ];
}

function selectCheapestCandidate(candidates: ShipmentMethodCandidate[]) {
  const availableCandidates = candidates.filter(
    (candidate): candidate is ShipmentMethodCandidate & { logisticsCostRmb: number } =>
      candidate.available && typeof candidate.logisticsCostRmb === "number",
  );

  return availableCandidates.reduce<
    (ShipmentMethodCandidate & { logisticsCostRmb: number }) | null
  >((selected, candidate) => {
    if (!selected) return candidate;
    return candidate.logisticsCostRmb < selected.logisticsCostRmb
      ? candidate
      : selected;
  }, null);
}

export function calculateMultiShipmentProfitRow(
  mode: MultiShipmentMode,
  product: Product,
  skuItems: ProductItem[],
  settings: PricingSettings,
  input: ProfitCalculationInput,
  quantity: number,
): MultiShipmentProfitRow {
  const safeQuantity = Math.max(1, Math.trunc(Number(quantity) || 1));
  const finalUnitSalePriceRmb = calculateFinalSalePriceRmb(input);
  const orderSalePriceRmb = finalUnitSalePriceRmb * safeQuantity;
  const priceBeforeActivityDiscount =
    input.temuPriceRmb - input.trafficDiscountRate - input.couponDiscountRate;
  const orderSalePriceJpy =
    settings.exchange_rate_rmb_per_jpy > 0
      ? orderSalePriceRmb / settings.exchange_rate_rmb_per_jpy
      : null;
  const losesShippingSubsidy =
    orderSalePriceJpy !== null && orderSalePriceJpy > FREE_SHIPPING_THRESHOLD_JPY;
  const isValid =
    input.temuPriceRmb > 0 &&
    input.trafficDiscountRate >= 0 &&
    input.activityDiscountRate > 0 &&
    input.activityDiscountRate <= 10 &&
    input.couponDiscountRate >= 0 &&
    (input.adRoas ?? 0) >= 0 &&
    priceBeforeActivityDiscount > 0 &&
    finalUnitSalePriceRmb > 0 &&
    settings.exchange_rate_rmb_per_jpy > 0;
  const subsidyRmb =
    isValid && !losesShippingSubsidy
      ? settings.temu_shipping_subsidy_jpy * settings.exchange_rate_rmb_per_jpy
      : 0;
  const purchaseCostRmb =
    skuItems.reduce(
      (sum, item) => sum + item.purchase_price_rmb * item.quantity,
      0,
    ) * safeQuantity;
  const purchaseShippingRmb =
    skuItems.reduce((sum, item) => sum + calculatePurchaseShippingRmb(item, item.quantity), 0) *
    safeQuantity;
  const packagingCostRmb = settings.packaging_cost_rmb * safeQuantity;
  const totalWeightG = product.package_weight_g * safeQuantity;
  const firstLegs = getFirstLegs(settings);
  const activeFirstLegs = firstLegs.filter((m) => m.isActive);
  const sfMethod = activeFirstLegs.find((m) => m.formula === "sf" || m.name.includes("顺丰"));

  const inboundSfCostRmb =
    mode === "direct"
      ? sfMethod
        ? calculateDynamicMethodCost(sfMethod, totalWeightG, settings.exchange_rate_rmb_per_jpy)
        : calculateSfCostRmb(totalWeightG / 1000, settings)
      : 0;
  const adFeeRmb = isValid ? calculateAdFeeRmb(input) * safeQuantity : 0;
  const candidates = buildShipmentCandidates(
    mode,
    product,
    skuItems,
    safeQuantity,
    settings,
  );
  const selectedCandidate = selectCheapestCandidate(candidates);
  const logisticsCostRmb = selectedCandidate?.logisticsCostRmb ?? 0;
  const revenueRmb = isValid ? orderSalePriceRmb + subsidyRmb : 0;
  const totalCostRmb =
    purchaseCostRmb +
    purchaseShippingRmb +
    packagingCostRmb +
    inboundSfCostRmb +
    logisticsCostRmb +
    adFeeRmb;
  const profitRmb = revenueRmb - totalCostRmb;
  const profitRate = revenueRmb > 0 ? profitRmb / revenueRmb : null;

  return {
    quantity: safeQuantity,
    isValid,
    finalUnitSalePriceRmb: round(finalUnitSalePriceRmb),
    orderSalePriceRmb: round(orderSalePriceRmb),
    orderSalePriceJpy: orderSalePriceJpy === null ? null : round(orderSalePriceJpy),
    losesShippingSubsidy,
    subsidyRmb: round(subsidyRmb),
    purchaseCostRmb: round(purchaseCostRmb),
    purchaseShippingRmb: round(purchaseShippingRmb),
    packagingCostRmb: round(packagingCostRmb),
    inboundSfCostRmb: round(inboundSfCostRmb),
    adFeeRmb: round(adFeeRmb),
    logisticsCostRmb: round(logisticsCostRmb),
    totalCostRmb: round(totalCostRmb),
    revenueRmb: round(revenueRmb),
    profitRmb: round(profitRmb),
    profitRate: profitRate === null ? null : round(profitRate, 4),
    selectedMethodName: selectedCandidate?.name ?? "无可用方式",
    selectedPackageCount: selectedCandidate?.packageCount ?? null,
    candidates,
  };
}

export function calculateMultiShipmentProfitRows(
  mode: MultiShipmentMode,
  product: Product,
  skuItems: ProductItem[],
  settings: PricingSettings,
  input: ProfitCalculationInput,
  maxQuantity: number,
) {
  const safeMaxQuantity = Math.max(1, Math.trunc(Number(maxQuantity) || 1));
  const rows: MultiShipmentProfitRow[] = [];

  for (let quantity = 1; quantity <= safeMaxQuantity; quantity += 1) {
    const row = calculateMultiShipmentProfitRow(
      mode,
      product,
      skuItems,
      settings,
      input,
      quantity,
    );
    rows.push(row);

    if (row.isValid && row.profitRmb < 0) break;
  }

  return rows;
}
