import type { User } from "@supabase/supabase-js";
import {
  FileSpreadsheet,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { OrderBulkActions } from "../components/orders/OrderBulkActions";
import { OrderDetailPanel } from "../components/orders/OrderDetailPanel";
import { OrderFilters } from "../components/orders/OrderFilters";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Badge, PageHeader } from "../components/ui";
import { StandardTable, type StandardTableColumn } from "../components/ui/StandardTable";
import {
  createEmptyDraft,
  getOrdersErrorMessage,
  toDraft,
  type OrderDraft,
  useOrders,
} from "../hooks/useOrders";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import {
  addObjectSheet,
  createWorkbook,
  downloadWorkbook,
  readTabularFileObjects,
} from "../lib/excel";
import {
  releaseWarehouseSkuStockForOrder,
  reserveWarehouseSkuStockForOrder,
} from "../lib/inventory";
import {
  getWarehouseLogisticsMethodNames,
  isLogisticsMethodAllowedForWarehouse as isConfiguredLogisticsMethodAllowedForWarehouse,
  normalizeLogisticsMethodName,
} from "../lib/logistics-methods";
import { getWarehouseLogisticsConfigStatus } from "../lib/warehouse-logistics";
import {
  deleteTemuOrder,
  importTemuOrders,
  updateTemuOrder,
  createReshipmentOrder,
  type TemuOrderImportRow,
} from "../lib/orders";
import type {
  Product,
  ProductSku,
  LogisticsMethod,
  TemuOrderRecord,
  Warehouse,
  WarehouseLogisticsMethod,
  WarehouseSku,
} from "../types";
import {
  calculatePurchaseShippingRmb,
  getThreeCmDimensionIssue,
} from "../utils/shipping-costs";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { confirmAction, confirmDelete, confirmSave } from "../utils/confirmations";
import {
  getOrderStage,
  getOrderStageDefinition as getStageDefinition,
  isShippingTrackingStage,
  orderStageDefinitions as stageDefinitions,
  shouldReserveOrderInventory,
  type OrderStage,
  uploadedTemuOrderStatus,
} from "../domain/order-workflow";

type OrdersPageProps = {
  user: User;
};

type OrderSortKey =
  | "ship_deadline"
  | "delivery_deadline"
  | "product"
  | "logistics_status";
type OrderSortDirection = "asc" | "desc";
type OrderSort = {
  key: OrderSortKey;
  direction: OrderSortDirection;
};

type TrackingImportRecord = {
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

type TrackingCarrier = "yamato" | "japan_post";
type TrackingStatusResult = {
  status: string;
  actualSignedTime?: string;
};

type OrderStockDeduction = {
  orderId: string;
  stock: WarehouseSku;
  quantity: number;
  warehouseName: string;
  orderNo: string;
  orderLineLabel: string;
};

type OrderDisplayRow = {
  id: string;
  primaryOrder: TemuOrderRecord;
  orders: TemuOrderRecord[];
  quantity: number;
};

type TemuOrderImportField = keyof TemuOrderImportRow;

const importColumnAliases = {
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

const optionalImportFields = new Set<TemuOrderImportField>([
  "sub_order_no",
  "sku_code",
  "fulfillment_quantity",
  "product_attributes",
]);

const importFieldLabels = {
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

const trackingNoImportColumnAliases = [
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
const trackingOrderNoImportColumnAliases = ["订单号", "主订单号", "REF_NO", "REF NO", "Order ID"] as const;
const trackingSubOrderNoImportColumnAliases = [
  "子订单号",
  "子订单编号",
  "Sub Order ID",
  "Sub-order ID",
] as const;

const rmbPerUsdForDeclaration = 7;
const defaultOrderSort: OrderSort = { key: "ship_deadline", direction: "asc" };
const yamatoTrackingBaseUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";
const ocsTrackingBaseUrl = "https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do";
const japanPostTrackingBaseUrl =
  "https://trackings.post.japanpost.jp/services/srv/search/direct";
const japanPostTrackingProxyPath = "/japanpost-tracking/services/srv/search/direct";
const temuUploadWarehouseName = "东京仓";
const urgentUnuploadedDeadlineMs = 12 * 60 * 60 * 1000;

const temuUploadColumns = [
  "订单号",
  "子订单号",
  "商品件数",
  "跟踪单号",
  "物流承运商",
  "发货仓库名称",
] as const;

const visibleColumns = [
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

const orderColumnWidths: Record<string, string> = {
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

function cleanCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text === "--" ? "" : text;
}

function normalizeColumnName(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\s_\-＿－]+/g, "")
    .toLowerCase();
}

function hasAnyColumn(row: Record<string, unknown>, columns: readonly string[]) {
  const normalizedColumns = new Set(columns.map(normalizeColumnName));
  return (
    columns.some((column) => Object.prototype.hasOwnProperty.call(row, column)) ||
    Object.keys(row).some((column) => normalizedColumns.has(normalizeColumnName(column)))
  );
}

function readAnyCell(row: Record<string, unknown>, columns: readonly string[]) {
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

function readImportCell(row: Record<string, unknown>, field: TemuOrderImportField) {
  return readAnyCell(row, importColumnAliases[field]);
}

function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function normalizeLooseText(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function normalizeDigits(value: string) {
  return value.replace(/\D/g, "");
}

function normalizeJapanesePhone(value: string) {
  const digits = normalizeDigits(value);
  if (digits.startsWith("81")) return digits.slice(2);
  return digits;
}

function normalizePostalCode(value: string) {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function includesLooseText(container: string, value: string) {
  const normalizedContainer = normalizeLooseText(container);
  const normalizedValue = normalizeLooseText(value);
  return Boolean(normalizedValue && normalizedContainer.includes(normalizedValue));
}

const styleAttributeNameTranslations: Record<string, string> = {
  color: "Color",
  colour: "Color",
  颜色: "Color",
  色: "Color",
  カラー: "Color",
};

const styleColorTranslations: Record<string, string> = {
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

function toTitleCaseEnglish(value: string) {
  return value
    .split(/\s+/)
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : ""))
    .join(" ");
}

function translateStyleAttributeName(value: string) {
  const text = value.trim();
  return styleAttributeNameTranslations[text.toLowerCase()] ?? styleAttributeNameTranslations[text] ?? text;
}

function translateStyleColorValue(value: string) {
  const text = value.trim();
  if (!text) return "";
  return styleColorTranslations[text.toLowerCase()] ?? styleColorTranslations[text] ?? toTitleCaseEnglish(text);
}

function formatStyleColorForDeclaration(value: string) {
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

function normalizeLogisticsMethod(value: string) {
  return normalizeLogisticsMethodName(value);
}

function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);

  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

function buildSkuOrderLookup(products: Product[], skus: ProductSku[]) {
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

type ProductsById = Map<string, Product>;
type OrdersById = Map<string, TemuOrderRecord>;
type SkuOrderLookup = ReturnType<typeof buildSkuOrderLookup>;
type OrderDeclaration = {
  sku: ProductSku;
  product: Product;
};
type OrderDeclarationGroup = {
  declaration: OrderDeclaration;
  quantity: number;
};
type OrderFulfillmentMatch = {
  warehouse: Warehouse;
  logisticsMethod: string;
  sku: ProductSku;
  quantity: number;
};
type OrderFulfillmentMatchResult =
  | { status: "matched"; match: OrderFulfillmentMatch }
  | { status: "blocked"; reason: string }
  | { status: "unmatched" };

const fukuokaWarehouseAliases = ["福冈", "福岡", "fukuoka", "fugang"];
const suzhouWarehouseAliases = ["苏州", "suzhou"];
const fukuokaLastmileMethod = "福冈Japan Post";
const ocsThreeCmMethod = "OCS Yamato";
const ocsSmallParcelMethod = "OCS 小包";

function getOrderFulfillmentQuantity(order: TemuOrderRecord) {
  return Math.max(1, Math.trunc(order.fulfillment_quantity || 0));
}

function isWarehouseMatchedByAlias(warehouse: Warehouse, aliases: string[]) {
  const warehouseName = warehouse.name.trim().toLowerCase();
  return aliases.some((alias) => warehouseName.includes(alias.toLowerCase()));
}

function getWarehousesByAliases(warehouses: Warehouse[], aliases: string[]) {
  return warehouses.filter((warehouse) => isWarehouseMatchedByAlias(warehouse, aliases));
}

function formatAutoMatchBlockedReasons(reasons: string[]) {
  const uniqueReasons = Array.from(new Set(reasons));
  const visibleReasons = uniqueReasons.slice(0, 3).join("；");
  return uniqueReasons.length > 3
    ? `${visibleReasons}；另有 ${uniqueReasons.length - 3} 条订单未匹配。`
    : visibleReasons;
}

function getOrderExactSkuGroupKey(order: TemuOrderRecord) {
  return [
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function getOrderDisplayGroupKey(order: TemuOrderRecord) {
  return getOrderNoKey(order.order_no) || order.id;
}

function mergeOrderWithDraft(
  order: TemuOrderRecord,
  drafts: Record<string, OrderDraft>,
) {
  return {
    ...order,
    ...(drafts[order.id] ?? toDraft(order)),
  };
}

function buildOrderDisplayRowsWithDrafts(
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

function getOrderSkuFromLookup(
  order: TemuOrderRecord,
  skuOrderLookup: SkuOrderLookup,
) {
  const skuCode = normalizeSkuCode(order.sku_code);
  if (skuCode) return skuOrderLookup.skuByCode.get(skuCode) ?? null;
  return skuOrderLookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ?? null;
}

function getOrderDeclarationFromLookups(
  order: TemuOrderRecord,
  productsById: ProductsById,
  skuOrderLookup: SkuOrderLookup,
): OrderDeclaration | null {
  const sku = getOrderSkuFromLookup(order, skuOrderLookup);
  const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
  return sku && product ? { sku, product } : null;
}

function getOrderDisplayRowDeclarationGroups(
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

function getOrderDisplayRowSkuSummary(
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

function SkuImageThumb({ product, sku }: { product: Product; sku: ProductSku }) {
  const imageUrl = sku.temu_image_url.trim();
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [imageUrl]);

  if (!imageUrl || hasError) {
    return <div className="h-12 w-12 shrink-0 rounded-md border border-slate-200 bg-slate-50" role="img" aria-label="暂无图片" title="暂无图片" />;
  }

  return (
    <img
      src={imageUrl}
      alt={`${product.product_name_cn} ${formatSkuSalesSpec(sku)}`.trim()}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className="h-12 w-12 shrink-0 rounded-md border border-slate-200 object-cover"
    />
  );
}

function parseFulfillmentQuantity(value: string) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 1;
}

function getOrderNoKey(value: string) {
  return value.trim().toLowerCase();
}

function getOrderLineKey(
  order: Pick<
    TemuOrderRecord,
    "order_no" | "sub_order_no" | "sku_code" | "product_attributes"
  >,
) {
  const orderNo = getOrderNoKey(order.order_no);
  if (!orderNo) return "";

  const subOrderNo = order.sub_order_no.trim().toLowerCase();
  if (subOrderNo) return `${orderNo}\u0000${subOrderNo}`;

  return [
    orderNo,
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function getOrderLineSkuKey(
  order: Pick<TemuOrderRecord, "order_no" | "sku_code" | "product_attributes">,
) {
  const orderNo = getOrderNoKey(order.order_no);
  if (!orderNo) return "";

  return [
    orderNo,
    normalizeSkuCode(order.sku_code),
    normalizeSalesSpec(order.product_attributes),
  ].join("\u0000");
}

function getOrderLineLabel(order: Pick<TemuOrderRecord, "order_no" | "sub_order_no" | "id">) {
  const subOrderNo = order.sub_order_no.trim();
  return subOrderNo ? `${order.order_no} / ${subOrderNo}` : `${order.order_no} / ${order.id}`;
}

function dedupeImportRowsByOrderLine(rows: TemuOrderImportRow[]) {
  const uniqueRows = new Map<string, TemuOrderImportRow>();

  rows.forEach((row) => {
    const key = getOrderLineKey(row);
    if (key && !uniqueRows.has(key)) {
      uniqueRows.set(key, row);
    }
  });

  return Array.from(uniqueRows.values());
}

function parseTrackingImportRecord(row: Record<string, unknown>, index: number): TrackingImportRecord | null {
  const trackingNo = readAnyCell(row, trackingNoImportColumnAliases);
  if (!trackingNo) return null;

  return {
    rowIndex: index + 2,
    trackingNo,
    orderNo: readAnyCell(row, trackingOrderNoImportColumnAliases),
    subOrderNo: readAnyCell(row, trackingSubOrderNoImportColumnAliases),
    remark: readAnyCell(row, ["REMARK", "备注", "客户备注"]),
    refNo: readAnyCell(row, ["REF_NO", "REF NO", "订单号", "主订单号"]),
    phone: readAnyCell(row, ["CONTACT_TEL", "CONTACT TEL", "收件电话", "电话"]),
    postalCode: readAnyCell(row, ["POSTCODE", "邮编", "收件邮编"]),
    recipientName: readAnyCell(row, ["CONSIGNEE_NAME", "CONSIGNEE NAME", "收件人"]),
    address: readAnyCell(row, ["DELIVERY_ADDR_JP", "DELIVERY ADDR JP", "收件人地址", "地址"]),
    carrier: readAnyCell(row, ["物流承运商", "承运商", "Carrier"]),
    warehouseName: readAnyCell(row, ["发货仓库名称", "仓库", "Warehouse"]),
    allText: Object.values(row).map((value) => cleanCell(value)).filter(Boolean).join(" "),
  };
}

function getFullAddress(
  order: Pick<
    TemuOrderRecord,
    "province" | "city" | "district" | "address_line1" | "address_line2"
  >,
) {
  return [
    order.province,
    order.city,
    order.district,
    order.address_line1,
    order.address_line2,
  ].filter(Boolean).join(" ");
}

function formatRecipientPhone(phone: string) {
  return phone.trim().replace(/^\+81[\s-]*/, "");
}

function formatRecipientName(name: string) {
  return name.replace(/[（(][^（）()]*[）)]/g, "").trim();
}

const recipientImportFields = [
  "recipient_name",
  "recipient_phone",
  "email",
  "province",
  "city",
  "district",
  "address_line1",
  "address_line2",
  "postal_code",
] as const satisfies readonly TemuOrderImportField[];

type RecipientInfoRecord = Pick<
  TemuOrderImportRow,
  (typeof recipientImportFields)[number]
>;

function hasAnyRecipientInfo(order: RecipientInfoRecord) {
  return recipientImportFields.some((field) => String(order[field] ?? "").trim());
}

function hasCompleteRecipientInfo(
  order: Pick<
    TemuOrderImportRow,
    "recipient_name" | "recipient_phone" | "province" | "city" | "district" | "address_line1" | "address_line2" | "postal_code"
  >,
) {
  return Boolean(
    formatRecipientName(order.recipient_name) &&
      formatRecipientPhone(order.recipient_phone) &&
      getFullAddress(order) &&
      order.postal_code.trim(),
  );
}

function isDeliveredTrackingStatus(status: string) {
  return ["配達完了", "お届け済み", "配達済み", "Delivered"].some((keyword) =>
    status.includes(keyword),
  );
}

function getTrackingStatusLabel(status: string) {
  return (
    status.replace(/▶/g, " ").replace(/\s+/g, " ").trim().split("/")[0]?.trim() ||
    ""
  );
}

const trackingStatusSortRanks = [
  { keyword: "待查询", rank: 0 },
  { keyword: "暂无轨迹", rank: 1 },
  { keyword: "伝票番号未登録", rank: 1 },
  { keyword: "查询失败", rank: 2 },
  { keyword: "引受", rank: 10 },
  { keyword: "発送", rank: 20 },
  { keyword: "通過", rank: 30 },
  { keyword: "到着", rank: 40 },
  { keyword: "保管", rank: 45 },
  { keyword: "ご不在", rank: 50 },
  { keyword: "持ち出し中", rank: 60 },
  { keyword: "配達中", rank: 60 },
  { keyword: "お届け済み", rank: 70 },
  { keyword: "配達完了", rank: 70 },
  { keyword: "配達済み", rank: 70 },
  { keyword: "Delivered", rank: 70 },
] as const;

const japanPostTrackingStatusKeywords = [
  "お届け済み",
  "配達完了",
  "配達済み",
  "配達中",
  "持ち出し中",
  "ご不在",
  "保管",
  "到着",
  "通過",
  "発送",
  "引受",
  "差出人に返送",
] as const;

function getComparableTrackingStatus(status: string) {
  return getTrackingStatusLabel(status) || "待查询";
}

function getTrackingStatusSortRank(status: string) {
  const label = getComparableTrackingStatus(status);
  return trackingStatusSortRanks.find((item) => label.includes(item.keyword))?.rank ?? 80;
}

function compareTrackingStatus(left: string, right: string) {
  const leftRank = getTrackingStatusSortRank(left);
  const rightRank = getTrackingStatusSortRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;

  return getComparableTrackingStatus(left).localeCompare(getComparableTrackingStatus(right));
}

function isJapanPostTrackingStatus(value: string) {
  return japanPostTrackingStatusKeywords.some((status) => value.includes(status));
}

function hasFukuokaText(value: string) {
  return /福[冈岡]|fukuoka/i.test(value);
}

function hasSuzhouText(value: string) {
  return /苏州|蘇州|suzhou/i.test(value);
}

function hasJapanPostText(value: string) {
  return /japan\s*post|japanpost|日本[邮郵]便|邮便|郵便/i.test(value);
}

function hasOcsYamatoText(value: string) {
  return /ocs\s*yamato|yamato|ヤマト/i.test(value);
}

function getOrderTrackingCarrier(order: Pick<TemuOrderRecord, "warehouse_name" | "logistics_method">): TrackingCarrier {
  if (
    hasJapanPostText(order.logistics_method) ||
    hasJapanPostText(order.warehouse_name) ||
    hasFukuokaText(order.logistics_method) ||
    hasFukuokaText(order.warehouse_name)
  ) {
    return "japan_post";
  }

  return "yamato";
}

function getTemuUploadCarrier(order: Pick<TemuOrderRecord, "warehouse_name" | "logistics_method">) {
  return getOrderTrackingCarrier(order) === "japan_post" ? "Japan Post" : "Yamato";
}

function getJapanPostTrackingUrl(trackingNo: string) {
  const normalizedTrackingNo = trackingNo.trim();
  if (!normalizedTrackingNo) return "";

  const params = new URLSearchParams({
    reqCodeNo1: normalizedTrackingNo,
    searchKind: "S002",
    locale: "ja",
  });
  return `${japanPostTrackingBaseUrl}?${params.toString()}`;
}

function getOcsTrackingUrl(trackingNo: string) {
  const normalizedTrackingNo = trackingNo.trim();
  if (!normalizedTrackingNo) return "";

  const params = new URLSearchParams({ cwbno: normalizedTrackingNo });
  return `${ocsTrackingBaseUrl}?${params.toString()}`;
}

function getTrackingUrl(order: TemuOrderRecord) {
  const trackingNo = order.logistics_tracking_no.trim();
  if (!trackingNo) return "";

  if (getOrderTrackingCarrier(order) === "japan_post") {
    return "";
  }

  if (
    hasSuzhouText(order.warehouse_name) &&
    hasOcsYamatoText(order.logistics_method)
  ) {
    return getOcsTrackingUrl(trackingNo);
  }

  return "";
}

function getTrackingStatusUrl(order: TemuOrderRecord) {
  const trackingNo = order.logistics_tracking_no.trim();
  if (!trackingNo) return "";

  if (getOrderTrackingCarrier(order) === "japan_post") {
    return getJapanPostTrackingUrl(trackingNo);
  }

  return yamatoTrackingBaseUrl;
}

function openTrackingStatus(event: MouseEvent<HTMLAnchorElement>, order: TemuOrderRecord) {
  const trackingNo = order.logistics_tracking_no.trim();
  if (!trackingNo) return;
  if (getOrderTrackingCarrier(order) === "japan_post") return;

  event.preventDefault();
  const form = document.createElement("form");
  form.method = "post";
  form.action = yamatoTrackingBaseUrl;
  form.target = "_blank";

  [
    ["number01", trackingNo],
    ["category", "0"],
  ].forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function formatLocalDateTime(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatFileTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

function parseOrderDateTime(value: string) {
  const text = value.trim();
  if (!text) return null;

  const matched = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/,
  );
  if (matched) {
    const [, year, month, day, hour, minute, second = "0"] = matched;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(text.replace(" ", "T"));
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  return `${seconds}秒`;
}

function getCountdownBadge(value: string, now: Date) {
  const targetDate = parseOrderDateTime(value);
  if (!value.trim()) return { label: "--", tone: "neutral" as const };
  if (!targetDate) return { label: value, tone: "neutral" as const };

  const diff = targetDate.getTime() - now.getTime();
  return diff >= 0
    ? { label: `剩余 ${formatDuration(diff)}`, tone: "warning" as const }
    : { label: `超时 ${formatDuration(Math.abs(diff))}`, tone: "danger" as const };
}

function getShipDeadlineBadge(order: TemuOrderRecord, now: Date) {
  const actualShipTime = order.actual_ship_time.trim();
  if (!actualShipTime) return getCountdownBadge(order.latest_ship_time, now);

  const deadlineDate = parseOrderDateTime(order.latest_ship_time);
  const actualShipDate = parseOrderDateTime(actualShipTime);
  if (!deadlineDate || !actualShipDate) {
    return { label: actualShipTime, tone: "neutral" as const };
  }

  return actualShipDate.getTime() <= deadlineDate.getTime()
    ? { label: "期限内发货", tone: "success" as const }
    : { label: "期限外发货", tone: "danger" as const };
}

function getDeliveryDeadlineBadge(order: TemuOrderRecord, now: Date) {
  const actualSignedTime = order.actual_signed_time.trim();
  if (!actualSignedTime) return getCountdownBadge(order.estimated_delivery_time, now);

  const deadlineDate = parseOrderDateTime(order.estimated_delivery_time);
  const actualSignedDate = parseOrderDateTime(actualSignedTime);
  if (!deadlineDate || !actualSignedDate) {
    return { label: actualSignedTime, tone: "neutral" as const };
  }

  return actualSignedDate.getTime() <= deadlineDate.getTime()
    ? { label: "期限内签收", tone: "success" as const }
    : { label: "期限外签收", tone: "danger" as const };
}

function isUrgentUnuploadedOrder(order: TemuOrderRecord, now: Date) {
  const stage = getOrderStage(order);
  if (stage === "uploaded_temu" || stage === "completed") return false;

  const deadlineDate = parseOrderDateTime(order.latest_ship_time);
  if (!deadlineDate) return false;

  const diff = deadlineDate.getTime() - now.getTime();
  return diff >= 0 && diff <= urgentUnuploadedDeadlineMs;
}

function getOrderDeadlineTimestamp(value: string) {
  return parseOrderDateTime(value)?.getTime() ?? null;
}

function compareOptionalNumber(left: number | null, right: number | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function normalizeRmbAmount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Number(value.toFixed(2)));
}

type OrderTableRowProps = {
  activeStage: OrderStage;
  canEdit: boolean;
  currentTime: Date;
  logisticsMethods: LogisticsMethod[];
  onHandleWarehouseChangeForOrders: (orderIds: string[], warehouseId: string) => void;
  onSaveActualShipTimeForOrders: (targetOrders: TemuOrderRecord[]) => Promise<void>;
  onToggleOrderRowSelection: (rowOrderIds: string[], checked: boolean) => void;
  onUpdateDraftForOrders: <K extends keyof OrderDraft>(
    orderIds: string[],
    field: K,
    value: OrderDraft[K],
  ) => void;
  ordersById: OrdersById;
  primaryDraft: OrderDraft | undefined;
  productsById: ProductsById;
  rowId: string;
  rowOrderIdsKey: string;
  selectedOrderIdSet: Set<string>;
  skuOrderLookup: SkuOrderLookup;
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
  warehouses: Warehouse[];
};

const OrderTableRow = memo(function OrderTableRow({
  activeStage,
  canEdit,
  currentTime,
  logisticsMethods,
  onHandleWarehouseChangeForOrders,
  onSaveActualShipTimeForOrders,
  onToggleOrderRowSelection,
  onUpdateDraftForOrders,
  ordersById,
  primaryDraft,
  productsById,
  rowId,
  rowOrderIdsKey,
  selectedOrderIdSet,
  skuOrderLookup,
  warehouseLogisticsMethods,
  warehouses,
}: OrderTableRowProps) {
  const [attrCellExpanded, setAttrCellExpanded] = useState(false);

  const rowOrderIds = useMemo(
    () => rowOrderIdsKey.split("|").filter(Boolean),
    [rowOrderIdsKey],
  );

  const rowOrders = useMemo(
    () =>
      rowOrderIds
        .map((orderId) => ordersById.get(orderId))
        .filter((order): order is TemuOrderRecord => Boolean(order)),
    [ordersById, rowOrderIds],
  );

  const primaryOrder = rowOrders[0] ?? null;
  const rowQuantity = useMemo(
    () =>
      rowOrders.reduce(
        (total, order) => total + getOrderFulfillmentQuantity(order),
        0,
      ),
    [rowOrders],
  );

  const draft = useMemo(
    () => (primaryOrder ? primaryDraft ?? toDraft(primaryOrder) : createEmptyDraft()),
    [primaryDraft, primaryOrder],
  );

  const mergedOrder = useMemo(
    () => (primaryOrder ? { ...primaryOrder, ...draft } : null),
    [draft, primaryOrder],
  );

  const persistedStage = useMemo(
    () => (mergedOrder ? getOrderStage(mergedOrder) : "pending_assignment"),
    [mergedOrder],
  );
  const stage = useMemo(() => getStageDefinition(persistedStage), [persistedStage]);
  const shipCountdown = useMemo(
    () =>
      mergedOrder
        ? getShipDeadlineBadge(mergedOrder, currentTime)
        : { label: "--", tone: "neutral" as const },
    [currentTime, mergedOrder],
  );
  const deliveryCountdown = useMemo(
    () =>
      mergedOrder
        ? getDeliveryDeadlineBadge(mergedOrder, currentTime)
        : { label: "--", tone: "neutral" as const },
    [currentTime, mergedOrder],
  );
  const draftWarehouse = useMemo(
    () =>
      draft.warehouse_id
        ? warehouses.find((warehouse) => warehouse.id === draft.warehouse_id) ?? null
        : null,
    [draft.warehouse_id, warehouses],
  );
  const rowLogisticsOptions = useMemo(
    () =>
      draftWarehouse
        ? getWarehouseLogisticsMethodNames(
            draftWarehouse.id,
            logisticsMethods,
            warehouseLogisticsMethods,
          )
        : [],
    [draftWarehouse, logisticsMethods, warehouseLogisticsMethods],
  );
  const currentWarehouseMissing = useMemo(
    () =>
      Boolean(
        draft.warehouse_id &&
          draft.warehouse_name &&
          !warehouses.some((warehouse) => warehouse.id === draft.warehouse_id),
      ),
    [draft.warehouse_id, draft.warehouse_name, warehouses],
  );
  const declarationGroups = useMemo(
    () =>
      getOrderDisplayRowDeclarationGroups(
        rowOrders,
        productsById,
        skuOrderLookup,
      ),
    [productsById, rowOrders, skuOrderLookup],
  );
  const primaryDeclaration = declarationGroups[0]?.declaration ?? null;
  const trackingStatusLabel = useMemo(
    () => (mergedOrder ? getTrackingStatusLabel(mergedOrder.logistics_status) || "待查询" : "待查询"),
    [mergedOrder],
  );
  const rowSelected = useMemo(
    () => rowOrderIds.every((orderId) => selectedOrderIdSet.has(orderId)),
    [rowOrderIds, selectedOrderIdSet],
  );
  const skuSummary = useMemo(
    () => getOrderDisplayRowSkuSummary(rowOrders, rowQuantity, declarationGroups),
    [declarationGroups, rowOrders, rowQuantity],
  );
  const specLines = useMemo(
    () =>
      Array.from(
        (() => {
          const specGroups = new Map<string, { label: string; quantity: number }>();
          rowOrders.forEach((order) => {
            const label = order.product_attributes.trim() || "--";
            const key =
              [
                normalizeSkuCode(order.sku_code),
                normalizeSalesSpec(order.product_attributes),
              ].join("\u0000") || label;
            const current = specGroups.get(key);
            specGroups.set(key, {
              label: current?.label ?? label,
              quantity:
                (current?.quantity ?? 0) +
                Math.max(1, Math.trunc(order.fulfillment_quantity || 0)),
            });
          });
          return specGroups;
        })().values(),
      ).map((item) =>
        item.quantity > 1 ? `${item.label} ×${item.quantity}` : item.label,
      ),
    [rowOrders],
  );
  const salesSpec = useMemo(
    () => specLines.join(" / "),
    [specLines],
  );
  const canExpandAttrCell =
    specLines.length > 1 || (salesSpec?.length ?? 0) > 14;
  const normalizedDraftLogisticsMethod = useMemo(
    () => normalizeLogisticsMethod(draft.logistics_method),
    [draft.logistics_method],
  );
  const trackingUrl = useMemo(
    () => (mergedOrder ? getTrackingUrl(mergedOrder) : ""),
    [mergedOrder],
  );
  const trackingStatusUrl = useMemo(
    () => (mergedOrder ? getTrackingStatusUrl(mergedOrder) : ""),
    [mergedOrder],
  );

  if (!primaryOrder || !mergedOrder) return null;

  const canAssignOrder = canEdit && persistedStage === "pending_assignment";
  const productCellFullText = primaryDeclaration
    ? declarationGroups
        .map(
          (group) =>
            `${group.declaration.product.product_name_cn || "--"} ${group.declaration.sku.sku_code || "--"} x${group.quantity}`,
        )
        .join("\n")
    : skuSummary;

  return (
    <tr key={rowId}>
      <td className="text-center">
        <input
          type="checkbox"
          checked={rowSelected}
          onChange={(event) =>
            onToggleOrderRowSelection(rowOrderIds, event.target.checked)
          }
          aria-label={`选择订单 ${primaryOrder.order_no}`}
          className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
        />
      </td>
      <td className="order-no-col">{primaryOrder.order_no}</td>
      {activeStage === "all" && (
        <td className="order-stage-col">
          <Badge tone={stage.tone}>{stage.label}</Badge>
        </td>
      )}
      <td className="order-time-col" title={mergedOrder.latest_ship_time || undefined}>
        <Badge tone={shipCountdown.tone}>{shipCountdown.label}</Badge>
      </td>
      <td className="order-time-col" title={mergedOrder.estimated_delivery_time || undefined}>
        <Badge tone={deliveryCountdown.tone}>{deliveryCountdown.label}</Badge>
      </td>
      <td className="order-warehouse-col">
        {canAssignOrder ? (
          <select
            value={draft.warehouse_id ?? ""}
            onChange={(event) =>
              onHandleWarehouseChangeForOrders(rowOrderIds, event.target.value)
            }
            className="h-9 w-36 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
          >
            <option value="">未分配</option>
            {currentWarehouseMissing && (
              <option value={draft.warehouse_id ?? ""}>{draft.warehouse_name}</option>
            )}
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium text-slate-700 whitespace-nowrap">
            {draft.warehouse_name || "未分配"}
          </span>
        )}
      </td>
      <td className="order-logistics-col">
        {canAssignOrder ? (
          <select
            value={normalizedDraftLogisticsMethod}
            disabled={!draft.warehouse_id}
            onChange={(event) =>
              onUpdateDraftForOrders(
                rowOrderIds,
                "logistics_method",
                event.target.value,
              )
            }
            className="h-9 w-36 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value="">未分配</option>
            {rowLogisticsOptions.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
            {draft.logistics_method &&
              !rowLogisticsOptions.includes(normalizedDraftLogisticsMethod) && (
                <option value={normalizedDraftLogisticsMethod}>
                  {normalizedDraftLogisticsMethod}
                </option>
              )}
          </select>
        ) : (
          <span className="text-sm font-medium text-slate-700 whitespace-nowrap">
            {normalizedDraftLogisticsMethod || "未分配"}
          </span>
        )}
      </td>
      <td className="order-qty-col text-right-num">{rowQuantity}</td>
      <td className="order-product-col" data-full-text={productCellFullText || undefined}>
        {primaryDeclaration ? (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex w-[58px] shrink-0 items-center gap-1 overflow-hidden">
              {declarationGroups.slice(0, 1).map((group) => (
                <SkuImageThumb
                  key={group.declaration.sku.id || group.declaration.sku.sku_code}
                  product={group.declaration.product}
                  sku={group.declaration.sku}
                />
              ))}
              {declarationGroups.length > 1 && (
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-1 text-[11px] font-semibold text-slate-500">
                  +{declarationGroups.length - 1}
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="table-cell-clamp table-cell-clamp-1 font-medium text-slate-900">
                {primaryDeclaration.product.product_name_cn || "--"}
              </span>
              <span className="text-xs font-medium text-slate-500">
                {primaryDeclaration.sku.sku_code || "--"} ×{declarationGroups[0]?.quantity ?? 1}
              </span>
            </div>
          </div>
        ) : (
          <span className="text-sm font-medium text-slate-500">{skuSummary}</span>
        )}
      </td>
      <td
        className="order-attr-col"
        data-full-text={salesSpec || undefined}
        style={{ cursor: canExpandAttrCell ? "pointer" : "default" }}
        onClick={() => {
          if (canExpandAttrCell) {
            setAttrCellExpanded((prev) => !prev);
          }
        }}
      >
        {attrCellExpanded ? (
          <div className="flex flex-col gap-0.5">
            {specLines.map((line, index) => (
              <span key={index} className="text-xs text-slate-700 leading-5">
                {line}
              </span>
            ))}
            <button
              type="button"
              className="mt-0.5 text-left text-xs text-sky-600 hover:text-sky-800"
              onClick={(e) => {
                e.stopPropagation();
                setAttrCellExpanded(false);
              }}
            >
              ⌃ 收起
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="table-cell-clamp table-cell-clamp-1 text-slate-700">
              {salesSpec || "--"}
            </span>
            {(specLines.length > 1 || (salesSpec?.length ?? 0) > 14) && (
              <span className="shrink-0 text-xs text-slate-400">⌄</span>
            )}
          </div>
        )}
      </td>
      {isShippingTrackingStage(activeStage) && (
        <>
          <td className="order-tracking-col">
            {mergedOrder.logistics_tracking_no ? (
              trackingUrl ? (
                <a
                  href={trackingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-sky-700 hover:text-sky-900"
                >
                  {mergedOrder.logistics_tracking_no}
                </a>
              ) : (
                mergedOrder.logistics_tracking_no
              )
            ) : (
              "--"
            )}
          </td>
          <td className="order-tracking-status-col">
            {mergedOrder.logistics_tracking_no ? (
              trackingStatusUrl ? (
                <a
                  href={trackingStatusUrl}
                  onClick={(event) => openTrackingStatus(event, mergedOrder)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-sky-700 hover:text-sky-900"
                >
                  {trackingStatusLabel}
                </a>
              ) : (
                trackingStatusLabel
              )
            ) : (
              "--"
            )}
          </td>
        </>
      )}
      <td className="order-recipient-col">{formatRecipientName(mergedOrder.recipient_name) || "--"}</td>
      <td className="order-phone-col">{formatRecipientPhone(mergedOrder.recipient_phone) || "--"}</td>
      <td className="order-address-col" data-full-text={getFullAddress(mergedOrder) || undefined}>
        <div className="table-cell-preview">
          <span className="table-cell-clamp table-cell-clamp-1">
            {getFullAddress(mergedOrder) || "--"}
          </span>
        </div>
      </td>
      <td className="order-postal-col">{mergedOrder.postal_code || "--"}</td>
      <td>
        {activeStage === "uploaded_temu" ? (
          <input
            value={draft.actual_ship_time}
            readOnly={!canEdit}
            onChange={(event) =>
              onUpdateDraftForOrders(
                rowOrderIds,
                "actual_ship_time",
                event.target.value,
              )
            }
            onBlur={() => void onSaveActualShipTimeForOrders(rowOrders)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="填写时间"
            className="h-9 w-40 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
          />
        ) : (
          <span className="text-sm font-medium text-slate-700">
            {draft.actual_ship_time || "--"}
          </span>
        )}
      </td>
    </tr>
  );
});

type ReshipOrderModalProps = {
  originalOrder: TemuOrderRecord;
  relatedOrders: TemuOrderRecord[];
  productSkus: ProductSku[];
  products: Product[];
  onClose: () => void;
  onSuccess: (newOrders: TemuOrderRecord[]) => void;
  setErrorMessage: (msg: string) => void;
};

function ReshipOrderModal({
  originalOrder,
  relatedOrders,
  productSkus,
  products,
  onClose,
  onSuccess,
  setErrorMessage,
}: ReshipOrderModalProps) {
  const [suffix, setSuffix] = useState("");
  const [items, setItems] = useState<Array<{
    skuCode: string;
    productAttributes: string;
    quantity: number;
    isOriginal: boolean;
    checked: boolean;
  }>>(() => {
    return relatedOrders.map(o => ({
      skuCode: o.sku_code,
      productAttributes: o.product_attributes,
      quantity: o.fulfillment_quantity,
      isOriginal: true,
      checked: true,
    }));
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [showSkuDropdown, setShowSkuDropdown] = useState(false);

  const productsMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);

  const filteredSkus = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return productSkus.filter(sku => {
      const prod = productsMap.get(sku.product_id ?? "");
      const prodName = prod?.product_name_cn?.toLowerCase() || "";
      const skuCode = sku.sku_code.toLowerCase();
      return skuCode.includes(query) || prodName.includes(query);
    }).slice(0, 10);
  }, [searchQuery, productSkus, productsMap]);

  const handleAddSku = (sku: ProductSku) => {
    const prod = productsMap.get(sku.product_id ?? "");
    const prodName = prod?.product_name_cn || "";
    const spec = formatSkuSalesSpec(sku) || "默认规格";
    const attr = `${prodName} ${spec}`.trim();
    
    if (items.some(item => item.skuCode === sku.sku_code)) {
      alert("该 SKU 已经在列表中了！");
      return;
    }

    setItems(prev => [
      ...prev,
      {
        skuCode: sku.sku_code,
        productAttributes: attr,
        quantity: 1,
        isOriginal: false,
        checked: true,
      }
    ]);
    setSearchQuery("");
    setShowSkuDropdown(false);
  };

  const handleRemoveItem = (index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleFieldChange = (index: number, field: "quantity" | "productAttributes" | "checked", value: any) => {
    setItems(prev => prev.map((item, i) => {
      if (i === index) {
        return { ...item, [field]: value };
      }
      return item;
    }));
  };

  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async () => {
    const cleanSuffix = suffix.trim().replace(/^-+/, "");
    if (!cleanSuffix) {
      alert("请输入有效的补发单号后缀");
      return;
    }
    const selectedItems = items.filter(item => item.checked);
    if (selectedItems.length === 0) {
      alert("请至少选择或添加一项补发商品");
      return;
    }
    
    if (selectedItems.some(item => item.quantity <= 0 || !Number.isInteger(item.quantity))) {
      alert("请输入有效的补发数量（正整数）");
      return;
    }

    setIsSaving(true);
    try {
      const data = await createReshipmentOrder(relatedOrders, cleanSuffix, selectedItems.map(item => ({
        skuCode: item.skuCode,
        productAttributes: item.productAttributes,
        quantity: item.quantity,
      })));
      onSuccess(data);
    } catch (err: any) {
      setErrorMessage(err.message || "创建补发订单失败");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-2xl flex flex-col bg-white rounded-2xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-lg font-bold text-slate-900">创建补发订单</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Info Banner */}
          <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="font-semibold text-slate-500">原订单号</span>
              <span className="font-mono font-medium text-slate-800">{originalOrder.order_no}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-semibold text-slate-500">收件人</span>
              <span className="font-medium text-slate-800">{originalOrder.recipient_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-semibold text-slate-500">收件地址</span>
              <span className="font-medium text-slate-800 text-right truncate max-w-[20rem]" title={originalOrder.province + originalOrder.city + originalOrder.district + originalOrder.address_line1}>
                {originalOrder.province} {originalOrder.city} {originalOrder.district} {originalOrder.address_line1}
              </span>
            </div>
          </div>

          {/* Suffix Input */}
          <div className="space-y-2">
            <label className="text-sm font-bold text-slate-700 block">补发订单号后缀</label>
            <div className="flex items-center rounded-xl border border-line bg-slate-50 overflow-hidden focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10 transition">
              <span className="pl-4 pr-1 text-sm font-mono text-slate-400 shrink-0 select-none">
                {originalOrder.order_no}-
              </span>
              <input
                value={suffix}
                onChange={e => setSuffix(e.target.value.replace(/[^a-zA-Z0-9-]/g, ""))}
                placeholder="例如: reship1, bufa"
                className="h-11 w-full bg-transparent px-2 text-sm outline-none font-mono text-slate-800"
              />
            </div>
            <p className="text-xs text-slate-400 font-medium">后缀只能包含英文字母、数字和横杠，自动拼接在原订单号后</p>
          </div>

          {/* SKU Items List */}
          <div className="space-y-3">
            <label className="text-sm font-bold text-slate-700 block">选择或增加补发商品 (SKU)</label>
            
            <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100 max-h-[220px] overflow-y-auto">
              {items.map((item, index) => (
                <div key={item.skuCode + "-" + index} className={`flex items-center gap-3 p-3 text-xs ${item.checked ? "bg-accentSoft/10" : "bg-white"}`}>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={e => handleFieldChange(index, "checked", e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex justify-between font-mono font-medium text-slate-800">
                      <span className="truncate">{item.skuCode}</span>
                      {!item.isOriginal && (
                        <span className="rounded bg-sky-50 text-sky-700 px-1 text-[10px] font-sans scale-90 origin-right">手动增加</span>
                      )}
                    </div>
                    <input
                      value={item.productAttributes}
                      onChange={e => handleFieldChange(index, "productAttributes", e.target.value)}
                      placeholder="商品属性/销售规格"
                      className="h-8 w-full border border-line rounded-lg px-2 text-xs bg-white/70 outline-none focus:border-accent text-slate-600 font-medium"
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    <input
                      type="number"
                      min={1}
                      value={item.quantity}
                      onChange={e => handleFieldChange(index, "quantity", Math.max(1, parseInt(e.target.value) || 1))}
                      className="h-8 w-full border border-line rounded-lg px-2 text-center outline-none focus:border-accent"
                    />
                  </div>
                  {!item.isOriginal && (
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(index)}
                      className="text-slate-400 hover:text-rose-600 p-1 transition"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
              {items.length === 0 && (
                <div className="p-6 text-center text-slate-400 text-xs font-medium">请至少添加一项商品</div>
              )}
            </div>

            {/* Add Other SKU Row */}
            <div className="relative">
              <div className="flex gap-2">
                <input
                  value={searchQuery}
                  onChange={e => {
                    setSearchQuery(e.target.value);
                    setShowSkuDropdown(true);
                  }}
                  onFocus={() => setShowSkuDropdown(true)}
                  placeholder="搜索并添加其他商品 SKU 号/商品名"
                  className="h-10 flex-1 border border-line rounded-xl px-3 text-xs outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowSkuDropdown(!showSkuDropdown)}
                  className="btn-secondary h-10 px-3 text-xs shrink-0"
                >
                  {showSkuDropdown ? "隐藏" : "显示全部"}
                </button>
              </div>

              {/* SKU Autocomplete Dropdown */}
              {showSkuDropdown && (
                <div className="absolute z-50 left-0 right-0 mt-1 max-h-[180px] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg divide-y divide-slate-100">
                  {(searchQuery.trim() === "" ? productSkus.slice(0, 50) : filteredSkus).map(sku => {
                    const prod = productsMap.get(sku.product_id ?? "");
                    const prodName = prod?.product_name_cn || "未知商品";
                    return (
                      <button
                        key={sku.id}
                        type="button"
                        onClick={() => handleAddSku(sku)}
                        className="w-full text-left px-4 py-2 hover:bg-slate-50 transition text-xs flex justify-between gap-3 items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-slate-800 truncate font-mono">{sku.sku_code}</p>
                          <p className="text-slate-500 truncate">{prodName} ({formatSkuSalesSpec(sku)})</p>
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono shrink-0">点击选择</span>
                      </button>
                    );
                  })}
                  {(searchQuery.trim() !== "" && filteredSkus.length === 0) && (
                    <div className="p-4 text-center text-slate-400 text-xs font-medium">未找到匹配的 SKU</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary h-10 px-4 text-xs font-semibold"
          >
            取消
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={handleSubmit}
            className="btn-primary h-10 px-5 text-xs font-semibold inline-flex items-center gap-1.5"
          >
            {isSaving && <div className="h-3 w-3 animate-spin rounded-full border border-white border-r-transparent" />}
            确认创建
          </button>
        </div>
      </div>
    </div>
  );
}

export function OrdersPage({ user }: OrdersPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trackingInputRef = useRef<HTMLInputElement | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setPage(1);
  }, [pageSize, search]);
  
  const {
    allOrders,
    warehouses,
    products,
    productItems,
    productSkus,
    logisticsMethods,
    warehouseLogisticsMethods,
    warehouseSkus,
    settings,
    drafts,
    selectedOrderIds,
    bulkWarehouseId,
    bulkLogisticsMethod,
    loading,
    errorMessage,
    draftNotice,
    currentTime,
    setSelectedOrderIds,
    setBulkWarehouseId,
    setBulkLogisticsMethod,
    setErrorMessage,
    updateDraftForOrders,
    updateDraftFieldsForOrders,
    removeOrders,
    mergeOrders: updateOrdersState,
    clearDrafts,
    applyWarehouseSkuStockUpdates,
    fetchLatestProductsAndSkus,
  } = useOrders(user);
  const mergeOrderDraft = useCallback(
    (order: TemuOrderRecord) => mergeOrderWithDraft(order, drafts),
    [drafts],
  );
  const buildOrderDisplayRows = useCallback(
    (targetOrders: TemuOrderRecord[]) =>
      buildOrderDisplayRowsWithDrafts(targetOrders, drafts),
    [drafts],
  );
  const [activeStage, setActiveStage] = useState<OrderStage>("all");
  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [logisticsMethodFilter, setLogisticsMethodFilter] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [detailOrder, setDetailOrder] = useState<TemuOrderRecord | null>(null);
  const [reshipTargetOrder, setReshipTargetOrder] = useState<TemuOrderRecord | null>(null);

  const handleReshipSuccess = (newOrders: TemuOrderRecord[]) => {
    updateOrdersState(newOrders);
    setNoticeMessage(`补发订单创建成功！共创建 ${newOrders.length} 条商品记录。`);
    
    setActiveStage("pending_assignment");
    setPage(1);
    setSearch("");
    setSelectedOrderIds([]);
    setReshipTargetOrder(null);
    setDetailOrder(null);
  };
  const [orderSort, setOrderSort] = useState<OrderSort>(defaultOrderSort);
  const [showUrgentUnuploadedOnly, setShowUrgentUnuploadedOnly] = useState(false);
  useAutoDismiss(noticeMessage, () => setNoticeMessage(""));

  const logisticsMethodOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...logisticsMethods
            .filter((method) => method.is_active)
            .sort((left, right) => {
              if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
              return left.created_at.localeCompare(right.created_at);
            })
            .map((method) => normalizeLogisticsMethod(method.name))
            .filter(Boolean),
          ...allOrders
            .map((order) => normalizeLogisticsMethod(mergeOrderDraft(order).logistics_method))
            .filter(Boolean),
        ]),
      ),
    [allOrders, logisticsMethods, mergeOrderDraft],
  );

  const skuOrderLookup = useMemo(
    () => buildSkuOrderLookup(products, productSkus),
    [products, productSkus],
  );

  const ordersById = useMemo(
    () => new Map(allOrders.map((order) => [order.id, order])),
    [allOrders],
  );

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  const getOrderDeclaration = useCallback(
    (order: TemuOrderRecord) =>
      getOrderDeclarationFromLookups(order, productsById, skuOrderLookup),
    [productsById, skuOrderLookup],
  );

  const productItemsById = useMemo(
    () => new Map(productItems.flatMap((item) => (item.id ? [[item.id, item]] : []))),
    [productItems],
  );

  const warehouseSkusByKey = useMemo(
    () =>
      new Map(
        warehouseSkus.map((item) => [`${item.warehouse_id}:${item.sku_id}`, item]),
      ),
    [warehouseSkus],
  );

  const selectedBulkWarehouse = useMemo(
    () =>
      bulkWarehouseId
        ? warehouses.find((warehouse) => warehouse.id === bulkWarehouseId) ?? null
        : null,
    [bulkWarehouseId, warehouses],
  );

  const bulkLogisticsMethodOptions = useMemo(
    () =>
      selectedBulkWarehouse
        ? getWarehouseLogisticsMethodNames(
            selectedBulkWarehouse.id,
            logisticsMethods,
            warehouseLogisticsMethods,
          )
        : logisticsMethodOptions,
    [
      logisticsMethodOptions,
      logisticsMethods,
      selectedBulkWarehouse,
      warehouseLogisticsMethods,
    ],
  );

  const urgentUnuploadedOrders = useMemo(
    () => allOrders.filter((order) => isUrgentUnuploadedOrder(order, currentTime)),
    [allOrders, currentTime],
  );

  useEffect(() => {
    if (showUrgentUnuploadedOnly && urgentUnuploadedOrders.length === 0) {
      setShowUrgentUnuploadedOnly(false);
    }
  }, [showUrgentUnuploadedOnly, urgentUnuploadedOrders.length]);

  useEffect(() => {
    if (warehouseFilter && !warehouses.some((warehouse) => warehouse.id === warehouseFilter)) {
      setWarehouseFilter("");
    }
  }, [warehouseFilter, warehouses]);

  useEffect(() => {
    if (logisticsMethodFilter && !logisticsMethodOptions.includes(logisticsMethodFilter)) {
      setLogisticsMethodFilter("");
    }
  }, [logisticsMethodFilter, logisticsMethodOptions]);

  const matchesFulfillmentFilters = useCallback((order: TemuOrderRecord) => {
    const merged = mergeOrderDraft(order);
    if (warehouseFilter) {
      const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === warehouseFilter);
      const selectedWarehouseName = selectedWarehouse?.name.trim().toLowerCase() ?? "";
      const orderWarehouseName = merged.warehouse_name.trim().toLowerCase();
      if (
        merged.warehouse_id !== warehouseFilter &&
        (!selectedWarehouseName || orderWarehouseName !== selectedWarehouseName)
      ) {
        return false;
      }
    }
    if (
      logisticsMethodFilter &&
      normalizeLogisticsMethod(merged.logistics_method) !== logisticsMethodFilter
    ) {
      return false;
    }
    return true;
  }, [logisticsMethodFilter, mergeOrderDraft, warehouseFilter, warehouses]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    const nextOrders = allOrders.filter((order) => {
      const merged = mergeOrderDraft(order);
      if (showUrgentUnuploadedOnly && !isUrgentUnuploadedOrder(merged, currentTime)) {
        return false;
      }
      if (activeStage !== "all" && getOrderStage(merged) !== activeStage) return false;
      if (!matchesFulfillmentFilters(order)) return false;
      if (!term) return true;

      return [
        order.order_no,
        order.sub_order_no,
        order.order_status,
        order.sku_code,
        order.warehouse_name,
        order.logistics_method,
        order.logistics_tracking_no,
        order.logistics_status,
        order.product_attributes,
        order.recipient_name,
        order.recipient_phone,
        order.email,
        order.province,
        order.city,
        order.district,
        order.address_line1,
        order.address_line2,
        order.postal_code,
      ].some((value) => String(value ?? "").toLowerCase().includes(term));
    });

    return [...nextOrders].sort((left, right) => {
      let comparison: number;

      if (orderSort.key === "ship_deadline") {
        comparison = compareOptionalNumber(
          getOrderDeadlineTimestamp(left.latest_ship_time),
          getOrderDeadlineTimestamp(right.latest_ship_time),
        );
      } else if (orderSort.key === "delivery_deadline") {
        comparison = compareOptionalNumber(
          getOrderDeadlineTimestamp(left.estimated_delivery_time),
          getOrderDeadlineTimestamp(right.estimated_delivery_time),
        );
      } else if (orderSort.key === "logistics_status") {
        comparison = compareTrackingStatus(
          mergeOrderDraft(left).logistics_status,
          mergeOrderDraft(right).logistics_status,
        );
      } else {
        const leftDeclaration = getOrderDeclaration(left);
        const rightDeclaration = getOrderDeclaration(right);
        comparison = (leftDeclaration?.product.product_code || "\uffff").localeCompare(
          rightDeclaration?.product.product_code || "\uffff",
        );
      }

      const directedComparison =
        orderSort.direction === "asc" ? comparison : -comparison;
      return directedComparison || left.order_no.localeCompare(right.order_no);
    });
  }, [
    activeStage,
    allOrders,
    currentTime,
    getOrderDeclaration,
    matchesFulfillmentFilters,
    mergeOrderDraft,
    orderSort,
    search,
    showUrgentUnuploadedOnly,
  ]);

  const filteredOrderRows = useMemo(
    () => buildOrderDisplayRows(filteredOrders),
    [buildOrderDisplayRows, filteredOrders],
  );
  const filteredTotalPages = Math.max(1, Math.ceil(filteredOrderRows.length / pageSize));
  const paginatedOrderRows = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    return filteredOrderRows.slice(startIndex, startIndex + pageSize);
  }, [filteredOrderRows, page, pageSize]);

  useEffect(() => {
    if (page > filteredTotalPages) {
      setPage(filteredTotalPages);
    }
  }, [filteredTotalPages, page]);

  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(
      stageDefinitions.map((definition) => [definition.key, 0]),
    ) as Record<OrderStage, number>;
    const countableOrders = allOrders.filter((order) => matchesFulfillmentFilters(order));
    const rows = buildOrderDisplayRows(countableOrders);

    counts.all = rows.length;
    rows.forEach((row) => {
      counts[getOrderStage(row.primaryOrder)] += 1;
    });
    return counts;
  }, [
    allOrders,
    buildOrderDisplayRows,
    matchesFulfillmentFilters,
  ]);

  const tableColumns = useMemo(
    () =>
      visibleColumns.filter(
        (column) =>
          (activeStage === "all" || column.key !== "stage") &&
          (!column.shippedOnly || isShippingTrackingStage(activeStage)),
      ),
    [activeStage],
  );

  const orderTableLayoutColumns = useMemo<StandardTableColumn[]>(
    () => [
      { key: "select", width: "3.25rem" },
      ...tableColumns.map((column) => ({
        key: column.key,
        width: orderColumnWidths[column.key] ?? "8rem",
      })),
    ],
    [tableColumns],
  );

  const newOrdersInView = useMemo(
    () => filteredOrders.filter((order) => getOrderStage(mergeOrderDraft(order)) === "new_order"),
    [filteredOrders, mergeOrderDraft],
  );

  const pendingShippingOrdersInView = useMemo(
    () => filteredOrders.filter((order) => getOrderStage(mergeOrderDraft(order)) === "pending_shipping"),
    [filteredOrders, mergeOrderDraft],
  );

  const selectedOrderIdSet = useMemo(
    () => new Set(selectedOrderIds),
    [selectedOrderIds],
  );

  const selectedNewOrdersInView = useMemo(
    () => newOrdersInView.filter((order) => selectedOrderIdSet.has(order.id)),
    [newOrdersInView, selectedOrderIdSet],
  );

  const selectedPendingShippingOrdersInView = useMemo(
    () => pendingShippingOrdersInView.filter((order) => selectedOrderIdSet.has(order.id)),
    [pendingShippingOrdersInView, selectedOrderIdSet],
  );

  const selectedShippedOrdersInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) => selectedOrderIdSet.has(order.id) && getOrderStage(mergeOrderDraft(order)) === "shipped",
      ),
    [filteredOrders, mergeOrderDraft, selectedOrderIdSet],
  );

  const selectedCompletableOrdersInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) =>
          selectedOrderIdSet.has(order.id) && getOrderStage(mergeOrderDraft(order)) === "uploaded_temu",
      ),
    [filteredOrders, mergeOrderDraft, selectedOrderIdSet],
  );

  const selectedOrdersInView = useMemo(
    () => filteredOrders.filter((order) => selectedOrderIdSet.has(order.id)),
    [filteredOrders, selectedOrderIdSet],
  );
  const selectedCompletedOrdersInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) => selectedOrderIdSet.has(order.id) && getOrderStage(mergeOrderDraft(order)) === "completed",
      ),
    [filteredOrders, mergeOrderDraft, selectedOrderIdSet],
  );

  const selectedOrderRowsInView = useMemo(
    () =>
      filteredOrderRows.filter((row) =>
        row.orders.every((order) => selectedOrderIdSet.has(order.id)),
      ),
    [filteredOrderRows, selectedOrderIdSet],
  );
  const {
    selectedNewOrderRowCount,
    selectedPendingShippingRowCount,
    selectedShippedRowCount,
    selectedUploadedTemuRowCount,
  } = useMemo(() => {
    const counts = {
      selectedNewOrderRowCount: 0,
      selectedPendingShippingRowCount: 0,
      selectedShippedRowCount: 0,
      selectedUploadedTemuRowCount: 0,
    };

    selectedOrderRowsInView.forEach((row) => {
      const stage = getOrderStage(row.primaryOrder);
      if (stage === "new_order") counts.selectedNewOrderRowCount += 1;
      if (stage === "pending_shipping") counts.selectedPendingShippingRowCount += 1;
      if (stage === "shipped") counts.selectedShippedRowCount += 1;
      if (stage === "uploaded_temu") counts.selectedUploadedTemuRowCount += 1;
    });

    return counts;
  }, [selectedOrderRowsInView]);

  const selectedOrderLineInViewCount = selectedOrdersInView.length;
  const selectedInViewCount = selectedOrderRowsInView.length;
  const hasSelectedCompletedOrders = selectedCompletedOrdersInView.length > 0;
  const selectedSingleOrderInView =
    selectedOrderRowsInView.length === 1 ? selectedOrderRowsInView[0].primaryOrder : null;
  const canManageSelectedShippedOrders =
    selectedShippedOrdersInView.length > 0 &&
    (activeStage === "shipped" || showUrgentUnuploadedOnly);
  const shippedOrdersWithTrackingInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) =>
          isShippingTrackingStage(getOrderStage(mergeOrderDraft(order))) && order.logistics_tracking_no.trim(),
      ),
    [filteredOrders, mergeOrderDraft],
  );
  const allFilteredSelected =
    paginatedOrderRows.length > 0 &&
    paginatedOrderRows.every((row) =>
      row.orders.every((order) => selectedOrderIdSet.has(order.id)),
    );

  useEffect(() => {
    if (!canEdit || loading || !isShippingTrackingStage(activeStage) || busyKey) return;
  }, [activeStage, busyKey, canEdit, loading, shippedOrdersWithTrackingInView]);

  useEffect(() => {
    if (!canEdit || loading || busyKey) return;
  }, [allOrders, busyKey, canEdit, loading]);

  function getOrderWarehouseLogisticsIssue(order: Pick<TemuOrderRecord, "warehouse_id" | "warehouse_name" | "order_no">) {
    if (!order.warehouse_id) return "";
    const status = getWarehouseLogisticsConfigStatus(
      order.warehouse_id,
      settings,
      logisticsMethods,
      warehouseLogisticsMethods,
    );
    if (!status.issue) return "";

    const warehouseName =
      warehouses.find((warehouse) => warehouse.id === order.warehouse_id)?.name ||
      order.warehouse_name ||
      order.warehouse_id;
    return `${order.order_no}（${warehouseName}）：${status.issue}`;
  }

  function assertOrdersWarehouseLogisticsComplete(
    ordersToValidate: Array<Pick<TemuOrderRecord, "warehouse_id" | "warehouse_name" | "order_no">>,
  ) {
    const issue = ordersToValidate
      .map((order) => getOrderWarehouseLogisticsIssue(order))
      .find(Boolean);
    if (issue) {
      throw new Error(`仓库物流配置不完整，不能保存订单：${issue}`);
    }
  }

  function handleWarehouseChangeForOrders(orderIds: string[], warehouseId: string) {
    if (!warehouseId) {
      updateDraftFieldsForOrders(orderIds, {
        warehouse_id: null,
        warehouse_name: "",
        logistics_method: "",
      });
      return;
    }

    const warehouse = warehouses.find((item) => item.id === warehouseId);
    if (warehouse) {
      const status = getWarehouseLogisticsConfigStatus(
        warehouse.id,
        settings,
        logisticsMethods,
        warehouseLogisticsMethods,
      );
      if (!status.isComplete) {
        setErrorMessage(`仓库“${warehouse.name}”物流配置不完整，不能选择：${status.issue}`);
        return;
      }
    }

    const currentDraft = drafts[orderIds[0]] ?? createEmptyDraft();
    const nextWarehouseName = warehouse?.name ?? "";
    const nextLogisticsMethod =
      warehouse &&
      isConfiguredLogisticsMethodAllowedForWarehouse(
        warehouse.id,
        currentDraft.logistics_method,
        logisticsMethods,
        warehouseLogisticsMethods,
      )
      ? currentDraft.logistics_method
      : "";
    updateDraftFieldsForOrders(orderIds, {
      warehouse_id: warehouse?.id ?? warehouseId,
      warehouse_name: nextWarehouseName,
      logistics_method: nextLogisticsMethod,
    });
  }

  function getOrderSku(order: TemuOrderRecord) {
    const skuCode = normalizeSkuCode(order.sku_code);
    if (skuCode) return skuOrderLookup.skuByCode.get(skuCode) ?? null;
    return skuOrderLookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ?? null;
  }

  function getAllowedWarehouseLogisticsMethod(
    warehouse: Warehouse,
    logisticsMethod: string,
  ) {
    const normalizedMethod = normalizeLogisticsMethod(logisticsMethod);
    const methods = getWarehouseLogisticsMethodNames(
      warehouse.id,
      logisticsMethods,
      warehouseLogisticsMethods,
    );
    return methods.includes(normalizedMethod) ? normalizedMethod : "";
  }

  function canQueryTrackingStatus(order: TemuOrderRecord) {
    return Boolean(order.logistics_tracking_no.trim());
  }

  function cleanTrackingText(value: string) {
    return value.replace(/▶/g, " ").replace(/\s+/g, " ").trim();
  }

  function formatJapanPostDateTime(value: string) {
    const match = value.match(
      /(\d{4})[/年](\d{1,2})[/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})/,
    );
    if (!match) return "";

    const [, year, month, day, hour, minute] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute}`;
  }

  function parseJapanPostDateTime(value: string) {
    const formatted = formatJapanPostDateTime(value);
    if (!formatted) return null;

    const timestamp = parseOrderDateTime(formatted)?.getTime() ?? Number.NaN;
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  function getJapanPostHistoryStatus(document: Document): TrackingStatusResult | null {
    const historyRows = Array.from(
      document.querySelectorAll('table[summary="履歴情報"] tr'),
    );
    const candidates: Array<{
      status: string;
      actualSignedTime?: string;
      timestamp: number | null;
      index: number;
    }> = [];

    historyRows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
        cleanTrackingText(cell.textContent ?? ""),
      );
      if (cells.length < 2) return;

      const status = getTrackingStatusLabel(cells[1]);
      if (!isJapanPostTrackingStatus(status)) return;

      candidates.push({
        status,
        actualSignedTime: formatJapanPostDateTime(cells[0]) || undefined,
        timestamp: parseJapanPostDateTime(cells[0]),
        index: candidates.length,
      });
    });

    const latest = candidates.sort((left, right) => {
      const timestampComparison =
        (right.timestamp ?? Number.NEGATIVE_INFINITY) -
        (left.timestamp ?? Number.NEGATIVE_INFINITY);
      return timestampComparison || right.index - left.index;
    })[0];

    if (!latest) return null;

    return {
      status: latest.status,
      actualSignedTime: isDeliveredTrackingStatus(latest.status)
        ? latest.actualSignedTime
        : undefined,
    };
  }

  function getJapanPostResultStatus(document: Document) {
    const resultRows = Array.from(
      document.querySelectorAll('table[summary="照会結果"] tr'),
    );

    for (const row of resultRows) {
      const status = Array.from(row.querySelectorAll("td"))
        .map((cell) => getTrackingStatusLabel(cleanTrackingText(cell.textContent ?? "")))
        .find((cellText) => isJapanPostTrackingStatus(cellText));
      if (status) return status;
    }

    return "";
  }

  function parseYamatoTrackingStatus(html: string): TrackingStatusResult {
    const document = new DOMParser().parseFromString(html, "text/html");
    const statusTitle = cleanTrackingText(
      document.querySelector(".tracking-invoice-block-state-title")?.textContent ?? "",
    );
    const latestDetailRow = Array.from(
      document.querySelectorAll(".tracking-invoice-block-detail li"),
    ).at(-1);
    const latestStatus = cleanTrackingText(
      latestDetailRow?.querySelector(".item")?.textContent ?? "",
    );
    const listStatus = cleanTrackingText(
      document.querySelector(".tracking-box-area:not(.no-item) .data.state")
        ?.textContent ?? "",
    );
    const displayStatus = statusTitle || latestStatus || listStatus;
    return { status: getTrackingStatusLabel(displayStatus) || "暂无轨迹" };
  }

  async function fetchYamatoTrackingStatus(trackingNo: string) {
    const body = new URLSearchParams({
      number01: trackingNo.trim(),
      category: "0",
    });
    const response = await fetch(
      "/yamato-tracking/cgi-bin/tneko",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(`Yamato 查询失败：HTTP ${response.status}`);
    }
    return parseYamatoTrackingStatus(await response.text());
  }

  function parseJapanPostTrackingStatus(html: string): TrackingStatusResult {
    const document = new DOMParser().parseFromString(html, "text/html");
    const bodyText = cleanTrackingText(document.body?.textContent ?? "");
    if (bodyText.includes("お問い合わせ番号が見つかりません")) {
      return { status: "暂无轨迹" };
    }

    const historyStatus = getJapanPostHistoryStatus(document);
    if (historyStatus) return historyStatus;

    return {
      status:
        getTrackingStatusLabel(getJapanPostResultStatus(document)) ||
        "暂无轨迹",
    };
  }

  async function fetchJapanPostTrackingStatus(trackingNo: string) {
    const params = new URLSearchParams({
      reqCodeNo1: trackingNo.trim(),
      searchKind: "S002",
      locale: "ja",
    });
    const response = await fetch(`${japanPostTrackingProxyPath}?${params.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Japan Post 查询失败：HTTP ${response.status}`);
    }
    return parseJapanPostTrackingStatus(await response.text());
  }

  async function fetchTrackingStatus(order: TemuOrderRecord) {
    if (getOrderTrackingCarrier(order) === "japan_post") {
      return fetchJapanPostTrackingStatus(order.logistics_tracking_no);
    }
    return fetchYamatoTrackingStatus(order.logistics_tracking_no);
  }

  function buildTrackingStatusUpdates(
    order: TemuOrderRecord,
    trackingResult: TrackingStatusResult,
  ) {
    const logisticsStatus = trackingResult.status;
    const updates: Parameters<typeof updateTemuOrder>[1] = {
      logistics_status: logisticsStatus,
    };

    if (isDeliveredTrackingStatus(logisticsStatus)) {
      const draft = drafts[order.id] ?? toDraft(order);
      updates.order_status = "已完成";
      updates.actual_signed_time =
        trackingResult.actualSignedTime ||
        draft.actual_signed_time.trim() ||
        formatLocalDateTime();
    }

    return updates;
  }

  function getTrackingMatchScore(order: TemuOrderRecord, record: TrackingImportRecord) {
    const orderPhone = normalizeJapanesePhone(formatRecipientPhone(order.recipient_phone));
    const recordPhone = normalizeJapanesePhone(record.phone);
    const orderPostalCode = normalizePostalCode(order.postal_code);
    const recordPostalCode = normalizePostalCode(record.postalCode);
    const orderName = formatRecipientName(order.recipient_name);
    const orderAddress = getFullAddress(order);
    let score = 0;

    if (record.orderNo && includesLooseText(record.orderNo, order.order_no)) score += 140;
    if (record.subOrderNo && includesLooseText(record.subOrderNo, order.sub_order_no)) score += 90;
    if (includesLooseText(record.allText, order.order_no)) score += 100;
    if (record.refNo && includesLooseText(record.refNo, order.order_no)) score += 100;
    if (orderPhone && recordPhone && orderPhone === recordPhone) score += 60;
    if (orderPostalCode && recordPostalCode && orderPostalCode === recordPostalCode) score += 45;
    if (orderName && includesLooseText(record.recipientName, orderName)) score += 40;
    if (orderAddress && includesLooseText(record.address, orderAddress)) score += 35;
    if (order.sku_code && includesLooseText(record.remark, order.sku_code)) score += 20;

    return score;
  }

  function isConfidentTrackingMatch(order: TemuOrderRecord, record: TrackingImportRecord, score: number) {
    const phoneMatched =
      normalizeJapanesePhone(formatRecipientPhone(order.recipient_phone)) ===
      normalizeJapanesePhone(record.phone);
    const postalMatched =
      normalizePostalCode(order.postal_code) === normalizePostalCode(record.postalCode);
    const nameMatched = includesLooseText(record.recipientName, formatRecipientName(order.recipient_name));
    const addressMatched = includesLooseText(record.address, getFullAddress(order));
    const orderNoMatched = includesLooseText(record.orderNo, order.order_no);
    const subOrderNoMatched = includesLooseText(record.subOrderNo, order.sub_order_no);

    return (
      orderNoMatched ||
      subOrderNoMatched ||
      includesLooseText(record.allText, order.order_no) ||
      (phoneMatched && postalMatched) ||
      (nameMatched && postalMatched) ||
      (addressMatched && postalMatched) ||
      score >= 100
    );
  }

  function findTrackingMatch(
    order: TemuOrderRecord,
    records: TrackingImportRecord[],
    usedRowIndexes: Set<number>,
  ) {
    const scoredRecords = records
      .filter((record) => !usedRowIndexes.has(record.rowIndex))
      .map((record) => ({
        record,
        score: getTrackingMatchScore(order, record),
      }))
      .sort((left, right) => right.score - left.score);

    const best = scoredRecords[0];
    if (!best || !isConfidentTrackingMatch(order, best.record, best.score)) return null;
    return best.record;
  }

  function getSkuAvailableStock(
    warehouseId: string,
    sku: ProductSku,
    availableStockByKey?: Map<string, number>,
  ) {
    if (!sku.id) return 0;
    const stockKey = `${warehouseId}:${sku.id}`;
    if (availableStockByKey) {
      return availableStockByKey.get(stockKey) ?? 0;
    }
    return warehouseSkusByKey.get(stockKey)?.stock_quantity ?? 0;
  }

  function reserveOrderInventory(
    warehouseId: string,
    sku: ProductSku,
    orderQuantity: number,
    availableStockByKey: Map<string, number>,
  ) {
    if (!sku.id) return false;
    const stockKey = `${warehouseId}:${sku.id}`;
    if ((availableStockByKey.get(stockKey) ?? 0) < orderQuantity) return false;
    availableStockByKey.set(stockKey, (availableStockByKey.get(stockKey) ?? 0) - orderQuantity);
    return true;
  }

  function getWarehouseWithSkuStock(
    candidateWarehouses: Warehouse[],
    sku: ProductSku,
    quantity: number,
    availableStockByKey?: Map<string, number>,
  ) {
    return candidateWarehouses.find(
      (warehouse) => getSkuAvailableStock(warehouse.id, sku, availableStockByKey) >= quantity,
    );
  }

  function getThreeCmDimensionIssueForSku(sku: ProductSku) {
    const product = sku.product_id ? productsById.get(sku.product_id) ?? null : null;
    if (!product) return "商品资料缺少包裹尺寸";
    return getThreeCmDimensionIssue(product);
  }

  function matchOrderFulfillment(
    order: TemuOrderRecord,
    availableStockByKey?: Map<string, number>,
  ): OrderFulfillmentMatchResult {
    const sku = getOrderSku(order);
    if (!sku?.id) return { status: "unmatched" };

    const quantity = getOrderFulfillmentQuantity(order);
    const warehouseIdsWithSku = new Set(
      warehouseSkus
        .filter((stock) => stock.sku_id === sku.id)
        .map((stock) => stock.warehouse_id),
    );
    const warehousesWithSku = warehouses.filter((warehouse) =>
      warehouseIdsWithSku.has(warehouse.id),
    );
    const fukuokaWarehouse = getWarehouseWithSkuStock(
      getWarehousesByAliases(warehousesWithSku, fukuokaWarehouseAliases),
      sku,
      quantity,
      availableStockByKey,
    );
    if (fukuokaWarehouse) {
      const dimensionIssue = getThreeCmDimensionIssueForSku(sku);
      if (dimensionIssue) {
        return {
          status: "blocked",
          reason: `订单 ${getOrderLineLabel(order)}：福冈仓有库存，但${dimensionIssue}，不能发福冈Japan Post。`,
        };
      }

      const logisticsMethod = getAllowedWarehouseLogisticsMethod(
        fukuokaWarehouse,
        fukuokaLastmileMethod,
      );
      if (!logisticsMethod) {
        return {
          status: "blocked",
          reason: `${fukuokaWarehouse.name} 没有配置“${fukuokaLastmileMethod}”发货方式。`,
        };
      }
      return {
        status: "matched",
        match: { warehouse: fukuokaWarehouse, logisticsMethod, sku, quantity },
      };
    }

    const suzhouWarehouse = getWarehouseWithSkuStock(
      getWarehousesByAliases(warehousesWithSku, suzhouWarehouseAliases),
      sku,
      quantity,
      availableStockByKey,
    );
    if (!suzhouWarehouse) return { status: "unmatched" };

    const dimensionIssue = getThreeCmDimensionIssueForSku(sku);
    const logisticsMethod = getAllowedWarehouseLogisticsMethod(
      suzhouWarehouse,
      dimensionIssue ? ocsSmallParcelMethod : ocsThreeCmMethod,
    );
    if (!logisticsMethod) return { status: "unmatched" };

    return {
      status: "matched",
      match: { warehouse: suzhouWarehouse, logisticsMethod, sku, quantity },
    };
  }

  function getOrderDetailRows(order: TemuOrderRecord) {
    const merged = mergeOrderDraft(order);
    return [
      ["订单号", merged.order_no],
      ["子订单号", merged.sub_order_no],
      ["订单状态", merged.order_status],
      ["SKU货号", merged.sku_code],
      ["应履约件数", String(merged.fulfillment_quantity)],
      ["商品属性", merged.product_attributes],
      ["收货人姓名", formatRecipientName(merged.recipient_name)],
      ["收货人联系方式", formatRecipientPhone(merged.recipient_phone)],
      ["邮箱", merged.email],
      ["省份", merged.province],
      ["城市", merged.city],
      ["区县", merged.district],
      ["详细地址1", merged.address_line1],
      ["详细地址2", merged.address_line2],
      ["收货地址邮编", merged.postal_code],
      ["要求最晚发货时间", merged.latest_ship_time],
      ["实际发货时间", merged.actual_ship_time],
      ["预计送达时间", merged.estimated_delivery_time],
      ["实际签收时间", merged.actual_signed_time],
      ["发货仓库", merged.warehouse_name || "未分配"],
      ["发货方式", normalizeLogisticsMethod(merged.logistics_method) || "未分配"],
      ["物流单号", merged.logistics_tracking_no],
      ["物流状态", getTrackingStatusLabel(merged.logistics_status)],
      ["面单打印时间", merged.label_printed_at],
      ["完整地址", getFullAddress(merged)],
    ] as const;
  }

  function toggleOrderRowSelection(rowIds: string[], checked: boolean) {
    setSelectedOrderIds((current) =>
      checked
        ? Array.from(new Set([...current, ...rowIds]))
        : current.filter((id) => !rowIds.includes(id)),
    );
  }

  function toggleFilteredSelection(checked: boolean) {
    const filteredIds = paginatedOrderRows.flatMap((row) =>
      row.orders.map((order) => order.id),
    );
    setSelectedOrderIds((current) =>
      checked
        ? Array.from(new Set([...current, ...filteredIds]))
        : current.filter((id) => !filteredIds.includes(id)),
    );
  }

  function toggleOrderSort(key: OrderSortKey) {
    setPage(1);
    setOrderSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }

  async function handleFileChange(file: File | undefined) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入订单。");
      return;
    }
    if (!file) return;
    if (!(await confirmAction(`确认导入订单文件“${file.name}”吗？`))) return;

    setBusyKey("import");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const rows = await readTabularFileObjects(file);
      const missingColumns = (Object.keys(importColumnAliases) as TemuOrderImportField[])
        .filter(
          (field) =>
            !optionalImportFields.has(field) &&
            !hasAnyColumn(rows[0] ?? {}, importColumnAliases[field]),
        )
        .map((field) => importFieldLabels[field]);
      if (missingColumns.length > 0) {
        throw new Error(`缺少必要列：${missingColumns.join("、")}`);
      }

      const { products: nextProducts, productSkus: nextSkus } =
        await fetchLatestProductsAndSkus();
      const importSkuLookup = buildSkuOrderLookup(nextProducts, nextSkus);

      const importRows: TemuOrderImportRow[] = rows.flatMap((row, index) => {
        const orderNo = readImportCell(row, "order_no");
        if (!orderNo) return [];
        const skuCode = readImportCell(row, "sku_code");
        const matchedSalesSpec = importSkuLookup.salesSpecByCode.get(normalizeSkuCode(skuCode));
        return [
          {
            order_no: orderNo,
            sub_order_no: readImportCell(row, "sub_order_no") || String(index + 2),
            order_status: readImportCell(row, "order_status"),
            sku_code: skuCode,
            fulfillment_quantity: parseFulfillmentQuantity(
              readImportCell(row, "fulfillment_quantity"),
            ),
            product_attributes: matchedSalesSpec ?? readImportCell(row, "product_attributes"),
            recipient_name: readImportCell(row, "recipient_name"),
            recipient_phone: readImportCell(row, "recipient_phone"),
            email: readImportCell(row, "email"),
            province: readImportCell(row, "province"),
            city: readImportCell(row, "city"),
            district: readImportCell(row, "district"),
            address_line1: readImportCell(row, "address_line1"),
            address_line2: readImportCell(row, "address_line2"),
            postal_code: readImportCell(row, "postal_code"),
            latest_ship_time: readImportCell(row, "latest_ship_time"),
            actual_ship_time: readImportCell(row, "actual_ship_time"),
            estimated_delivery_time: readImportCell(row, "estimated_delivery_time"),
          },
        ];
      });
      if (importRows.length === 0) throw new Error("没有读取到可导入的订单行");

      const uniqueImportRows = dedupeImportRowsByOrderLine(importRows);
      const skippedDuplicateCount = importRows.length - uniqueImportRows.length;
      const existingOrders = allOrders;
      const existingOrdersByLineKey = new Map<string, TemuOrderRecord>();
      const existingOrdersBySkuKey = new Map<string, TemuOrderRecord>();
      const existingOrderNoCounts = existingOrders.reduce<Record<string, number>>(
        (counts, order) => {
          const key = getOrderNoKey(order.order_no);
          if (key) counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        },
        {},
      );
      const importOrderNoCounts = uniqueImportRows.reduce<Record<string, number>>(
        (counts, row) => {
          const key = getOrderNoKey(row.order_no);
          if (key) counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        },
        {},
      );

      existingOrders.forEach((order) => {
        const lineKey = getOrderLineKey(order);
        if (lineKey && !existingOrdersByLineKey.has(lineKey)) {
          existingOrdersByLineKey.set(lineKey, order);
        }

        const skuKey = getOrderLineSkuKey(order);
        if (skuKey && !existingOrdersBySkuKey.has(skuKey)) {
          existingOrdersBySkuKey.set(skuKey, order);
        }
      });

      const findExistingImportOrder = (row: TemuOrderImportRow) => {
        const lineKey = getOrderLineKey(row);
        const lineMatch = lineKey ? existingOrdersByLineKey.get(lineKey) : undefined;
        if (lineMatch) return lineMatch;

        const skuKey = getOrderLineSkuKey(row);
        const skuMatch = skuKey ? existingOrdersBySkuKey.get(skuKey) : undefined;
        if (skuMatch) return skuMatch;

        const orderNoKey = getOrderNoKey(row.order_no);
        if (
          orderNoKey &&
          (existingOrderNoCounts[orderNoKey] ?? 0) === 1 &&
          (importOrderNoCounts[orderNoKey] ?? 0) === 1
        ) {
          return existingOrders.find((order) => getOrderNoKey(order.order_no) === orderNoKey);
        }

        return undefined;
      };

      const newImportRows = uniqueImportRows.filter((row) => !findExistingImportOrder(row));
      const existingLineCount = uniqueImportRows.length - newImportRows.length;
      const unresolvedRowsMissingRecipientInfo = newImportRows.filter(
        (row) => !hasAnyRecipientInfo(row),
      ).length;
      const savedOrders =
        newImportRows.length > 0
          ? await importTemuOrders(newImportRows)
          : [] as TemuOrderRecord[];
      if (savedOrders.length > 0) {
        updateOrdersState(savedOrders);
        setActiveStage("pending_assignment");
        setSearch("");
        setWarehouseFilter("");
        setLogisticsMethodFilter("");
        setShowUrgentUnuploadedOnly(false);
        setPage(1);
      }
      const skipMessages = [
        skippedDuplicateCount > 0 ? `跳过上传表内重复订单明细 ${skippedDuplicateCount} 行` : "",
        existingLineCount > 0 ? `跳过已有订单明细 ${existingLineCount} 条` : "",
        unresolvedRowsMissingRecipientInfo > 0
          ? `${unresolvedRowsMissingRecipientInfo} 条订单仍缺少收件信息，请重新上传包含收件信息的 Temu 订单表`
          : "",
      ].filter(Boolean);
      setNoticeMessage(
        [
          savedOrders.length > 0
            ? `已导入 ${savedOrders.length} 条新订单明细`
            : "没有新增订单",
          ...skipMessages,
        ].join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "导入订单失败"));
    } finally {
      setBusyKey("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleTrackingFileChange(file: File | undefined) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入物流单号。");
      return;
    }
    if (!file) return;
    if (!(await confirmAction(`确认导入物流单号文件“${file.name}”吗？`))) return;

    setBusyKey("tracking-import");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const rows = await readTabularFileObjects(file);
      if (rows.length === 0) {
        throw new Error("文件里没有可读取的数据。");
      }
      const hasTrackingNoColumn = rows.some((row) =>
        hasAnyColumn(row, trackingNoImportColumnAliases),
      );
      if (!hasTrackingNoColumn) {
        throw new Error("缺少物流单号列，请确认表格包含 CWB_NO、跟踪单号或物流单号。");
      }

      const trackingRows = rows
        .map((row, index) => parseTrackingImportRecord(row, index))
        .filter((row): row is TrackingImportRecord => Boolean(row));
      if (trackingRows.length === 0) throw new Error("没有读取到可用的物流单号");

      const pendingOrders = allOrders.filter(
        (order) => getOrderStage(order) === "pending_shipping",
      );
      if (pendingOrders.length === 0) {
        setNoticeMessage("当前没有待发货订单需要匹配物流单号。");
        return;
      }

      const pendingOrderRows = buildOrderDisplayRows(pendingOrders);
      const usedRowIndexes = new Set<number>();
      const matchedPairs = pendingOrderRows.flatMap((orderRow) => {
        const match = findTrackingMatch(orderRow.primaryOrder, trackingRows, usedRowIndexes);
        if (!match) return [];
        usedRowIndexes.add(match.rowIndex);
        return orderRow.orders.map((order) => ({ order, trackingRow: match }));
      });

      if (matchedPairs.length === 0) {
        setNoticeMessage(`未匹配到物流单号，${pendingOrders.length} 条待发货订单保持不变。`);
        return;
      }

      const saveEntries = matchedPairs.map(({ order, trackingRow }) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const updates = {
          ...draft,
          order_status: "已发货",
          actual_ship_time: "",
          logistics_tracking_no: trackingRow.trackingNo,
          logistics_status: "待查询",
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setActiveStage("shipped");
      setNoticeMessage(
        [
          `已匹配物流单号 ${nextOrders.length} 条并转入已发货`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          `未处理 ${pendingOrders.length - nextOrders.length} 条继续留在待发货`,
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "导入物流单号失败"));
    } finally {
      setBusyKey("");
      if (trackingInputRef.current) trackingInputRef.current.value = "";
    }
  }

  async function queryAndSaveTrackingStatuses(
    targetOrders: TemuOrderRecord[],
    busyName: string,
    showNotice = true,
  ) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新物流状态。");
      return;
    }

    const queryableOrders = targetOrders.filter(canQueryTrackingStatus);
    if (queryableOrders.length === 0) {
      if (showNotice) setNoticeMessage("当前没有可查询的物流单号。");
      return;
    }
    if (showNotice && !(await confirmAction(`确认查询并保存 ${queryableOrders.length} 条物流状态吗？`))) {
      return;
    }

    setBusyKey(busyName);
    if (showNotice) {
      setErrorMessage("");
      setNoticeMessage("");
    }

    try {
      const statusResults = await Promise.all(
        queryableOrders.map(async (order) => {
          try {
            const trackingResult = await fetchTrackingStatus(order);
            return { order, trackingResult };
          } catch {
            return { order, trackingResult: { status: "查询失败" } };
          }
        }),
      );

      const saveEntries = statusResults.map(({ order, trackingResult }) => {
        const updates = buildTrackingStatusUpdates(order, trackingResult);
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      if (showNotice) {
        const completedCount = statusResults.filter(({ trackingResult }) =>
          isDeliveredTrackingStatus(trackingResult.status),
        ).length;
        setNoticeMessage(
          [
            completedCount > 0
              ? `已查询 ${nextOrders.length} 条物流状态，自动完成 ${completedCount} 条订单`
              : `已查询 ${nextOrders.length} 条物流状态`,
            inventoryChanges.length > 0
              ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
              : "",
            failures.length > 0 ? `${failures.length} 条更新失败` : "",
          ].filter(Boolean).join("，"),
        );
      }
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "查询物流状态失败"));
    } finally {
      setBusyKey("");
    }
  }

  function buildOrderSaveUpdates(order: TemuOrderRecord) {
    const draft = drafts[order.id] ?? toDraft(order);
    return {
      ...draft,
      logistics_method: normalizeLogisticsMethod(draft.logistics_method),
      order_status:
        draft.order_status.trim() ||
        (draft.warehouse_id || draft.warehouse_name.trim() ? "新订单" : ""),
    };
  }

  function sanitizeOrderUpdatesForSave(
    order: TemuOrderRecord,
    updates: Parameters<typeof updateTemuOrder>[1],
  ) {
    const sanitizedUpdates = { ...updates };
    if (
      Object.prototype.hasOwnProperty.call(
        sanitizedUpdates,
        "actual_shipping_fee_rmb",
      )
    ) {
      const nextFee = normalizeRmbAmount(
        Number(sanitizedUpdates.actual_shipping_fee_rmb ?? 0),
      );
      if (nextFee === normalizeRmbAmount(order.actual_shipping_fee_rmb)) {
        delete sanitizedUpdates.actual_shipping_fee_rmb;
      } else {
        sanitizedUpdates.actual_shipping_fee_rmb = nextFee;
      }
    }
    return sanitizedUpdates;
  }

  async function saveOrderEntriesWithInventory(
    entries: Array<{
      order: TemuOrderRecord;
      updates: Parameters<typeof updateTemuOrder>[1];
      nextOrder: TemuOrderRecord;
    }>,
  ) {
    assertOrdersWarehouseLogisticsComplete(entries.map((entry) => entry.nextOrder));

    const nextOrders: TemuOrderRecord[] = [];
    const inventoryChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];
    const deductedInventoryChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];
    const restoredInventoryChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];
    const failures: Array<{ order: TemuOrderRecord; error: unknown }> = [];

    const collectInventoryChanges = (
      changes: Awaited<ReturnType<typeof deductInventoryForOrders>>,
    ) => {
      inventoryChanges.push(...changes);
      deductedInventoryChanges.push(...changes.filter((change) => change.change_quantity < 0));
      restoredInventoryChanges.push(...changes.filter((change) => change.change_quantity > 0));
    };

    for (const entry of entries) {
      const previousStage = getOrderStage(entry.order);
      const nextStage = getOrderStage(entry.nextOrder);
      const hadReservedInventory = shouldReserveOrderInventory(previousStage);
      const shouldReserveInventory = shouldReserveOrderInventory(nextStage);
      const shouldReleaseInventory = hadReservedInventory && !shouldReserveInventory;
      let entryReservationChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];
      let entryReleaseChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];

      try {
        if (shouldReserveInventory) {
          entryReservationChanges = await deductInventoryForOrders([entry.nextOrder]);
        } else if (shouldReleaseInventory) {
          entryReleaseChanges = await releaseInventoryForOrders(
            [entry.order],
            `订单库存释放：${getOrderLineLabel(entry.order)}`,
          );
        }

        const nextOrder = await updateTemuOrder(
          entry.order.id,
          sanitizeOrderUpdatesForSave(entry.order, entry.updates),
        );
        nextOrders.push(nextOrder);
        collectInventoryChanges(entryReservationChanges);
        collectInventoryChanges(entryReleaseChanges);
      } catch (error) {
        if (shouldReserveInventory && entryReservationChanges.length > 0) {
          try {
            if (hadReservedInventory) {
              await deductInventoryForOrders([entry.order]);
            } else {
              await releaseInventoryForOrders(
                [entry.nextOrder],
                `订单保存失败释放库存：${getOrderLineLabel(entry.nextOrder)}`,
              );
            }
          } catch (rollbackError) {
            throw new Error(
              `${getOrdersErrorMessage(error, "保存订单失败")}；库存占用已变更但订单保存失败，且库存回滚失败：${getOrdersErrorMessage(
                rollbackError,
                "库存回滚失败",
              )}`,
              { cause: rollbackError },
            );
          }
        } else if (shouldReleaseInventory && entryReleaseChanges.length > 0) {
          try {
            await deductInventoryForOrders([entry.order]);
          } catch (rollbackError) {
            throw new Error(
              `${getOrdersErrorMessage(error, "保存订单失败")}；库存已释放但订单保存失败，且库存回滚失败：${getOrdersErrorMessage(
                rollbackError,
                "库存回滚失败",
              )}`,
              { cause: rollbackError },
            );
          }
        }

        failures.push({ order: entry.order, error });
      }
    }

    return {
      nextOrders,
      inventoryChanges,
      deductedInventoryChanges,
      restoredInventoryChanges,
      failures,
    };
  }

  function formatInventoryChangeSummary(
    changes: Awaited<ReturnType<typeof saveOrderEntriesWithInventory>>,
  ) {
    return [
      changes.deductedInventoryChanges.length > 0
        ? `扣减 ${changes.deductedInventoryChanges.length} 项 SKU 库存`
        : "",
      changes.restoredInventoryChanges.length > 0
        ? `回补 ${changes.restoredInventoryChanges.length} 项 SKU 库存`
        : "",
    ].filter(Boolean).join("，");
  }

  async function handleSaveSelectedOrders() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }
    if (selectedOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要保存的订单。");
      return;
    }
    if (!(await confirmSave(`确认保存已选中的 ${selectedOrdersInView.length} 条订单吗？`))) return;

    setBusyKey("save-selected");
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const saveEntries = selectedOrdersInView.map((order) => {
        const updates = buildOrderSaveUpdates(order);
        const nextOrder = { ...order, ...updates };
        return { order, updates, nextOrder };
      });
      const saveResult = await saveOrderEntriesWithInventory(saveEntries);
      const { nextOrders, failures } = saveResult;
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }
      updateOrdersState(nextOrders);
      setNoticeMessage(
        [
          `已保存 ${nextOrders.length} 条订单`,
          formatInventoryChangeSummary(saveResult),
          failures.length > 0 ? `${failures.length} 条保存失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "保存订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleMoveSelectedNewOrdersToPendingAssignment() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能退回订单。");
      return;
    }
    if (selectedNewOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要退回待分配的新订单。");
      return;
    }

    const targetOrders = selectedNewOrdersInView.map((order) => mergeOrderDraft(order));
    const targetIds = new Set(targetOrders.map((order) => order.id));
    const pendingAssignmentUpdates: Parameters<typeof updateTemuOrder>[1] = {
      order_status: "",
      warehouse_id: null,
      warehouse_name: "",
      logistics_method: "",
      label_printed_at: "",
      logistics_tracking_no: "",
      logistics_status: "",
      actual_ship_time: "",
      actual_signed_time: "",
    };
    if (!(await confirmAction(`确认退回 ${targetOrders.length} 条订单到待分配吗？`))) return;

    setBusyKey("new-to-pending-assignment");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const saveEntries = targetOrders.map((order) => ({
        order,
        updates: pendingAssignmentUpdates,
        nextOrder: { ...order, ...pendingAssignmentUpdates },
      }));
      const saveResult = await saveOrderEntriesWithInventory(saveEntries);
      if (saveResult.nextOrders.length === 0 && saveResult.failures.length > 0) {
        throw saveResult.failures[0].error;
      }

      updateOrdersState(saveResult.nextOrders);
      clearDrafts(Array.from(targetIds));
      setSelectedOrderIds((current) => current.filter((id) => !targetIds.has(id)));
      setActiveStage("pending_assignment");
      setNoticeMessage(
        [
          `已退回待分配 ${saveResult.nextOrders.length} 条订单`,
          formatInventoryChangeSummary(saveResult),
          saveResult.failures.length > 0 ? `${saveResult.failures.length} 条退回失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "退回待分配失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleMoveSelectedPendingShippingOrdersToNewOrder() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能退回订单。");
      return;
    }
    if (selectedPendingShippingOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要退回新订单的待发货订单。");
      return;
    }

    const targetOrders = selectedPendingShippingOrdersInView.map((order) => mergeOrderDraft(order));
    const targetIds = new Set(targetOrders.map((order) => order.id));
    if (!(await confirmAction(`确认退回 ${targetOrders.length} 条订单到新订单吗？`))) return;

    setBusyKey("pending-shipping-to-new-order");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const saveEntries = targetOrders.map((order) => {
        const updates = {
          order_status: "新订单",
          warehouse_id: order.warehouse_id,
          warehouse_name: order.warehouse_name,
          logistics_method: order.logistics_method,
          label_printed_at: "",
          logistics_tracking_no: "",
          logistics_status: "",
          actual_ship_time: "",
          actual_signed_time: "",
        };

        return {
          order,
          updates,
          nextOrder: { ...order, ...updates },
        };
      });
      const { nextOrders, failures } = await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      clearDrafts(Array.from(targetIds));
      setSelectedOrderIds((current) => current.filter((id) => !targetIds.has(id)));
      setActiveStage("new_order");
      setNoticeMessage(
        [
          `已退回新订单 ${buildOrderDisplayRows(nextOrders).length} 行订单`,
          failures.length > 0 ? `${failures.length} 条退回失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "退回新订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSaveActualShipTimeForOrders(targetOrders: TemuOrderRecord[]) {
    if (!canEdit) return;

    const changedOrders = targetOrders.filter((order) => {
      if (getOrderStage(mergeOrderDraft(order)) !== "uploaded_temu") return false;
      const nextActualShipTime = (drafts[order.id] ?? toDraft(order)).actual_ship_time.trim();
      return nextActualShipTime !== order.actual_ship_time.trim();
    });
    if (changedOrders.length === 0) return;
    if (!(await confirmSave(`确认保存 ${changedOrders.length} 条订单明细的实际发货时间吗？`))) return;

    setBusyKey(`actual-ship-time-${changedOrders.map((order) => order.id).join("|")}`);
    setErrorMessage("");

    try {
      const saveEntries = changedOrders.map((order) => {
        const updates = {
          actual_ship_time: (drafts[order.id] ?? toDraft(order)).actual_ship_time.trim(),
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }
      updateOrdersState(nextOrders);
      setNoticeMessage(
        [
          `已保存 ${nextOrders.length} 条订单明细的实际发货时间`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          failures.length > 0 ? `${failures.length} 条保存失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "保存实际发货时间失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDeleteSelectedOrders() {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }
    if (selectedOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要删除的订单。");
      return;
    }
    if (hasSelectedCompletedOrders) {
      setErrorMessage("已完成订单不能删除。");
      return;
    }

    if (!(await confirmDelete(`当前列表中已选中的 ${selectedOrdersInView.length} 条订单`))) return;

    const targetIds = new Set(selectedOrdersInView.map((order) => order.id));
    setBusyKey("delete-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const inventoryChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];

      for (const order of selectedOrdersInView) {
        const shouldReleaseInventory = shouldReserveOrderInventory(getOrderStage(order));
        let entryReleaseChanges: Awaited<ReturnType<typeof deductInventoryForOrders>> = [];

        try {
          if (shouldReleaseInventory) {
            entryReleaseChanges = await releaseInventoryForOrders(
              [order],
              `删除订单释放库存：${getOrderLineLabel(order)}`,
            );
          }
          await deleteTemuOrder(order.id);
          inventoryChanges.push(...entryReleaseChanges);
        } catch (error) {
          if (entryReleaseChanges.length > 0) {
            try {
              await deductInventoryForOrders([order]);
            } catch (rollbackError) {
              throw new Error(
                `${getOrdersErrorMessage(error, "删除订单失败")}；库存已释放但订单删除失败，且库存回滚失败：${getOrdersErrorMessage(
                  rollbackError,
                  "库存回滚失败",
                )}`,
                { cause: rollbackError },
              );
            }
          }
          throw error;
        }
      }

      removeOrders(Array.from(targetIds));
      setSelectedOrderIds((current) => current.filter((id) => !targetIds.has(id)));
      clearDrafts(Array.from(targetIds));
      setNoticeMessage(
        inventoryChanges.length > 0
          ? `已删除 ${targetIds.size} 条订单，并回补 ${inventoryChanges.length} 项 SKU 库存`
          : `已删除 ${targetIds.size} 条订单`,
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "删除订单失败，请重试"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleBulkAssign() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能批量分配订单。");
      return;
    }
    if (activeStage !== "pending_assignment") {
      setNoticeMessage("只有待分配页面可以批量修改仓库和发货方式。");
      return;
    }
    const pendingSelectedOrders = selectedOrdersInView.filter(
      (order) => getOrderStage(mergeOrderDraft(order)) === "pending_assignment",
    );
    if (pendingSelectedOrders.length === 0) {
      setNoticeMessage("请先勾选要批量分配的订单。");
      return;
    }

    const selectedWarehouse = selectedBulkWarehouse;
    if (bulkWarehouseId && !selectedWarehouse) {
      setErrorMessage("选择的仓库不存在，请重新选择。");
      return;
    }

    const logisticsMethod = normalizeLogisticsMethod(bulkLogisticsMethod);
    if (!selectedWarehouse && !logisticsMethod) {
      setNoticeMessage("请选择仓库或填写发货方式后再批量分配。");
      return;
    }
    if (
      selectedWarehouse &&
      logisticsMethod &&
      !isConfiguredLogisticsMethodAllowedForWarehouse(
        selectedWarehouse.id,
        logisticsMethod,
        logisticsMethods,
        warehouseLogisticsMethods,
      )
    ) {
      setErrorMessage(`${selectedWarehouse.name} 不能使用“${logisticsMethod}”发货方式。`);
      return;
    }
    if (!(await confirmSave(`确认批量分配 ${pendingSelectedOrders.length} 条订单吗？`))) return;

    setBusyKey("bulk-assign");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const assignEntries = pendingSelectedOrders.map((order) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const nextWarehouseName = selectedWarehouse
          ? selectedWarehouse.name
          : draft.warehouse_name;
        const nextWarehouseId = selectedWarehouse
          ? selectedWarehouse.id
          : draft.warehouse_id;
        const nextLogisticsMethod = logisticsMethod || draft.logistics_method;
        const nextDraft: OrderDraft = {
          ...draft,
          warehouse_id: nextWarehouseId,
          warehouse_name: nextWarehouseName,
          logistics_method:
            nextWarehouseId &&
            isConfiguredLogisticsMethodAllowedForWarehouse(
              nextWarehouseId,
              nextLogisticsMethod,
              logisticsMethods,
              warehouseLogisticsMethods,
            )
              ? nextLogisticsMethod
              : "",
        };
        const updates = {
          ...nextDraft,
          order_status:
            nextDraft.order_status.trim() ||
            (nextDraft.warehouse_id || nextDraft.warehouse_name.trim() ? "新订单" : ""),
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(assignEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setNoticeMessage(
        [
          `已批量分配 ${nextOrders.length} 条订单`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          failures.length > 0 ? `${failures.length} 条因库存或保存失败未分配` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "批量分配订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleAutoMatchPendingOrders() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能自动匹配订单。");
      return;
    }
    if (activeStage !== "pending_assignment") {
      setNoticeMessage("请先切换到待分配页面再自动匹配。");
      return;
    }
    if (warehouses.length === 0) {
      setNoticeMessage("没有读取到可用仓库，请先确认仓库资料或执行库存共享迁移。");
      return;
    }
    if (warehouseSkus.length === 0) {
      setNoticeMessage("没有读取到仓库 SKU 库存，请先确认库存资料或执行库存共享迁移。");
      return;
    }
    const targetOrders = (
      selectedOrderLineInViewCount > 0 ? selectedOrdersInView : filteredOrders
    ).filter((order) => getOrderStage(mergeOrderDraft(order)) === "pending_assignment");
    if (targetOrders.length === 0) {
      setNoticeMessage("当前没有需要匹配的待分配订单。");
      return;
    }

    const availableStockByKey = new Map(
      warehouseSkus.map((stock) => [
        `${stock.warehouse_id}:${stock.sku_id}`,
        stock.stock_quantity,
      ]),
    );
    const blockedReasons: string[] = [];
    const targetGroupKeys = new Set(
      targetOrders.map((order) => getOrderDisplayGroupKey(order)),
    );
    const targetOrderGroups = buildOrderDisplayRows(
      allOrders.filter((order) => targetGroupKeys.has(getOrderDisplayGroupKey(order))),
    );
    const matchedOrders: Array<{ order: TemuOrderRecord } & OrderFulfillmentMatch> = [];
    let matchedOrderGroupCount = 0;

    targetOrderGroups.forEach((orderGroup) => {
      const groupOrders = orderGroup.orders;
      const orderLabel = orderGroup.primaryOrder.order_no.trim() || getOrderLineLabel(orderGroup.primaryOrder);
      const pendingOrders = groupOrders.filter(
        (order) => getOrderStage(mergeOrderDraft(order)) === "pending_assignment",
      );

      if (pendingOrders.length !== groupOrders.length) {
        blockedReasons.push(
          `订单 ${orderLabel} 已存在部分 SKU 被分配，自动匹配不会继续拆分订单，请手动处理整单。`,
        );
        return;
      }

      const groupAvailableStockByKey = new Map(availableStockByKey);
      const groupMatches: Array<{ order: TemuOrderRecord } & OrderFulfillmentMatch> = [];

      for (const order of groupOrders) {
        const matchResult = matchOrderFulfillment(order, groupAvailableStockByKey);
        if (matchResult.status === "blocked") {
          blockedReasons.push(matchResult.reason);
          return;
        }
        if (matchResult.status !== "matched") {
          blockedReasons.push(
            `订单 ${orderLabel} 含未匹配 SKU（${getOrderLineLabel(order)}），整单保持未匹配。`,
          );
          return;
        }

        const matched = matchResult.match;
        const reserved = reserveOrderInventory(
          matched.warehouse.id,
          matched.sku,
          matched.quantity,
          groupAvailableStockByKey,
        );
        if (!reserved) {
          blockedReasons.push(
            `订单 ${orderLabel} 的 ${getOrderLineLabel(order)} SKU 库存不足，整单保持未匹配。`,
          );
          return;
        }
        groupMatches.push({ order, ...matched });
      }

      availableStockByKey.clear();
      groupAvailableStockByKey.forEach((quantity, stockKey) => {
        availableStockByKey.set(stockKey, quantity);
      });
      matchedOrders.push(...groupMatches);
      matchedOrderGroupCount += 1;
    });

    if (matchedOrders.length === 0) {
      if (blockedReasons.length > 0) {
        setErrorMessage(formatAutoMatchBlockedReasons(blockedReasons));
        setNoticeMessage("没有自动匹配订单。");
        return;
      }
      setNoticeMessage("没有找到 SKU 库存充足且可用发货方式的订单。");
      return;
    }
    if (!(await confirmAction(`确认自动匹配并保存 ${matchedOrders.length} 条订单明细吗？`))) return;

    setBusyKey("auto-match");
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const matchedEntries = matchedOrders.map(({ order, warehouse, logisticsMethod }) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const updates = {
          ...draft,
          order_status: "新订单",
          warehouse_id: warehouse.id,
          warehouse_name: warehouse.name,
          logistics_method: logisticsMethod,
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(matchedEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      const skippedCount = targetOrders.length - nextOrders.length;
      if (blockedReasons.length > 0) {
        setErrorMessage(formatAutoMatchBlockedReasons(blockedReasons));
      }
      setNoticeMessage(
        [
          `已自动匹配 ${matchedOrderGroupCount} 个订单（${nextOrders.length} 条明细）`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          skippedCount > 0 ? `${skippedCount} 条因 SKU、库存、尺寸或保存失败未匹配` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "自动匹配订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  function getSkuPurchaseTotalRmb(sku: ProductSku) {
    return sku.component_links.reduce((total, link) => {
      const item = productItemsById.get(link.item_id);
      if (!item) return total;

      const quantity = Math.max(0, link.quantity);
      const purchaseCost = item.purchase_price_rmb * quantity;
      const purchaseShipping = calculatePurchaseShippingRmb(item, quantity);
      return total + purchaseCost + purchaseShipping;
    }, 0);
  }

  function getDeclarationUnitPriceUsd(sku: ProductSku) {
    const purchaseTotalUsd = getSkuPurchaseTotalRmb(sku) / rmbPerUsdForDeclaration;
    return Number(Math.max(5, purchaseTotalUsd).toFixed(2));
  }

  function validateOrdersReadyForFulfillment(targetOrders: TemuOrderRecord[], requireLogistics = true) {
    const mergedOrders = targetOrders.map((order) => mergeOrderDraft(order));
    const missingWarehouse = mergedOrders.find(
      (order) => !order.warehouse_id && !order.warehouse_name.trim(),
    );
    if (missingWarehouse) return `订单 ${missingWarehouse.order_no} 还没有分配仓库。`;

    if (requireLogistics) {
      const missingLogistics = mergedOrders.find((order) => !order.logistics_method.trim());
      if (missingLogistics) return `订单 ${missingLogistics.order_no} 还没有填写物流方式。`;
    }

    const missingRecipient = mergedOrders.find((order) => !hasCompleteRecipientInfo(order));
    if (missingRecipient) {
      return `订单 ${missingRecipient.order_no} 缺少收件人信息，请重新上传包含收件信息的 Temu 订单表。`;
    }

    const missingProduct = mergedOrders.find((order) => !getOrderDeclaration(order));
    if (missingProduct) return `订单 ${missingProduct.order_no} 没有匹配到商品 SKU，不能生成发货表格。`;

    const missingEnglishName = mergedOrders.find((order) => {
      const declaration = getOrderDeclaration(order);
      return !declaration?.product.product_name_en.trim();
    });
    if (missingEnglishName) return `订单 ${missingEnglishName.order_no} 对应商品还没有填写英文品名。`;

    const missingMaterial = mergedOrders.find((order) => {
      const declaration = getOrderDeclaration(order);
      return !declaration?.product.material_en.trim();
    });
    if (missingMaterial) return `订单 ${missingMaterial.order_no} 对应商品还没有填写英文材质。`;

    return "";
  }

  function buildOrderStockDeductions(targetOrders: TemuOrderRecord[]) {
    const deductions: OrderStockDeduction[] = [];

    for (const order of targetOrders) {
      const warehouseId = order.warehouse_id;
      if (!warehouseId) {
        return {
          errorMessage: `订单 ${order.order_no} 还没有分配仓库。`,
          deductions: [] as OrderStockDeduction[],
        };
      }

      const sku = getOrderSku(order);
      if (!sku?.id) {
        return {
          errorMessage: `订单 ${order.order_no} 没有匹配到商品 SKU，不能扣减库存。`,
          deductions: [] as OrderStockDeduction[],
        };
      }
      const orderQuantity = getOrderFulfillmentQuantity(order);
      const warehouseName =
        order.warehouse_name ||
        warehouses.find((warehouse) => warehouse.id === warehouseId)?.name ||
        "未命名仓库";

      const stock = warehouseSkusByKey.get(`${warehouseId}:${sku.id}`);
      if (!stock) {
        return {
          errorMessage: `订单 ${order.order_no} 的 SKU 没有加入 ${warehouseName} 的仓库库存。`,
          deductions: [] as OrderStockDeduction[],
        };
      }

      deductions.push({
        orderId: order.id,
        stock,
        quantity: orderQuantity,
        warehouseName,
        orderNo: order.order_no,
        orderLineLabel: getOrderLineLabel(order),
      });
    }

    if (deductions.length === 0) {
      return {
        errorMessage: "没有找到需要扣减的 SKU 库存，请检查商品 SKU 和仓库库存。",
        deductions: [] as OrderStockDeduction[],
      };
    }

    return { errorMessage: "", deductions };
  }

  async function deductInventoryForOrders(targetOrders: TemuOrderRecord[]) {
    if (targetOrders.length === 0) return [];

    const stockDeductionResult = buildOrderStockDeductions(targetOrders);
    if (stockDeductionResult.errorMessage) {
      throw new Error(stockDeductionResult.errorMessage);
    }

    const inventoryChanges: Array<{
      sku: WarehouseSku;
      previous_quantity: number;
      change_quantity: number;
    }> = [];

    for (const deduction of stockDeductionResult.deductions) {
      const entryChanges = await reserveWarehouseSkuStockForOrder({
        orderId: deduction.orderId,
        stockId: deduction.stock.id,
        quantity: deduction.quantity,
        reason: `订单库存占用：${deduction.orderLineLabel}`,
      });
      inventoryChanges.push(...entryChanges);
    }

    applyWarehouseSkuStockUpdates(inventoryChanges.map((change) => change.sku));
    return inventoryChanges;
  }

  async function releaseInventoryForOrders(targetOrders: TemuOrderRecord[], reason: string) {
    if (targetOrders.length === 0) return [];

    const inventoryChanges: Array<{
      sku: WarehouseSku;
      previous_quantity: number;
      change_quantity: number;
    }> = [];

    for (const order of targetOrders) {
      const entryChanges = await releaseWarehouseSkuStockForOrder(order.id, reason);
      inventoryChanges.push(...entryChanges);
    }

    applyWarehouseSkuStockUpdates(inventoryChanges.map((change) => change.sku));
    return inventoryChanges;
  }

  function buildOcsSheet1Rows(targetOrders: TemuOrderRecord[]) {
    return buildOrderDisplayRows(targetOrders).map((row) => {
      const merged = row.primaryOrder;
      return {
        收件人: formatRecipientName(merged.recipient_name),
        收件人地址: getFullAddress(merged),
        收件邮编: merged.postal_code,
        收件电话: formatRecipientPhone(merged.recipient_phone),
        件数: 1,
        "目的地(可以都填TYO)": "TYO",
        订单号: merged.order_no,
        "服务类型(不填写默认B2C)": "NEP",
        店铺名称: "",
        店铺备注: "",
        发件人: "",
        发件人地址: "",
        发件人电话: "",
        发件人邮编: "",
        店铺: "",
        自定义重量: "",
        "是否带电(0:不带电/1:带电)": 0,
        平台名称: "TEMU",
        生产销售单位: "",
        生产销售单位统一编码: "",
      };
    });
  }

  function buildOcsSheet2Rows(targetOrders: TemuOrderRecord[]) {
    return buildOrderDisplayRows(targetOrders).flatMap((row) => {
      const declarationGroups = new Map<
        string,
        {
          order: TemuOrderRecord;
          declaration: { sku: ProductSku; product: Product };
          quantity: number;
        }
      >();

      row.orders.forEach((order) => {
        const declaration = getOrderDeclaration(order);
        if (!declaration) return;
        const key = [
          declaration.sku.id ?? declaration.sku.sku_code,
          normalizeSalesSpec(order.product_attributes),
        ].join("\u0000");
        const current = declarationGroups.get(key);
        declarationGroups.set(key, {
          order: current?.order ?? order,
          declaration: current?.declaration ?? declaration,
          quantity: (current?.quantity ?? 0) + getOrderFulfillmentQuantity(order),
        });
      });

      return Array.from(declarationGroups.values()).map((group, index) => ({
        订单号: row.primaryOrder.order_no,
        商品代码: index + 1,
        品名: group.declaration.product.product_name_en,
        描述: group.declaration.product.material_en,
        商品数量: group.quantity,
        单价: getDeclarationUnitPriceUsd(group.declaration.sku),
        币值: "USD",
        编制方式: "",
        HS_CODE: "",
        原产国: "CN",
        货架号: "",
        采购编号: "",
        样式颜色: formatStyleColorForDeclaration(group.order.product_attributes),
        客户备注: `${group.declaration.product.product_name_en} ${group.declaration.product.product_code}`.trim(),
        URL: "",
        PRIMARYKEY: "",
        国内申报价值: "",
        国内申报币值: "",
      }));
    });
  }

  async function downloadOcsShippingWorkbook(targetOrders: TemuOrderRecord[]) {
    const workbook = await createWorkbook();
    addObjectSheet(workbook, "Sheet1", buildOcsSheet1Rows(targetOrders));
    addObjectSheet(workbook, "Sheet2", buildOcsSheet2Rows(targetOrders));
    await downloadWorkbook(workbook, `OCS-3cm-发货表格-${formatFileTimestamp()}.xlsx`);
  }

  function validateOrdersReadyForTemuUpload(targetOrders: TemuOrderRecord[]) {
    const mergedOrders = targetOrders.map((order) => mergeOrderDraft(order));

    const missingSubOrderNo = mergedOrders.find((order) => !order.sub_order_no.trim());
    if (missingSubOrderNo) {
      return `订单 ${missingSubOrderNo.order_no} 还没有子订单号，不能生成上传 Temu 表格。`;
    }

    const missingTrackingNo = mergedOrders.find(
      (order) => !order.logistics_tracking_no.trim(),
    );
    if (missingTrackingNo) {
      return `订单 ${missingTrackingNo.order_no} 还没有物流单号，不能生成上传 Temu 表格。`;
    }

    return "";
  }

  function buildTemuUploadRows(targetOrders: TemuOrderRecord[]) {
    return targetOrders.map((order) => {
      const merged = mergeOrderDraft(order);

      return {
        订单号: merged.order_no,
        子订单号: merged.sub_order_no,
        商品件数: getOrderFulfillmentQuantity(merged),
        跟踪单号: merged.logistics_tracking_no.trim(),
        物流承运商: getTemuUploadCarrier(merged),
        发货仓库名称: temuUploadWarehouseName,
      };
    });
  }

  async function downloadTemuUploadWorkbook(targetOrders: TemuOrderRecord[]) {
    const workbook = await createWorkbook();
    addObjectSheet(workbook, "Sheet1", buildTemuUploadRows(targetOrders), {
      headers: [...temuUploadColumns],
      columnWidths: [28, 28, 10, 18, 14, 16],
    });
    await downloadWorkbook(workbook, `Temu上传发货表格-${formatFileTimestamp()}.xlsx`);
  }

  async function handleMoveNewOrdersToPendingShipping(
    targetOrders: TemuOrderRecord[],
    busyName: string,
  ) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }
    if (targetOrders.length === 0) {
      setNoticeMessage("当前没有可转入待发货的订单。");
      return;
    }

    const mergedOrders = targetOrders.map((order) => mergeOrderDraft(order));
    const validationMessage = validateOrdersReadyForFulfillment(mergedOrders, false);
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }
    if (!(await confirmAction(`确认将 ${targetOrders.length} 条订单转入待发货吗？`))) return;

    setBusyKey(busyName);
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const printedAt = formatLocalDateTime();
      const saveEntries = targetOrders.map((order, index) => {
        const mergedOrder = mergedOrders[index];
        const updates = {
          order_status: "待发货",
          warehouse_id: mergedOrder.warehouse_id,
          warehouse_name: mergedOrder.warehouse_name,
          logistics_method: mergedOrder.logistics_method,
          label_printed_at: printedAt,
          actual_ship_time: mergedOrder.actual_ship_time,
          actual_signed_time: mergedOrder.actual_signed_time,
        };
        return {
          order,
          updates,
          nextOrder: { ...mergedOrder, ...updates },
        };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      setActiveStage("pending_shipping");
      setNoticeMessage(
        [
          `已转入待发货 ${buildOrderDisplayRows(nextOrders).length} 行订单，请下载发货表格`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          failures.length > 0 ? `${failures.length} 条转入失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "转入待发货失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDownloadShippingTable(targetOrders: TemuOrderRecord[], busyName: string) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能下载发货表格。");
      return;
    }
    if (targetOrders.length === 0) {
      setNoticeMessage("当前没有可下载发货表格的订单。");
      return;
    }

    const validationMessage = validateOrdersReadyForFulfillment(targetOrders);
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setBusyKey(busyName);
    setErrorMessage("");
    setNoticeMessage("");

    try {
      await downloadOcsShippingWorkbook(targetOrders);
      setNoticeMessage(`已下载 ${buildOrderDisplayRows(targetOrders).length} 行 OCS 3cm 发货表格`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "下载发货表格失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDownloadTemuUploadTable(
    targetOrders: TemuOrderRecord[],
    busyName: string,
  ) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能下载上传 Temu 表格。");
      return;
    }
    if (targetOrders.length === 0) {
      setNoticeMessage("请先勾选要下载上传 Temu 表格的已发货订单。");
      return;
    }

    const validationMessage = validateOrdersReadyForTemuUpload(targetOrders);
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setBusyKey(busyName);
    setErrorMessage("");
    setNoticeMessage("");

    try {
      await downloadTemuUploadWorkbook(targetOrders);
      setNoticeMessage(`已下载 ${targetOrders.length} 条订单的上传 Temu 表格`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "下载上传 Temu 表格失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleMarkSelectedUploadedTemu() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }
    if (selectedShippedOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要标记已上传 Temu 的已发货订单。");
      return;
    }
    if (!(await confirmAction(`确认标记 ${selectedShippedOrdersInView.length} 条订单为上传 Temu 吗？`))) return;

    setBusyKey("uploaded-temu-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const saveEntries = selectedShippedOrdersInView.map((order) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const shippedAt = formatLocalDateTime();
        const printedAt = draft.label_printed_at.trim() || formatLocalDateTime();

        const updates = {
          ...draft,
          order_status: uploadedTemuOrderStatus,
          label_printed_at: printedAt,
          actual_ship_time: shippedAt,
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }
      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setActiveStage("uploaded_temu");
      setNoticeMessage(
        [
          `已标记 ${nextOrders.length} 条订单为上传Temu`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          failures.length > 0 ? `${failures.length} 条更新失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "标记上传Temu失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleMarkSelectedCompleted() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }
    if (selectedCompletableOrdersInView.length === 0) {
      setNoticeMessage("请先在上传Temu页面勾选要标记签收的订单。");
      return;
    }
    if (!(await confirmAction(`确认标记签收 ${selectedCompletableOrdersInView.length} 条订单吗？`))) return;

    setBusyKey("complete-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const saveEntries = selectedCompletableOrdersInView.map((order) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const finishedAt = draft.actual_signed_time.trim() || formatLocalDateTime();
        const printedAt = draft.label_printed_at.trim() || formatLocalDateTime();

        const updates = {
          ...draft,
          order_status: "已完成",
          label_printed_at: printedAt,
          actual_ship_time: draft.actual_ship_time.trim(),
          actual_signed_time: finishedAt,
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }
      updateOrdersState(nextOrders);
      setNoticeMessage(
        [
          `已标记签收 ${nextOrders.length} 条订单`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          failures.length > 0 ? `${failures.length} 条更新失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "标记签收失败"));
    } finally {
      setBusyKey("");
    }
  }

  const activeStageMeta = getStageDefinition(activeStage);
  const activeOrderViewLabel = showUrgentUnuploadedOnly
    ? "即将逾期未发货"
    : activeStageMeta.label;
  const activeOrderViewTone = showUrgentUnuploadedOnly ? "danger" : activeStageMeta.tone;

  return (
    <section className="grid gap-5">
      <PageHeader
        title="订单管理"
        description="上传 Temu 导出的订单表，按仓库分配、下载发货表格并跟进签收流程"
        actions={
          canEdit ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                className="hidden"
                onChange={(event) => void handleFileChange(event.target.files?.[0])}
              />
              <input
                ref={trackingInputRef}
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                className="hidden"
                onChange={(event) => void handleTrackingFileChange(event.target.files?.[0])}
              />
              <button
                type="button"
                disabled={busyKey === "tracking-import"}
                onClick={() => trackingInputRef.current?.click()}
                className="btn-secondary"
              >
                <Upload size={18} />
                上传物流单号
              </button>
              <button
                type="button"
                disabled={busyKey === "import"}
                onClick={() => inputRef.current?.click()}
                className="btn-primary"
              >
                <Upload size={18} />
                上传订单表
              </button>
            </>
          ) : null
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {noticeMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {noticeMessage}
        </div>
      )}
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}

      <OrderFilters
        activeStage={activeStage}
        stages={stageDefinitions}
        stageCounts={stageCounts}
        search={search}
        warehouseFilter={warehouseFilter}
        warehouseOptions={warehouses}
        logisticsMethodFilter={logisticsMethodFilter}
        logisticsMethodOptions={logisticsMethodOptions}
        urgentUnuploadedCount={urgentUnuploadedOrders.length}
        showUrgentUnuploadedOnly={showUrgentUnuploadedOnly}
        onSearchChange={setSearch}
        onStageChange={(stage) => {
          setActiveStage(stage as OrderStage);
          setOrderSort(defaultOrderSort);
          setSelectedOrderIds([]);
          setShowUrgentUnuploadedOnly(false);
          setPage(1);
        }}
        onWarehouseFilterChange={(warehouseId) => {
          setWarehouseFilter(warehouseId);
          setSelectedOrderIds([]);
          setPage(1);
        }}
        onLogisticsMethodFilterChange={(method) => {
          setLogisticsMethodFilter(method);
          setSelectedOrderIds([]);
          setPage(1);
        }}
        onShowUrgentUnuploadedOnly={() => {
          setActiveStage("all");
          setOrderSort(defaultOrderSort);
          setSelectedOrderIds([]);
          setShowUrgentUnuploadedOnly(true);
          setPage(1);
        }}
      />

      <section className="surface-card grid gap-4 p-4 min-w-0 w-full overflow-hidden">
        <div className="grid gap-3 border-b border-slate-100 pb-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
              <FileSpreadsheet size={18} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">Temu 订单数据</h2>
                <Badge tone={activeOrderViewTone}>{activeOrderViewLabel}</Badge>
              </div>
              <p className="mt-1 text-sm font-medium text-slate-500">
                当前显示 {paginatedOrderRows.length} 行，共 {filteredOrderRows.length} 行，覆盖 {filteredOrders.length} 个订单
              </p>
            </div>
          </div>
          {canEdit && isShippingTrackingStage(activeStage) && shippedOrdersWithTrackingInView.length > 0 && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto xl:justify-end">
              <button
                type="button"
                disabled={busyKey === "tracking-status-refresh" || busyKey === "tracking-status-auto"}
                onClick={() =>
                  void queryAndSaveTrackingStatuses(
                    shippedOrdersWithTrackingInView,
                    "tracking-status-refresh",
                  )
                }
                className="btn-secondary"
              >
                <RefreshCw size={18} />
                查询物流状态
              </button>
            </div>
          )}
        </div>

        <OrderBulkActions
          activeStage={activeStage}
          busyKey={busyKey}
          canDelete={canDelete}
          canEdit={canEdit}
          selectedOrderLineInViewCount={selectedOrderLineInViewCount}
          selectedInViewCount={selectedInViewCount}
          selectedNewOrderRowCount={selectedNewOrderRowCount}
          selectedPendingShippingRowCount={selectedPendingShippingRowCount}
          selectedShippedRowCount={selectedShippedRowCount}
          selectedUploadedTemuRowCount={selectedUploadedTemuRowCount}
          selectedNewOrdersInViewCount={selectedNewOrdersInView.length}
          selectedPendingShippingOrdersInViewCount={selectedPendingShippingOrdersInView.length}
          selectedCompletableOrdersInViewCount={selectedCompletableOrdersInView.length}
          selectedSingleOrderInView={Boolean(selectedSingleOrderInView)}
          canManageSelectedShippedOrders={canManageSelectedShippedOrders}
          hasSelectedCompletedOrders={hasSelectedCompletedOrders}
          bulkWarehouseId={bulkWarehouseId}
          bulkLogisticsMethod={bulkLogisticsMethod}
          bulkLogisticsMethodOptions={bulkLogisticsMethodOptions}
          warehouses={warehouses}
          filteredOrdersCount={filteredOrders.length}
          onClearSelection={() => setSelectedOrderIds([])}
          onShowSelectedDetail={() => {
            if (selectedSingleOrderInView) setDetailOrder(selectedSingleOrderInView);
          }}
          onMoveNewOrdersToPendingAssignment={() =>
            void handleMoveSelectedNewOrdersToPendingAssignment()
          }
          onMovePendingShippingOrdersToNewOrder={() =>
            void handleMoveSelectedPendingShippingOrdersToNewOrder()
          }
          onMoveNewOrdersToPendingShipping={() =>
            void handleMoveNewOrdersToPendingShipping(
              selectedNewOrdersInView,
              "download-batch",
            )
          }
          onSaveSelectedOrders={() => void handleSaveSelectedOrders()}
          onDownloadShippingTable={() =>
            void handleDownloadShippingTable(
              selectedPendingShippingOrdersInView,
              "download-shipping-table",
            )
          }
          onDownloadTemuUploadTable={() =>
            void handleDownloadTemuUploadTable(
              selectedShippedOrdersInView,
              "download-temu-upload-table",
            )
          }
          onMarkSelectedUploadedTemu={() => void handleMarkSelectedUploadedTemu()}
          onMarkSelectedCompleted={() => void handleMarkSelectedCompleted()}
          onDeleteSelectedOrders={() => void handleDeleteSelectedOrders()}
          onBulkWarehouseChange={(warehouseId) => {
            const warehouse = warehouses.find((item) => item.id === warehouseId);
            if (warehouse) {
              const status = getWarehouseLogisticsConfigStatus(
                warehouse.id,
                settings,
                logisticsMethods,
                warehouseLogisticsMethods,
              );
              if (!status.isComplete) {
                setErrorMessage(`仓库“${warehouse.name}”物流配置不完整，不能选择：${status.issue}`);
                return;
              }
            }
            setBulkWarehouseId(warehouseId);
            if (
              warehouse &&
              bulkLogisticsMethod &&
              !isConfiguredLogisticsMethodAllowedForWarehouse(
                warehouse.id,
                bulkLogisticsMethod,
                logisticsMethods,
                warehouseLogisticsMethods,
              )
            ) {
              setBulkLogisticsMethod("");
            }
          }}
          onBulkLogisticsMethodChange={setBulkLogisticsMethod}
          onBulkAssign={() => void handleBulkAssign()}
          onAutoMatchPendingOrders={() => void handleAutoMatchPendingOrders()}
          onCreateReshipOrder={() => setReshipTargetOrder(selectedSingleOrderInView)}
        />

        {loading ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm text-slate-500">
            加载中...
          </div>
        ) : filteredOrderRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm font-medium text-slate-500">
            暂无订单数据
          </div>
        ) : (
          <div className="shadow-none min-w-0 w-full overflow-hidden">
            <StandardTable
              page={page}
              pageSize={pageSize}
              totalPages={filteredTotalPages}
              totalRecordCount={filteredOrderRows.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              loading={loading}
              empty={filteredOrderRows.length === 0}
              columns={orderTableLayoutColumns}
              layout="fixed"
              minWidth="min-w-[1920px]"
              tableClassName="orders-table"
            >
                <thead>
                  <tr>
                    <th className="w-12 text-center" scope="col">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        disabled={paginatedOrderRows.length === 0}
                        onChange={(event) => toggleFilteredSelection(event.target.checked)}
                        aria-label="选择当前列表全部订单"
                        className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                      />
                    </th>
                    {tableColumns.map((column) => (
                      <th key={column.key} className={`text-sm font-semibold whitespace-nowrap ${column.className ?? ""}`} scope="col">
                        {column.sortable ? (
                          <button
                            type="button"
                            onClick={() => toggleOrderSort(column.key as OrderSortKey)}
                            className="inline-flex items-center gap-1 font-semibold text-inherit whitespace-nowrap"
                            title={`按${column.label}排序`}
                          >
                            <span>{column.label}</span>
                            {orderSort.key === column.key && (
                              <span aria-hidden="true">
                                {orderSort.direction === "asc" ? "↑" : "↓"}
                              </span>
                            )}
                          </button>
                        ) : (
                          column.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginatedOrderRows.map((orderRow) => (
                    <OrderTableRow
                      key={orderRow.id}
                      activeStage={activeStage}
                      canEdit={canEdit}
                      currentTime={currentTime}
                      logisticsMethods={logisticsMethods}
                      onHandleWarehouseChangeForOrders={handleWarehouseChangeForOrders}
                      onSaveActualShipTimeForOrders={handleSaveActualShipTimeForOrders}
                      onToggleOrderRowSelection={toggleOrderRowSelection}
                      onUpdateDraftForOrders={updateDraftForOrders}
                      ordersById={ordersById}
                      primaryDraft={drafts[orderRow.primaryOrder.id]}
                      productsById={productsById}
                      rowId={orderRow.id}
                      rowOrderIdsKey={orderRow.orders.map((item) => item.id).join("|")}
                      selectedOrderIdSet={selectedOrderIdSet}
                      skuOrderLookup={skuOrderLookup}
                      warehouseLogisticsMethods={warehouseLogisticsMethods}
                      warehouses={warehouses}
                    />
                  ))}
                </tbody>
            </StandardTable>
          </div>
        )}
      </section>

      {detailOrder && (
        <OrderDetailPanel
          orderNo={detailOrder.order_no}
          rows={getOrderDetailRows(detailOrder)}
          onClose={() => setDetailOrder(null)}
          canEdit={canEdit}
          onCreateReshipOrder={() => setReshipTargetOrder(detailOrder)}
        />
      )}

      {reshipTargetOrder && (
        <ReshipOrderModal
          originalOrder={reshipTargetOrder}
          relatedOrders={allOrders.filter(o => o.order_no === reshipTargetOrder.order_no)}
          productSkus={productSkus}
          products={products}
          onClose={() => setReshipTargetOrder(null)}
          onSuccess={handleReshipSuccess}
          setErrorMessage={setErrorMessage}
        />
      )}
    </section>
  );
}
