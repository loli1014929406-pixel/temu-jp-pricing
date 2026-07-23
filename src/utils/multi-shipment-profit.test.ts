import { describe, expect, it } from "vitest";
import type {
  PricingSettings,
  Product,
  ProductItem,
  ProfitCalculationInput,
} from "../types";
import {
  calculateMultiShipmentProfitRow,
  calculateMultiShipmentProfitRows,
} from "./multi-shipment-profit";

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
    osaka_lastmile_jpy: 260,
    fukuoka_lastmile_jpy: 220,
    test_ocs_3cm_first_price_rmb: 10,
    test_ocs_3cm_extra_price_per_100g_rmb: 0,
    test_ocs_small_parcel_first_price_rmb: 36,
    test_ocs_small_parcel_extra_price_per_500g_rmb: 0,
    target_profit_rate: 0.2,
    target_post_ad_profit_rate: 0.1,
    first_leg_methods: [
      {
        id: "ocs-first-leg",
        name: "OCS RMB/kg",
        type: "first_leg",
        formula: "flat_rmb",
        params: { price: 0 },
        isActive: true,
        isDefault: true,
      },
    ],
    last_leg_methods: [
      {
        id: "ocs-yamato-last-leg",
        name: "OCS Yamato",
        type: "last_leg",
        formula: "ocs_3cm",
        params: {
          firstPrice: overrides.test_ocs_3cm_first_price_rmb ?? 10,
          extraPrice:
            overrides.test_ocs_3cm_extra_price_per_100g_rmb ?? 0,
        },
        isActive: true,
      },
      {
        id: "ocs-small-last-leg",
        name: "OCS 小包",
        type: "last_leg",
        formula: "ocs_small",
        params: {
          firstPrice:
            overrides.test_ocs_small_parcel_first_price_rmb ?? 36,
          extraPrice:
            overrides.test_ocs_small_parcel_extra_price_per_500g_rmb ?? 0,
        },
        isActive: true,
      },
      {
        id: "osaka-jp-last-leg",
        name: "大阪Japan Post",
        type: "last_leg",
        formula: "flat_jpy",
        params: { price: overrides.osaka_lastmile_jpy ?? 260 },
        isActive: true,
        isDefault: true,
      },
    ],
    ...overrides,
  };
}

function buildProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "product-1",
    owner_id: "user-1",
    product_code: "zn001",
    product_name_cn: "测试商品",
    product_name_en: "",
    material_en: "",
    material_cn: "",
    combo_name: "",
    combo_description: "",
    title_jp: "",
    package_length_cm: 20,
    package_width_cm: 20,
    package_height_cm: 2,
    package_weight_g: 50,
    max_units_per_parcel: 5,
    is_selling: true,
    notes: "",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function buildItem(overrides: Partial<ProductItem> = {}): ProductItem {
  return {
    item_name: "配件",
    item_spec: "",
    quantity: 1,
    item_length_cm: 0,
    item_width_cm: 0,
    item_height_cm: 0,
    item_weight_g: 0,
    purchase_price_rmb: 1,
    purchase_shipping_fee_per_500g_rmb: 0,
    purchase_url: "",
    ...overrides,
  };
}

function buildInput(overrides: Partial<ProfitCalculationInput> = {}): ProfitCalculationInput {
  return {
    temuPriceRmb: 10,
    trafficDiscountRate: 0,
    activityDiscountRate: 10,
    couponDiscountRate: 0,
    adRoas: 0,
    ...overrides,
  };
}

describe("multi-shipment profit", () => {
  it("uses direct OCS 3cm when split parcels are cheaper", () => {
    const row = calculateMultiShipmentProfitRow(
      "direct",
      buildProduct(),
      [buildItem()],
      buildSettings({ test_ocs_small_parcel_first_price_rmb: 100 }),
      buildInput(),
      5,
    );

    expect(row.selectedMethodName).toBe("OCS Yamato");
    expect(row.selectedPackageCount).toBe(1);
    expect(row.logisticsCostRmb).toBe(10);
  });

  it("uses OCS small parcel when it is cheaper than direct 3cm split parcels", () => {
    const row = calculateMultiShipmentProfitRow(
      "direct",
      buildProduct({ max_units_per_parcel: 1 }),
      [buildItem()],
      buildSettings({
        test_ocs_3cm_first_price_rmb: 60,
        test_ocs_small_parcel_first_price_rmb: 36,
      }),
      buildInput(),
      2,
    );

    expect(row.selectedMethodName).toBe("OCS 小包");
    expect(row.selectedPackageCount).toBe(1);
    expect(row.logisticsCostRmb).toBe(36);
  });

  it("uses the configured default logistics cost for standard shipping", () => {
    const row = calculateMultiShipmentProfitRow(
      "standard",
      buildProduct(),
      [buildItem()],
      buildSettings({
        osaka_lastmile_jpy: 260,
        fukuoka_lastmile_jpy: 220,
        test_ocs_small_parcel_first_price_rmb: 36,
      }),
      buildInput(),
      2,
    );

    expect(row.selectedMethodName).toBe("默认核价物流方案");
    expect(row.selectedPackageCount).toBe(1);
    expect(row.logisticsCostRmb).toBe(13);
  });

  it("does not add inbound SF cost to standard shipping", () => {
    const standardRow = calculateMultiShipmentProfitRow(
      "standard",
      buildProduct({ package_weight_g: 500 }),
      [buildItem()],
      buildSettings({ sf_first_price_rmb: 8 }),
      buildInput(),
      2,
    );
    const directRow = calculateMultiShipmentProfitRow(
      "direct",
      buildProduct({ package_weight_g: 500 }),
      [buildItem()],
      buildSettings({ sf_first_price_rmb: 8 }),
      buildInput(),
      2,
    );

    expect(standardRow.inboundSfCostRmb).toBe(0);
    expect(directRow.inboundSfCostRmb).toBe(8);
  });

  it("uses OCS small parcel for standard shipping when 3cm is unavailable", () => {
    const row = calculateMultiShipmentProfitRow(
      "standard",
      buildProduct({ package_height_cm: 4 }),
      [buildItem()],
      buildSettings({
        test_ocs_small_parcel_first_price_rmb: 36,
      }),
      buildInput(),
      2,
    );

    expect(row.selectedMethodName).toBe("OCS 小包");
    expect(row.selectedPackageCount).toBe(1);
    expect(row.logisticsCostRmb).toBe(36);
  });

  it("stops rows after the first loss", () => {
    const rows = calculateMultiShipmentProfitRows(
      "direct",
      buildProduct({
        package_height_cm: 4,
        package_weight_g: 400,
      }),
      [buildItem()],
      buildSettings({
        test_ocs_small_parcel_first_price_rmb: 3,
        test_ocs_small_parcel_extra_price_per_500g_rmb: 20,
      }),
      buildInput(),
      10,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.profitRmb).toBeGreaterThanOrEqual(0);
    expect(rows[1]?.profitRmb).toBeLessThan(0);
  });
});
