import type { PricingSettings, Product, TestShippingResult } from "../types";
import {
  calculateOcsSmallParcelCostRmb,
  calculateOcsThreeCmCostRmb,
  calculateInboundSfCostRmb,
  getThreeCmUnavailableReason,
} from "./shipping-costs";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export function calculateTestShipping(
  product: Product,
  settings: PricingSettings,
): TestShippingResult {
  const ocsKunshan3cmCostRmb = calculateOcsThreeCmCostRmb(
    product.package_weight_g,
    settings,
  );
  const ocsKunshanSmallParcelCostRmb = calculateOcsSmallParcelCostRmb(
    product.package_weight_g,
    settings,
  );
  const canUseOcsKunshan3cm = !getThreeCmUnavailableReason(product);

  return {
    sfCostRmb: round(calculateInboundSfCostRmb(product.package_weight_g, settings)),
    ocsKunshan3cmCostRmb: round(ocsKunshan3cmCostRmb),
    ocsKunshanSmallParcelCostRmb: round(ocsKunshanSmallParcelCostRmb),
    canUseOcsKunshan3cm,
  };
}
