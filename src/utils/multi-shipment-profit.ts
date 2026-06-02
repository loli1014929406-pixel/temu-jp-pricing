import type {
  PricingSettings,
  Product,
  ProductItem,
  ProfitCalculationInput,
} from "../types";
import { calculateAdFeeRmb, calculateFinalSalePriceRmb } from "./profit-calculation";
import { calculatePricing } from "./pricing";

export type MultiShipmentMode = "direct" | "standard";

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
const DIRECT_THREE_CM_WEIGHT_LIMIT_G = 1000;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function calculatePurchaseShippingRmb(item: ProductItem) {
  const weightG = Math.max(0, item.item_weight_g * item.quantity);
  if (weightG === 0 || item.purchase_shipping_fee_per_500g_rmb <= 0) return 0;
  return (weightG / 500) * item.purchase_shipping_fee_per_500g_rmb;
}

function calculateSfCostRmb(packageWeightKg: number, settings: PricingSettings) {
  if (packageWeightKg <= 0) return 0;

  const firstWeightKg = Math.max(0, settings.sf_first_weight_kg);
  if (firstWeightKg === 0) {
    return packageWeightKg * settings.sf_extra_price_per_kg_rmb;
  }

  return (
    Math.min(packageWeightKg, firstWeightKg) *
      (settings.sf_first_price_rmb / firstWeightKg) +
    Math.max(packageWeightKg - firstWeightKg, 0) *
      settings.sf_extra_price_per_kg_rmb
  );
}

function calculateOcsThreeCmCostRmb(weightG: number, settings: PricingSettings) {
  const weightUnits = Math.max(Math.ceil(Math.max(0, weightG) / 100), 1);
  return (
    settings.test_ocs_3cm_first_price_rmb +
    Math.max(weightUnits - 1, 0) * settings.test_ocs_3cm_extra_price_per_100g_rmb
  );
}

function calculateOcsSmallParcelCostRmb(weightG: number, settings: PricingSettings) {
  const weightUnits = Math.max(Math.ceil(Math.max(0, weightG) / 500), 1);
  return (
    settings.test_ocs_small_parcel_first_price_rmb +
    Math.max(weightUnits - 1, 0) *
      settings.test_ocs_small_parcel_extra_price_per_500g_rmb
  );
}

export function getThreeCmDimensionIssue(product: Product) {
  const dimensions = [
    product.package_length_cm,
    product.package_width_cm,
    product.package_height_cm,
  ];
  const dimensionSum = dimensions.reduce((sum, dimension) => sum + dimension, 0);
  const maxDimension = Math.max(...dimensions);

  if (product.package_height_cm > 3) return "包装高度超过 3cm";
  if (dimensionSum > 60) return "三边和超过 60cm";
  if (maxDimension > 34) return "最长边超过 34cm";
  return "";
}

export function getProductThreeCmUnavailableReason(product: Product) {
  const dimensionIssue = getThreeCmDimensionIssue(product);
  if (dimensionIssue) return dimensionIssue;
  if (product.package_weight_g > DIRECT_THREE_CM_WEIGHT_LIMIT_G) {
    return "单件重量超过 1kg";
  }
  return "";
}

function getEffectiveThreeCmCapacity(product: Product) {
  const configuredCapacity = Math.max(
    1,
    Math.trunc(Number(product.max_units_per_parcel) || 1),
  );
  const unitWeightG = Math.max(0, product.package_weight_g);

  if (unitWeightG <= 0) return configuredCapacity;
  if (unitWeightG > DIRECT_THREE_CM_WEIGHT_LIMIT_G) return 0;

  return Math.max(
    1,
    Math.min(
      configuredCapacity,
      Math.floor(DIRECT_THREE_CM_WEIGHT_LIMIT_G / unitWeightG),
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
  const dimensionIssue = getThreeCmDimensionIssue(product);
  if (dimensionIssue) {
    return {
      key: "direct_ocs_3cm",
      name: "OCS 3cm",
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
      name: "OCS 3cm",
      available: false,
      logisticsCostRmb: null,
      packageCount: null,
      unavailableReason: "单件重量超过 1kg",
    };
  }

  const logisticsCostRmb = parcelUnitCounts.reduce(
    (sum, parcelQuantity) =>
      sum + calculateOcsThreeCmCostRmb(product.package_weight_g * parcelQuantity, settings),
    0,
  );

  return {
    key: "direct_ocs_3cm",
    name: "OCS 3cm",
    available: true,
    logisticsCostRmb: round(logisticsCostRmb),
    packageCount: parcelUnitCounts.length,
  };
}

function getCheapestNormalLogisticsCostRmb(
  product: Product,
  skuItems: ProductItem[],
  settings: PricingSettings,
) {
  const pricing = calculatePricing(product.package_weight_g, skuItems, settings);
  const planCosts = [pricing.planA, pricing.planB, pricing.planC, pricing.planD];
  return Math.min(...planCosts);
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

  const referencedLogisticsCostRmb = getCheapestNormalLogisticsCostRmb(
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
) {
  return {
    key: "ocs_small_parcel",
    name: "OCS 小包",
    available: true,
    logisticsCostRmb: round(
      calculateOcsSmallParcelCostRmb(product.package_weight_g * quantity, settings),
    ),
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
    skuItems.reduce((sum, item) => sum + calculatePurchaseShippingRmb(item), 0) *
    safeQuantity;
  const packagingCostRmb = settings.packaging_cost_rmb * safeQuantity;
  const totalWeightG = product.package_weight_g * safeQuantity;
  const inboundSfCostRmb = calculateSfCostRmb(totalWeightG / 1000, settings);
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
