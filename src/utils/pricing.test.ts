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
    first_leg_methods: [
      {
        id: "ocs-first-leg",
        name: "OCS RMB/kg",
        type: "first_leg",
        formula: "flat_rmb_tariff",
        params: { price: 0, tariffRate: 0 },
        isActive: true,
        isDefault: true,
      },
    ],
    last_leg_methods: [
      {
        id: "osaka-jp-last-leg",
        name: "大阪Japan Post",
        type: "last_leg",
        formula: "flat_jpy",
        params: { price: 0 },
        isActive: true,
        isDefault: true,
      },
    ],
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
        first_leg_methods: [
          {
            id: "ocs-first-leg",
            name: "OCS RMB/kg",
            type: "first_leg",
            formula: "flat_rmb_tariff",
            params: { price: 100, tariffRate: 0.2 },
            isActive: true,
            isDefault: true,
          },
        ],
      }),
    );

    expect(result.ocsCostRmb).toBe(100);
    expect(result.planC).toBe(120);
    expect(result.planD).toBe(120);
    expect(result.logisticsCostRmb).toBe(120);
  });

  it("uses the selected default pair instead of the most expensive pair", () => {
    const result = calculatePricing(
      60,
      [],
      buildSettings({
        exchange_rate_rmb_per_jpy: 0.041,
        first_leg_methods: [
          {
            id: "huaian-air-first-leg",
            name: "淮安空运 RMB/kg",
            type: "first_leg",
            formula: "flat_rmb",
            params: { price: 25, currency: "RMB", billingUnit: "kg" },
            isActive: true,
            isDefault: true,
          },
        ],
        last_leg_methods: [
          {
            id: "osaka-jp-last-leg",
            name: "大阪Japan Post",
            type: "last_leg",
            formula: "flat_jpy",
            params: { price: 260, currency: "JPY", billingUnit: "ticket" },
            isActive: true,
            isDefault: true,
          },
          {
            id: "kobe-yamato-small-parcel",
            name: "神户 Yamato小包",
            type: "last_leg",
            formula: "flat_jpy",
            params: { price: 500, currency: "JPY", billingUnit: "ticket" },
            isActive: true,
          },
        ],
      }),
    );

    expect(result.planA).toBe(12.16);
    expect(result.logisticsCostRmb).toBe(12.16);
  });

  it("uses OCS RMB/kg with Kobe Yamato 3cm when selected", () => {
    const result = calculatePricing(
      60,
      [],
      buildSettings({
        exchange_rate_rmb_per_jpy: 0.041,
        first_leg_methods: [
          {
            id: "ocs-first-leg",
            name: "OCS RMB/kg",
            type: "first_leg",
            formula: "flat_rmb_tariff",
            params: {
              price: 20,
              tariffRate: 0,
              currency: "RMB",
              billingUnit: "kg",
            },
            isActive: true,
            isDefault: true,
          },
        ],
        last_leg_methods: [
          {
            id: "osaka-jp-last-leg",
            name: "大阪Japan Post",
            type: "last_leg",
            formula: "flat_jpy",
            params: { price: 100, currency: "JPY", billingUnit: "ticket" },
            isActive: true,
          },
          {
            id: "kobe-yamato-3cm",
            name: "神户 Yamato3cm",
            type: "last_leg",
            formula: "quantity_tier",
            params: {
              quantityPrices: [225, 269],
              currency: "JPY",
              billingUnit: "ticket",
            },
            isActive: true,
            isDefault: true,
          },
          {
            id: "kobe-yamato-small-parcel",
            name: "神户 Yamato小包",
            type: "last_leg",
            formula: "flat_jpy",
            params: { price: 500, currency: "JPY", billingUnit: "ticket" },
            isActive: true,
          },
        ],
      }),
    );

    expect(result.logisticsCostRmb).toBe(10.43);
  });

  it("allows Kobe small parcel to be selected as the default last leg", () => {
    const result = calculatePricing(
      60,
      [],
      buildSettings({
        first_leg_methods: [
          {
            id: "ocs-first-leg",
            name: "OCS RMB/kg",
            type: "first_leg",
            formula: "flat_rmb",
            params: { price: 20 },
            isActive: true,
            isDefault: true,
          },
        ],
        last_leg_methods: [
          {
            id: "kobe-small",
            name: "神户 Yamato小包",
            type: "last_leg",
            formula: "fixed_rmb",
            params: { price: 30 },
            isActive: true,
            isDefault: true,
          },
        ],
      }),
    );

    expect(result.logisticsCostRmb).toBe(31.2);
  });
});
