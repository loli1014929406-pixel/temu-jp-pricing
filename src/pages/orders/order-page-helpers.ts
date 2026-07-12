import { toDraft, type OrderDraft } from "../../hooks/useOrders";
import type { TemuOrderImportRow } from "../../lib/orders";
import { normalizeLogisticsMethodName } from "../../lib/logistics-methods";
import type { Product, ProductSku, TemuOrderRecord, Warehouse, WarehouseSku } from "../../types";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../../utils/sku-code";

function getDisplayOrderNoKey(value: string) {
  return value.trim().toLowerCase();
}

export type OrderSortKey =
  | "ship_deadline"
  | "delivery_deadline"
  | "product"
  | "logistics_status";
export type OrderSortDirection = "asc" | "desc";
export type OrderSort = {
  key: OrderSortKey;
  direction: OrderSortDirection;
};

export type TrackingImportRecord = {
  rowIndex: number;
  trackingNo: string;
  orderNo: string;
  subOrderNo: string;
  remark: string;
  refNo: string;
  phone: string;
  postalCode: string;
  recipientName: string;
  address: string;
  carrier: string;
  warehouseName: string;
  allText: string;
};

export type TrackingCarrier = "yamato" | "japan_post";
export type TrackingStatusResult = {
  status: string;
  actualSignedTime?: string;
};

export type OrderStockDeduction = {
  orderId: string;
  stock: WarehouseSku;
  quantity: number;
  warehouseName: string;
  orderNo: string;
  orderLineLabel: string;
};

export type OrderDisplayRow = {
  id: string;
  primaryOrder: TemuOrderRecord;
  orders: TemuOrderRecord[];
  quantity: number;
};

export type TemuOrderImportField = keyof TemuOrderImportRow;

export const importColumnAliases = {
  order_no: ["订单号", "主订单号", "订单编号", "订单ID", "Order ID"],
  sub_order_no: ["子订单号", "子订单编号", "子订单ID", "Sub Order ID", "Sub-order ID"],
  order_status: ["订单状态", "状态", "Order Status"],
  sku_code: ["SKU货号", "SKU 货号", "SKU", "SKU ID", "商品SKU", "商家SKU"],
  fulfillment_quantity: ["应履约件数", "商品数量", "数量", "购买数量", "件数", "商品件数"],
  product_attributes: ["商品属性", "商品规格", "销售属性", "SKU属性", "规格"],
  recipient_name: [
    "收货人姓名",
    "收件人姓名",
    "收货人",
    "收件人",
    "CONSIGNEE_NAME",
    "CONSIGNEE NAME",
    "Recipient Name",
  ],
  recipient_phone: [
    "收货人联系方式",
    "收件人联系方式",
    "收货电话",
    "收件电话",
    "联系电话",
    "电话",
    "CONTACT_TEL",
    "CONTACT TEL",
    "Recipient Phone",
  ],
  email: ["邮箱", "电子邮箱", "Email", "E-mail"],
  province: ["省份", "都道府县", "都道府県", "州/省", "Province"],
  city: ["城市", "市区町村", "市", "City"],
  district: ["区县", "区町村", "区", "District"],
  address_line1: [
    "详细地址1",
    "详细地址 1",
    "地址1",
    "收货地址1",
    "收件地址1",
    "收件人地址",
    "收货地址",
    "地址",
    "住所1",
    "DELIVERY_ADDR_JP",
    "DELIVERY ADDR JP",
  ],
  address_line2: ["详细地址2", "详细地址 2", "地址2", "收货地址2", "收件地址2", "住所2"],
  postal_code: [
    "收货地址邮编",
    "邮编",
    "收件邮编",
    "收货邮编",
    "郵便番号",
    "POSTCODE",
    "Postal Code",
    "Zip Code",
  ],
  latest_ship_time: ["要求最晚发货时间", "最晚发货时间", "发货截止时间", "Latest Ship Time"],
  actual_ship_time: ["实际发货时间", "Actual Ship Time"],
  estimated_delivery_time: ["预计送达时间", "预计送达日期", "Estimated Delivery Time"],
} satisfies Record<TemuOrderImportField, readonly string[]>;

export const optionalImportFields = new Set<TemuOrderImportField>([
  "sub_order_no",
  "sku_code",
  "fulfillment_quantity",
  "product_attributes",
]);

export const importFieldLabels = {
  order_no: "订单号",
  sub_order_no: "子订单号",
  order_status: "订单状态",
  sku_code: "SKU货号",
  fulfillment_quantity: "应履约件数",
  product_attributes: "商品属性",
  recipient_name: "收货人姓名",
  recipient_phone: "收货人联系方式",
  email: "邮箱",
  province: "省份",
  city: "城市",
  district: "区县",
  address_line1: "详细地址1",
  address_line2: "详细地址2",
  postal_code: "收货地址邮编",
  latest_ship_time: "要求最晚发货时间",
  actual_ship_time: "实际发货时间",
  estimated_delivery_time: "预计送达时间",
} satisfies Record<TemuOrderImportField, string>;

export const trackingNoImportColumnAliases = [
  "CWB_NO",
  "CWB NO",
  "跟踪单号",
  "物流单号",
  "运单号",
  "单号",
  "お問い合わせ番号",
  "Tracking No",
  "Tracking Number",
] as const;
export const trackingOrderNoImportColumnAliases = ["订单号", "主订单号", "REF_NO", "REF NO", "Order ID"] as const;
export const trackingSubOrderNoImportColumnAliases = [
  "子订单号",
  "子订单编号",
  "Sub Order ID",
  "Sub-order ID",
] as const;

export const rmbPerUsdForDeclaration = 7;
export const defaultOrderSort: OrderSort = { key: "ship_deadline", direction: "asc" };
export const yamatoTrackingBaseUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";
export const ocsTrackingBaseUrl = "https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do";
export const japanPostTrackingBaseUrl =
  "https://trackings.post.japanpost.jp/services/srv/search/direct";
export const japanPostTrackingProxyPath = "/japanpost-tracking/services/srv/search/direct";
export const temuUploadWarehouseName = "东京仓";

export const temuUploadColumns = [
  "订单号",
  "子订单号",
  "商品件数",
  "跟踪单号",
  "物流承运商",
  "发货仓库名称",
] as const;

export const visibleColumns = [
  { key: "order_no", label: "订单号", className: "order-no-col" },
  { key: "stage", label: "流程状态", className: "order-stage-col" },
  { key: "ship_deadline", label: "发货时效", className: "order-time-col", sortable: true },
  { key: "delivery_deadline", label: "签收时效", className: "order-time-col", sortable: true },
  { key: "warehouse", label: "仓库", className: "order-warehouse-col" },
  { key: "logistics", label: "发货方式", className: "order-logistics-col" },
  { key: "quantity", label: "数量", className: "order-qty-col text-right-num" },
  { key: "product", label: "商品信息", className: "order-product-col", sortable: true },
  { key: "sales_spec", label: "销售规格", className: "order-attr-col" },
  { key: "logistics_tracking_no", label: "物流单号", className: "order-tracking-col", shippedOnly: true },
  { key: "logistics_status", label: "物流状态", className: "order-tracking-status-col", sortable: true, shippedOnly: true },
  { key: "recipient", label: "收件人", className: "order-recipient-col" },
  { key: "phone", label: "电话", className: "order-phone-col" },
  { key: "address", label: "地址", className: "order-address-col" },
  { key: "postal_code", label: "邮编", className: "order-postal-col" },
  { key: "actual_ship_time", label: "实际发货时间", className: "order-time-col order-actual-ship-time-col" },
] satisfies Array<{
  key: string;
  label: string;
  className?: string;
  sortable?: boolean;
  shippedOnly?: boolean;
}>;

export const orderColumnWidths: Record<string, string> = {
  order_no: "14.5rem",
  stage: "6rem",
  ship_deadline: "7.5rem",
  delivery_deadline: "7.5rem",
  warehouse: "5.5rem",
  logistics: "8rem",
  quantity: "4rem",
  product: "16rem",
  sales_spec: "10rem",
  logistics_tracking_no: "9.5rem",
  logistics_status: "8.5rem",
  recipient: "7rem",
  phone: "9rem",
  address: "18rem",
  postal_code: "6rem",
  actual_ship_time: "11rem",
};

export function cleanCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text === "--" ? "" : text;
}

export function normalizeColumnName(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\s_\-＿－]+/g, "")
    .toLowerCase();
}

export function hasAnyColumn(row: Record<string, unknown>, columns: readonly string[]) {
  const normalizedColumns = new Set(columns.map(normalizeColumnName));
  return (
    columns.some((column) => Object.prototype.hasOwnProperty.call(row, column)) ||
    Object.keys(row).some((column) => normalizedColumns.has(normalizeColumnName(column)))
  );
}

export function readAnyCell(row: Record<string, unknown>, columns: readonly string[]) {
  const normalizedColumns = new Set(columns.map(normalizeColumnName));

  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      const value = cleanCell(row[column]);
      if (value) return value;
    }
  }

  for (const [column, rawValue] of Object.entries(row)) {
    if (normalizedColumns.has(normalizeColumnName(column))) {
      const value = cleanCell(rawValue);
      if (value) return value;
    }
  }

  return "";
}

export function readImportCell(row: Record<string, unknown>, field: TemuOrderImportField) {
  return readAnyCell(row, importColumnAliases[field]);
}

export function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function normalizeLooseText(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function normalizeDigits(value: string) {
  return value.replace(/\D/g, "");
}

export function normalizeJapanesePhone(value: string) {
  const digits = normalizeDigits(value);
  if (digits.startsWith("81")) return digits.slice(2);
  return digits;
}

export function normalizePostalCode(value: string) {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

export function includesLooseText(container: string, value: string) {
  const normalizedContainer = normalizeLooseText(container);
  const normalizedValue = normalizeLooseText(value);
  return Boolean(normalizedValue && normalizedContainer.includes(normalizedValue));
}

export const styleAttributeNameTranslations: Record<string, string> = {
  color: "Color",
  colour: "Color",
  颜色: "Color",
  色: "Color",
  カラー: "Color",
};

export const styleColorTranslations: Record<string, string> = {
  black: "Black",
  blue: "Blue",
  green: "Green",
  white: "White",
  red: "Red",
  pink: "Pink",
  yellow: "Yellow",
  gray: "Gray",
  grey: "Gray",
  purple: "Purple",
  brown: "Brown",
  orange: "Orange",
  beige: "Beige",
  silver: "Silver",
  gold: "Gold",
  transparent: "Transparent",
  黑色: "Black",
  蓝色: "Blue",
  藍色: "Blue",
  绿色: "Green",
  綠色: "Green",
  白色: "White",
  红色: "Red",
  紅色: "Red",
  粉色: "Pink",
  黄色: "Yellow",
  黃色: "Yellow",
  灰色: "Gray",
  紫色: "Purple",
  棕色: "Brown",
  褐色: "Brown",
  橙色: "Orange",
  米色: "Beige",
  银色: "Silver",
  銀色: "Silver",
  金色: "Gold",
  透明: "Transparent",
  ブラック: "Black",
  ブルー: "Blue",
  グリーン: "Green",
  ホワイト: "White",
  レッド: "Red",
  ピンク: "Pink",
  イエロー: "Yellow",
  グレー: "Gray",
  パープル: "Purple",
  ブラウン: "Brown",
  オレンジ: "Orange",
  ベージュ: "Beige",
  シルバー: "Silver",
  ゴールド: "Gold",
};

export function toTitleCaseEnglish(value: string) {
  return value
    .split(/\s+/)
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : ""))
    .join(" ");
}

export function translateStyleAttributeName(value: string) {
  const text = value.trim();
  return styleAttributeNameTranslations[text.toLowerCase()] ?? styleAttributeNameTranslations[text] ?? text;
}

export function translateStyleColorValue(value: string) {
  const text = value.trim();
  if (!text) return "";
  return styleColorTranslations[text.toLowerCase()] ?? styleColorTranslations[text] ?? toTitleCaseEnglish(text);
}

export function formatStyleColorForDeclaration(value: string) {
  return value
    .split(/\s*(?:\/|,|，|;|；|、|\n)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.includes("：") ? "：" : part.includes(":") ? ":" : "";
      if (!separator) return translateStyleColorValue(part);

      const [rawName, ...rawValues] = part.split(separator);
      const translatedName = translateStyleAttributeName(rawName);
      const translatedValue = translateStyleColorValue(rawValues.join(separator));
      return translatedValue ? `${translatedName}: ${translatedValue}` : translatedName;
    })
    .join(" / ");
}

export function normalizeLogisticsMethod(value: string) {
  return normalizeLogisticsMethodName(value);
}

export function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

export function buildSkuOrderLookup(products: Product[], skus: ProductSku[]) {
  const productsById = Object.fromEntries(products.map((product) => [product.id, product]));
  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
    if (!sku.product_id) return groups;
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});
  const salesSpecByCode = new Map<string, string>();
  const skuByCode = new Map<string, ProductSku>();
  const skuBySalesSpec = new Map<string, ProductSku>();

  Object.entries(skusByProductId).forEach(([productId, productSkus]) => {
    const product = productsById[productId];
    productSkus.forEach((sku, index) => {
      const salesSpec = formatSkuSalesSpec(sku);
      const salesSpecKey = normalizeSalesSpec(salesSpec);
      if (salesSpecKey && !skuBySalesSpec.has(salesSpecKey)) {
        skuBySalesSpec.set(salesSpecKey, sku);
      }
      const skuCodes = [
        sku.sku_code,
        product && isLegacyDefaultSkuCode(sku.sku_code)
          ? buildDefaultSkuCode(product.product_code, index)
          : "",
      ];

      skuCodes.forEach((skuCode) => {
        const key = normalizeSkuCode(skuCode);
        if (key) {
          salesSpecByCode.set(key, salesSpec);
          skuByCode.set(key, sku);
        }
      });
    });
  });

  return { salesSpecByCode, skuByCode, skuBySalesSpec };
}

export type ProductsById = Map<string, Product>;
export type OrdersById = Map<string, TemuOrderRecord>;
export type SkuOrderLookup = ReturnType<typeof buildSkuOrderLookup>;
export type OrderDeclaration = {
  sku: ProductSku;
  product: Product;
};
export type OrderDeclarationGroup = {
  declaration: OrderDeclaration;
  quantity: number;
};
export type OrderFulfillmentMatch = {
  warehouse: Warehouse;
  logisticsMethod: string;
  sku: ProductSku;
  quantity: number;
};
export type OrderFulfillmentMatchResult =
  | { status: "matched"; match: OrderFulfillmentMatch }
  | { status: "blocked"; reason: string }
  | { status: "unmatched" };

export const fukuokaWarehouseAliases = ["福冈", "福岡", "fukuoka", "fugang"];
export const suzhouWarehouseAliases = ["苏州", "suzhou"];
export const fukuokaLastmileMethod = "福冈Japan Post";
export const ocsThreeCmMethod = "OCS Yamato";
export const ocsSmallParcelMethod = "OCS 小包";

export function getOrderFulfillmentQuantity(order: TemuOrderRecord) {
  return Math.max(1, Math.trunc(order.fulfillment_quantity || 0));
}

export function isWarehouseMatchedByAlias(warehouse: Warehouse, aliases: string[]) {
  const warehouseName = warehouse.name.trim().toLowerCase();
  return aliases.some((alias) => warehouseName.includes(alias.toLowerCase()));
}

export function getWarehousesByAliases(warehouses: Warehouse[], aliases: string[]) {
  return warehouses.filter((warehouse) => isWarehouseMatchedByAlias(warehouse, aliases));
}

export function formatAutoMatchBlockedReasons(reasons: string[]) {
  const uniqueReasons = Array.from(new Set(reasons));
  const visibleReasons = uniqueReasons.slice(0, 3).join("；");
  return uniqueReasons.length > 3
    ? `${visibleReasons}；另有 ${uniqueReasons.length - 3} 条订单未匹配。`
    : visibleReasons;
}

export function getOrderExactSkuGroupKey(order: TemuOrderRecord) {
  return [
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

export function getOrderDisplayGroupKey(order: TemuOrderRecord) {
  return getDisplayOrderNoKey(order.order_no) || order.id;
}

export function mergeOrderWithDraft(
  order: TemuOrderRecord,
  drafts: Record<string, OrderDraft>,
) {
  return {
    ...order,
    ...(drafts[order.id] ?? toDraft(order)),
  };
}

export function buildOrderDisplayRowsWithDrafts(
  targetOrders: TemuOrderRecord[],
  drafts: Record<string, OrderDraft>,
) {
  const groups = new Map<string, TemuOrderRecord[]>();
  targetOrders.forEach((order) => {
    const key = getOrderDisplayGroupKey(order);
    groups.set(key, [...(groups.get(key) ?? []), order]);
  });

  const rows: OrderDisplayRow[] = [];
  groups.forEach((groupOrders) => {
    const mergedGroupOrders = groupOrders.map((order) => mergeOrderWithDraft(order, drafts));
    const sortedGroupOrders = [...mergedGroupOrders].sort((left, right) => {
      const bySku = getOrderExactSkuGroupKey(left).localeCompare(
        getOrderExactSkuGroupKey(right),
      );
      return bySku || left.sub_order_no.localeCompare(right.sub_order_no);
    });
    const primaryOrder = sortedGroupOrders[0];
    if (!primaryOrder) return;

    rows.push({
      id: sortedGroupOrders.map((order) => order.id).sort().join("|"),
      primaryOrder,
      orders: sortedGroupOrders,
      quantity: sortedGroupOrders.reduce(
        (total, order) => total + getOrderFulfillmentQuantity(order),
        0,
      ),
    });
  });

  return rows;
}

export function getOrderSkuFromLookup(
  order: TemuOrderRecord,
  skuOrderLookup: SkuOrderLookup,
) {
  const skuCode = normalizeSkuCode(order.sku_code);
  if (skuCode) return skuOrderLookup.skuByCode.get(skuCode) ?? null;
  return skuOrderLookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ?? null;
}

export function getOrderDeclarationFromLookups(
  order: TemuOrderRecord,
  productsById: ProductsById,
  skuOrderLookup: SkuOrderLookup,
): OrderDeclaration | null {
  const sku = getOrderSkuFromLookup(order, skuOrderLookup);
  const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
  return sku && product ? { sku, product } : null;
}

export function getOrderDisplayRowDeclarationGroups(
  rowOrders: TemuOrderRecord[],
  productsById: ProductsById,
  skuOrderLookup: SkuOrderLookup,
): OrderDeclarationGroup[] {
  const groups = new Map<string, OrderDeclarationGroup>();

  rowOrders.forEach((order) => {
    const declaration = getOrderDeclarationFromLookups(order, productsById, skuOrderLookup);
    if (!declaration) return;

    const key = declaration.sku.id || getOrderExactSkuGroupKey(order);
    const current = groups.get(key);
    groups.set(key, {
      declaration: current?.declaration ?? declaration,
      quantity: (current?.quantity ?? 0) + getOrderFulfillmentQuantity(order),
    });
  });

  return Array.from(groups.values());
}

export function getOrderDisplayRowSkuSummary(
  rowOrders: TemuOrderRecord[],
  rowQuantity: number,
  declarationGroups: OrderDeclarationGroup[],
) {
  const skuCount =
    declarationGroups.length ||
    new Set(
      rowOrders
        .map((order) => getOrderExactSkuGroupKey(order))
        .filter(Boolean),
    ).size ||
    rowOrders.length;

  return `${skuCount} 个 SKU 共${rowQuantity} 件`;
}
