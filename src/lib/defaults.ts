import type {
  PricingSettings,
  ProductDraft,
  ProductItem,
  ProductSkuDraft,
  ProductSpec,
  LogisticsMethodConfig,
} from "../types";

export const defaultFirstLegMethods: LogisticsMethodConfig[] = [
  {
    id: "sf-first-leg",
    name: "顺丰",
    type: "first_leg",
    formula: "sf",
    params: {
      firstWeight: 1,
      firstPrice: 8,
      extraPrice: 2,
    },
    isActive: true,
  },
  {
    id: "huaian-air-first-leg",
    name: "淮安空运 RMB/kg",
    type: "first_leg",
    formula: "flat_rmb",
    params: {
      price: 25,
    },
    isActive: true,
  },
  {
    id: "ocs-first-leg",
    name: "OCS RMB/kg",
    type: "first_leg",
    formula: "flat_rmb_tariff",
    params: {
      price: 20,
      tariffRate: 0,
    },
    isActive: true,
  },
];

export const defaultLastLegMethods: LogisticsMethodConfig[] = [
  {
    id: "ocs-yamato-last-leg",
    name: "OCS Yamato",
    type: "last_leg",
    formula: "ocs_3cm",
    params: {
      firstPrice: 16.5,
      extraPrice: 1.5,
    },
    isActive: true,
  },
  {
    id: "ocs-small-last-leg",
    name: "OCS 小包",
    type: "last_leg",
    formula: "ocs_small",
    params: {
      firstPrice: 36.5,
      extraPrice: 6,
    },
    isActive: true,
  },
  {
    id: "osaka-jp-last-leg",
    name: "大阪Japan Post",
    type: "last_leg",
    formula: "flat_jpy",
    params: {
      price: 260,
    },
    isActive: true,
  },
  {
    id: "fukuoka-jp-last-leg",
    name: "福冈Japan Post",
    type: "last_leg",
    formula: "flat_jpy",
    params: {
      price: 220,
    },
    isActive: true,
  },
];

export const defaultSettings: PricingSettings = {
  packaging_cost_rmb: 0.2,
  exchange_rate_rmb_per_jpy: 0.0425,
  temu_shipping_subsidy_jpy: 410,
  sf_first_weight_kg: 1,
  sf_first_price_rmb: 8,
  sf_extra_price_per_kg_rmb: 2,
  huaian_air_price_per_kg_rmb: 25,
  ocs_price_per_kg_rmb: 20,
  osaka_lastmile_jpy: 260,
  fukuoka_lastmile_jpy: 220,
  test_ocs_3cm_first_price_rmb: 16.5,
  test_ocs_3cm_extra_price_per_100g_rmb: 1.5,
  test_ocs_small_parcel_first_price_rmb: 36.5,
  test_ocs_small_parcel_extra_price_per_500g_rmb: 6,
  target_profit_rate: 0.3,
  target_post_ad_profit_rate: 0.25,
  first_leg_methods: defaultFirstLegMethods,
  last_leg_methods: defaultLastLegMethods,
};

export const emptyProductDraft: ProductDraft = {
  product_code: "",
  product_name_cn: "",
  product_name_en: "",
  material_en: "",
  material_cn: "",
  combo_name: "",
  combo_description: "",
  title_jp: "",
  package_length_cm: 0,
  package_width_cm: 0,
  package_height_cm: 0,
  package_weight_g: 0,
  max_units_per_parcel: 1,
  notes: "",
};

export const createEmptySku = (): ProductSkuDraft => ({
  sku_code: "",
  temu_image_url: "",
  attributes: {},
  notes: "",
  component_links: [],
});

export const createEmptyItem = (): ProductItem => ({
  item_name: "",
  item_spec: "",
  quantity: 1,
  item_length_cm: 0,
  item_width_cm: 0,
  item_height_cm: 0,
  item_weight_g: 0,
  purchase_price_rmb: 0,
  purchase_shipping_fee_per_500g_rmb: 0,
  purchase_url: "",
});

export const createEmptySpec = (): ProductSpec => ({
  id: crypto.randomUUID(),
  name: "",
  values: [""],
});
