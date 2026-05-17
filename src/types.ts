export type Product = {
  id: string;
  owner_id: string;
  product_code: string;
  product_name_cn: string;
  combo_name: string;
  combo_description: string;
  title_jp: string;
  package_length_cm: number;
  package_width_cm: number;
  package_height_cm: number;
  package_weight_g: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ProductSku = {
  id?: string;
  product_id?: string;
  owner_id?: string;
  sku_code: string;
  attributes: Record<string, string>;
  notes: string;
  component_links: ProductSkuItemLink[];
};

export type ProductItem = {
  id?: string;
  product_id?: string;
  owner_id?: string;
  item_name: string;
  item_spec: string;
  quantity: number;
  item_length_cm: number;
  item_width_cm: number;
  item_height_cm: number;
  item_weight_g: number;
  purchase_price_rmb: number;
  purchase_shipping_fee_per_500g_rmb: number;
  purchase_url: string;
};

export type ProductSkuItemLink = {
  id?: string;
  sku_id?: string;
  item_id: string;
  quantity: number;
};

export type ProductSkuDraftLink = Omit<ProductSkuItemLink, "item_id"> & {
  item_key: string;
};

export type ProductSkuDraft = Omit<ProductSku, "component_links"> & {
  component_links: ProductSkuDraftLink[];
};

export type ProductSpec = {
  id: string;
  name: string;
  values: string[];
};

export type PricingSettings = {
  id?: string;
  owner_id?: string;
  packaging_cost_rmb: number;
  exchange_rate_rmb_per_jpy: number;
  temu_shipping_subsidy_jpy: number;
  sf_first_weight_kg: number;
  sf_first_price_rmb: number;
  sf_extra_price_per_kg_rmb: number;
  huaian_air_price_per_kg_rmb: number;
  ocs_price_per_kg_rmb: number;
  ocs_tariff_rate?: number;
  osaka_lastmile_jpy: number;
  fukuoka_lastmile_jpy: number;
  target_profit_rate: number;
};

export type ProductDraft = Omit<
  Product,
  "id" | "owner_id" | "created_at" | "updated_at"
>;

export type PricingResult = {
  purchaseCostRmb: number;
  purchaseShippingRmb: number;
  packagingCostRmb: number;
  subsidyRmb: number;
  packageWeightKg: number;
  sfCostRmb: number;
  huaianAirCostRmb: number;
  ocsCostRmb: number;
  osakaLastmileRmb: number;
  fukuokaLastmileRmb: number;
  planA: number;
  planB: number;
  planC: number;
  planD: number;
  logisticsCostRmb: number;
  totalCostRmb: number;
  minimumPriceRmb: number;
  profitRmb: number;
  profitRate: number;
};

export type ProductTransferItem = Omit<
  ProductItem,
  "id" | "product_id" | "owner_id"
>;

export type ProductTransferSku = {
  sku_code: string;
  attributes: Record<string, string>;
  notes: string;
  component_links: Array<{
    item_index: number;
    quantity: number;
  }>;
};

export type ProductTransferRecord = ProductDraft & {
  items: ProductTransferItem[];
  skus: ProductTransferSku[];
};
