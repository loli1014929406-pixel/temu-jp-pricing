import type { User } from "@supabase/supabase-js";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Truck,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Badge, PageHeader } from "../components/ui";
import { isSameDraft, readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import {
  addObjectSheet,
  createWorkbook,
  downloadWorkbook,
  readTabularFileObjects,
} from "../lib/excel";
import {
  deductWarehouseItemStocks,
  fetchWarehouseItemStocks,
  fetchWarehouses,
  fetchWarehouseSkus,
  restoreWarehouseItemStockDeductions,
  type WarehouseItemStockRestorationInput,
} from "../lib/inventory";
import {
  deleteTemuOrder,
  fetchTemuOrders,
  importTemuOrders,
  updateTemuOrder,
  type TemuOrderImportRow,
} from "../lib/orders";
import {
  fetchProducts,
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
} from "../lib/products";
import type {
  Product,
  ProductItem,
  ProductSku,
  TemuOrderRecord,
  Warehouse,
  WarehouseItemStock,
  WarehouseSku,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";

type OrdersPageProps = {
  user: User;
};

type OrderStage =
  | "all"
  | "pending_assignment"
  | "new_order"
  | "pending_shipping"
  | "shipped"
  | "uploaded_temu"
  | "completed";

type OrderSortKey = "ship_deadline" | "delivery_deadline" | "product";
type OrderSortDirection = "asc" | "desc";
type OrderSort = {
  key: OrderSortKey;
  direction: OrderSortDirection;
};

type OrderDraft = Pick<
  TemuOrderRecord,
  | "order_status"
  | "warehouse_id"
  | "warehouse_name"
  | "logistics_method"
  | "label_printed_at"
  | "logistics_tracking_no"
  | "logistics_status"
  | "actual_ship_time"
  | "actual_signed_time"
>;

type OrdersDraftState = {
  drafts: Record<string, OrderDraft>;
  selectedOrderIds: string[];
  bulkWarehouseId: string;
  bulkLogisticsMethod: string;
};

function hasOrdersDraft(draft: OrdersDraftState | null | undefined) {
  return Boolean(
    draft &&
      (Object.keys(draft.drafts).length > 0 ||
        draft.selectedOrderIds.length > 0 ||
        draft.bulkWarehouseId ||
        draft.bulkLogisticsMethod),
  );
}

type TrackingImportRecord = {
  rowIndex: number;
  trackingNo: string;
  remark: string;
  refNo: string;
  phone: string;
  postalCode: string;
  recipientName: string;
  address: string;
  allText: string;
};

type OrderStockDeduction = {
  stock: WarehouseItemStock;
  quantity: number;
  itemName: string;
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

const importColumns = [
  "订单号",
  "子订单号",
  "订单状态",
  "SKU货号",
  "应履约件数",
  "商品属性",
  "收货人姓名",
  "收货人联系方式",
  "邮箱",
  "省份",
  "城市",
  "区县",
  "详细地址1",
  "详细地址2",
  "收货地址邮编",
  "要求最晚发货时间",
  "实际发货时间",
  "预计送达时间",
] as const;

const trackingImportColumns = ["CWB_NO", "REMARK"] as const;

const stageDefinitions = [
  { key: "all", label: "全部", tone: "neutral" },
  { key: "pending_assignment", label: "待分配", tone: "warning" },
  { key: "new_order", label: "新订单", tone: "info" },
  { key: "pending_shipping", label: "待发货", tone: "warning" },
  { key: "shipped", label: "已发货", tone: "success" },
  { key: "uploaded_temu", label: "上传Temu", tone: "info" },
  { key: "completed", label: "已完成", tone: "neutral" },
] satisfies Array<{
  key: OrderStage;
  label: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
}>;

const warehouseLogisticsRules = [
  { warehouseNameIncludes: "苏州", methods: ["OCS 3cm", "OCS 小包"] },
] as const;

const defaultLogisticsMethods = warehouseLogisticsRules.flatMap((rule) => [...rule.methods]);
const restrictedLogisticsMethods = new Set<string>(defaultLogisticsMethods);
const rmbPerUsdForDeclaration = 7;
const defaultOrderSort: OrderSort = { key: "ship_deadline", direction: "asc" };
const yamatoTrackingBaseUrl = "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko";
const uploadedTemuOrderStatus = "上传Temu";
const legacyUploadedTemuOrderStatus = "已上传Temu";
const temuUploadCarrier = "Yamato";
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
  { key: "stage", label: "流程状态" },
  { key: "ship_deadline", label: "发货时效", className: "order-time-col", sortable: true },
  { key: "delivery_deadline", label: "签收时效", className: "order-time-col", sortable: true },
  { key: "warehouse", label: "仓库" },
  { key: "logistics", label: "发货方式" },
  { key: "quantity", label: "数量" },
  { key: "product", label: "商品信息", className: "order-product-col", sortable: true },
  { key: "sales_spec", label: "销售规格", className: "order-attr-col" },
  { key: "logistics_tracking_no", label: "物流单号", className: "order-tracking-col", shippedOnly: true },
  { key: "logistics_status", label: "物流状态", className: "order-tracking-status-col", shippedOnly: true },
  { key: "recipient", label: "收件人" },
  { key: "phone", label: "电话", className: "order-phone-col" },
  { key: "address", label: "地址", className: "order-address-col" },
  { key: "postal_code", label: "邮编" },
  { key: "actual_ship_time", label: "实际发货时间", className: "order-time-col" },
] satisfies Array<{
  key: string;
  label: string;
  className?: string;
  sortable?: boolean;
  shippedOnly?: boolean;
}>;

function cleanCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text === "--" ? "" : text;
}

function readCell(row: Record<string, unknown>, column: (typeof importColumns)[number]) {
  return cleanCell(row[column]);
}

function readAnyCell(row: Record<string, unknown>, columns: readonly string[]) {
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      const value = cleanCell(row[column]);
      if (value) return value;
    }
  }
  return "";
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
  const text = value.trim();
  if (text === "OCS 昆山3cm" || text === "OCS 昆山 3cm") return "OCS 3cm";
  if (text === "OCS 昆山小包") return "OCS 小包";
  return text;
}

function isThreeCmLogisticsMethod(value: string) {
  const method = normalizeLogisticsMethod(value).replace(/\s+/g, "").toLowerCase();
  return (
    method === "ocs3cm" ||
    method === "日本邮便3cm" ||
    method === "日本郵便3cm" ||
    method === "japanpost3cm" ||
    method === "jp3cm"
  );
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

function SkuImageThumb({ product, sku }: { product: Product; sku: ProductSku }) {
  const imageUrl = sku.temu_image_url.trim();
  if (!imageUrl) return null;

  return (
    <img
      src={imageUrl}
      alt={`${product.product_name_cn} ${formatSkuSalesSpec(sku)}`.trim()}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
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

function getOrderLineLabel(order: Pick<TemuOrderRecord, "order_no" | "sub_order_no" | "id">) {
  const subOrderNo = order.sub_order_no.trim();
  return subOrderNo ? `${order.order_no} / ${subOrderNo}` : `${order.order_no} / ${order.id}`;
}

function isUploadedTemuStatus(value: string) {
  const status = value.trim().toLowerCase();
  return (
    status === uploadedTemuOrderStatus.toLowerCase() ||
    status === legacyUploadedTemuOrderStatus.toLowerCase()
  );
}

function isShippingTrackingStage(stage: OrderStage) {
  return stage === "shipped" || stage === "uploaded_temu";
}

function getOrderDedupStageRank(order: TemuOrderRecord) {
  if (order.actual_signed_time.trim()) return 6;
  if (isUploadedTemuStatus(order.order_status)) return 5;
  if (order.actual_ship_time.trim() || order.logistics_tracking_no.trim()) return 4;
  if (order.label_printed_at.trim()) return 3;
  if (order.warehouse_id || order.warehouse_name.trim()) return 2;
  if (order.order_status.trim()) return 1;
  return 0;
}

function shouldReplaceDuplicateOrder(
  current: TemuOrderRecord,
  candidate: TemuOrderRecord,
) {
  const currentStageRank = getOrderDedupStageRank(current);
  const candidateStageRank = getOrderDedupStageRank(candidate);
  if (candidateStageRank !== currentStageRank) {
    return candidateStageRank > currentStageRank;
  }

  return candidate.updated_at.localeCompare(current.updated_at) > 0;
}

function dedupeOrdersByOrderLine(orders: TemuOrderRecord[]) {
  const uniqueOrders = new Map<string, TemuOrderRecord>();

  orders.forEach((order) => {
    const key = getOrderLineKey(order);
    if (!key) return;

    const current = uniqueOrders.get(key);
    if (!current || shouldReplaceDuplicateOrder(current, order)) {
      uniqueOrders.set(key, order);
    }
  });

  return Array.from(uniqueOrders.values());
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
  const trackingNo = readAnyCell(row, ["CWB_NO", "CWB NO", "物流单号", "运单号", "单号"]);
  if (!trackingNo) return null;

  return {
    rowIndex: index + 2,
    trackingNo,
    remark: readAnyCell(row, ["REMARK", "备注", "客户备注"]),
    refNo: readAnyCell(row, ["REF_NO", "REF NO", "订单号"]),
    phone: readAnyCell(row, ["CONTACT_TEL", "CONTACT TEL", "收件电话", "电话"]),
    postalCode: readAnyCell(row, ["POSTCODE", "邮编", "收件邮编"]),
    recipientName: readAnyCell(row, ["CONSIGNEE_NAME", "CONSIGNEE NAME", "收件人"]),
    address: readAnyCell(row, ["DELIVERY_ADDR_JP", "DELIVERY ADDR JP", "收件人地址", "地址"]),
    allText: Object.values(row).map((value) => cleanCell(value)).filter(Boolean).join(" "),
  };
}

function toDraft(order: TemuOrderRecord): OrderDraft {
  return {
    order_status: order.order_status,
    warehouse_id: order.warehouse_id,
    warehouse_name: order.warehouse_name,
    logistics_method: normalizeLogisticsMethod(order.logistics_method),
    label_printed_at: order.label_printed_at,
    logistics_tracking_no: order.logistics_tracking_no,
    logistics_status: order.logistics_status,
    actual_ship_time: order.actual_ship_time,
    actual_signed_time: order.actual_signed_time,
  };
}

function createEmptyDraft(): OrderDraft {
  return {
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
}

function getFullAddress(order: TemuOrderRecord) {
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

function getOrderStage(order: TemuOrderRecord): Exclude<OrderStage, "all"> {
  if (order.actual_signed_time.trim()) return "completed";
  if (isUploadedTemuStatus(order.order_status)) return "uploaded_temu";
  if (order.actual_ship_time.trim() || order.logistics_tracking_no.trim()) return "shipped";
  if (order.label_printed_at.trim()) return "pending_shipping";
  if (order.warehouse_id || order.warehouse_name.trim()) return "new_order";
  return "pending_assignment";
}

function isDeliveredTrackingStatus(status: string) {
  return status.includes("配達完了");
}

function getTrackingStatusLabel(status: string) {
  return (
    status.replace(/▶/g, " ").replace(/\s+/g, " ").trim().split("/")[0]?.trim() ||
    ""
  );
}

function getStageDefinition(stage: OrderStage) {
  return stageDefinitions.find((item) => item.key === stage) ?? stageDefinitions[0];
}

function getWarehouseLogisticsMethods(warehouseName: string, allMethods: string[]) {
  const rule = warehouseLogisticsRules.find((item) =>
    warehouseName.includes(item.warehouseNameIncludes),
  );
  if (rule) return [...rule.methods] as string[];
  return allMethods.filter((method) => !restrictedLogisticsMethods.has(method));
}

function isLogisticsMethodAllowedForWarehouse(
  warehouseName: string,
  logisticsMethod: string,
  allMethods: string[],
) {
  const method = normalizeLogisticsMethod(logisticsMethod);
  if (!method) return true;
  return getWarehouseLogisticsMethods(warehouseName, allMethods).includes(method);
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

function getOrdersErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error, fallback);
  if (message.includes("sku_code")) {
    return "订单管理数据库还没有新增 SKU 货号字段，请在 Supabase SQL Editor 执行最新订单迁移以启用精准自动匹配";
  }
  if (
    message.includes("public.temu_orders") ||
    message.includes("warehouse_id") ||
    message.includes("logistics_method") ||
    message.includes("label_printed_at") ||
    message.includes("logistics_tracking_no") ||
    message.includes("logistics_status")
  ) {
    return "订单管理数据库还没有初始化最新流程字段，请先执行最新的订单表迁移";
  }
  if (
    message.includes("warehouse_item_stocks") ||
    message.includes("warehouse_item_stock_adjustments")
  ) {
    return "库存数据库还没有初始化最新配件库存字段，请先执行最新的库存表迁移";
  }
  return message;
}

export function OrdersPage({ user }: OrdersPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const draftKey = `orders-draft:v1:${user.id}`;
  const restoredDraftRef = useRef(readDraft<OrdersDraftState>(draftKey));
  const restoredDraft = restoredDraftRef.current;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trackingInputRef = useRef<HTMLInputElement | null>(null);
  const [orders, setOrders] = useState<TemuOrderRecord[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [productSkus, setProductSkus] = useState<ProductSku[]>([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>(restoredDraft?.drafts ?? {});
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>(
    restoredDraft?.selectedOrderIds ?? [],
  );
  const [bulkWarehouseId, setBulkWarehouseId] = useState(restoredDraft?.bulkWarehouseId ?? "");
  const [bulkLogisticsMethod, setBulkLogisticsMethod] = useState(restoredDraft?.bulkLogisticsMethod ?? "");
  const [activeStage, setActiveStage] = useState<OrderStage>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    hasOrdersDraft(restoredDraft) ? "已恢复上次未保存的订单编辑草稿。" : "",
  );
  const [detailOrder, setDetailOrder] = useState<TemuOrderRecord | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [orderSort, setOrderSort] = useState<OrderSort>(defaultOrderSort);
  const [showUrgentUnuploadedOnly, setShowUrgentUnuploadedOnly] = useState(false);
  const autoQueriedTrackingNosRef = useRef<Set<string>>(new Set());
  const autoCompletedDeliveredOrderIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");
      try {
        const [nextOrders, nextWarehouses, nextProducts] = await Promise.all([
          fetchTemuOrders(),
          fetchWarehouses(),
          fetchProducts(),
        ]);
        const [nextProductItems, nextProductSkus, nextWarehouseSkus, nextWarehouseItemStocks] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchWarehouseSkus(nextWarehouses.map((warehouse) => warehouse.id)),
          fetchWarehouseItemStocks(nextWarehouses.map((warehouse) => warehouse.id)),
        ]);
        if (!active) return;
        const uniqueOrders = dedupeOrdersByOrderLine(nextOrders);
        setOrders(uniqueOrders);
        setWarehouses(nextWarehouses);
        setProducts(nextProducts);
        setProductItems(nextProductItems);
        setProductSkus(nextProductSkus);
        setWarehouseSkus(nextWarehouseSkus);
        setWarehouseItemStocks(nextWarehouseItemStocks);
        const serverDrafts = Object.fromEntries(uniqueOrders.map((order) => [order.id, toDraft(order)]));
        const latestDraft = readDraft<OrdersDraftState>(draftKey);
        setDrafts({
          ...serverDrafts,
          ...(latestDraft?.drafts ?? {}),
        });
        setBulkWarehouseId(latestDraft?.bulkWarehouseId ?? "");
        setBulkLogisticsMethod(latestDraft?.bulkLogisticsMethod ?? "");
        setSelectedOrderIds(latestDraft?.selectedOrderIds ?? []);
        if (hasOrdersDraft(latestDraft)) {
          setDraftNotice("已恢复上次未保存的订单编辑草稿。");
        }
      } catch (error) {
        if (active) setErrorMessage(getOrdersErrorMessage(error, "加载订单失败"));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [draftKey, user.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ordersDraftValue = useMemo<OrdersDraftState>(
    () => {
      const ordersById = new Map(orders.map((order) => [order.id, order]));

      return {
        drafts: Object.fromEntries(
          Object.entries(drafts).filter(([orderId, draft]) => {
            const order = ordersById.get(orderId);
            return order ? !isSameDraft(draft, toDraft(order)) : false;
          }),
        ),
        selectedOrderIds,
        bulkWarehouseId,
        bulkLogisticsMethod,
      };
    },
    [bulkLogisticsMethod, bulkWarehouseId, drafts, orders, selectedOrderIds],
  );

  useDraftPersistence(
    draftKey,
    ordersDraftValue,
    {
      enabled: !loading,
      shouldPersist: (draft) =>
        Object.keys(draft.drafts).length > 0 ||
        draft.selectedOrderIds.length > 0 ||
        Boolean(draft.bulkWarehouseId || draft.bulkLogisticsMethod),
    },
  );

  const logisticsMethodOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...defaultLogisticsMethods,
          ...orders
            .map((order) => normalizeLogisticsMethod(order.logistics_method))
            .filter(Boolean),
        ]),
      ),
    [orders],
  );

  const skuOrderLookup = useMemo(
    () => buildSkuOrderLookup(products, productSkus),
    [products, productSkus],
  );

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  const productItemsById = useMemo(
    () => new Map(productItems.flatMap((item) => (item.id ? [[item.id, item]] : []))),
    [productItems],
  );

  const warehouseItemStocksByKey = useMemo(
    () =>
      new Map(
        warehouseItemStocks.map((item) => [`${item.warehouse_id}:${item.item_id}`, item]),
      ),
    [warehouseItemStocks],
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
        ? getWarehouseLogisticsMethods(selectedBulkWarehouse.name, logisticsMethodOptions)
        : logisticsMethodOptions,
    [logisticsMethodOptions, selectedBulkWarehouse],
  );

  const urgentUnuploadedOrders = useMemo(
    () => orders.filter((order) => isUrgentUnuploadedOrder(order, currentTime)),
    [currentTime, orders],
  );

  useEffect(() => {
    if (showUrgentUnuploadedOnly && urgentUnuploadedOrders.length === 0) {
      setShowUrgentUnuploadedOnly(false);
    }
  }, [showUrgentUnuploadedOnly, urgentUnuploadedOrders.length]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    const nextOrders = orders.filter((order) => {
      if (showUrgentUnuploadedOnly && !isUrgentUnuploadedOrder(order, currentTime)) {
        return false;
      }
      if (activeStage !== "all" && getOrderStage(order) !== activeStage) return false;
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
      let comparison = 0;

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
    currentTime,
    orders,
    orderSort,
    productsById,
    search,
    showUrgentUnuploadedOnly,
    skuOrderLookup,
  ]);

  const filteredOrderRows = useMemo(
    () => buildOrderDisplayRows(filteredOrders),
    [drafts, filteredOrders, productsById, skuOrderLookup],
  );

  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(
      stageDefinitions.map((definition) => [definition.key, 0]),
    ) as Record<OrderStage, number>;
    const rows = buildOrderDisplayRows(orders);

    counts.all = rows.length;
    rows.forEach((row) => {
      counts[getOrderStage(row.primaryOrder)] += 1;
    });
    return counts;
  }, [drafts, orders, productsById, skuOrderLookup]);

  const tableColumns = useMemo(
    () =>
      visibleColumns.filter(
        (column) =>
          (activeStage === "all" || column.key !== "stage") &&
          (!column.shippedOnly || isShippingTrackingStage(activeStage)),
      ),
    [activeStage],
  );

  const newOrdersInView = useMemo(
    () => filteredOrders.filter((order) => getOrderStage(order) === "new_order"),
    [filteredOrders],
  );

  const pendingShippingOrdersInView = useMemo(
    () => filteredOrders.filter((order) => getOrderStage(order) === "pending_shipping"),
    [filteredOrders],
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
        (order) => selectedOrderIdSet.has(order.id) && getOrderStage(order) === "shipped",
      ),
    [filteredOrders, selectedOrderIdSet],
  );

  const selectedUploadedTemuOrdersInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) =>
          selectedOrderIdSet.has(order.id) && getOrderStage(order) === "uploaded_temu",
      ),
    [filteredOrders, selectedOrderIdSet],
  );

  const selectedCompletableOrdersInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) =>
          selectedOrderIdSet.has(order.id) && getOrderStage(order) === "uploaded_temu",
      ),
    [filteredOrders, selectedOrderIdSet],
  );

  const selectedOrdersInView = useMemo(
    () => filteredOrders.filter((order) => selectedOrderIdSet.has(order.id)),
    [filteredOrders, selectedOrderIdSet],
  );

  const selectedOrderRowsInView = useMemo(
    () =>
      filteredOrderRows.filter((row) =>
        row.orders.every((order) => selectedOrderIdSet.has(order.id)),
      ),
    [filteredOrderRows, selectedOrderIdSet],
  );
  const selectedNewOrderRowCount = selectedOrderRowsInView.filter(
    (row) => getOrderStage(row.primaryOrder) === "new_order",
  ).length;
  const selectedPendingShippingRowCount = selectedOrderRowsInView.filter(
    (row) => getOrderStage(row.primaryOrder) === "pending_shipping",
  ).length;
  const selectedShippedRowCount = selectedOrderRowsInView.filter(
    (row) => getOrderStage(row.primaryOrder) === "shipped",
  ).length;
  const selectedUploadedTemuRowCount = selectedOrderRowsInView.filter(
    (row) => getOrderStage(row.primaryOrder) === "uploaded_temu",
  ).length;

  const selectedOrderLineInViewCount = selectedOrdersInView.length;
  const selectedInViewCount = selectedOrderRowsInView.length;
  const selectedSingleOrderInView =
    selectedOrderLineInViewCount === 1 ? selectedOrdersInView[0] : null;
  const canManageSelectedShippedOrders =
    selectedShippedOrdersInView.length > 0 &&
    (activeStage === "shipped" || showUrgentUnuploadedOnly);
  const shippedOrdersWithTrackingInView = useMemo(
    () =>
      filteredOrders.filter(
        (order) =>
          isShippingTrackingStage(getOrderStage(order)) && order.logistics_tracking_no.trim(),
      ),
    [filteredOrders],
  );
  const allFilteredSelected =
    filteredOrderRows.length > 0 &&
    filteredOrderRows.every((row) =>
      row.orders.every((order) => selectedOrderIdSet.has(order.id)),
    );

  useEffect(() => {
    if (!canEdit || loading || !isShippingTrackingStage(activeStage) || busyKey) return;

    const targetOrders = shippedOrdersWithTrackingInView.filter((order) => {
      const trackingNo = order.logistics_tracking_no.trim();
      const status = order.logistics_status.trim();
      return (
        trackingNo &&
        !autoQueriedTrackingNosRef.current.has(trackingNo) &&
        (!status || status === "待查询")
      );
    });
    if (targetOrders.length === 0) return;

    targetOrders.forEach((order) => {
      autoQueriedTrackingNosRef.current.add(order.logistics_tracking_no.trim());
    });
    void queryAndSaveTrackingStatuses(targetOrders, "tracking-status-auto", false);
  }, [activeStage, busyKey, canEdit, loading, shippedOrdersWithTrackingInView]);

  useEffect(() => {
    if (!canEdit || loading || busyKey) return;

    const deliveredOrders = orders.filter(
      (order) =>
        !order.actual_signed_time.trim() &&
        isDeliveredTrackingStatus(order.logistics_status) &&
        !autoCompletedDeliveredOrderIdsRef.current.has(order.id),
    );
    if (deliveredOrders.length === 0) return;

    deliveredOrders.forEach((order) => {
      autoCompletedDeliveredOrderIdsRef.current.add(order.id);
    });
    void completeDeliveredOrders(deliveredOrders, "delivered-complete-auto", true);
  }, [busyKey, canEdit, loading, orders]);

  function mergeOrderDraft(order: TemuOrderRecord) {
    return {
      ...order,
      ...(drafts[order.id] ?? toDraft(order)),
    };
  }

  function updateOrdersState(nextOrders: TemuOrderRecord[]) {
    setOrders((current) =>
      current.map((order) => nextOrders.find((nextOrder) => nextOrder.id === order.id) ?? order),
    );
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(nextOrders.map((order) => [order.id, toDraft(order)])),
    }));
  }

  function buildOrderInventoryRestorationInputs(
    targetOrders: TemuOrderRecord[],
  ): WarehouseItemStockRestorationInput[] {
    const selectedOrderNoCounts = targetOrders.reduce<Record<string, number>>(
      (counts, order) => {
        const key = getOrderNoKey(order.order_no);
        if (key) counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const orderNoCounts = orders.reduce<Record<string, number>>((counts, order) => {
      const key = getOrderNoKey(order.order_no);
      if (key) counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const inputsByReason = new Map<string, WarehouseItemStockRestorationInput>();

    const addInput = (label: string) => {
      const normalizedLabel = label.trim();
      if (!normalizedLabel) return;
      const input = {
        outboundReason: `订单出库：${normalizedLabel}`,
        reversalReason: `删除订单冲回：${normalizedLabel}`,
      };
      inputsByReason.set(`${input.outboundReason}\u0000${input.reversalReason}`, input);
    };

    targetOrders.forEach((order) => {
      addInput(getOrderLineLabel(order));

      const orderNo = order.order_no.trim();
      const orderNoKey = getOrderNoKey(orderNo);
      if (
        orderNo &&
        orderNoKey &&
        (orderNoCounts[orderNoKey] ?? 0) === (selectedOrderNoCounts[orderNoKey] ?? 0)
      ) {
        addInput(orderNo);
      }
    });

    return Array.from(inputsByReason.values());
  }

  function updateDraft<K extends keyof OrderDraft>(
    orderId: string,
    field: K,
    value: OrderDraft[K],
  ) {
    updateDraftForOrders([orderId], field, value);
  }

  function updateDraftForOrders<K extends keyof OrderDraft>(
    orderIds: string[],
    field: K,
    value: OrderDraft[K],
  ) {
    setDrafts((current) => {
      const next = { ...current };
      orderIds.forEach((orderId) => {
        next[orderId] = {
          ...(next[orderId] ?? createEmptyDraft()),
          [field]: value,
        };
      });
      return next;
    });
  }

  function updateDraftFields(orderId: string, values: Partial<OrderDraft>) {
    updateDraftFieldsForOrders([orderId], values);
  }

  function updateDraftFieldsForOrders(orderIds: string[], values: Partial<OrderDraft>) {
    setDrafts((current) => {
      const next = { ...current };
      orderIds.forEach((orderId) => {
        next[orderId] = {
          ...(next[orderId] ?? createEmptyDraft()),
          ...values,
        };
      });
      return next;
    });
  }

  function handleWarehouseChange(orderId: string, warehouseId: string) {
    handleWarehouseChangeForOrders([orderId], warehouseId);
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
    const currentDraft = drafts[orderIds[0]] ?? createEmptyDraft();
    const nextWarehouseName = warehouse?.name ?? "";
    const nextLogisticsMethod = isLogisticsMethodAllowedForWarehouse(
      nextWarehouseName,
      currentDraft.logistics_method,
      logisticsMethodOptions,
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

  function getDefaultLogisticsMethod(warehouse: Warehouse, sku: ProductSku | null) {
    const methods = getWarehouseLogisticsMethods(warehouse.name, logisticsMethodOptions);
    if (methods.length === 0) return "";

    if (methods.includes("OCS 3cm") && methods.includes("OCS 小包") && sku?.product_id) {
      const product = productsById.get(sku.product_id);
      if (product && product.package_height_cm > 3) return "OCS 小包";
      return "OCS 3cm";
    }

    return methods[0] ?? "";
  }

  function getYamatoTrackingUrl(order: TemuOrderRecord) {
    const trackingNo = order.logistics_tracking_no.trim();
    if (!trackingNo) return "";
    return yamatoTrackingBaseUrl;
  }

  function canQueryYamatoTracking(order: TemuOrderRecord) {
    return Boolean(getYamatoTrackingUrl(order));
  }

  function openYamatoTracking(
    event: MouseEvent<HTMLAnchorElement>,
    trackingNo: string,
  ) {
    const normalizedTrackingNo = trackingNo.trim();
    if (!normalizedTrackingNo) return;

    event.preventDefault();
    const form = document.createElement("form");
    form.method = "post";
    form.action = yamatoTrackingBaseUrl;
    form.target = "_blank";

    [
      ["number01", normalizedTrackingNo],
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

  function cleanTrackingText(value: string) {
    return value.replace(/▶/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseYamatoTrackingStatus(html: string) {
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
    return getTrackingStatusLabel(displayStatus) || "暂无轨迹";
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

  function buildTrackingStatusUpdates(
    order: TemuOrderRecord,
    logisticsStatus: string,
  ) {
    const updates: Parameters<typeof updateTemuOrder>[1] = {
      logistics_status: logisticsStatus,
    };

    if (isDeliveredTrackingStatus(logisticsStatus)) {
      const draft = drafts[order.id] ?? toDraft(order);
      updates.order_status = "已完成";
      updates.actual_signed_time =
        draft.actual_signed_time.trim() || formatLocalDateTime();
    }

    return updates;
  }

  async function completeDeliveredOrders(
    targetOrders: TemuOrderRecord[],
    busyName: string,
    showNotice = false,
  ) {
    if (targetOrders.length === 0) return;

    setBusyKey(busyName);
    if (showNotice) {
      setErrorMessage("");
      setNoticeMessage("");
    }

    try {
      const nextOrders = await Promise.all(
        targetOrders.map((order) =>
          updateTemuOrder(
            order.id,
            buildTrackingStatusUpdates(order, order.logistics_status),
          ),
        ),
      );
      updateOrdersState(nextOrders);
      if (showNotice) {
        setNoticeMessage(`已自动完成 ${nextOrders.length} 条配達完了订单`);
      }
    } catch (error) {
      targetOrders.forEach((order) => {
        autoCompletedDeliveredOrderIdsRef.current.delete(order.id);
      });
      setErrorMessage(getOrdersErrorMessage(error, "自动完成订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  function getTrackingMatchScore(order: TemuOrderRecord, record: TrackingImportRecord) {
    const orderPhone = normalizeJapanesePhone(formatRecipientPhone(order.recipient_phone));
    const recordPhone = normalizeJapanesePhone(record.phone);
    const orderPostalCode = normalizePostalCode(order.postal_code);
    const recordPostalCode = normalizePostalCode(record.postalCode);
    const orderName = formatRecipientName(order.recipient_name);
    const orderAddress = getFullAddress(order);
    let score = 0;

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

    return (
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

  function getSkuAvailableStock(warehouseId: string, sku: ProductSku) {
    if (sku.component_links.length === 0) return 0;

    const possibleStocks = sku.component_links.flatMap((link) => {
      if (link.quantity <= 0) return [];
      const itemStock = warehouseItemStocksByKey.get(`${warehouseId}:${link.item_id}`);
      return [Math.floor((itemStock?.stock_quantity ?? 0) / link.quantity)];
    });

    return possibleStocks.length > 0 ? Math.min(...possibleStocks) : 0;
  }

  function matchOrderFulfillment(order: TemuOrderRecord) {
    const sku = getOrderSku(order);
    if (!sku?.id) return null;

    const quantity = Math.max(1, order.fulfillment_quantity);
    const warehouseIdsWithSku = new Set(
      warehouseSkus
        .filter((stock) => stock.sku_id === sku.id)
        .map((stock) => stock.warehouse_id),
    );
    const warehouse = warehouses.find(
      (item) =>
        warehouseIdsWithSku.has(item.id) &&
        getSkuAvailableStock(item.id, sku) >= quantity,
    );
    if (!warehouse) return null;

    const logisticsMethod = getDefaultLogisticsMethod(warehouse, sku);
    if (!logisticsMethod) return null;

    return { warehouse, logisticsMethod };
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

  function toggleOrderSelection(orderId: string, checked: boolean) {
    setSelectedOrderIds((current) =>
      checked
        ? Array.from(new Set([...current, orderId]))
        : current.filter((id) => id !== orderId),
    );
  }

  function toggleOrderRowSelection(row: OrderDisplayRow, checked: boolean) {
    const rowIds = row.orders.map((order) => order.id);
    setSelectedOrderIds((current) =>
      checked
        ? Array.from(new Set([...current, ...rowIds]))
        : current.filter((id) => !rowIds.includes(id)),
    );
  }

  function toggleFilteredSelection(checked: boolean) {
    const filteredIds = filteredOrderRows.flatMap((row) =>
      row.orders.map((order) => order.id),
    );
    setSelectedOrderIds((current) =>
      checked
        ? Array.from(new Set([...current, ...filteredIds]))
        : current.filter((id) => !filteredIds.includes(id)),
    );
  }

  function toggleOrderSort(key: OrderSortKey) {
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

    setBusyKey("import");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const rows = await readTabularFileObjects(file);
      const missingColumns = importColumns.filter(
        (column) =>
          !["子订单号", "SKU货号", "应履约件数", "商品属性"].includes(column) &&
          !Object.prototype.hasOwnProperty.call(rows[0] ?? {}, column),
      );
      if (missingColumns.length > 0) {
        throw new Error(`缺少必要列：${missingColumns.join("、")}`);
      }

      const nextProducts = await fetchProducts();
      const nextSkus = await fetchProductSkusByProductIds(
        nextProducts.map((product) => product.id),
      );
      const importSkuLookup = buildSkuOrderLookup(nextProducts, nextSkus);

      const importRows: TemuOrderImportRow[] = rows.flatMap((row, index) => {
        const orderNo = readCell(row, "订单号");
        if (!orderNo) return [];
        const skuCode = readCell(row, "SKU货号");
        const matchedSalesSpec = importSkuLookup.salesSpecByCode.get(normalizeSkuCode(skuCode));
        return [
          {
            order_no: orderNo,
            sub_order_no: readCell(row, "子订单号") || String(index + 2),
            order_status: readCell(row, "订单状态"),
            sku_code: skuCode,
            fulfillment_quantity: parseFulfillmentQuantity(
              readAnyCell(row, ["应履约件数", "商品数量", "数量", "购买数量", "件数", "商品件数"]),
            ),
            product_attributes: matchedSalesSpec ?? readCell(row, "商品属性"),
            recipient_name: readCell(row, "收货人姓名"),
            recipient_phone: readCell(row, "收货人联系方式"),
            email: readCell(row, "邮箱"),
            province: readCell(row, "省份"),
            city: readCell(row, "城市"),
            district: readCell(row, "区县"),
            address_line1: readCell(row, "详细地址1"),
            address_line2: readCell(row, "详细地址2"),
            postal_code: readCell(row, "收货地址邮编"),
            latest_ship_time: readCell(row, "要求最晚发货时间"),
            actual_ship_time: readCell(row, "实际发货时间"),
            estimated_delivery_time: readCell(row, "预计送达时间"),
          },
        ];
      });
      if (importRows.length === 0) throw new Error("没有读取到可导入的订单行");

      const uniqueImportRows = dedupeImportRowsByOrderLine(importRows);
      const skippedDuplicateCount = importRows.length - uniqueImportRows.length;
      const existingOrders = await fetchTemuOrders();
      const existingOrdersByLineKey = new Map(
        existingOrders.flatMap((order) => {
          const key = getOrderLineKey(order);
          return key ? [[key, order] as const] : [];
        }),
      );
      const existingLineCount = uniqueImportRows.filter((row) =>
        existingOrdersByLineKey.has(getOrderLineKey(row)),
      ).length;
      const importRowsForSave = uniqueImportRows.map((row) => {
        const existingOrder = existingOrdersByLineKey.get(getOrderLineKey(row));
        return existingOrder
          ? {
              ...row,
              order_status: existingOrder.order_status || row.order_status,
              actual_ship_time: existingOrder.actual_ship_time || row.actual_ship_time,
            }
          : row;
      });
      const savedOrders =
        importRowsForSave.length > 0
          ? await importTemuOrders(importRowsForSave)
          : [] as TemuOrderRecord[];
      const nextOrders = dedupeOrdersByOrderLine(
        importRowsForSave.length > 0 ? await fetchTemuOrders() : existingOrders,
      );
      setOrders(nextOrders);
      setDrafts(Object.fromEntries(nextOrders.map((order) => [order.id, toDraft(order)])));
      const skipMessages = [
        skippedDuplicateCount > 0 ? `跳过上传表内重复订单明细 ${skippedDuplicateCount} 行` : "",
        existingLineCount > 0 ? `更新已有订单明细 ${existingLineCount} 条` : "",
      ].filter(Boolean);
      setNoticeMessage(
        [
          savedOrders.length > 0
            ? `已导入/更新 ${savedOrders.length} 条订单明细`
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

    setBusyKey("tracking-import");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const rows = await readTabularFileObjects(file);
      const missingColumns = trackingImportColumns.filter(
        (column) => !Object.prototype.hasOwnProperty.call(rows[0] ?? {}, column),
      );
      if (missingColumns.length > 0) {
        throw new Error(`缺少必要列：${missingColumns.join("、")}`);
      }

      const trackingRows = rows
        .map((row, index) => parseTrackingImportRecord(row, index))
        .filter((row): row is TrackingImportRecord => Boolean(row));
      if (trackingRows.length === 0) throw new Error("没有读取到可用的物流单号 CWB_NO");

      const pendingOrders = orders.filter((order) => getOrderStage(order) === "pending_shipping");
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

      const nextOrders = await Promise.all(
        matchedPairs.map(({ order, trackingRow }) => {
          const draft = drafts[order.id] ?? toDraft(order);
          return updateTemuOrder(order.id, {
            ...draft,
            order_status: "已发货",
            actual_ship_time: "",
            logistics_tracking_no: trackingRow.trackingNo,
            logistics_status: "待查询",
          });
        }),
      );

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setActiveStage("shipped");
      setNoticeMessage(
        `已匹配物流单号 ${nextOrders.length} 条并转入已发货，未匹配 ${
          pendingOrders.length - nextOrders.length
        } 条继续留在待发货。`,
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

    const queryableOrders = targetOrders.filter(canQueryYamatoTracking);
    if (queryableOrders.length === 0) {
      if (showNotice) setNoticeMessage("当前没有可查询的 Yamato 物流单号。");
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
            const logisticsStatus = await fetchYamatoTrackingStatus(
              order.logistics_tracking_no,
            );
            return { order, logisticsStatus };
          } catch {
            return { order, logisticsStatus: "查询失败" };
          }
        }),
      );

      const nextOrders = await Promise.all(
        statusResults.map(({ order, logisticsStatus }) =>
          updateTemuOrder(order.id, buildTrackingStatusUpdates(order, logisticsStatus)),
        ),
      );

      updateOrdersState(nextOrders);
      if (showNotice) {
        const completedCount = statusResults.filter(({ logisticsStatus }) =>
          isDeliveredTrackingStatus(logisticsStatus),
        ).length;
        setNoticeMessage(
          completedCount > 0
            ? `已查询 ${nextOrders.length} 条物流状态，自动完成 ${completedCount} 条订单`
            : `已查询 ${nextOrders.length} 条物流状态`,
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

  async function handleSaveSelectedOrders() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }
    if (selectedOrdersInView.length === 0) {
      setNoticeMessage("请先勾选要保存的订单。");
      return;
    }

    setBusyKey("save-selected");
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const saveEntries = selectedOrdersInView.map((order) => {
        const updates = buildOrderSaveUpdates(order);
        const nextOrder = { ...order, ...updates };
        return { order, updates, nextOrder };
      });
      const inventoryTargets = saveEntries
        .filter(
          ({ order, nextOrder }) =>
            getOrderStage(order) === "pending_assignment" &&
            getOrderStage(nextOrder) === "new_order",
        )
        .map((entry) => entry.nextOrder);
      const inventoryChanges = await deductInventoryForOrders(inventoryTargets);
      const nextOrders = await Promise.all(
        saveEntries.map(({ order, updates }) => updateTemuOrder(order.id, updates)),
      );
      updateOrdersState(nextOrders);
      setNoticeMessage(
        inventoryChanges.length > 0
          ? `已保存 ${nextOrders.length} 条订单，并扣减 ${inventoryChanges.length} 项配件库存`
          : `已保存 ${nextOrders.length} 条订单`,
      );
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "保存订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSaveActualShipTime(order: TemuOrderRecord) {
    await handleSaveActualShipTimeForOrders([order]);
  }

  async function handleSaveActualShipTimeForOrders(targetOrders: TemuOrderRecord[]) {
    if (!canEdit) return;

    const changedOrders = targetOrders.filter((order) => {
      if (getOrderStage(order) !== "uploaded_temu") return false;
      const nextActualShipTime = (drafts[order.id] ?? toDraft(order)).actual_ship_time.trim();
      return nextActualShipTime !== order.actual_ship_time.trim();
    });
    if (changedOrders.length === 0) return;

    setBusyKey(`actual-ship-time-${changedOrders.map((order) => order.id).join("|")}`);
    setErrorMessage("");

    try {
      const nextOrders = await Promise.all(
        changedOrders.map((order) =>
          updateTemuOrder(order.id, {
            actual_ship_time: (drafts[order.id] ?? toDraft(order)).actual_ship_time.trim(),
          }),
        ),
      );
      updateOrdersState(nextOrders);
      setNoticeMessage(`已保存 ${nextOrders.length} 条订单明细的实际发货时间`);
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

    const confirmed = window.confirm(
      `确认删除当前列表中已选中的 ${selectedOrdersInView.length} 条订单吗？`,
    );
    if (!confirmed) return;

    const targetIds = new Set(selectedOrdersInView.map((order) => order.id));
    setBusyKey("delete-selected");
    setErrorMessage("");
    setNoticeMessage("");
    let ordersDeleted = false;

    try {
      const inventoryRestorations =
        buildOrderInventoryRestorationInputs(selectedOrdersInView);
      await Promise.all(selectedOrdersInView.map((order) => deleteTemuOrder(order.id)));
      ordersDeleted = true;
      setOrders((current) => current.filter((order) => !targetIds.has(order.id)));
      setSelectedOrderIds((current) => current.filter((id) => !targetIds.has(id)));
      setDrafts((current) => {
        const next = { ...current };
        targetIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });

      const inventoryChanges = await restoreWarehouseItemStockDeductions(
        inventoryRestorations,
      );
      applyWarehouseItemStockUpdates(inventoryChanges.map((change) => change.item));
      setNoticeMessage(
        inventoryChanges.length > 0
          ? `已删除 ${targetIds.size} 条订单，并回补 ${inventoryChanges.length} 项配件库存`
          : `已删除 ${targetIds.size} 条订单`,
      );
    } catch (error) {
      if (ordersDeleted) {
        setNoticeMessage(`已删除 ${targetIds.size} 条订单，但库存回补失败`);
        setErrorMessage(getOrdersErrorMessage(error, "库存回补失败"));
      } else {
        setErrorMessage(getOrdersErrorMessage(error, "批量删除订单失败"));
      }
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
      (order) => getOrderStage(order) === "pending_assignment",
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
      !isLogisticsMethodAllowedForWarehouse(
        selectedWarehouse.name,
        logisticsMethod,
        logisticsMethodOptions,
      )
    ) {
      setErrorMessage(`${selectedWarehouse.name} 不能使用“${logisticsMethod}”发货方式。`);
      return;
    }

    setBusyKey("bulk-assign");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const assignEntries = pendingSelectedOrders.map((order) => {
        const draft = drafts[order.id] ?? toDraft(order);
        const nextWarehouseName = selectedWarehouse
          ? selectedWarehouse.name
          : draft.warehouse_name;
        const nextLogisticsMethod = logisticsMethod || draft.logistics_method;
        const nextDraft: OrderDraft = {
          ...draft,
          warehouse_id: selectedWarehouse ? selectedWarehouse.id : draft.warehouse_id,
          warehouse_name: nextWarehouseName,
          logistics_method:
            nextWarehouseName &&
            isLogisticsMethodAllowedForWarehouse(
              nextWarehouseName,
              nextLogisticsMethod,
              logisticsMethodOptions,
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
      const inventoryTargets = assignEntries
        .filter(
          ({ order, nextOrder }) =>
            getOrderStage(order) === "pending_assignment" &&
            getOrderStage(nextOrder) === "new_order",
        )
        .map((entry) => entry.nextOrder);
      const inventoryChanges = await deductInventoryForOrders(inventoryTargets);
      const nextOrders = await Promise.all(
        assignEntries.map(({ order, updates }) => updateTemuOrder(order.id, updates)),
      );

      updateOrdersState(nextOrders);
      setSelectedOrderIds([]);
      setNoticeMessage(
        inventoryChanges.length > 0
          ? `已批量分配 ${nextOrders.length} 条订单，并扣减 ${inventoryChanges.length} 项配件库存`
          : `已批量分配 ${nextOrders.length} 条订单`,
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
    if (warehouseItemStocks.length === 0) {
      setNoticeMessage("没有读取到仓库配件库存，请先在库存页维护配件库存。");
      return;
    }

    const targetOrders = (
      selectedOrderLineInViewCount > 0 ? selectedOrdersInView : filteredOrders
    ).filter((order) => getOrderStage(order) === "pending_assignment");
    if (targetOrders.length === 0) {
      setNoticeMessage("当前没有需要匹配的待分配订单。");
      return;
    }

    const matchedOrders = targetOrders.flatMap((order) => {
      const matched = matchOrderFulfillment(order);
      return matched ? [{ order, ...matched }] : [];
    });
    if (matchedOrders.length === 0) {
      setNoticeMessage("没有找到 SKU 库存充足且可用发货方式的订单。");
      return;
    }

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
      const inventoryTargets = matchedEntries
        .filter(
          ({ order, nextOrder }) =>
            getOrderStage(order) === "pending_assignment" &&
            getOrderStage(nextOrder) === "new_order",
        )
        .map((entry) => entry.nextOrder);
      const inventoryChanges = await deductInventoryForOrders(inventoryTargets);
      const nextOrders = await Promise.all(
        matchedEntries.map(({ order, updates }) => updateTemuOrder(order.id, updates)),
      );

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      const skippedCount = targetOrders.length - nextOrders.length;
      setNoticeMessage(
        skippedCount > 0
          ? `已自动匹配 ${nextOrders.length} 条订单，扣减 ${inventoryChanges.length} 项配件库存，${skippedCount} 条因 SKU 或库存不足未匹配`
          : `已自动匹配 ${nextOrders.length} 条订单，并扣减 ${inventoryChanges.length} 项配件库存`,
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
      const purchaseShipping =
        item.item_weight_g > 0 && item.purchase_shipping_fee_per_500g_rmb > 0
          ? Math.ceil((item.item_weight_g * quantity) / 500) *
            item.purchase_shipping_fee_per_500g_rmb
          : 0;
      return total + purchaseCost + purchaseShipping;
    }, 0);
  }

  function getDeclarationUnitPriceUsd(sku: ProductSku) {
    const purchaseTotalUsd = getSkuPurchaseTotalRmb(sku) / rmbPerUsdForDeclaration;
    return Number(Math.max(5, purchaseTotalUsd).toFixed(2));
  }

  function getOrderDeclaration(order: TemuOrderRecord) {
    const sku = getOrderSku(order);
    const product = sku?.product_id ? productsById.get(sku.product_id) ?? null : null;
    return sku && product ? { sku, product } : null;
  }

  function validateOrdersReadyForFulfillment(targetOrders: TemuOrderRecord[]) {
    const mergedOrders = targetOrders.map((order) => mergeOrderDraft(order));
    const missingWarehouse = mergedOrders.find(
      (order) => !order.warehouse_id && !order.warehouse_name.trim(),
    );
    if (missingWarehouse) return `订单 ${missingWarehouse.order_no} 还没有分配仓库。`;

    const missingLogistics = mergedOrders.find((order) => !order.logistics_method.trim());
    if (missingLogistics) return `订单 ${missingLogistics.order_no} 还没有填写物流方式。`;

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

  function getOrderFulfillmentQuantity(order: TemuOrderRecord) {
    return Math.max(1, Math.trunc(order.fulfillment_quantity || 0));
  }

  function getOrderShipmentGroupKey(order: TemuOrderRecord) {
    const merged = mergeOrderDraft(order);
    const declaration = getOrderDeclaration(merged);
    const productKey =
      declaration?.product.id ||
      normalizeSkuCode(merged.sku_code) ||
      normalizeSalesSpec(merged.product_attributes);

    return [
      getOrderNoKey(merged.order_no),
      productKey,
      getOrderStage(merged),
      merged.warehouse_id ?? "",
      merged.warehouse_name.trim().toLowerCase(),
      normalizeLogisticsMethod(merged.logistics_method).toLowerCase(),
      merged.logistics_tracking_no.trim(),
      normalizeJapanesePhone(formatRecipientPhone(merged.recipient_phone)),
      normalizePostalCode(merged.postal_code),
      normalizeLooseText(formatRecipientName(merged.recipient_name)),
      normalizeLooseText(getFullAddress(merged)),
    ].join("\u0000");
  }

  function getOrderExactSkuGroupKey(order: TemuOrderRecord) {
    return [
      normalizeSkuCode(order.sku_code),
      normalizeSalesSpec(order.product_attributes),
    ].join("\u0000");
  }

  function getOrderParcelCapacity(order: TemuOrderRecord) {
    if (!isThreeCmLogisticsMethod(order.logistics_method)) return 1;

    const declaration = getOrderDeclaration(order);
    const capacity = Number(declaration?.product.max_units_per_parcel ?? 1);
    return Math.max(1, Math.trunc(Number.isFinite(capacity) ? capacity : 1));
  }

  function createOrderDisplayRow(rowOrders: TemuOrderRecord[]): OrderDisplayRow | null {
    const mergedOrders = rowOrders.map((order) => mergeOrderDraft(order));
    const primaryOrder = mergedOrders[0];
    if (!primaryOrder) return null;

    return {
      id: mergedOrders.map((order) => order.id).sort().join("|"),
      primaryOrder,
      orders: mergedOrders,
      quantity: mergedOrders.reduce(
        (total, order) => total + getOrderFulfillmentQuantity(order),
        0,
      ),
    };
  }

  function buildOrderDisplayRows(targetOrders: TemuOrderRecord[]) {
    const groups = new Map<string, TemuOrderRecord[]>();
    targetOrders.forEach((order) => {
      const key = getOrderShipmentGroupKey(order);
      groups.set(key, [...(groups.get(key) ?? []), order]);
    });

    const rows: OrderDisplayRow[] = [];
    groups.forEach((groupOrders) => {
      const mergedGroupOrders = groupOrders.map((order) => mergeOrderDraft(order));
      const capacity = getOrderParcelCapacity(mergedGroupOrders[0]);
      const sortedGroupOrders = [...mergedGroupOrders].sort((left, right) => {
        const bySku = getOrderExactSkuGroupKey(left).localeCompare(
          getOrderExactSkuGroupKey(right),
        );
        return bySku || left.sub_order_no.localeCompare(right.sub_order_no);
      });

      if (capacity <= 1) {
        sortedGroupOrders.forEach((order) => {
          const row = createOrderDisplayRow([order]);
          if (row) rows.push(row);
        });
        return;
      }

      let currentRowOrders: TemuOrderRecord[] = [];
      let currentQuantity = 0;
      sortedGroupOrders.forEach((order) => {
        const orderQuantity = getOrderFulfillmentQuantity(order);
        if (
          currentRowOrders.length > 0 &&
          currentQuantity + orderQuantity > capacity
        ) {
          const row = createOrderDisplayRow(currentRowOrders);
          if (row) rows.push(row);
          currentRowOrders = [];
          currentQuantity = 0;
        }

        currentRowOrders.push(order);
        currentQuantity += orderQuantity;
      });

      const row = createOrderDisplayRow(currentRowOrders);
      if (row) rows.push(row);
    });

    return rows;
  }

  function getOrderDisplayRowSalesSpec(row: OrderDisplayRow) {
    const specGroups = new Map<string, { label: string; quantity: number }>();
    row.orders.forEach((order) => {
      const label = order.product_attributes.trim() || "--";
      const key = getOrderExactSkuGroupKey(order) || label;
      const current = specGroups.get(key);
      specGroups.set(key, {
        label: current?.label ?? label,
        quantity: (current?.quantity ?? 0) + getOrderFulfillmentQuantity(order),
      });
    });

    return Array.from(specGroups.values())
      .map((item) => (item.quantity > 1 ? `${item.label} ×${item.quantity}` : item.label))
      .join(" / ");
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
      if (sku.component_links.length === 0) {
        return {
          errorMessage: `订单 ${order.order_no} 对应 SKU 没有维护配件组成，不能扣减库存。`,
          deductions: [] as OrderStockDeduction[],
        };
      }

      const orderQuantity = getOrderFulfillmentQuantity(order);
      const warehouseName =
        order.warehouse_name ||
        warehouses.find((warehouse) => warehouse.id === warehouseId)?.name ||
        "未命名仓库";

      for (const link of sku.component_links) {
        const requiredQuantity = Math.max(0, link.quantity) * orderQuantity;
        if (requiredQuantity <= 0) continue;

        const component = productItemsById.get(link.item_id);
        const itemName = component?.item_name || component?.item_spec || link.item_id;
        const stock = warehouseItemStocksByKey.get(`${warehouseId}:${link.item_id}`);
        if (!stock) {
          return {
            errorMessage: `订单 ${order.order_no} 的配件“${itemName}”没有加入 ${warehouseName} 的仓库库存。`,
            deductions: [] as OrderStockDeduction[],
          };
        }

        deductions.push({
          stock,
          quantity: requiredQuantity,
          itemName,
          warehouseName,
          orderNo: order.order_no,
          orderLineLabel: getOrderLineLabel(order),
        });
      }
    }

    if (deductions.length === 0) {
      return {
        errorMessage: "没有找到需要扣减的配件库存，请检查商品 SKU 配件组成。",
        deductions: [] as OrderStockDeduction[],
      };
    }

    return { errorMessage: "", deductions };
  }

  function applyWarehouseItemStockUpdates(nextStocks: WarehouseItemStock[]) {
    if (nextStocks.length === 0) return;

    setWarehouseItemStocks((current) =>
      current.map(
        (item) => nextStocks.find((nextItem) => nextItem.id === item.id) ?? item,
      ),
    );
  }

  async function deductInventoryForOrders(targetOrders: TemuOrderRecord[]) {
    if (targetOrders.length === 0) return [];

    const stockDeductionResult = buildOrderStockDeductions(targetOrders);
    if (stockDeductionResult.errorMessage) {
      throw new Error(stockDeductionResult.errorMessage);
    }

    const inventoryChanges = await deductWarehouseItemStocks(
      stockDeductionResult.deductions.map((deduction) => ({
        stockId: deduction.stock.id,
        quantity: deduction.quantity,
        reason: `订单出库：${deduction.orderLineLabel}`,
        dedupeKey: deduction.orderLineLabel,
        reversalReason: `删除订单冲回：${deduction.orderLineLabel}`,
      })),
    );
    applyWarehouseItemStockUpdates(inventoryChanges.map((change) => change.item));
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
        物流承运商: temuUploadCarrier,
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
    const validationMessage = validateOrdersReadyForFulfillment(mergedOrders);
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setBusyKey(busyName);
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const printedAt = formatLocalDateTime();
      const nextOrders = await Promise.all(
        mergedOrders.map((order) =>
          updateTemuOrder(order.id, {
            order_status: "待发货",
            warehouse_id: order.warehouse_id,
            warehouse_name: order.warehouse_name,
            logistics_method: order.logistics_method,
            label_printed_at: printedAt,
            actual_ship_time: order.actual_ship_time,
            actual_signed_time: order.actual_signed_time,
          }),
        ),
      );

      updateOrdersState(nextOrders);
      setActiveStage("pending_shipping");
      setNoticeMessage(
        `已转入待发货 ${buildOrderDisplayRows(targetOrders).length} 行订单，请下载发货表格。`,
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

    setBusyKey("uploaded-temu-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const nextOrders = await Promise.all(
        selectedShippedOrdersInView.map((order) => {
          const draft = drafts[order.id] ?? toDraft(order);
          const shippedAt = formatLocalDateTime();
          const printedAt = draft.label_printed_at.trim() || formatLocalDateTime();

          return updateTemuOrder(order.id, {
            ...draft,
            order_status: uploadedTemuOrderStatus,
            label_printed_at: printedAt,
            actual_ship_time: shippedAt,
          });
        }),
      );
      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setActiveStage("uploaded_temu");
      setNoticeMessage(`已标记 ${nextOrders.length} 条订单为上传Temu`);
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

    setBusyKey("complete-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const nextOrders = await Promise.all(
        selectedCompletableOrdersInView.map((order) => {
          const draft = drafts[order.id] ?? toDraft(order);
          const finishedAt = draft.actual_signed_time.trim() || formatLocalDateTime();
          const printedAt = draft.label_printed_at.trim() || formatLocalDateTime();

          return updateTemuOrder(order.id, {
            ...draft,
            order_status: "已完成",
            label_printed_at: printedAt,
            actual_ship_time: draft.actual_ship_time.trim(),
            actual_signed_time: finishedAt,
          });
        }),
      );
      updateOrdersState(nextOrders);
      setNoticeMessage(`已标记签收 ${nextOrders.length} 条订单`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "标记签收失败"));
    } finally {
      setBusyKey("");
    }
  }

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
                accept=".xlsx,.csv"
                className="hidden"
                onChange={(event) => void handleFileChange(event.target.files?.[0])}
              />
              <input
                ref={trackingInputRef}
                type="file"
                accept=".xlsx,.csv"
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

      {urgentUnuploadedOrders.length > 0 && (
        <section className="surface-card p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-20 text-sm font-medium text-slate-700">待办任务</span>
            <button
              type="button"
              onClick={() => {
                setActiveStage("all");
                setOrderSort(defaultOrderSort);
                setSelectedOrderIds([]);
                setShowUrgentUnuploadedOnly(true);
              }}
              className={`inline-flex h-10 min-w-60 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold transition ${
                showUrgentUnuploadedOnly
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-line bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <span>即将逾期未发货</span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-bold leading-none text-white">
                {urgentUnuploadedOrders.length}
              </span>
            </button>
          </div>
        </section>
      )}

      <section className="surface-card p-3">
        <div className="flex flex-wrap gap-2">
          {stageDefinitions.map((stage) => {
            const active = activeStage === stage.key;
            return (
              <button
                key={stage.key}
                type="button"
                onClick={() => {
                  setActiveStage(stage.key);
                  setOrderSort(defaultOrderSort);
                  setSelectedOrderIds([]);
                  setShowUrgentUnuploadedOnly(false);
                }}
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${
                  active
                    ? "bg-slate-900 text-white shadow-soft"
                    : "bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                }`}
              >
                <span>{stage.label}</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs tabular-nums ${
                    active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {stageCounts[stage.key]}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="surface-card grid gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <FileSpreadsheet size={18} />
            Temu 订单数据
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
              {showUrgentUnuploadedOnly
                ? "即将逾期未发货"
                : getStageDefinition(activeStage).label}{" "}
              {filteredOrderRows.length}
            </span>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {canEdit && isShippingTrackingStage(activeStage) && shippedOrdersWithTrackingInView.length > 0 && (
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
            )}
            <div className="relative w-full sm:w-[360px]">
              <Search size={16} className="absolute left-3 top-3 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索订单号 / 收货人 / 地址 / 物流"
                className="h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>
          </div>
        </div>

        {selectedOrderLineInViewCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <span className="text-sm font-semibold text-slate-900">
              已选 {selectedInViewCount || selectedOrderLineInViewCount}
              {selectedInViewCount > 0 ? " 行" : " 条明细"}
              {selectedInViewCount > 0 && selectedOrderLineInViewCount !== selectedInViewCount
                ? `（${selectedOrderLineInViewCount} 条明细）`
                : ""}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={Boolean(busyKey)}
                onClick={() => setSelectedOrderIds([])}
                className="text-sm font-medium text-slate-500 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                清空选中
              </button>
              {canEdit && activeStage === "new_order" && selectedNewOrdersInView.length > 0 && (
                <button
                  type="button"
                  disabled={busyKey === "download-batch"}
                  onClick={() =>
                    void handleMoveNewOrdersToPendingShipping(
                      selectedNewOrdersInView,
                      "download-batch",
                    )
                  }
                  className="btn-secondary h-9 px-3"
                >
                  <Truck size={16} />
                  转到待发货（{selectedNewOrderRowCount}）
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(busyKey) || !selectedSingleOrderInView}
                onClick={() => {
                  if (selectedSingleOrderInView) setDetailOrder(selectedSingleOrderInView);
                }}
                title={selectedSingleOrderInView ? undefined : "详情只能查看单条订单"}
                className="btn-secondary h-9 px-3"
              >
                <Eye size={16} />
                详情
              </button>
              {canEdit && (
                <button
                  type="button"
                  disabled={busyKey === "save-selected"}
                  onClick={() => void handleSaveSelectedOrders()}
                  className="btn-secondary h-9 px-3"
                >
                  <Save size={16} />
                  保存（{selectedInViewCount}）
                </button>
              )}
              {canEdit &&
                activeStage === "pending_shipping" &&
                selectedPendingShippingOrdersInView.length > 0 && (
                  <button
                    type="button"
                    disabled={busyKey === "download-shipping-table"}
                    onClick={() =>
                      void handleDownloadShippingTable(
                        selectedPendingShippingOrdersInView,
                        "download-shipping-table",
                      )
                    }
                    className="btn-secondary h-9 px-3"
                  >
                    <Download size={16} />
                    下载发货表格（{selectedPendingShippingRowCount}）
                  </button>
                )}
              {canEdit && canManageSelectedShippedOrders && (
                <>
                  <button
                    type="button"
                    disabled={busyKey === "download-temu-upload-table"}
                    onClick={() =>
                      void handleDownloadTemuUploadTable(
                        selectedShippedOrdersInView,
                        "download-temu-upload-table",
                      )
                    }
                    className="btn-secondary h-9 px-3"
                  >
                    <Download size={16} />
                    下载上传Temu表格（{selectedShippedRowCount}）
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === "uploaded-temu-selected"}
                    onClick={() => void handleMarkSelectedUploadedTemu()}
                    className="btn-secondary h-9 px-3"
                  >
                    <ArrowRight size={16} />
                    转到上传Temu（{selectedShippedRowCount}）
                  </button>
                </>
              )}
              {canEdit &&
                activeStage === "uploaded_temu" &&
                selectedCompletableOrdersInView.length > 0 && (
                <button
                  type="button"
                  disabled={busyKey === "complete-selected"}
                  onClick={() => void handleMarkSelectedCompleted()}
                  className="btn-secondary h-9 px-3"
                >
                  <CheckCircle2 size={16} />
                  签收（{selectedUploadedTemuRowCount}）
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  disabled={busyKey === "delete-selected"}
                  onClick={() => void handleDeleteSelectedOrders()}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-600 shadow-sm transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 size={16} />
                  删除（{selectedInViewCount}）
                </button>
              )}
            </div>
          </div>
        )}

        {canEdit && activeStage === "pending_assignment" && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-sm font-semibold text-slate-700">
              批量分配
            </span>
            <span className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
              已选 {selectedInViewCount}
            </span>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <span>仓库</span>
              <select
                value={bulkWarehouseId}
                disabled={busyKey === "bulk-assign"}
                onChange={(event) => {
                  const warehouseId = event.target.value;
                  const warehouse = warehouses.find((item) => item.id === warehouseId);
                  setBulkWarehouseId(warehouseId);
                  if (
                    warehouse &&
                    bulkLogisticsMethod &&
                    !isLogisticsMethodAllowedForWarehouse(
                      warehouse.name,
                      bulkLogisticsMethod,
                      logisticsMethodOptions,
                    )
                  ) {
                    setBulkLogisticsMethod("");
                  }
                }}
                className="h-10 min-w-40 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
              >
                <option value="">不修改仓库</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <span>发货方式</span>
              <select
                value={bulkLogisticsMethod}
                disabled={busyKey === "bulk-assign"}
                onChange={(event) => setBulkLogisticsMethod(event.target.value)}
                className="h-10 min-w-44 rounded-md border border-line bg-white px-3 text-sm outline-none focus:border-accent"
              >
                <option value="">不修改发货方式</option>
                {bulkLogisticsMethodOptions.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                selectedOrderLineInViewCount === 0 ||
                busyKey === "bulk-assign" ||
                (!bulkWarehouseId && !bulkLogisticsMethod.trim())
              }
              onClick={() => void handleBulkAssign()}
              className="btn-primary h-10 px-3"
            >
              批量分配
            </button>
            <button
              type="button"
              disabled={busyKey === "auto-match" || filteredOrders.length === 0}
              onClick={() => void handleAutoMatchPendingOrders()}
              className="btn-secondary h-10 px-3"
            >
              <Sparkles size={16} />
              自动匹配
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : filteredOrderRows.length === 0 ? (
          <div className="empty-state">暂无订单数据</div>
        ) : (
          <div className="table-card shadow-none">
            <div className="overflow-x-auto">
              <table className="data-table orders-table min-w-[1900px]">
                <thead>
                  <tr>
                    <th className="w-12 text-center">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        disabled={filteredOrderRows.length === 0}
                        onChange={(event) => toggleFilteredSelection(event.target.checked)}
                        aria-label="选择当前列表全部订单"
                        className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                      />
                    </th>
                    {tableColumns.map((column) => (
                      <th key={column.key} className={column.className ?? ""}>
                        {column.sortable ? (
                          <button
                            type="button"
                            onClick={() => toggleOrderSort(column.key as OrderSortKey)}
                            className="inline-flex items-center gap-1 font-medium text-inherit"
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
                  {filteredOrderRows.map((orderRow) => {
                    const order = orderRow.primaryOrder;
                    const rowOrderIds = orderRow.orders.map((item) => item.id);
                    const draft = drafts[order.id] ?? toDraft(order);
                    const mergedOrder = order;
                    const persistedStage = getOrderStage(order);
                    const stage = getStageDefinition(persistedStage);
                    const shipCountdown = getShipDeadlineBadge(mergedOrder, currentTime);
                    const deliveryCountdown = getDeliveryDeadlineBadge(
                      mergedOrder,
                      currentTime,
                    );
                    const canAssignOrder = canEdit && persistedStage === "pending_assignment";
                    const draftWarehouse = draft.warehouse_id
                      ? warehouses.find((warehouse) => warehouse.id === draft.warehouse_id) ?? null
                      : null;
                    const rowLogisticsOptions = draftWarehouse
                      ? getWarehouseLogisticsMethods(draftWarehouse.name, logisticsMethodOptions)
                      : [];
                    const currentWarehouseMissing =
                      draft.warehouse_id &&
                      draft.warehouse_name &&
                      !warehouses.some((warehouse) => warehouse.id === draft.warehouse_id);
                    const declaration = getOrderDeclaration(mergedOrder);
                    const trackingStatusLabel =
                      getTrackingStatusLabel(mergedOrder.logistics_status) || "待查询";
                    const rowSelected = orderRow.orders.every((item) =>
                      selectedOrderIdSet.has(item.id),
                    );

                    return (
                      <tr key={orderRow.id}>
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={rowSelected}
                            onChange={(event) =>
                              toggleOrderRowSelection(orderRow, event.target.checked)
                            }
                            aria-label={`选择订单 ${order.order_no}`}
                            className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                          />
                        </td>
                        <td className="order-no-col">{order.order_no}</td>
                        {activeStage === "all" && (
                          <td>
                            <Badge tone={stage.tone}>{stage.label}</Badge>
                          </td>
                        )}
                        <td className="order-time-col" title={order.latest_ship_time || undefined}>
                          <Badge tone={shipCountdown.tone}>{shipCountdown.label}</Badge>
                        </td>
                        <td className="order-time-col" title={order.estimated_delivery_time || undefined}>
                          <Badge tone={deliveryCountdown.tone}>{deliveryCountdown.label}</Badge>
                        </td>
                        <td>
                          {canAssignOrder ? (
                            <select
                              value={draft.warehouse_id ?? ""}
                              onChange={(event) =>
                                handleWarehouseChangeForOrders(rowOrderIds, event.target.value)
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
                            <span className="text-sm font-medium text-slate-700">
                              {draft.warehouse_name || "未分配"}
                            </span>
                          )}
                        </td>
                        <td>
                          {canAssignOrder ? (
                            <select
                              value={normalizeLogisticsMethod(draft.logistics_method)}
                              disabled={!draft.warehouse_id}
                              onChange={(event) =>
                                updateDraftForOrders(
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
                                !rowLogisticsOptions.includes(
                                  normalizeLogisticsMethod(draft.logistics_method),
                                ) && (
                                  <option value={normalizeLogisticsMethod(draft.logistics_method)}>
                                    {normalizeLogisticsMethod(draft.logistics_method)}
                                  </option>
                                )}
                            </select>
                          ) : (
                            <span className="text-sm font-medium text-slate-700">
                              {normalizeLogisticsMethod(draft.logistics_method) || "未分配"}
                            </span>
                          )}
                        </td>
                        <td className="number-cell">{orderRow.quantity}</td>
                        <td className="order-product-col">
                          {declaration ? (
                            <div className="flex min-w-48 items-center gap-3">
                              <SkuImageThumb
                                product={declaration.product}
                                sku={declaration.sku}
                              />
                              <div className="grid min-w-0 gap-1">
                                <span className="font-medium text-slate-900">
                                  {declaration.product.product_name_cn || "--"}
                                </span>
                                <span className="text-xs font-medium text-slate-500">
                                  {declaration.product.product_code || "--"}
                                </span>
                              </div>
                            </div>
                          ) : (
                            "--"
                          )}
                        </td>
                        <td className="order-attr-col">{getOrderDisplayRowSalesSpec(orderRow) || "--"}</td>
                        {isShippingTrackingStage(activeStage) && (
                          <>
                            <td className="order-tracking-col">
                              {mergedOrder.logistics_tracking_no ? (
                                getYamatoTrackingUrl(mergedOrder) ? (
                                  <a
                                    href={getYamatoTrackingUrl(mergedOrder)}
                                    onClick={(event) =>
                                      openYamatoTracking(
                                        event,
                                        mergedOrder.logistics_tracking_no,
                                      )
                                    }
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
                                getYamatoTrackingUrl(mergedOrder) ? (
                                  <a
                                    href={getYamatoTrackingUrl(mergedOrder)}
                                    onClick={(event) =>
                                      openYamatoTracking(
                                        event,
                                        mergedOrder.logistics_tracking_no,
                                      )
                                    }
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
                        <td>{formatRecipientName(order.recipient_name) || "--"}</td>
                        <td className="order-phone-col">{formatRecipientPhone(order.recipient_phone) || "--"}</td>
                        <td className="order-address-col">{getFullAddress(order) || "--"}</td>
                        <td>{order.postal_code || "--"}</td>
                        <td>
                          {activeStage === "uploaded_temu" ? (
                            <input
                              value={draft.actual_ship_time}
                              readOnly={!canEdit}
                              onChange={(event) =>
                                updateDraftForOrders(
                                  rowOrderIds,
                                  "actual_ship_time",
                                  event.target.value,
                                )
                              }
                              onBlur={() => void handleSaveActualShipTimeForOrders(orderRow.orders)}
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
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {detailOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="订单详情"
        >
          <div className="max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-slate-950">订单详情</h2>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  {detailOrder.order_no}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailOrder(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
                aria-label="关闭详情"
              >
                <X size={18} />
              </button>
            </div>
            <div className="max-h-[calc(86vh-72px)] overflow-auto p-4">
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {getOrderDetailRows(detailOrder).map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <dt className="text-xs font-semibold text-slate-500">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-slate-900">
                      {value || "--"}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
