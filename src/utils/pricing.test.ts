import { describe, expect, it } from "vitest";
import type { PricingSettings, ProductItem } from "../types";
import { calculatePricing } from "./pricing";

function buildSettings(overrides: Partial<PricingSettings> = {}): PricingSettings {
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
    ...overrides,
  };
}

function buildItem(overrides: Partial<ProductItem> = {}): ProductItem {
  return {
    item_name: "test item",
    item_spec: "",
    quantity: 1,
    item_length_cm: 0,
    item_width_cm: 0,
    item_height_cm: 0,
    item_weight_g: 0,
    purchase_price_rmb: 0,
    purchase_shipping_fee_per_500g_rmb: 0,
    purchase_url: "",
    ...overrides,
  };
}

describe("calculatePricing", () => {
  it("prorates purchase shipping by component weight", () => {
    const result = calculatePricing(
      0,
      [
        buildItem({
          item_weight_g: 250,
          purchase_shipping_fee_per_500g_rmb: 4,
        }),
      ],
      buildSettings(),
    );

    expect(result.purchaseShippingRmb).toBe(1);
  });

  it("does not add SF as a separate cost during normal pricing", () => {
    const result = calculatePricing(
      500,
      [],
      buildSettings({
        sf_first_weight_kg: 1,
        sf_first_price_rmb: 10,
        sf_extra_price_per_kg_rmb: 8,
      }),
    );

    expect(result.sfCostRmb).toBe(0);
    expect(result.totalCostRmb).toBe(result.logisticsCostRmb);
  });

  it("includes OCS tariff when comparing logistics plans", () => {
    const result = calculatePricing(
      1000,
      [],
      buildSettings({
        ocs_price_per_kg_rmb: 100,
        ocs_tariff_rate: 0.2,
      }),
    );

    expect(result.ocsCostRmb).toBe(100);
    expect(result.planC).toBe(120);
    expect(result.planD).toBe(120);
    expect(result.logisticsCostRmb).toBe(120);
  });
});
