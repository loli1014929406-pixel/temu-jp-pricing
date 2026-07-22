import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "../../components/ui";
import {
  getOrderCustomerHistoryMeta,
  getOrderCustomerHistoryTitle,
} from "../../domain/order-customer-history";
import { createEmptyDraft, toDraft, type OrderDraft } from "../../hooks/useOrders";
import { getWarehouseLastLegMethodNames } from "../../lib/warehouse-logistics";
import type { TemuOrderImportRow } from "../../lib/orders";
import type {
  Product,
  ProductSku,
  LogisticsMethod,
  PricingSettings,
  TemuOrderRecord,
  Warehouse,
  WarehouseLogisticsMethod,
} from "../../types";
import {
  getOrderStage,
  getOrderStageDefinition as getStageDefinition,
  isShippingTrackingStage,
  type OrderStage,
} from "../../domain/order-workflow";
import {
  type TrackingImportRecord,
  type TrackingCarrier,
  trackingNoImportColumnAliases,
  trackingOrderNoImportColumnAliases,
  trackingSubOrderNoImportColumnAliases,
  type TemuOrderImportField,
  yamatoTrackingBaseUrl,
  ocsTrackingBaseUrl,
  japanPostTrackingBaseUrl,
  cleanCell,
  readAnyCell,
  normalizeSkuCode,
  normalizeSalesSpec,
  normalizeLogisticsMethod,
  formatSkuSalesSpec,
  type ProductsById,
  type OrdersById,
  type SkuOrderLookup,
  getOrderFulfillmentQuantity,
  getOrderDisplayRowDeclarationGroups,
  getOrderDisplayRowSkuSummary,
} from "./order-page-helpers";


export function SkuImageThumb({ product, sku }: { product: Product; sku: ProductSku }) {
  const imageUrl = sku.temu_image_url.trim();
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [imageUrl]);

  if (!imageUrl || hasError) {
    return <div className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 bg-slate-50" role="img" aria-label="暂无图片" title="暂无图片" />;
  }

  return (
    <img
      src={imageUrl}
      alt={`${product.product_name_cn} ${formatSkuSalesSpec(sku)}`.trim()}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 object-cover"
    />
  );
}

export function parseFulfillmentQuantity(value: string) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 1;
}

export function getOrderNoKey(value: string) {
  return value.trim().toLowerCase();
}

export function getOrderLineKey(
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

export function getOrderLineSkuKey(
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

export function getOrderLineLabel(order: Pick<TemuOrderRecord, "order_no" | "sub_order_no" | "id">) {
  const subOrderNo = order.sub_order_no.trim();
  return subOrderNo ? `${order.order_no} / ${subOrderNo}` : `${order.order_no} / ${order.id}`;
}

export function dedupeImportRowsByOrderLine(rows: TemuOrderImportRow[]) {
  const uniqueRows = new Map<string, TemuOrderImportRow>();

  rows.forEach((row) => {
    const key = getOrderLineKey(row);
    if (key && !uniqueRows.has(key)) {
      uniqueRows.set(key, row);
    }
  });

  return Array.from(uniqueRows.values());
}

export function parseTrackingImportRecord(row: Record<string, unknown>, index: number): TrackingImportRecord | null {
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

export function getFullAddress(
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

export function formatRecipientPhone(phone: string) {
  return phone.trim().replace(/^\+81[\s-]*/, "");
}

export function formatRecipientName(name: string) {
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

export function hasAnyRecipientInfo(order: RecipientInfoRecord) {
  return recipientImportFields.some((field) => String(order[field] ?? "").trim());
}

export function hasCompleteRecipientInfo(
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

export function isDeliveredTrackingStatus(status: string) {
  return ["配達完了", "お届け済み", "配達済み", "Delivered"].some((keyword) =>
    status.includes(keyword),
  );
}

export function getTrackingStatusLabel(status: string) {
  return (
    status.replace(/▶/g, " ").replace(/\s+/g, " ").trim().split("/")[0]?.trim() ||
    ""
  );
}

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

export function isJapanPostTrackingStatus(value: string) {
  return japanPostTrackingStatusKeywords.some((status) => value.includes(status));
}

export function hasFukuokaText(value: string) {
  return /福[冈岡]|fukuoka/i.test(value);
}

export function hasSuzhouText(value: string) {
  return /苏州|蘇州|suzhou/i.test(value);
}

export function hasJapanPostText(value: string) {
  return /japan\s*post|japanpost|日本[邮郵]便|邮便|郵便/i.test(value);
}

export function hasOcsYamatoText(value: string) {
  return /ocs\s*yamato|yamato|ヤマト/i.test(value);
}

export function getOrderTrackingCarrier(order: Pick<TemuOrderRecord, "warehouse_name" | "logistics_method">): TrackingCarrier {
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

export function getTemuUploadCarrier(order: Pick<TemuOrderRecord, "warehouse_name" | "logistics_method">) {
  return getOrderTrackingCarrier(order) === "japan_post" ? "Japan Post" : "Yamato";
}

export function getJapanPostTrackingUrl(trackingNo: string) {
  const normalizedTrackingNo = trackingNo.trim();
  if (!normalizedTrackingNo) return "";

  const params = new URLSearchParams({
    reqCodeNo1: normalizedTrackingNo,
    searchKind: "S002",
    locale: "ja",
  });
  return `${japanPostTrackingBaseUrl}?${params.toString()}`;
}

export function getOcsTrackingUrl(trackingNo: string) {
  const normalizedTrackingNo = trackingNo.trim();
  if (!normalizedTrackingNo) return "";

  const params = new URLSearchParams({ cwbno: normalizedTrackingNo });
  return `${ocsTrackingBaseUrl}?${params.toString()}`;
}

export function getTrackingUrl(order: TemuOrderRecord) {
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

export function getTrackingStatusUrl(order: TemuOrderRecord) {
  const trackingNo = order.logistics_tracking_no.trim();
  if (!trackingNo) return "";

  if (getOrderTrackingCarrier(order) === "japan_post") {
    return getJapanPostTrackingUrl(trackingNo);
  }

  return yamatoTrackingBaseUrl;
}

export function openTrackingStatus(event: MouseEvent<HTMLAnchorElement>, order: TemuOrderRecord) {
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

export function formatLocalDateTime(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFileTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

export function parseOrderDateTime(value: string) {
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

export function formatDuration(milliseconds: number) {
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

export function getCountdownBadge(value: string, now: Date) {
  const targetDate = parseOrderDateTime(value);
  if (!value.trim()) return { label: "--", tone: "neutral" as const };
  if (!targetDate) return { label: value, tone: "neutral" as const };

  const diff = targetDate.getTime() - now.getTime();
  return diff >= 0
    ? { label: `剩余 ${formatDuration(diff)}`, tone: "warning" as const }
    : { label: `超时 ${formatDuration(Math.abs(diff))}`, tone: "danger" as const };
}

export function getShipDeadlineBadge(order: TemuOrderRecord, now: Date) {
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

export function getDeliveryDeadlineBadge(order: TemuOrderRecord, now: Date) {
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

const OrderCountdownContext = createContext<Date | null>(null);

export function OrderCountdownProvider({ children }: { children: ReactNode }) {
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <OrderCountdownContext.Provider value={currentTime}>
      {children}
    </OrderCountdownContext.Provider>
  );
}

function useOrderCountdownTime() {
  return useContext(OrderCountdownContext) ?? new Date();
}

export function normalizeRmbAmount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Number(value.toFixed(2)));
}

export type OrderTableRowProps = {
  activeStage: OrderStage;
  canEdit: boolean;
  logisticsMethods: LogisticsMethod[];
  settings: PricingSettings | null;
  onHandleWarehouseChangeForOrders: (orderIds: string[], warehouseId: string) => void;
  onHandleLogisticsMethodChangeForOrders: (
    orderIds: string[],
    logisticsMethod: string,
  ) => Promise<void>;
  getWarehouseStockIssueForOrders: (
    orders: TemuOrderRecord[],
    warehouseId: string,
  ) => string;
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

export const OrderTableRow = memo(function OrderTableRow({
  activeStage,
  canEdit,
  logisticsMethods,
  settings,
  getWarehouseStockIssueForOrders,
  onHandleWarehouseChangeForOrders,
  onHandleLogisticsMethodChangeForOrders,
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
  const [productCellExpanded, setProductCellExpanded] = useState(false);
  const currentTime = useOrderCountdownTime();

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
    () => (primaryOrder ? getOrderStage(primaryOrder) : "pending_assignment"),
    [primaryOrder],
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
        ? getWarehouseLastLegMethodNames(
            draftWarehouse.id,
            settings,
            logisticsMethods,
            warehouseLogisticsMethods,
          )
        : [],
    [draftWarehouse, logisticsMethods, settings, warehouseLogisticsMethods],
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
  const warehouseStockIssueById = useMemo(
    () =>
      new Map(
        warehouses.map((warehouse) => [
          warehouse.id,
          getWarehouseStockIssueForOrders(rowOrders, warehouse.id),
        ]),
      ),
    [getWarehouseStockIssueForOrders, rowOrders, warehouses],
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
              normalizeSkuCode(order.sku_code) ||
              normalizeSalesSpec(order.product_attributes) ||
              order.id;
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
  const canExpandProductCell = declarationGroups.length > 1;
  const visibleDeclarationGroups = productCellExpanded
    ? declarationGroups
    : declarationGroups.slice(0, 1);
  const normalizedDraftLogisticsMethod = useMemo(
    () => normalizeLogisticsMethod(draft.logistics_method),
    [draft.logistics_method],
  );
  const hasUnmatchedLogisticsMethod = rowOrders.some(
    (order) => order.logistics_method_is_unmatched,
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
  const customerHistoryMeta = getOrderCustomerHistoryMeta(
    primaryOrder.customer_history_status,
  );
  const productCellFullText = primaryDeclaration
    ? declarationGroups
        .map(
          (group) =>
            `${group.declaration.product.product_name_cn || "--"} ${group.declaration.sku.sku_code || "--"} x${group.quantity}`,
        )
        .join("\n")
    : skuSummary;

  return (
    <tr
      key={rowId}
      className={customerHistoryMeta.rowClassName}
      title={getOrderCustomerHistoryTitle(primaryOrder)}
      data-customer-history-status={primaryOrder.customer_history_status}
    >
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
            className="h-9 w-full min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
          >
            <option value="">未分配</option>
            {currentWarehouseMissing && (
              <option value={draft.warehouse_id ?? ""}>{draft.warehouse_name}</option>
            )}
            {warehouses.map((warehouse) => {
              const stockIssue = warehouseStockIssueById.get(warehouse.id) ?? "";
              return (
                <option
                  key={warehouse.id}
                  value={warehouse.id}
                  disabled={Boolean(stockIssue)}
                  title={stockIssue || undefined}
                >
                  {warehouse.name}{stockIssue ? "（库存不足）" : ""}
                </option>
              );
            })}
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
            value={
              rowLogisticsOptions.includes(normalizedDraftLogisticsMethod)
                ? normalizedDraftLogisticsMethod
                : ""
            }
            disabled={!draft.warehouse_id}
            onChange={(event) =>
              void onHandleLogisticsMethodChangeForOrders(
                rowOrderIds,
                event.target.value,
              )
            }
            className="h-9 w-full min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value="">未分配</option>
            {rowLogisticsOptions.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        ) : (
          <span
            className={`text-sm font-medium whitespace-nowrap ${
              hasUnmatchedLogisticsMethod ? "text-amber-700" : "text-slate-700"
            }`}
          >
            {hasUnmatchedLogisticsMethod
              ? `未匹配物流方式（${normalizedDraftLogisticsMethod}）`
              : normalizedDraftLogisticsMethod || "未分配"}
          </span>
        )}
      </td>
      <td className="order-qty-col text-right-num">{rowQuantity}</td>
      <td
        className="order-product-col"
        data-full-text={productCellFullText || undefined}
        data-cell-detail-disabled="true"
        style={{ cursor: canExpandProductCell ? "pointer" : "default" }}
        onClick={() => {
          if (canExpandProductCell) {
            setProductCellExpanded((current) => !current);
          }
        }}
      >
        {primaryDeclaration ? (
          <div
            className={
              productCellExpanded
                ? "min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
                : "min-w-0"
            }
          >
            {visibleDeclarationGroups.map((group) => (
              <div
                key={group.declaration.sku.id || group.declaration.sku.sku_code}
                className={`flex min-w-0 items-center gap-2 ${
                  productCellExpanded
                    ? "border-b border-slate-100 px-2 py-2 last:border-b-0"
                    : ""
                }`}
              >
                <SkuImageThumb
                  product={group.declaration.product}
                  sku={group.declaration.sku}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={
                      productCellExpanded
                        ? "whitespace-normal break-words font-medium leading-5 text-slate-900"
                        : "block truncate font-medium text-slate-900"
                    }
                  >
                    {group.declaration.product.product_name_cn || "--"}
                  </span>
                  <span className="text-xs font-medium text-slate-500">
                    {group.declaration.sku.sku_code || "--"} ×{group.quantity}
                  </span>
                </div>
                {!productCellExpanded && canExpandProductCell && (
                  <button
                    type="button"
                    aria-expanded="false"
                    aria-label={`查看全部 ${declarationGroups.length} 个 SKU`}
                    className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-500 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
                    onClick={(event) => {
                      event.stopPropagation();
                      setProductCellExpanded(true);
                    }}
                  >
                    <ChevronDown size={13} />
                    +{declarationGroups.length - 1}
                  </button>
                )}
              </div>
            ))}
            {productCellExpanded && (
              <button
                type="button"
                aria-expanded="true"
                className="inline-flex h-8 w-full items-center justify-center gap-1 border-t border-slate-100 bg-slate-50 text-xs font-semibold text-slate-600 transition hover:bg-sky-50 hover:text-sky-700"
                onClick={(event) => {
                  event.stopPropagation();
                  setProductCellExpanded(false);
                }}
              >
                <ChevronUp size={14} />
                收起 SKU
              </button>
            )}
          </div>
        ) : (
          <span className="text-sm font-medium text-slate-500">{skuSummary}</span>
        )}
      </td>
      <td
        className="order-attr-col"
        data-full-text={salesSpec || undefined}
        data-cell-detail-disabled="true"
        style={{ cursor: canExpandAttrCell ? "pointer" : "default" }}
        onClick={() => {
          if (canExpandAttrCell) {
            setAttrCellExpanded((prev) => !prev);
          }
        }}
      >
        {attrCellExpanded ? (
          <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {specLines.map((line, index) => (
              <span
                key={index}
                className="block w-full whitespace-normal break-all border-b border-slate-100 px-2 py-2 text-xs leading-5 text-slate-700 last:border-b-0"
              >
                {line}
              </span>
            ))}
            <button
              type="button"
              aria-expanded="true"
              className="inline-flex h-8 w-full items-center justify-center gap-1 border-t border-slate-100 bg-slate-50 text-xs font-semibold text-slate-600 transition hover:bg-sky-50 hover:text-sky-700"
              onClick={(e) => {
                e.stopPropagation();
                setAttrCellExpanded(false);
              }}
            >
              <ChevronUp size={14} />
              收起
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="block min-w-0 flex-1 truncate text-slate-700">
              {specLines[0] || "--"}
            </span>
            {canExpandAttrCell && (
              <button
                type="button"
                aria-expanded="false"
                aria-label={specLines.length > 1 ? `查看全部 ${specLines.length} 个 SKU 规格` : "查看完整规格"}
                className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-500 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
                onClick={(event) => {
                  event.stopPropagation();
                  setAttrCellExpanded(true);
                }}
              >
                <ChevronDown size={14} />
                {specLines.length > 1 ? `+${specLines.length - 1}` : "展开"}
              </button>
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
      <td className="order-time-col order-actual-ship-time-col">
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
            className="h-9 w-full min-w-0 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
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
