import type { PricingSettings, Product, ProductItem, LogisticsMethodConfig } from "../types";

export const THREE_CM_WEIGHT_LIMIT_G = 1000;

type PurchaseShippingItem = Pick<
  ProductItem,
  "item_weight_g" | "purchase_shipping_fee_per_500g_rmb"
>;

type SfPricingInput = Pick<
  PricingSettings,
  "sf_first_weight_kg" | "sf_first_price_rmb" | "sf_extra_price_per_kg_rmb"
>;

type OcsThreeCmPricingInput = Pick<
  PricingSettings,
  "test_ocs_3cm_first_price_rmb" | "test_ocs_3cm_extra_price_per_100g_rmb"
>;

type OcsSmallParcelPricingInput = Pick<
  PricingSettings,
  | "test_ocs_small_parcel_first_price_rmb"
  | "test_ocs_small_parcel_extra_price_per_500g_rmb"
>;

type ThreeCmDimensionProduct = Pick<
  Product,
  "package_length_cm" | "package_width_cm" | "package_height_cm"
>;

type ThreeCmEligibilityProduct = ThreeCmDimensionProduct &
  Pick<Product, "package_weight_g">;

/**
 * 计算单个采购项的采购运费。
 *
 * @param item 采购项，`item_weight_g` 单位为 g，`purchase_shipping_fee_per_500g_rmb` 单位为人民币 / 500g。
 * @param quantity 采购数量，单位为件。
 * @returns 采购运费，单位为人民币。
 */
export function calculatePurchaseShippingRmb(
  item: PurchaseShippingItem,
  quantity: number,
): number {
  const weightG = Math.max(0, item.item_weight_g * quantity);
  if (weightG === 0 || item.purchase_shipping_fee_per_500g_rmb <= 0) return 0;
  return (weightG / 500) * item.purchase_shipping_fee_per_500g_rmb;
}

/**
 * 计算顺丰入仓成本。
 *
 * @param packageWeightKg 包裹总重量，单位为 kg。
 * @param settings 顺丰计费配置：`sf_first_weight_kg` 单位为 kg，`sf_first_price_rmb` 单位为人民币，`sf_extra_price_per_kg_rmb` 单位为人民币 / kg。
 * @returns 顺丰成本，单位为人民币。
 */
export function calculateSfCostRmb(
  packageWeightKg: number,
  settings: SfPricingInput,
): number {
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

/**
 * 计算 OCS 3cm 物流成本。
 *
 * @param weightG 包裹重量，单位为 g。
 * @param settings OCS 3cm 计费配置：`test_ocs_3cm_first_price_rmb` 单位为人民币，`test_ocs_3cm_extra_price_per_100g_rmb` 单位为人民币 / 100g。
 * @returns OCS 3cm 成本，单位为人民币。
 */
export function calculateOcsThreeCmCostRmb(
  weightG: number,
  settings: OcsThreeCmPricingInput,
): number {
  const weightUnits = Math.max(Math.ceil(Math.max(0, weightG) / 100), 1);
  return (
    settings.test_ocs_3cm_first_price_rmb +
    Math.max(weightUnits - 1, 0) * settings.test_ocs_3cm_extra_price_per_100g_rmb
  );
}

/**
 * 计算 OCS 小包物流成本。
 *
 * @param weightG 包裹重量，单位为 g。
 * @param settings OCS 小包计费配置：`test_ocs_small_parcel_first_price_rmb` 单位为人民币，`test_ocs_small_parcel_extra_price_per_500g_rmb` 单位为人民币 / 500g。
 * @returns OCS 小包成本，单位为人民币。
 */
export function calculateOcsSmallParcelCostRmb(
  weightG: number,
  settings: OcsSmallParcelPricingInput,
): number {
  const weightUnits = Math.max(Math.ceil(Math.max(0, weightG) / 500), 1);
  return (
    settings.test_ocs_small_parcel_first_price_rmb +
    Math.max(weightUnits - 1, 0) *
      settings.test_ocs_small_parcel_extra_price_per_500g_rmb
  );
}

/**
 * 判断 3cm 渠道的尺寸限制问题。
 *
 * @param product 包裹尺寸，`package_length_cm`、`package_width_cm`、`package_height_cm` 单位均为 cm。
 * @returns 不可用原因；如果尺寸满足要求则返回空字符串。
 */
export function getThreeCmDimensionIssue(
  product: ThreeCmDimensionProduct,
): string {
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

/**
 * 判断商品是否可走 3cm 渠道。
 *
 * @param product 包裹信息：尺寸 `package_length_cm` / `package_width_cm` / `package_height_cm` 单位为 cm，重量 `package_weight_g` 单位为 g。
 * @returns 不可用原因；如果尺寸和重量都满足要求则返回空字符串。
 */
export function getThreeCmUnavailableReason(
  product: ThreeCmEligibilityProduct,
): string {
  const dimensionIssue = getThreeCmDimensionIssue(product);
  if (dimensionIssue) return dimensionIssue;
  if (product.package_weight_g > THREE_CM_WEIGHT_LIMIT_G) {
    return "单件重量超过 1kg";
  }
  return "";
}

export function calculateDynamicMethodCost(
  method: LogisticsMethodConfig,
  packageWeightG: number,
  exchangeRateRmbPerJpy: number,
): number {
  const packageWeightKg = packageWeightG / 1000;
  switch (method.formula) {
    case "sf": {
      const firstWeight = method.params.firstWeight ?? 1;
      const firstPrice = method.params.firstPrice ?? 8;
      const extraPrice = method.params.extraPrice ?? 2;
      if (packageWeightKg <= 0) return 0;
      if (firstWeight <= 0) return packageWeightKg * extraPrice;
      return (
        Math.min(packageWeightKg, firstWeight) * (firstPrice / firstWeight) +
        Math.max(packageWeightKg - firstWeight, 0) * extraPrice
      );
    }
    case "flat_rmb": {
      return packageWeightKg * (method.params.price ?? 0);
    }
    case "flat_rmb_tariff": {
      return (
        packageWeightKg *
        (method.params.price ?? 0) *
        (1 + (method.params.tariffRate ?? 0))
      );
    }
    case "flat_jpy": {
      return (method.params.price ?? 0) * exchangeRateRmbPerJpy;
    }
    case "ocs_3cm": {
      const firstPrice = method.params.firstPrice ?? 16.5;
      const extraPrice = method.params.extraPrice ?? 1.5;
      const weightUnits = Math.max(Math.ceil(Math.max(0, packageWeightG) / 100), 1);
      return firstPrice + Math.max(weightUnits - 1, 0) * extraPrice;
    }
    case "ocs_small": {
      const firstPrice = method.params.firstPrice ?? 36.5;
      const extraPrice = method.params.extraPrice ?? 6;
      const weightUnits = Math.max(Math.ceil(Math.max(0, packageWeightG) / 500), 1);
      return firstPrice + Math.max(weightUnits - 1, 0) * extraPrice;
    }
    default:
      return 0;
  }
}
