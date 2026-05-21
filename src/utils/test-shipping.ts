import type { PricingSettings, Product, TestShippingResult } from "../types";
import { defaultSettings } from "../lib/defaults";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export function calculateTestShipping(
  product: Product,
  settings: PricingSettings,
): TestShippingResult {
  const packageWeightKg = product.package_weight_g / 1000;

  const ocsKunshan3cmWeightUnits = Math.max(
    Math.ceil(product.package_weight_g / 100),
    1,
  );
  const ocsKunshan3cmCostRmb =
    settings.test_ocs_3cm_first_price_rmb +
    Math.max(ocsKunshan3cmWeightUnits - 1, 0) *
      settings.test_ocs_3cm_extra_price_per_100g_rmb;

  const ocsKunshanSmallParcelWeightUnits = Math.max(
    Math.ceil(product.package_weight_g / 500),
    1,
  );
  const ocsKunshanSmallParcelCostRmb =
    settings.test_ocs_small_parcel_first_price_rmb +
    Math.max(ocsKunshanSmallParcelWeightUnits - 1, 0) *
      settings.test_ocs_small_parcel_extra_price_per_500g_rmb;

  const dimensions = [
    product.package_length_cm,
    product.package_width_cm,
    product.package_height_cm,
  ];
  const canUseOcsKunshan3cm =
    dimensions.reduce((sum, dimension) => sum + dimension, 0) <= 60 &&
    Math.max(...dimensions) <= 34 &&
    packageWeightKg <= 1;

  return {
    sfCostRmb: 0,
    sf3cmCostRmb: round(
      settings.test_sf_3cm_price_rmb ?? defaultSettings.test_sf_3cm_price_rmb,
    ),
    ocsKunshan3cmCostRmb: round(ocsKunshan3cmCostRmb),
    ocsKunshanSmallParcelCostRmb: round(ocsKunshanSmallParcelCostRmb),
    canUseOcsKunshan3cm,
  };
}
