import type { User } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp } from "lucide-react";
import { OrderBulkActions } from "../components/orders/OrderBulkActions";
import { OrderDetailPanel } from "../components/orders/OrderDetailPanel";
import { OrderFilters } from "../components/orders/OrderFilters";
import {
  OrderDataHeader,
  OrderFileActions,
  OrderPageNotices,
} from "../components/orders/OrderPageChrome";
import { ReshipOrderModal } from "../components/orders/ReshipOrderModal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/ui";
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
  dedupeLogisticsMethodNames,
  getLogisticsMethodIdByName,
} from "../lib/logistics-methods";
import { resolveLastLegMethods } from "../lib/defaults";
import {
  getWarehouseLastLegMethodNames,
  getWarehouseLogisticsConfigStatus,
  isLastLegMethodAllowedForWarehouse,
} from "../lib/warehouse-logistics";
import { getSupabaseClient } from "../lib/supabase";
import { mapWithConcurrency } from "../lib/concurrency";
import {
  deleteTemuOrder,
  importTemuOrders,
  updateTemuOrder,
  type TemuOrderImportRow,
} from "../lib/orders";
import type {
  Product,
  ProductSku,
  LogisticsMethodConfig,
  TemuOrderRecord,
  Warehouse,
  WarehouseSku,
} from "../types";
import {
  calculatePurchaseShippingRmb,
  getThreeCmDimensionIssue,
} from "../utils/shipping-costs";
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

import {
  OrderSortKey,
  OrderSort,
  TrackingImportRecord,
  TrackingStatusResult,
  OrderStockDeduction,
  TemuOrderImportField,
  importColumnAliases,
  optionalImportFields,
  importFieldLabels,
  trackingNoImportColumnAliases,
  rmbPerUsdForDeclaration,
  defaultOrderSort,
  japanPostTrackingProxyPath,
  temuUploadWarehouseName,
  temuUploadColumns,
  visibleColumns,
  orderColumnWidths,
  hasAnyColumn,
  readImportCell,
  normalizeSkuCode,
  normalizeSalesSpec,
  normalizeJapanesePhone,
  normalizePostalCode,
  includesLooseText,
  formatStyleColorForDeclaration,
  normalizeLogisticsMethod,
  buildSkuOrderLookup,
  OrderFulfillmentMatch,
  OrderFulfillmentMatchResult,
  fukuokaWarehouseAliases,
  suzhouWarehouseAliases,
  fukuokaLastmileMethod,
  ocsThreeCmMethod,
  ocsSmallParcelMethod,
  getOrderFulfillmentQuantity,
  getWarehousesByAliases,
  formatAutoMatchBlockedReasons,
  getOrderDisplayGroupKey,
  mergeOrderWithDraft,
  buildOrderDisplayRowsWithDrafts,
  getOrderDeclarationFromLookups,
} from "./orders/order-page-helpers";


import {
  OrderTableRow,
  OrderCountdownProvider,
  parseFulfillmentQuantity,
  getOrderNoKey,
  getOrderLineKey,
  getOrderLineSkuKey,
  getOrderLineLabel,
  dedupeImportRowsByOrderLine,
  parseTrackingImportRecord,
  getFullAddress,
  formatRecipientPhone,
  formatRecipientName,
  hasAnyRecipientInfo,
  hasCompleteRecipientInfo,
  isDeliveredTrackingStatus,
  getTrackingStatusLabel,
  isJapanPostTrackingStatus,
  getOrderTrackingCarrier,
  getTemuUploadCarrier,
  formatLocalDateTime,
  formatFileTimestamp,
  parseOrderDateTime,
  normalizeRmbAmount,
} from "./orders/OrderTableRow";


export function OrdersPage({ user }: OrdersPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeStage, setActiveStage] = useState<OrderStage>("all");
  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [logisticsMethodFilter, setLogisticsMethodFilter] = useState("");
  const [orderSort, setOrderSort] = useState<OrderSort>(defaultOrderSort);
  const [showUrgentUnuploadedOnly, setShowUrgentUnuploadedOnly] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [pageSize, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const {
    allOrders,
    totalOrderCount,
    totalOrderLineCount,
    stageCounts,
    urgentUnuploadedCount,
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
  } = useOrders(user, {
    page,
    pageSize,
    searchQuery: debouncedSearch,
    stage: activeStage,
    warehouseId: warehouseFilter,
    logisticsMethod: logisticsMethodFilter,
    urgentOnly: showUrgentUnuploadedOnly,
    sortKey: orderSort.key,
    sortDirection: orderSort.direction,
  });
  const mergeOrderDraft = useCallback(
    (order: TemuOrderRecord) => mergeOrderWithDraft(order, drafts),
    [drafts],
  );
  const buildOrderDisplayRows = useCallback(
    (targetOrders: TemuOrderRecord[]) =>
      buildOrderDisplayRowsWithDrafts(targetOrders, drafts),
    [drafts],
  );
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
        ? getWarehouseLastLegMethodNames(
            selectedBulkWarehouse.id,
            settings,
            logisticsMethods,
            warehouseLogisticsMethods,
          )
        : [],
    [
      logisticsMethods,
      selectedBulkWarehouse,
      settings,
      warehouseLogisticsMethods,
    ],
  );

  useEffect(() => {
    if (showUrgentUnuploadedOnly && urgentUnuploadedCount === 0) {
      setShowUrgentUnuploadedOnly(false);
    }
  }, [showUrgentUnuploadedOnly, urgentUnuploadedCount]);

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

  const filteredOrders = allOrders;

  const filteredOrderRows = useMemo(
    () => buildOrderDisplayRows(filteredOrders),
    [buildOrderDisplayRows, filteredOrders],
  );
  const filteredTotalPages = Math.max(1, Math.ceil(totalOrderCount / pageSize));
  const paginatedOrderRows = filteredOrderRows;

  useEffect(() => {
    if (page > filteredTotalPages) {
      setPage(filteredTotalPages);
    }
  }, [filteredTotalPages, page]);

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
        logistics_method_id: null,
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
      isLastLegMethodAllowedForWarehouse(
        warehouse.id,
        currentDraft.logistics_method,
        settings,
        logisticsMethods,
        warehouseLogisticsMethods,
      )
      ? currentDraft.logistics_method
      : "";
    updateDraftFieldsForOrders(orderIds, {
      warehouse_id: warehouse?.id ?? warehouseId,
      warehouse_name: nextWarehouseName,
      logistics_method_id: nextLogisticsMethod
        ? getLogisticsMethodIdByName(nextLogisticsMethod, logisticsMethods)
        : null,
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
    const methods = getWarehouseLastLegMethodNames(
      warehouse.id,
      settings,
      logisticsMethods,
      warehouseLogisticsMethods,
    );
    return methods.includes(normalizedMethod) ? normalizedMethod : "";
  }

  function getAllowedWarehouseLogisticsMethodByFormula(
    warehouse: Warehouse,
    formula: LogisticsMethodConfig["formula"],
    fallbackName: string,
  ) {
    const allowedMethodIds = new Set(
      warehouseLogisticsMethods
        .filter((link) => link.warehouse_id === warehouse.id)
        .map((link) => link.logistics_method_id),
    );
    const allowedMethods = logisticsMethods.filter((method) =>
      allowedMethodIds.has(method.id),
    );
    const config = settings
      ? resolveLastLegMethods(settings).find(
          (method) =>
            method.isActive &&
            method.formula === formula &&
            (method.db_method_id
              ? allowedMethodIds.has(method.db_method_id)
              : allowedMethods.some(
                  (allowedMethod) =>
                    normalizeLogisticsMethod(allowedMethod.name) ===
                    normalizeLogisticsMethod(method.name),
                )),
        )
      : null;
    const masterMethod = config?.db_method_id
      ? logisticsMethods.find((method) => method.id === config.db_method_id)
      : null;
    return getAllowedWarehouseLogisticsMethod(
      warehouse,
      masterMethod?.name ?? config?.name ?? fallbackName,
    );
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
    const { data: { session } } = await getSupabaseClient().auth.getSession();
    if (!session?.access_token) throw new Error("登录状态已失效，请重新登录");
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
          Authorization: `Bearer ${session.access_token}`,
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
      const fukuokaMethod = getAllowedWarehouseLogisticsMethodByFormula(
        fukuokaWarehouse,
        "flat_jpy",
        fukuokaLastmileMethod,
      );
      const dimensionIssue = getThreeCmDimensionIssueForSku(sku);
      if (dimensionIssue) {
        return {
          status: "blocked",
          reason: `订单 ${getOrderLineLabel(order)}：福冈仓有库存，但${dimensionIssue}，不能发${fukuokaMethod || "该尾程方式"}。`,
        };
      }

      const logisticsMethod = fukuokaMethod;
      if (!logisticsMethod) {
        return {
          status: "blocked",
          reason: `${fukuokaWarehouse.name} 没有配置对应的尾程发货方式。`,
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
    const logisticsMethod = getAllowedWarehouseLogisticsMethodByFormula(
      suzhouWarehouse,
      dimensionIssue ? "ocs_small" : "ocs_3cm",
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
      const statusResults = await mapWithConcurrency(
        queryableOrders,
        5,
        async (order) => {
          try {
            const trackingResult = await fetchTrackingStatus(order);
            return { order, trackingResult };
          } catch {
            return { order, trackingResult: { status: "查询失败" } };
          }
        },
        (completed, total) => {
          if (showNotice) setNoticeMessage(`正在查询物流状态 ${completed} / ${total}`);
        },
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

        const logisticsMethod = Object.prototype.hasOwnProperty.call(
          entry.updates,
          "logistics_method",
        )
          ? normalizeLogisticsMethod(entry.updates.logistics_method ?? "")
          : undefined;
        const updatesWithReference =
          logisticsMethod === undefined
            ? entry.updates
            : {
                ...entry.updates,
                logistics_method: logisticsMethod,
                logistics_method_id: logisticsMethod
                  ? getLogisticsMethodIdByName(logisticsMethod, logisticsMethods)
                  : null,
              };
        const nextOrder = await updateTemuOrder(
          entry.order.id,
          sanitizeOrderUpdatesForSave(entry.order, updatesWithReference),
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
    const invalidPendingOrder = selectedOrdersInView
      .filter((order) => getOrderStage(order) === "pending_assignment")
      .map((order) => ({ order, nextOrder: mergeOrderDraft(order) }))
      .find(
        ({ nextOrder }) =>
          Boolean(nextOrder.logistics_method.trim()) &&
          (!nextOrder.warehouse_id ||
            !isLastLegMethodAllowedForWarehouse(
              nextOrder.warehouse_id,
              nextOrder.logistics_method,
              settings,
              logisticsMethods,
              warehouseLogisticsMethods,
            )),
      );
    if (invalidPendingOrder) {
      setErrorMessage(
        `订单 ${invalidPendingOrder.order.order_no} 的尾程发货方式必须从所选仓库的绑定方式中选择。`,
      );
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
    if (!selectedWarehouse && logisticsMethod) {
      setErrorMessage("请先选择仓库，再选择该仓库绑定的尾程发货方式。");
      return;
    }
    if (!selectedWarehouse && !logisticsMethod) {
      setNoticeMessage("请选择仓库后再批量分配。");
      return;
    }
    if (
      selectedWarehouse &&
      logisticsMethod &&
      !isLastLegMethodAllowedForWarehouse(
        selectedWarehouse.id,
        logisticsMethod,
        settings,
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
            isLastLegMethodAllowedForWarehouse(
              nextWarehouseId,
              nextLogisticsMethod,
              settings,
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
      const methodLabel = dedupeLogisticsMethodNames(
        targetOrders.map((order) => order.logistics_method),
      ).join("、");
      setNoticeMessage(
        `已下载 ${buildOrderDisplayRows(targetOrders).length} 行 ${methodLabel || "物流"}发货表格`,
      );
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
    <section className="page-stack">
      <PageHeader
        title="订单管理"
        description="上传 Temu 导出的订单表，按仓库分配、下载发货表格并跟进签收流程"
        actions={canEdit ? (
          <OrderFileActions
            canEdit={canEdit}
            busyKey={busyKey}
            onOrderFile={(file) => void handleFileChange(file)}
            onTrackingFile={(file) => void handleTrackingFileChange(file)}
          />
        ) : null}
      />

      <OrderPageNotices
        errorMessage={errorMessage}
        noticeMessage={noticeMessage}
        draftNotice={draftNotice}
      />

      <OrderFilters
        activeStage={activeStage}
        stages={stageDefinitions}
        stageCounts={stageCounts}
        search={search}
        warehouseFilter={warehouseFilter}
        warehouseOptions={warehouses}
        logisticsMethodFilter={logisticsMethodFilter}
        logisticsMethodOptions={logisticsMethodOptions}
        urgentUnuploadedCount={urgentUnuploadedCount}
        showUrgentUnuploadedOnly={showUrgentUnuploadedOnly}
        loading={loading}
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
        <OrderDataHeader
          activeLabel={activeOrderViewLabel}
          activeTone={activeOrderViewTone}
          currentRowCount={paginatedOrderRows.length}
          totalRowCount={totalOrderCount}
          totalLineCount={totalOrderLineCount}
          canRefreshTracking={
            canEdit &&
            isShippingTrackingStage(activeStage) &&
            shippedOrdersWithTrackingInView.length > 0
          }
          refreshing={
            busyKey === "tracking-status-refresh" || busyKey === "tracking-status-auto"
          }
          onRefreshTracking={() =>
            void queryAndSaveTrackingStatuses(
              shippedOrdersWithTrackingInView,
              "tracking-status-refresh",
            )
          }
        />

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
              !warehouse ||
              (bulkLogisticsMethod &&
                !isLastLegMethodAllowedForWarehouse(
                  warehouse.id,
                  bulkLogisticsMethod,
                  settings,
                  logisticsMethods,
                  warehouseLogisticsMethods,
                ))
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
            <div className="grid gap-3 md:hidden">
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  disabled={paginatedOrderRows.length === 0}
                  onChange={(event) => toggleFilteredSelection(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                />
                选择当前页全部订单
              </label>
              {paginatedOrderRows.map((orderRow) => {
                const order = orderRow.primaryOrder;
                const rowOrderIds = orderRow.orders.map((item) => item.id);
                const selected = rowOrderIds.every((id) => selectedOrderIdSet.has(id));
                const stage = getStageDefinition(getOrderStage(order));
                const latestShipTime = parseOrderDateTime(order.latest_ship_time);
                return (
                  <article key={orderRow.id} className="mobile-summary-card">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => toggleOrderRowSelection(rowOrderIds, event.target.checked)}
                        aria-label={`选择订单 ${order.order_no}`}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="break-all text-sm font-bold text-slate-900">{order.order_no}</h3>
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">{stage.label}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {orderRow.orders.length} 个明细 / {orderRow.quantity} 件
                        </p>
                      </div>
                    </div>
                    <div className="mobile-summary-grid">
                      <div className="mobile-summary-cell">
                        <span className="block text-[11px] text-slate-400">SKU</span>
                        <span className="mt-0.5 block break-all text-slate-700">{order.sku_code || "--"}</span>
                      </div>
                      <div className="mobile-summary-cell">
                        <span className="block text-[11px] text-slate-400">仓库 / 发货方式</span>
                        <span className="mt-0.5 block text-slate-700">{order.warehouse_name || "未分配"} / {order.logistics_method || "--"}</span>
                      </div>
                      <div className="mobile-summary-cell col-span-2">
                        <span className="block text-[11px] text-slate-400">收货人 / 最晚发货</span>
                        <span className="mt-0.5 block text-slate-700">{order.recipient_name || "--"} / {latestShipTime ? formatLocalDateTime(latestShipTime) : "--"}</span>
                      </div>
                    </div>
                    <div className="mobile-summary-actions">
                      <button type="button" className="btn-secondary h-9" onClick={() => setDetailOrder(order)}>
                        查看详情
                      </button>
                    </div>
                  </article>
                );
              })}
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                <span>第 {page} / {filteredTotalPages} 页</span>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary h-8 px-3" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
                  <button type="button" className="btn-secondary h-8 px-3" disabled={page >= filteredTotalPages} onClick={() => setPage((current) => current + 1)}>下一页</button>
                </div>
              </div>
            </div>
            <div className="hidden md:block">
            <OrderCountdownProvider>
              <StandardTable
              page={page}
              pageSize={pageSize}
              totalPages={filteredTotalPages}
              totalRecordCount={totalOrderCount}
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
                              orderSort.direction === "asc"
                                ? <ArrowUp size={14} aria-hidden="true" />
                                : <ArrowDown size={14} aria-hidden="true" />
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
                      logisticsMethods={logisticsMethods}
                      settings={settings}
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
            </OrderCountdownProvider>
            </div>
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
