export type Product = {
  id: string;
  owner_id: string;
  product_code: string;
  product_name_cn: string;
  product_name_en: string;
  material_en: string;
  material_cn: string;
  combo_name: string;
  combo_description: string;
  title_jp: string;
  package_length_cm: number;
  package_width_cm: number;
  package_height_cm: number;
  package_weight_g: number;
  max_units_per_parcel: number;
  is_selling: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountProfile = {
  id?: string;
  owner_id: string;
  username: string;
  user_code: string;
  created_at?: string;
  updated_at?: string;
};

export type ProductSku = {
  id?: string;
  product_id?: string;
  owner_id?: string;
  sku_code: string;
  temu_image_url: string;
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

export type LogisticsMethodConfig = {
  id: string;
  db_method_id?: string;
  name: string;
  type: "first_leg" | "last_leg";
  formula:
    | "sf"
    | "flat_rmb"
    | "flat_rmb_tariff"
    | "flat_jpy"
    | "fixed_rmb"
    | "quantity_tier"
    | "ocs_3cm"
    | "ocs_small";
  params: {
    price?: number;        // flat_rmb, flat_jpy, fixed_rmb
    quantityPrices?: number[]; // quantity_tier: index 0 = 1 item; overflow uses last price
    currency?: "RMB" | "JPY";
    billingUnit?: "kg" | "100g" | "500g" | "ticket";
    tariffRate?: number;   // flat_rmb_tariff
    firstWeight?: number;  // sf
    firstPrice?: number;   // sf, ocs_3cm, ocs_small
    extraPrice?: number;   // sf, ocs_3cm, ocs_small
  };
  isActive: boolean;
  isDefault?: boolean;
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
  test_ocs_3cm_first_price_rmb: number;
  test_ocs_3cm_extra_price_per_100g_rmb: number;
  test_ocs_small_parcel_first_price_rmb: number;
  test_ocs_small_parcel_extra_price_per_500g_rmb: number;
  target_profit_rate: number;
  target_post_ad_profit_rate: number;
  first_leg_methods?: LogisticsMethodConfig[];
  last_leg_methods?: LogisticsMethodConfig[];
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
  temuDeclarationPriceRmb: number;
  profitRmb: number;
  profitRate: number;
};

export type ProfitCalculationInput = {
  temuPriceRmb: number;
  trafficDiscountRate: number;
  activityDiscountRate: number;
  couponDiscountRate: number;
  adRoas?: number;
};

export type ProfitLogisticsPlanKey = string;

export type ProfitLogisticsPlanResult = {
  planKey: ProfitLogisticsPlanKey;
  planName: string;
  logisticsCostRmb: number;
  totalCostRmb: number;
  effectiveSubsidyRmb: number;
  realizedRevenueRmb: number;
  grossProfitRmb: number;
  adFeeRmb: number;
  profitRmb: number;
  profitRate: number | null;
  maxAdSpendRmb: number;
  breakEvenAdSpendRmb: number;
  recommendedMinRoas: number | null;
  breakEvenRoas: number | null;
};

export type ProfitCalculationResult = {
  calculationVersion: number;
  isValid: boolean;
  finalDiscountRate: number;
  adRoas: number;
  adFeeRmb: number;
  discountedSalePriceRmb: number;
  discountedUnitPriceJpy: number | null;
  singleUnitLosesShippingSubsidy: boolean;
  freeShippingThresholdQty: number | null;
  plans: ProfitLogisticsPlanResult[];
};

export type TestShippingResult = {
  sfCostRmb: number;
  ocsKunshan3cmCostRmb: number;
  ocsKunshanSmallParcelCostRmb: number;
  canUseOcsKunshan3cm: boolean;
};

export type SavedProfitCalculation = {
  id: string;
  product_id: string;
  sku_id: string;
  owner_id: string;
  temu_price_rmb: number;
  traffic_discount_rate: number;
  activity_discount_rate: number;
  coupon_discount_rate?: number;
  result_json: ProfitCalculationResult;
  created_at: string;
  updated_at: string;
};

export type ProductTransferItem = Omit<
  ProductItem,
  "id" | "product_id" | "owner_id"
>;

export type ProductTransferSku = {
  sku_code: string;
  temu_image_url: string;
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

export type Warehouse = {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type ProductWarehouseShippingLimit = {
  id?: string;
  owner_id?: string;
  product_id?: string;
  warehouse_id: string;
  max_units_per_parcel: number;
  created_at?: string;
  updated_at?: string;
};

export type LogisticsMethod = {
  id: string;
  owner_id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type WarehouseLogisticsMethod = {
  id: string;
  warehouse_id: string;
  logistics_method_id: string;
  owner_id: string;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type WarehouseItemStock = {
  id: string;
  warehouse_id: string;
  item_id: string;
  owner_id: string;
  stock_quantity: number;
  created_at: string;
  updated_at: string;
};

export type WarehouseSku = {
  id: string;
  warehouse_id: string;
  product_id: string;
  sku_id: string;
  owner_id: string;
  stock_quantity: number;
  created_at: string;
  updated_at: string;
};

export type WarehouseSkuStockAdjustment = {
  id: string;
  warehouse_id: string;
  sku_id: string;
  owner_id: string;
  previous_quantity: number;
  next_quantity: number;
  change_quantity: number;
  reason: string;
  purchase_order_id?: string | null;
  purchase_package_id?: string | null;
  created_at: string;
};

export type WarehouseItemStockAdjustment = {
  id: string;
  warehouse_id: string;
  item_id: string;
  owner_id: string;
  previous_quantity: number;
  next_quantity: number;
  change_quantity: number;
  reason: string;
  purchase_order_id?: string | null;
  purchase_package_id?: string | null;
  created_at: string;
};

export type PurchaseOrder = {
  id: string;
  order_code: string;
  owner_id: string;
  warehouse_id: string;
  warehouse_name: string;
  purchased_at: string;
  items_total_rmb: number;
  total_cost_rmb: number;
  notes: string;
  status: "pending" | "partially_received" | "received";
  received_at: string | null;
  created_at: string;
  updated_at: string;
  sources: PurchaseOrderSource[];
  items: PurchaseOrderItem[];
  packages: PurchasePackage[];
};

export type PurchaseOrderSource = {
  id: string;
  order_id: string;
  owner_id: string;
  purchase_url: string;
  alibaba_order_no: string;
  freight_rmb: number;
  created_at: string;
  updated_at: string;
};

export type PurchaseOrderItem = {
  id: string;
  order_id: string;
  owner_id: string;
  product_id: string | null;
  item_id: string | null;
  sku_id: string | null;
  sku_quantity: number | null;
  source_id: string;
  product_code: string;
  product_name_cn: string;
  item_name: string;
  item_spec: string;
  purchase_url: string;
  quantity: number;
  unit_price_rmb: number;
  created_at: string;
};

export type PurchasePackage = {
  id: string;
  order_id: string;
  owner_id: string;
  source_id: string;
  tracking_no: string;
  status: "pending" | "received";
  received_at: string | null;
  created_at: string;
  updated_at: string;
  items: PurchasePackageItem[];
};

export type PurchasePackageItem = {
  id: string;
  package_id: string;
  order_item_id: string;
  owner_id: string;
  quantity: number;
  created_at: string;
};

export type OrderCustomerHistoryStatus =
  | "normal"
  | "repeat_customer"
  | "refund_order"
  | "refund_customer";

export type TrackingCategory =
  | "pending"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "available_for_pickup"
  | "failed_attempt"
  | "exception";

export type TemuOrderRecord = {
  id: string;
  owner_id: string;
  order_no: string;
  sub_order_no: string;
  order_status: string;
  sku_code: string;
  warehouse_id: string | null;
  warehouse_name: string;
  logistics_method_id: string | null;
  logistics_method: string;
  logistics_method_is_unmatched: boolean;
  label_printed_at: string;
  logistics_tracking_no: string;
  logistics_status: string;
  logistics_status_detail: string;
  tracking_category: TrackingCategory;
  tracking_event_time: string;
  tracking_last_checked_at: string;
  tracking_last_query_error: string;
  tracking_last_query_error_at: string;
  tracking_is_exception: boolean;
  tracking_exception_reason: string;
  tracking_exception_fingerprint: string;
  tracking_exception_handled_at: string;
  tracking_exception_handled_by: string | null;
  fulfillment_quantity: number;
  product_attributes: string;
  recipient_name: string;
  recipient_phone: string;
  email: string;
  province: string;
  city: string;
  district: string;
  address_line1: string;
  address_line2: string;
  postal_code: string;
  latest_ship_time: string;
  actual_ship_time: string;
  estimated_delivery_time: string;
  actual_signed_time: string;
  actual_shipping_fee_rmb: number;
  customer_history_status: OrderCustomerHistoryStatus;
  customer_sales_reversal: number;
  customer_freight_reversal: number;
  created_at: string;
  updated_at: string;
};

export type FinanceExpense = {
  id: string;
  user_id: string;
  expense_date: string;
  category: "ad" | "customs" | "packaging" | "platform_commission" | "refund_loss" | "other";
  amount_rmb: number;
  remark: string;
  created_at: string;
  updated_at: string;
};
