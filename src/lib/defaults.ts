import type {
  PricingSettings,
  ProductDraft,
  ProductItem,
  ProductSkuDraft,
  ProductSpec,
} from "../types";

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
  target_profit_rate: 0.3,
};

export const emptyProductDraft: ProductDraft = {
  product_code: "",
  product_name_cn: "",
  combo_name: "",
  combo_description: "",
  title_jp: "",
  package_length_cm: 0,
  package_width_cm: 0,
  package_height_cm: 0,
  package_weight_g: 0,
  notes: "",
};

export const createEmptySku = (): ProductSkuDraft => ({
  sku_code: "",
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
