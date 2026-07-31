import type { User } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp } from "lucide-react";
import { OrderBulkActions } from "../components/orders/OrderBulkActions";
import { OrderDetailPanel } from "../components/orders/OrderDetailPanel";
import { OrderFilters } from "../components/orders/OrderFilters";
import {
  OrderCustomerHistoryLegend,
  OrderDataHeader,
  OrderFileActions,
  OrderPageNotices,
  OrderTrackingAlerts,
  type TrackingAlertFilter,
} from "../components/orders/OrderPageChrome";
import { ReshipOrderModal } from "../components/orders/ReshipOrderModal";
import { SplitOrderModal } from "../components/orders/SplitOrderModal";
import {
  OrderFileImportModal,
  type PreparedOrderFileImport,
} from "../components/orders/OrderFileImportModal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/ui";
import { StandardTable, type StandardTableColumn } from "../components/ui/StandardTable";
import {
  getOrdersErrorMessage,
  toDraft,
  type OrderDraft,
  useOrders,
} from "../hooks/useOrders";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import {
  downloadWorkbook,
} from "../lib/excel";
import {
  fillTemuUploadExportWorkbook,
  type TemuUploadExportRow,
} from "../lib/temu-upload-export";
import {
  fillShippingExportWorkbook,
  type ShippingExportRow,
} from "../lib/shipping-table-export";
import {
  getWarehouseLastLegMethods,
  getWarehouseLogisticsConfigStatus,
  isLastLegMethodIdAllowedForWarehouse,
} from "../lib/warehouse-logistics";
import {
  assignTemuOrderShipment,
  autoAssignTemuOrderShipment,
  cancelTemuOrderSplit,
  deleteTemuOrder,
  fetchTemuOrderFulfillmentByOrderNo,
  findNewTemuOrderImportRows,
  importTemuOrders,
  releaseTemuOrderShipmentInventory,
  saveTemuOrderSplit,
  updateTemuOrder,
  type TemuOrderImportRow,
  type TemuShipmentInventoryChange,
} from "../lib/orders";
import {
  fetchTemuTrackingAlerts,
  markTemuTrackingAlertHandled,
  refreshTemuTrackingForOrderIds,
  type TemuTrackingAlert,
} from "../lib/order-tracking";
import type {
  LogisticsMethod,
  Product,
  ProductSku,
  TemuOrderRecord,
  Warehouse,
} from "../types";
import {
  calculatePurchaseShippingRmb,
} from "../utils/shipping-costs";
import { confirmAction, confirmDelete, confirmSave } from "../utils/confirmations";
import {
  buildPendingAssignmentResetUpdates,
  getOrderFulfillmentAssignmentIssue,
  getOrderStage,
  getOrderStageDefinition as getStageDefinition,
  isShippingTrackingStage,
  orderStageDefinitions as stageDefinitions,
  shouldReserveOrderInventory,
  type OrderStage,
  uploadedTemuOrderStatus,
} from "../domain/order-workflow";
import {
  matchSingleSkuThreeCmShipment,
} from "../domain/order-auto-match";
import {
  getOrderCustomerHistoryMeta,
  getOrderCustomerHistoryTitle,
} from "../domain/order-customer-history";

type OrdersPageProps = {
  user: User;
};

import {
  OrderSortKey,
  OrderSort,
  OrderStockDeduction,
  rmbPerUsdForDeclaration,
  defaultOrderSort,
  temuUploadWarehouseName,
  visibleColumns,
  orderColumnWidths,
  normalizeSkuCode,
  normalizeSalesSpec,
  formatStyleColorForDeclaration,
  normalizeLogisticsMethod,
  buildSkuOrderLookup,
  getOrderFulfillmentQuantity,
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
  getFullAddress,
  formatRecipientPhone,
  formatRecipientName,
  hasAnyRecipientInfo,
  hasCompleteRecipientInfo,
  getTrackingStatusLabel,
  getTemuUploadCarrier,
  formatLocalDateTime,
  formatFileTimestamp,
  parseOrderDateTime,
  normalizeRmbAmount,
} from "./orders/OrderTableRow";
import {
  buildTrackingImportPreview,
  type TrackingImportPreview,
} from "../lib/order-tracking-import";
import type { OrderFileImportKind } from "../lib/order-file-import-templates";

type OrderImportReviewRow = {
  sourceRowNumber: number;
  orderNo: string;
  subOrderNo: string;
  status: "importable" | "duplicate_file" | "existing" | "missing_order_no";
  message: string;
};

type PendingOrderFileImport = {
  kind: "orders";
  fileName: string;
  templateName: string;
  sheetName: string;
  totalRowCount: number;
  rows: OrderImportReviewRow[];
  importRows: TemuOrderImportRow[];
  missingRecipientInfoCount: number;
};

type PendingTrackingFileImport = {
  kind: "tracking";
  fileName: string;
  templateName: string;
  sheetName: string;
  totalRowCount: number;
  preview: TrackingImportPreview;
};

type PendingOrderPageFileImport =
  | PendingOrderFileImport
  | PendingTrackingFileImport;

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
  const [openFileImportKind, setOpenFileImportKind] =
    useState<OrderFileImportKind | null>(null);
  const [pendingFileImport, setPendingFileImport] =
    useState<PendingOrderPageFileImport | null>(null);

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
    productWarehouseShippingLimits,
    orderAutoMatchSettings,
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
    reloadOrders,
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
  const [trackingAlerts, setTrackingAlerts] = useState<TemuTrackingAlert[]>([]);
  const [trackingAlertFilter, setTrackingAlertFilter] =
    useState<TrackingAlertFilter>("unhandled");
  const [trackingAlertRefreshVersion, setTrackingAlertRefreshVersion] =
    useState(0);
  const [handlingTrackingOrderNo, setHandlingTrackingOrderNo] = useState("");
  const [detailOrder, setDetailOrder] = useState<TemuOrderRecord | null>(null);
  const [reshipTargetOrder, setReshipTargetOrder] = useState<TemuOrderRecord | null>(null);
  const [reshipRelatedOrders, setReshipRelatedOrders] = useState<
    TemuOrderRecord[]
  >([]);
  const [splitOrderLines, setSplitOrderLines] = useState<TemuOrderRecord[] | null>(
    null,
  );

  const handleReshipSuccess = (newOrders: TemuOrderRecord[]) => {
    updateOrdersState(newOrders);
    setNoticeMessage(`补发订单创建成功！共创建 ${newOrders.length} 条商品记录。`);
    
    setActiveStage("pending_assignment");
    setPage(1);
    setSearch("");
    setSelectedOrderIds([]);
    setReshipTargetOrder(null);
    setReshipRelatedOrders([]);
    setDetailOrder(null);
  };
  useAutoDismiss(noticeMessage, () => setNoticeMessage(""));

  useEffect(() => {
    let active = true;

    async function loadTrackingAlerts() {
      try {
        const nextAlerts = await fetchTemuTrackingAlerts();
        if (active) setTrackingAlerts(nextAlerts);
      } catch (error) {
        if (active) {
          setErrorMessage(
            getOrdersErrorMessage(error, "加载物流异常提醒失败"),
          );
        }
      }
    }

    void loadTrackingAlerts();
    return () => {
      active = false;
    };
  }, [setErrorMessage, trackingAlertRefreshVersion, user.id]);

  useEffect(() => {
    const refreshTrackingAlerts = () => {
      if (document.visibilityState === "visible") {
        setTrackingAlertRefreshVersion((current) => current + 1);
      }
    };
    const intervalId = window.setInterval(refreshTrackingAlerts, 5 * 60 * 1000);

    document.addEventListener("visibilitychange", refreshTrackingAlerts);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshTrackingAlerts);
    };
  }, []);

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
        ? getWarehouseLastLegMethods(
            selectedBulkWarehouse.id,
            logisticsMethods,
            warehouseLogisticsMethods,
          )
        : [],
    [
      logisticsMethods,
      selectedBulkWarehouse,
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
    () => filteredOrders.filter((order) => getOrderStage(order) === "new_order"),
    [filteredOrders],
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
      const stage = getOrderStage(ordersById.get(row.primaryOrder.id) ?? row.primaryOrder);
      if (stage === "new_order") counts.selectedNewOrderRowCount += 1;
      if (stage === "pending_shipping") counts.selectedPendingShippingRowCount += 1;
      if (stage === "shipped") counts.selectedShippedRowCount += 1;
      if (stage === "uploaded_temu") counts.selectedUploadedTemuRowCount += 1;
    });

    return counts;
  }, [ordersById, selectedOrderRowsInView]);

  const selectedOrderLineInViewCount = selectedOrdersInView.length;
  const selectedInViewCount = selectedOrderRowsInView.length;
  const hasSelectedCompletedOrders = selectedCompletedOrdersInView.length > 0;
  const selectedSingleOrderInView =
    selectedOrderRowsInView.length === 1 ? selectedOrderRowsInView[0].primaryOrder : null;
  const selectedSingleOrderRow =
    selectedOrderRowsInView.length === 1 ? selectedOrderRowsInView[0] : null;
  const canSplitSelectedOrder = Boolean(
    selectedSingleOrderInView &&
      getOrderStage(selectedSingleOrderInView) === "pending_assignment" &&
      (selectedSingleOrderInView.is_split ||
        (selectedSingleOrderRow?.quantity ?? 0) > 1),
  );
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

  function getOrderWarehouseLogisticsIssue(order: TemuOrderRecord) {
    const assignmentIssue = getOrderFulfillmentAssignmentIssue(order);
    if (getOrderStage(order) !== "pending_assignment" && assignmentIssue) {
      return `${order.order_no}：${assignmentIssue}`;
    }
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
    ordersToValidate: TemuOrderRecord[],
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

      const targetOrders = orderIds
        .map((orderId) => ordersById.get(orderId))
        .filter((order): order is TemuOrderRecord => Boolean(order));
      const stockIssue = getWarehouseStockIssueForOrders(targetOrders, warehouse.id);
      if (stockIssue) {
        setErrorMessage(stockIssue);
        return;
      }
    }

    const nextWarehouseName = warehouse?.name ?? "";
    updateDraftFieldsForOrders(orderIds, {
      warehouse_id: warehouse?.id ?? warehouseId,
      warehouse_name: nextWarehouseName,
      logistics_method_id: null,
      logistics_method: "",
    });
  }

  async function handleLogisticsMethodChangeForOrders(
    orderIds: string[],
    value: string,
  ) {
    const logisticsMethodId = value.trim();
    if (!logisticsMethodId) {
      updateDraftFieldsForOrders(orderIds, {
        logistics_method_id: null,
        logistics_method: "",
      });
      return;
    }
    if (!canEdit || busyKey) return;

    const targetOrders = orderIds
      .map((orderId) => ordersById.get(orderId))
      .filter((order): order is TemuOrderRecord => Boolean(order));
    if (targetOrders.length !== orderIds.length || targetOrders.length === 0) {
      setErrorMessage("订单数据已变化，请刷新页面后重新分配。");
      return;
    }

    const previousDrafts = new Map(
      targetOrders.map((order) => [order.id, drafts[order.id] ?? toDraft(order)]),
    );
    const warehouseIds = new Set(
      targetOrders
        .map((order) => previousDrafts.get(order.id)?.warehouse_id ?? null)
        .filter((warehouseId): warehouseId is string => Boolean(warehouseId)),
    );
    if (warehouseIds.size !== 1) {
      setErrorMessage(`订单 ${targetOrders[0].order_no} 还没有选择统一的发货仓库。`);
      return;
    }

    const warehouseId = Array.from(warehouseIds)[0];
    const warehouse = warehouses.find((item) => item.id === warehouseId);
    if (!warehouse) {
      setErrorMessage("选择的仓库不存在，请重新选择。");
      return;
    }
    const logisticsMethod = logisticsMethods.find(
      (method) => method.id === logisticsMethodId && method.is_active,
    );
    if (!logisticsMethod) {
      setErrorMessage("选择的发货方式不存在或已停用，请刷新后重试。");
      return;
    }
    if (
      !isLastLegMethodIdAllowedForWarehouse(
        warehouse.id,
        logisticsMethod.id,
        logisticsMethods,
        warehouseLogisticsMethods,
      )
    ) {
      setErrorMessage(`${warehouse.name} 不能使用“${logisticsMethod.name}”发货方式。`);
      return;
    }

    const stockIssue = getWarehouseStockIssueForOrders(targetOrders, warehouse.id);
    if (stockIssue) {
      setErrorMessage(stockIssue);
      return;
    }

    updateDraftFieldsForOrders(orderIds, {
      logistics_method_id: logisticsMethodId,
      logistics_method: logisticsMethod.name,
    });
    setBusyKey(`assign-${orderIds.join("|")}`);
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const saveEntries = targetOrders.map((order) => {
        const draft = previousDrafts.get(order.id) ?? toDraft(order);
        const updates = {
          ...draft,
          warehouse_id: warehouse.id,
          warehouse_name: warehouse.name,
          logistics_method_id: logisticsMethodId,
          logistics_method: logisticsMethod.name,
          order_status: draft.order_status.trim() || "新订单",
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const saveResult = await saveOrderEntriesWithInventory(saveEntries);
      const { nextOrders, failures } = saveResult;

      failures.forEach(({ order }) => {
        const previousDraft = previousDrafts.get(order.id) ?? toDraft(order);
        updateDraftFieldsForOrders([order.id], {
          logistics_method_id: previousDraft.logistics_method_id,
          logistics_method: previousDraft.logistics_method,
        });
      });
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }

      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter((id) => !nextOrders.some((order) => order.id === id)),
      );
      setNoticeMessage(
        [
          `已自动分配 ${buildOrderDisplayRows(nextOrders).length} 个订单并转入新订单`,
          formatInventoryChangeSummary(saveResult),
          failures.length > 0 ? `${failures.length} 条保存失败` : "",
        ].filter(Boolean).join("，"),
      );
    } catch (error) {
      targetOrders.forEach((order) => {
        const previousDraft = previousDrafts.get(order.id) ?? toDraft(order);
        updateDraftFieldsForOrders([order.id], {
          logistics_method_id: previousDraft.logistics_method_id,
          logistics_method: previousDraft.logistics_method,
        });
      });
      setErrorMessage(getOrdersErrorMessage(error, "自动分配订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  function getOrderSku(order: TemuOrderRecord) {
    const skuCode = normalizeSkuCode(order.sku_code);
    if (skuCode) return skuOrderLookup.skuByCode.get(skuCode) ?? null;
    return skuOrderLookup.skuBySalesSpec.get(normalizeSalesSpec(order.product_attributes)) ?? null;
  }

  function getWarehouseStockIssueForOrders(
    targetOrders: TemuOrderRecord[],
    warehouseId: string,
  ) {
    const warehouseName =
      warehouses.find((warehouse) => warehouse.id === warehouseId)?.name || "所选仓库";
    const requiredQuantityBySkuId = new Map<
      string,
      { sku: ProductSku; quantity: number }
    >();

    for (const order of targetOrders) {
      const sku = getOrderSku(order);
      if (!sku?.id) {
        return `订单 ${order.order_no} 没有匹配到商品 SKU，不能分配仓库。`;
      }
      const current = requiredQuantityBySkuId.get(sku.id);
      requiredQuantityBySkuId.set(sku.id, {
        sku,
        quantity:
          (current?.quantity ?? 0) + getOrderFulfillmentQuantity(order),
      });
    }

    for (const [skuId, requirement] of requiredQuantityBySkuId) {
      const stock = warehouseSkusByKey.get(`${warehouseId}:${skuId}`);
      const availableQuantity = stock?.stock_quantity ?? 0;
      if (availableQuantity < requirement.quantity) {
        return `${warehouseName} 的 SKU ${requirement.sku.sku_code || skuId} 库存不足：当前 ${availableQuantity}，需要 ${requirement.quantity}。`;
      }
    }

    return "";
  }

  function canQueryTrackingStatus(order: TemuOrderRecord) {
    return Boolean(
      order.logistics_tracking_no.trim() &&
        isShippingTrackingStage(getOrderStage(order)),
    );
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

  function getOrderDetailRows(order: TemuOrderRecord) {
    const merged = mergeOrderDraft(order);
    const rows: Array<readonly [string, string]> = [
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
    ];
    if (merged.is_split) {
      rows.splice(1, 0, [
        "拆单包裹",
        `${merged.package_sequence}/${merged.package_count}`,
      ]);
    }
    return rows;
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

  async function handlePreparedFileImport(
    prepared: PreparedOrderFileImport,
  ) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入文件。");
      return;
    }
    setErrorMessage("");
    setNoticeMessage("");

    if (prepared.kind === "shipping_export") {
      if (selectedPendingShippingOrdersInView.length === 0) {
        setNoticeMessage("请先勾选要下载发货表格的待发货订单。");
        return;
      }
      const validationMessage = validateOrdersReadyForFulfillment(
        selectedPendingShippingOrdersInView,
      );
      if (validationMessage) {
        setErrorMessage(validationMessage);
        return;
      }
      setBusyKey("download-shipping-table");
      try {
        await downloadOcsShippingWorkbook(
          selectedPendingShippingOrdersInView,
          prepared.template,
          prepared.workbook,
        );
        setNoticeMessage(
          `已按模板“${prepared.template.name}”下载 ${buildOrderDisplayRows(selectedPendingShippingOrdersInView).length} 行发货表格`,
        );
        setOpenFileImportKind(null);
      } catch (error) {
        setErrorMessage(getOrdersErrorMessage(error, "下载发货表格失败"));
      } finally {
        setBusyKey("");
      }
      return;
    }

    if (prepared.kind === "temu_upload") {
      if (selectedShippedOrdersInView.length === 0) {
        setNoticeMessage("请先勾选要下载上传表格的已发货订单。");
        return;
      }
      const validationMessage = validateOrdersReadyForTemuUpload(
        selectedShippedOrdersInView,
      );
      if (validationMessage) {
        setErrorMessage(validationMessage);
        return;
      }
      setBusyKey("download-temu-upload-table");
      try {
        await downloadTemuUploadWorkbook(
          selectedShippedOrdersInView,
          prepared.template,
          prepared.workbook,
        );
        setNoticeMessage(
          `已按模板“${prepared.template.name}”下载 ${selectedShippedOrdersInView.length} 条订单的上传表格`,
        );
        setOpenFileImportKind(null);
      } catch (error) {
        setErrorMessage(getOrdersErrorMessage(error, "下载上传表格失败"));
      } finally {
        setBusyKey("");
      }
      return;
    }

    if (prepared.kind === "tracking") {
      const records = prepared.parsed.rows.map((row) => ({
        sourceRowNumber: row.sourceRowNumber,
        orderNo: row.values.order_no ?? "",
        subOrderNo: row.values.sub_order_no ?? "",
        trackingNo: row.values.tracking_no ?? "",
      }));
      const preview = buildTrackingImportPreview(
        records,
        allOrders.filter(
          (order) => getOrderStage(order) === "pending_shipping",
        ),
      );
      setPendingFileImport({
        kind: "tracking",
        fileName: prepared.fileName,
        templateName: prepared.template.name,
        sheetName: prepared.parsed.sheetName,
        totalRowCount: prepared.parsed.totalRowCount,
        preview,
      });
      setOpenFileImportKind(null);
      return;
    }

    setBusyKey("import-preview");
    try {
      const { products: nextProducts, productSkus: nextSkus } =
        await fetchLatestProductsAndSkus();
      const importSkuLookup = buildSkuOrderLookup(nextProducts, nextSkus);
      const parsedRows = prepared.parsed.rows.map((source) => {
        const values = source.values;
        const skuCode = values.sku_code ?? "";
        const matchedSalesSpec = importSkuLookup.salesSpecByCode.get(
          normalizeSkuCode(skuCode),
        );
        return {
          sourceRowNumber: source.sourceRowNumber,
          row: {
            order_no: values.order_no ?? "",
            sub_order_no:
              values.sub_order_no || String(source.sourceRowNumber),
            order_status: values.order_status ?? "",
            sku_code: skuCode,
            fulfillment_quantity: parseFulfillmentQuantity(
              values.fulfillment_quantity ?? "",
            ),
            product_attributes:
              matchedSalesSpec ?? values.product_attributes ?? "",
            recipient_name: values.recipient_name ?? "",
            recipient_phone: values.recipient_phone ?? "",
            email: values.email ?? "",
            province: values.province ?? "",
            city: values.city ?? "",
            district: values.district ?? "",
            address_line1: values.address_line1 ?? "",
            address_line2: values.address_line2 ?? "",
            postal_code: values.postal_code ?? "",
            latest_ship_time: values.latest_ship_time ?? "",
            actual_ship_time: values.actual_ship_time ?? "",
            estimated_delivery_time:
              values.estimated_delivery_time ?? "",
          } satisfies TemuOrderImportRow,
        };
      });

      const validRows = parsedRows.filter((item) => item.row.order_no.trim());
      const uniqueRows = dedupeImportRowsByOrderLine(
        validRows.map((item) => item.row),
      );
      const uniqueKeys = new Set(uniqueRows.map(getOrderLineKey));
      const databaseNewRows = await findNewTemuOrderImportRows(uniqueRows);
      const databaseNewLineKeys = new Set(
        databaseNewRows.map(getOrderLineKey),
      );
      const seenUniqueKeys = new Set<string>();

      const importRows: TemuOrderImportRow[] = [];
      const reviewRows: OrderImportReviewRow[] = parsedRows.map((item) => {
        const lineKey = getOrderLineKey(item.row);
        if (!item.row.order_no.trim()) {
          return {
            sourceRowNumber: item.sourceRowNumber,
            orderNo: "",
            subOrderNo: item.row.sub_order_no,
            status: "missing_order_no",
            message: "订单号为空",
          };
        }
        if (
          !uniqueKeys.has(lineKey) ||
          (lineKey && seenUniqueKeys.has(lineKey))
        ) {
          return {
            sourceRowNumber: item.sourceRowNumber,
            orderNo: item.row.order_no,
            subOrderNo: item.row.sub_order_no,
            status: "duplicate_file",
            message: "上传文件内订单明细重复，已跳过",
          };
        }
        if (lineKey) seenUniqueKeys.add(lineKey);
        if (!databaseNewLineKeys.has(lineKey)) {
          return {
            sourceRowNumber: item.sourceRowNumber,
            orderNo: item.row.order_no,
            subOrderNo: item.row.sub_order_no,
            status: "existing",
            message: "网站已有该订单明细，已跳过",
          };
        }
        importRows.push(item.row);
        return {
          sourceRowNumber: item.sourceRowNumber,
          orderNo: item.row.order_no,
          subOrderNo: item.row.sub_order_no,
          status: "importable",
          message: "可导入",
        };
      });

      setPendingFileImport({
        kind: "orders",
        fileName: prepared.fileName,
        templateName: prepared.template.name,
        sheetName: prepared.parsed.sheetName,
        totalRowCount: prepared.parsed.totalRowCount,
        rows: reviewRows,
        importRows,
        missingRecipientInfoCount: importRows.filter(
          (row) => !hasAnyRecipientInfo(row),
        ).length,
      });
      setOpenFileImportKind(null);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "核对订单文件失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function confirmPendingOrderFileImport() {
    if (!pendingFileImport || pendingFileImport.kind !== "orders") return;
    setBusyKey("import");
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const savedOrders =
        pendingFileImport.importRows.length > 0
          ? await importTemuOrders(pendingFileImport.importRows)
          : [];
      if (savedOrders.length > 0) {
        updateOrdersState(savedOrders);
        setActiveStage("pending_assignment");
        setSearch("");
        setWarehouseFilter("");
        setLogisticsMethodFilter("");
        setShowUrgentUnuploadedOnly(false);
        setPage(1);
      }
      const duplicateCount = pendingFileImport.rows.filter(
        (row) => row.status === "duplicate_file",
      ).length;
      const existingCount = pendingFileImport.rows.filter(
        (row) => row.status === "existing",
      ).length;
      setNoticeMessage(
        [
          savedOrders.length > 0
            ? `已导入 ${savedOrders.length} 条新订单明细`
            : "没有新增订单",
          duplicateCount > 0
            ? `跳过上传表内重复订单明细 ${duplicateCount} 行`
            : "",
          existingCount > 0
            ? `跳过已有订单明细 ${existingCount} 条`
            : "",
          pendingFileImport.missingRecipientInfoCount > 0
            ? `${pendingFileImport.missingRecipientInfoCount} 条订单仍缺少收件信息，请重新上传包含收件信息的 Temu 订单表`
            : "",
        ].filter(Boolean).join("，"),
      );
      setPendingFileImport(null);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "导入订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function confirmPendingTrackingFileImport() {
    if (!pendingFileImport || pendingFileImport.kind !== "tracking") return;
    setBusyKey("tracking-import");
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const saveEntries = pendingFileImport.preview.matches.flatMap((match) =>
        match.orders.map((order) => {
          const draft = drafts[order.id] ?? toDraft(order);
          const updates = {
            ...draft,
            order_status: "已发货",
            actual_ship_time: "",
            logistics_tracking_no: match.record.trackingNo,
            logistics_status: "待查询",
          };
          return { order, updates, nextOrder: { ...order, ...updates } };
        }),
      );
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(saveEntries);
      if (nextOrders.length === 0 && failures.length > 0) {
        throw failures[0].error;
      }
      updateOrdersState(nextOrders);
      setSelectedOrderIds((current) =>
        current.filter(
          (id) => !nextOrders.some((order) => order.id === id),
        ),
      );
      setActiveStage("shipped");
      const skippedCount = pendingFileImport.preview.rows.filter(
        (row) => row.status !== "importable",
      ).length;
      setNoticeMessage(
        [
          `已匹配物流单号 ${pendingFileImport.preview.matches.length} 个包裹并转入已发货`,
          inventoryChanges.length > 0
            ? `扣减 ${inventoryChanges.length} 项 SKU 库存`
            : "",
          skippedCount > 0 ? `跳过 ${skippedCount} 行未匹配或冲突数据` : "",
          failures.length > 0 ? `${failures.length} 条更新失败` : "",
        ].filter(Boolean).join("，"),
      );
      setPendingFileImport(null);
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
    const queryableOrderCount = new Set(
      queryableOrders.map((order) => getOrderNoKey(order.order_no)),
    ).size;
    if (queryableOrders.length === 0) {
      if (showNotice) setNoticeMessage("当前没有可查询的物流单号。");
      return;
    }
    if (
      showNotice &&
      !(await confirmAction(
        `确认查询当前页面 ${queryableOrderCount} 个订单的物流状态吗？`,
      ))
    ) {
      return;
    }

    setBusyKey(busyName);
    if (showNotice) {
      setErrorMessage("");
      setNoticeMessage("");
    }

    try {
      if (showNotice) {
        setNoticeMessage(
          `正在查询当前页面 ${queryableOrderCount} 个订单的物流状态...`,
        );
      }
      const result = await refreshTemuTrackingForOrderIds(
        queryableOrders.map((order) => order.id),
      );
      reloadOrders();
      setTrackingAlertRefreshVersion((current) => current + 1);

      if (showNotice) {
        setNoticeMessage(
          [
            `已查询 ${result.queriedOrderCount} 个订单`,
            result.exceptionOrderCount > 0
              ? `发现 ${result.exceptionOrderCount} 个物流异常`
              : "",
            result.deliveredOrderCount > 0
              ? `${result.deliveredOrderCount} 个订单已签收`
              : "",
            result.failedOrderCount > 0
              ? `${result.failedOrderCount} 个订单查询失败（保留原物流状态）`
              : "",
          ]
            .filter(Boolean)
            .join("，"),
        );
      }
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "查询物流状态失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleMarkTrackingAlertHandled(alert: TemuTrackingAlert) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能处理物流异常。");
      return;
    }

    setHandlingTrackingOrderNo(alert.order_no);
    setErrorMessage("");
    try {
      const updatedCount = await markTemuTrackingAlertHandled(
        alert.order_no,
        alert.tracking_exception_fingerprint,
      );
      if (updatedCount === 0) {
        throw new Error("物流异常已发生变化，请刷新后重新处理。");
      }
      reloadOrders();
      setTrackingAlertRefreshVersion((current) => current + 1);
      setNoticeMessage(`订单 ${alert.order_no} 的物流异常已标记为已处理。`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "处理物流异常失败"));
    } finally {
      setHandlingTrackingOrderNo("");
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
    options: { autoMatch?: boolean } = {},
  ) {
    assertOrdersWarehouseLogisticsComplete(entries.map((entry) => entry.nextOrder));

    const nextOrders: TemuOrderRecord[] = [];
    const inventoryChanges: TemuShipmentInventoryChange[] = [];
    const deductedInventoryChanges: TemuShipmentInventoryChange[] = [];
    const restoredInventoryChanges: TemuShipmentInventoryChange[] = [];
    const failures: Array<{ order: TemuOrderRecord; error: unknown }> = [];

    const collectInventoryChanges = (
      changes: TemuShipmentInventoryChange[],
    ) => {
      inventoryChanges.push(...changes);
      deductedInventoryChanges.push(...changes.filter((change) => change.change_quantity < 0));
      restoredInventoryChanges.push(...changes.filter((change) => change.change_quantity > 0));
    };

    const entriesByShipment = new Map<string, typeof entries>();
    entries.forEach((entry) => {
      const shipmentKey = entry.order.shipment_id || entry.order.id;
      entriesByShipment.set(shipmentKey, [
        ...(entriesByShipment.get(shipmentKey) ?? []),
        entry,
      ]);
    });

    const shipmentDraftFields = [
      "order_status",
      "label_printed_at",
      "logistics_tracking_no",
      "logistics_status",
      "actual_ship_time",
      "actual_signed_time",
      "actual_shipping_fee_rmb",
    ] as const;

    for (const shipmentEntries of entriesByShipment.values()) {
      const entry = shipmentEntries[0];
      if (!entry) continue;

      const previousStage = getOrderStage(entry.order);
      const nextStage = getOrderStage(entry.nextOrder);
      const hadReservedInventory = shouldReserveOrderInventory(previousStage);
      const shouldReserveInventory = shouldReserveOrderInventory(nextStage);
      const shouldReleaseInventory = hadReservedInventory && !shouldReserveInventory;
      const assignmentChanged =
        entry.order.warehouse_id !== entry.nextOrder.warehouse_id ||
        normalizeLogisticsMethod(entry.order.logistics_method) !==
          normalizeLogisticsMethod(entry.nextOrder.logistics_method) ||
        entry.order.logistics_method_id !== entry.nextOrder.logistics_method_id;

      try {
        let nextShipmentOrders: TemuOrderRecord[] = [];
        let shipmentInventoryChanges: TemuShipmentInventoryChange[] = [];

        if (shouldReserveInventory && (!hadReservedInventory || assignmentChanged)) {
          const nextShipmentLines = shipmentEntries.map(
            (shipmentEntry) => shipmentEntry.nextOrder,
          );
          const stockDeductionResult = buildOrderStockDeductions(nextShipmentLines);
          if (stockDeductionResult.errorMessage) {
            throw new Error(stockDeductionResult.errorMessage);
          }

          const warehouseId = entry.nextOrder.warehouse_id;
          const logisticsMethodId = entry.nextOrder.logistics_method_id;
          if (!warehouseId || !logisticsMethodId) {
            throw new Error("仓库和尾程发货方式必须同时选择。");
          }

          const assignShipment = options.autoMatch
            ? autoAssignTemuOrderShipment
            : assignTemuOrderShipment;
          const result = await assignShipment({
            shipmentId: entry.order.shipment_id,
            warehouseId,
            logisticsMethodId,
            reservations: stockDeductionResult.deductions.map((deduction) => ({
              shipmentItemId: deduction.orderId,
              warehouseSkuId: deduction.stock.id,
            })),
            reason: `订单包裹库存占用：${getOrderLineLabel(entry.order)}`,
          });
          nextShipmentOrders = result.orders;
          shipmentInventoryChanges = result.changes;
        } else if (shouldReleaseInventory) {
          const result = await releaseTemuOrderShipmentInventory(
            entry.order.shipment_id,
            `订单库存释放：${getOrderLineLabel(entry.order)}`,
          );
          nextShipmentOrders = result.orders;
          shipmentInventoryChanges = result.changes;
        }

        const shipmentUpdates = Object.fromEntries(
          shipmentDraftFields
            .filter((field) => Object.prototype.hasOwnProperty.call(entry.updates, field))
            .map((field) => [field, entry.updates[field]]),
        ) as Parameters<typeof updateTemuOrder>[1];
        const sanitizedUpdates = sanitizeOrderUpdatesForSave(
          entry.order,
          shipmentUpdates,
        );
        if (Object.keys(sanitizedUpdates).length > 0) {
          const updated = await updateTemuOrder(entry.order.id, sanitizedUpdates);
          const shipmentSource =
            nextShipmentOrders.length > 0
              ? nextShipmentOrders
              : allOrders.filter(
                  (order) => order.shipment_id === entry.order.shipment_id,
                );
          nextShipmentOrders = shipmentSource.map((order) => ({
            ...order,
            ...Object.fromEntries(
              shipmentDraftFields.map((field) => [field, updated[field]]),
            ),
          }));
        }

        if (nextShipmentOrders.length === 0) {
          nextShipmentOrders = shipmentEntries.map(
            (shipmentEntry) => shipmentEntry.nextOrder,
          );
        }
        nextOrders.push(...nextShipmentOrders);
        collectInventoryChanges(shipmentInventoryChanges);
      } catch (error) {
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
    const pendingOrderAssignments = selectedOrdersInView
      .filter((order) => getOrderStage(order) === "pending_assignment")
      .map((order) => ({ order, nextOrder: mergeOrderDraft(order) }));
    const incompletePendingOrder = pendingOrderAssignments.find(
      ({ nextOrder }) => Boolean(getOrderFulfillmentAssignmentIssue(nextOrder)),
    );
    if (incompletePendingOrder) {
      setErrorMessage(
        `订单 ${incompletePendingOrder.order.order_no}：${getOrderFulfillmentAssignmentIssue(incompletePendingOrder.nextOrder)}`,
      );
      return;
    }
    const invalidPendingOrder = pendingOrderAssignments
      .find(
        ({ nextOrder }) =>
          Boolean(nextOrder.logistics_method_id || nextOrder.logistics_method.trim()) &&
          (!nextOrder.warehouse_id ||
            !nextOrder.logistics_method_id ||
            !isLastLegMethodIdAllowedForWarehouse(
              nextOrder.warehouse_id,
              nextOrder.logistics_method_id,
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

    const targetOrders = selectedNewOrdersInView;
    const targetIds = new Set(targetOrders.map((order) => order.id));
    const pendingAssignmentUpdates: Parameters<typeof updateTemuOrder>[1] =
      buildPendingAssignmentResetUpdates();
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

  async function handleOpenSplitOrder() {
    if (!canEdit || !selectedSingleOrderInView) return;
    setBusyKey("load-split-order");
    setErrorMessage("");
    try {
      const orderLines = await fetchTemuOrderFulfillmentByOrderNo(
        selectedSingleOrderInView.order_no,
      );
      if (orderLines.length === 0) {
        throw new Error("没有找到该订单的包裹明细。");
      }
      const totalQuantityBySource = new Map<string, number>();
      orderLines.forEach((order) => {
        const sourceId = order.source_order_id || order.id;
        totalQuantityBySource.set(
          sourceId,
          (totalQuantityBySource.get(sourceId) ?? 0) +
            order.fulfillment_quantity,
        );
      });
      const totalQuantity = Array.from(totalQuantityBySource.values()).reduce(
        (total, quantity) => total + quantity,
        0,
      );
      if (totalQuantity < 2) {
        throw new Error("订单商品总数不足 2 件，不能拆单。");
      }
      setSplitOrderLines(orderLines);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "加载拆单信息失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleOpenReshipOrder(order: TemuOrderRecord) {
    setBusyKey("load-reship-order");
    setErrorMessage("");
    try {
      const fulfillmentLines = await fetchTemuOrderFulfillmentByOrderNo(
        order.order_no,
      );
      const sourceLines = new Map<string, TemuOrderRecord>();
      fulfillmentLines.forEach((line) => {
        const sourceId = line.source_order_id || line.id;
        const current = sourceLines.get(sourceId);
        sourceLines.set(sourceId, {
          ...(current ?? line),
          fulfillment_quantity:
            (current?.fulfillment_quantity ?? 0) +
            line.fulfillment_quantity,
        });
      });
      const relatedOrders = Array.from(sourceLines.values());
      if (relatedOrders.length === 0) {
        throw new Error("没有找到原订单商品明细。");
      }
      setReshipTargetOrder(order);
      setReshipRelatedOrders(relatedOrders);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "加载补发订单明细失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSaveOrderSplit(
    packages: Parameters<typeof saveTemuOrderSplit>[1],
  ) {
    if (!splitOrderLines?.[0]) return;
    setBusyKey("save-order-split");
    setErrorMessage("");
    try {
      await saveTemuOrderSplit(splitOrderLines[0].order_no, packages);
      const packageCount = packages.length;
      setSplitOrderLines(null);
      setSelectedOrderIds([]);
      reloadOrders();
      setNoticeMessage(`拆单已保存，共 ${packageCount} 个待分配包裹。`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "保存拆单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleCancelOrderSplit() {
    if (!canEdit || !selectedSingleOrderInView?.is_split) return;
    if (
      !(await confirmAction(
        `确认取消订单 ${selectedSingleOrderInView.order_no} 的拆单，并恢复为一个待分配订单吗？`,
      ))
    ) {
      return;
    }

    setBusyKey("cancel-order-split");
    setErrorMessage("");
    try {
      await cancelTemuOrderSplit(selectedSingleOrderInView.order_no);
      setSelectedOrderIds([]);
      reloadOrders();
      setNoticeMessage("已取消拆单并恢复为一个待分配订单。");
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "取消拆单失败"));
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

    setBusyKey("delete-selected");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const inventoryChanges: TemuShipmentInventoryChange[] = [];
      const selectedOrderGroups = new Map<string, TemuOrderRecord>();
      selectedOrdersInView.forEach((order) => {
        const key = order.order_no.trim().toLowerCase();
        if (key && !selectedOrderGroups.has(key)) {
          selectedOrderGroups.set(key, order);
        }
      });

      for (const order of selectedOrderGroups.values()) {
        const result = await deleteTemuOrder(order.id);
        inventoryChanges.push(...(result?.released_changes ?? []));
      }

      applyWarehouseSkuStockUpdates(inventoryChanges.map((change) => change.sku));
      const deletedOrderKeys = new Set(selectedOrderGroups.keys());
      const deletedIds = allOrders
        .filter((order) =>
          deletedOrderKeys.has(order.order_no.trim().toLowerCase()),
        )
        .map((order) => order.id);
      removeOrders(deletedIds);
      setSelectedOrderIds((current) =>
        current.filter((id) => !deletedIds.includes(id)),
      );
      clearDrafts(deletedIds);
      setNoticeMessage(
        inventoryChanges.length > 0
          ? `已删除 ${selectedOrderGroups.size} 个订单，并回补 ${inventoryChanges.length} 项 SKU 库存`
          : `已删除 ${selectedOrderGroups.size} 个订单`,
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

    const logisticsMethodId = bulkLogisticsMethod.trim();
    const logisticsMethod = logisticsMethods.find(
      (method) => method.id === logisticsMethodId && method.is_active,
    );
    if (!selectedWarehouse) {
      setNoticeMessage("请选择仓库后再批量分配。");
      return;
    }
    if (!logisticsMethodId || !logisticsMethod) {
      setNoticeMessage("请选择发货方式后再批量分配。");
      return;
    }
    if (
      selectedWarehouse &&
      !isLastLegMethodIdAllowedForWarehouse(
        selectedWarehouse.id,
        logisticsMethod.id,
        logisticsMethods,
        warehouseLogisticsMethods,
      )
    ) {
      setErrorMessage(`${selectedWarehouse.name} 不能使用“${logisticsMethod.name}”发货方式。`);
      return;
    }
    if (selectedWarehouse) {
      const stockIssue = getWarehouseStockIssueForOrders(
        pendingSelectedOrders,
        selectedWarehouse.id,
      );
      if (stockIssue) {
        setErrorMessage(stockIssue);
        return;
      }
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
        const nextDraft: OrderDraft = {
          ...draft,
          warehouse_id: nextWarehouseId,
          warehouse_name: nextWarehouseName,
          logistics_method: logisticsMethod.name,
          logistics_method_id: logisticsMethod.id,
        };
        const updates = {
          ...nextDraft,
          order_status:
            nextDraft.order_status.trim() ||
            (nextDraft.warehouse_id && nextDraft.logistics_method_id ? "新订单" : ""),
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
    if (!orderAutoMatchSettings.enabled) {
      setNoticeMessage("自动匹配当前已暂停，请先完成仓库和尾程配置后再启用。");
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
    const matchedOrders: Array<{
      order: TemuOrderRecord;
      warehouse: Warehouse;
      logisticsMethod: LogisticsMethod;
    }> = [];
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
      const matchResult = matchSingleSkuThreeCmShipment({
        lines: groupOrders.map((order) => ({
          label: getOrderLineLabel(order),
          quantity: getOrderFulfillmentQuantity(order),
          sku: getOrderSku(order),
        })),
        warehouses,
        logisticsMethods,
        warehouseLogisticsMethods,
        warehouseSkus,
        productWarehouseShippingLimits,
        availableStockByKey: groupAvailableStockByKey,
      });
      if (matchResult.status !== "matched") {
        blockedReasons.push(`订单 ${orderLabel}：${matchResult.reason}`);
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
        blockedReasons.push(`订单 ${orderLabel}：匹配后的仓库库存不足，整单保持待分配。`);
        return;
      }
      availableStockByKey.clear();
      groupAvailableStockByKey.forEach((quantity, stockKey) => {
        availableStockByKey.set(stockKey, quantity);
      });
      matchedOrders.push(
        ...groupOrders.map((order) => ({
          order,
          warehouse: matched.warehouse,
          logisticsMethod: matched.logisticsMethod,
        })),
      );
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
          logistics_method_id: logisticsMethod.id,
          logistics_method: logisticsMethod.name,
        };
        return { order, updates, nextOrder: { ...order, ...updates } };
      });
      const { nextOrders, inventoryChanges, failures } =
        await saveOrderEntriesWithInventory(matchedEntries, { autoMatch: true });
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
          skippedCount > 0
            ? `${skippedCount} 条因 SKU、3cm 上限、库存、尾程或保存失败未匹配`
            : "",
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

  function buildOcsSheet1Rows(
    targetOrders: TemuOrderRecord[],
  ): ShippingExportRow[] {
    return buildOrderDisplayRows(targetOrders).map((row) => {
      const merged = row.primaryOrder;
      return {
        shipment_recipient_name: formatRecipientName(merged.recipient_name),
        shipment_address: getFullAddress(merged),
        shipment_postal_code: merged.postal_code,
        shipment_phone: formatRecipientPhone(merged.recipient_phone),
        shipment_package_count: 1,
        shipment_destination: "TYO",
        shipment_order_no: merged.order_no,
        shipment_service_type: "NEP",
        shipment_store_name: "",
        shipment_store_note: "",
        shipment_sender_name: "",
        shipment_sender_address: "",
        shipment_sender_phone: "",
        shipment_sender_postal_code: "",
        shipment_store: "",
        shipment_custom_weight: "",
        shipment_has_battery: 0,
        shipment_platform_name: "TEMU",
        shipment_sales_unit: "",
        shipment_sales_unit_code: "",
      };
    });
  }

  function buildOcsSheet2Rows(
    targetOrders: TemuOrderRecord[],
  ): ShippingExportRow[] {
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
        item_order_no: row.primaryOrder.order_no,
        item_code: index + 1,
        item_name: group.declaration.product.product_name_en,
        item_description: group.declaration.product.material_en,
        item_quantity: group.quantity,
        item_unit_price: getDeclarationUnitPriceUsd(group.declaration.sku),
        item_currency: "USD",
        item_compilation_method: "",
        item_hs_code: "",
        item_origin_country: "CN",
        item_shelf_no: "",
        item_purchase_no: "",
        item_style_color: formatStyleColorForDeclaration(group.order.product_attributes),
        item_customer_note: `${group.declaration.product.product_name_en} ${group.declaration.product.product_code}`.trim(),
        item_url: "",
        item_primary_key: "",
        item_domestic_declared_value: "",
        item_domestic_currency: "",
      }));
    });
  }

  async function downloadOcsShippingWorkbook(
    targetOrders: TemuOrderRecord[],
    template: Extract<
      PreparedOrderFileImport,
      { kind: "shipping_export" }
    >["template"],
    sourceWorkbook: Extract<
      PreparedOrderFileImport,
      { kind: "shipping_export" }
    >["workbook"],
  ) {
    const workbook = fillShippingExportWorkbook(sourceWorkbook, template, {
      Sheet1: buildOcsSheet1Rows(targetOrders),
      Sheet2: buildOcsSheet2Rows(targetOrders),
    });
    await downloadWorkbook(
      workbook,
      `OCS-3cm-发货表格-${formatFileTimestamp()}.xlsx`,
    );
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

  function buildTemuUploadRows(
    targetOrders: TemuOrderRecord[],
  ): TemuUploadExportRow[] {
    return targetOrders.map((order) => {
      const merged = mergeOrderDraft(order);

      return {
        order_no: merged.order_no,
        sub_order_no: merged.sub_order_no,
        fulfillment_quantity: getOrderFulfillmentQuantity(merged),
        tracking_no: merged.logistics_tracking_no.trim(),
        carrier: getTemuUploadCarrier(merged),
        warehouse_name: temuUploadWarehouseName,
      };
    });
  }

  async function downloadTemuUploadWorkbook(
    targetOrders: TemuOrderRecord[],
    template: Extract<
      PreparedOrderFileImport,
      { kind: "temu_upload" }
    >["template"],
    sourceWorkbook: Extract<
      PreparedOrderFileImport,
      { kind: "temu_upload" }
    >["workbook"],
  ) {
    const workbook = fillTemuUploadExportWorkbook(
      sourceWorkbook,
      template,
      buildTemuUploadRows(targetOrders),
    );
    await downloadWorkbook(
      workbook,
      `Temu上传发货表格-${formatFileTimestamp()}.xlsx`,
    );
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

  function handleOpenShippingTableDownload(targetOrders: TemuOrderRecord[]) {
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

    setErrorMessage("");
    setNoticeMessage("");
    setOpenFileImportKind("shipping_export");
  }

  function handleOpenTemuUploadTableDownload(targetOrders: TemuOrderRecord[]) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能下载上传表格。");
      return;
    }
    if (targetOrders.length === 0) {
      setNoticeMessage("请先勾选要下载上传表格的已发货订单。");
      return;
    }

    const validationMessage = validateOrdersReadyForTemuUpload(targetOrders);
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setErrorMessage("");
    setNoticeMessage("");
    setOpenFileImportKind("temu_upload");
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
            onOpenOrderImport={() => setOpenFileImportKind("orders")}
            onOpenTrackingImport={() => setOpenFileImportKind("tracking")}
          />
        ) : null}
      />

      <OrderPageNotices
        errorMessage={errorMessage}
        noticeMessage={noticeMessage}
        draftNotice={draftNotice}
      />

      {openFileImportKind && (
        <OrderFileImportModal
          kind={openFileImportKind}
          canEdit={canEdit}
          onClose={() => setOpenFileImportKind(null)}
          onPrepared={(prepared) => void handlePreparedFileImport(prepared)}
        />
      )}

      {pendingFileImport && (
        <section className="rounded-xl border border-sky-200 bg-sky-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                导入前核对 · {pendingFileImport.templateName}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {pendingFileImport.fileName} · 工作表{" "}
                {pendingFileImport.sheetName} · 读取{" "}
                {pendingFileImport.totalRowCount} 行
              </p>
            </div>
            <button
              type="button"
              className="icon-btn h-8 w-8"
              onClick={() => setPendingFileImport(null)}
              disabled={Boolean(busyKey)}
              aria-label="关闭导入预览"
            >
              ×
            </button>
          </div>

          {pendingFileImport.kind === "orders" ? (
            <>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["读取订单行", pendingFileImport.rows.length],
                  ["可导入", pendingFileImport.importRows.length],
                  [
                    "已有订单",
                    pendingFileImport.rows.filter(
                      (row) => row.status === "existing",
                    ).length,
                  ],
                  [
                    "重复或无效",
                    pendingFileImport.rows.filter(
                      (row) =>
                        row.status === "duplicate_file" ||
                        row.status === "missing_order_no",
                    ).length,
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-white bg-white/90 p-3"
                  >
                    <div className="text-[11px] font-semibold text-slate-500">
                      {label}
                    </div>
                    <div className="mt-1 text-lg font-bold text-slate-900">
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              {pendingFileImport.missingRecipientInfoCount > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                  可导入数据中有{" "}
                  {pendingFileImport.missingRecipientInfoCount} 条缺少收件信息。
                </div>
              )}
              <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-white bg-white/90">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2">行</th>
                      <th className="px-3 py-2">订单号</th>
                      <th className="px-3 py-2">子订单号</th>
                      <th className="px-3 py-2">处理结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingFileImport.rows.map((row) => (
                      <tr
                        key={`${row.sourceRowNumber}-${row.orderNo}-${row.subOrderNo}`}
                        className="border-t border-slate-100"
                      >
                        <td className="px-3 py-2 text-slate-400">
                          {row.sourceRowNumber}
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-700">
                          {row.orderNo || "--"}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-600">
                          {row.subOrderNo || "--"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-2 py-1 font-bold ${
                              row.status === "importable"
                                ? "bg-emerald-50 text-emerald-700"
                                : row.status === "existing"
                                  ? "bg-slate-100 text-slate-600"
                                  : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {row.message}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPendingFileImport(null)}
                  disabled={Boolean(busyKey)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void confirmPendingOrderFileImport()}
                  disabled={
                    Boolean(busyKey) ||
                    pendingFileImport.importRows.length === 0
                  }
                >
                  {busyKey === "import"
                    ? "导入中..."
                    : `确认导入 ${pendingFileImport.importRows.length} 条`}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["读取物流行", pendingFileImport.preview.rows.length],
                  ["可匹配包裹", pendingFileImport.preview.matches.length],
                  [
                    "未匹配",
                    pendingFileImport.preview.rows.filter((row) =>
                      [
                        "unmatched_order",
                        "unmatched_sub_order",
                        "missing_order_no",
                        "missing_sub_order_no",
                        "missing_tracking_no",
                      ].includes(row.status),
                    ).length,
                  ],
                  [
                    "冲突或重复",
                    pendingFileImport.preview.rows.filter((row) =>
                      [
                        "ambiguous_package",
                        "duplicate_order_key",
                        "duplicate_tracking_no",
                      ].includes(row.status),
                    ).length,
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-white bg-white/90 p-3"
                  >
                    <div className="text-[11px] font-semibold text-slate-500">
                      {label}
                    </div>
                    <div className="mt-1 text-lg font-bold text-slate-900">
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-white bg-white/90">
                <table className="w-full min-w-[920px] text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2">行</th>
                      <th className="px-3 py-2">订单号</th>
                      <th className="px-3 py-2">子订单号</th>
                      <th className="px-3 py-2">包裹</th>
                      <th className="px-3 py-2">物流单号</th>
                      <th className="px-3 py-2">处理结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingFileImport.preview.rows.map((row) => (
                      <tr
                        key={`${row.sourceRowNumber}-${row.trackingNo}`}
                        className="border-t border-slate-100"
                      >
                        <td className="px-3 py-2 text-slate-400">
                          {row.sourceRowNumber}
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-700">
                          {row.orderNo || "--"}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-600">
                          {row.subOrderNo || "--"}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.packageSequence
                            ? `包裹 ${row.packageSequence}`
                            : "--"}
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-700">
                          {row.trackingNo || "--"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-2 py-1 font-bold ${
                              row.status === "importable"
                                ? "bg-emerald-50 text-emerald-700"
                                : row.status === "ambiguous_package" ||
                                    row.status === "duplicate_order_key" ||
                                    row.status === "duplicate_tracking_no"
                                  ? "bg-rose-50 text-rose-700"
                                  : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {row.message}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPendingFileImport(null)}
                  disabled={Boolean(busyKey)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void confirmPendingTrackingFileImport()}
                  disabled={
                    Boolean(busyKey) ||
                    pendingFileImport.preview.matches.length === 0
                  }
                >
                  {busyKey === "tracking-import"
                    ? "导入中..."
                    : `确认导入 ${pendingFileImport.preview.matches.length} 个包裹`}
                </button>
              </div>
            </>
          )}
        </section>
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

        <OrderTrackingAlerts
          alerts={trackingAlerts}
          filter={trackingAlertFilter}
          canEdit={canEdit}
          handlingOrderNo={handlingTrackingOrderNo}
          onFilterChange={setTrackingAlertFilter}
          onMarkHandled={(alert) =>
            void handleMarkTrackingAlertHandled(alert)
          }
        />

        <OrderCustomerHistoryLegend />

        <OrderBulkActions
          activeStage={activeStage}
          busyKey={busyKey}
          canDelete={canDelete}
          canEdit={canEdit}
          canSaveSelectedOrders={selectedOrdersInView.some(
            (order) => getOrderStage(order) === "pending_assignment",
          )}
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
          canSplitSelectedOrder={canSplitSelectedOrder}
          selectedOrderIsSplit={Boolean(selectedSingleOrderInView?.is_split)}
          canManageSelectedShippedOrders={canManageSelectedShippedOrders}
          hasSelectedCompletedOrders={hasSelectedCompletedOrders}
          bulkWarehouseId={bulkWarehouseId}
          bulkLogisticsMethod={bulkLogisticsMethod}
          bulkLogisticsMethodOptions={bulkLogisticsMethodOptions}
          autoMatchEnabled={orderAutoMatchSettings.enabled}
          warehouses={warehouses}
          filteredOrdersCount={filteredOrders.length}
          onClearSelection={() => setSelectedOrderIds([])}
          onShowSelectedDetail={() => {
            if (selectedSingleOrderInView) setDetailOrder(selectedSingleOrderInView);
          }}
          onOpenSplitOrder={() => void handleOpenSplitOrder()}
          onCancelSplitOrder={() => void handleCancelOrderSplit()}
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
            handleOpenShippingTableDownload(selectedPendingShippingOrdersInView)
          }
          onDownloadTemuUploadTable={() =>
            handleOpenTemuUploadTableDownload(selectedShippedOrdersInView)
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
            setBulkLogisticsMethod("");
          }}
          onBulkLogisticsMethodChange={setBulkLogisticsMethod}
          onBulkAssign={() => void handleBulkAssign()}
          onAutoMatchPendingOrders={() => void handleAutoMatchPendingOrders()}
          onCreateReshipOrder={() => {
            if (selectedSingleOrderInView) {
              void handleOpenReshipOrder(selectedSingleOrderInView);
            }
          }}
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
                  <article
                    key={orderRow.id}
                    className={`mobile-summary-card ${getOrderCustomerHistoryMeta(order.customer_history_status).rowClassName}`}
                    title={getOrderCustomerHistoryTitle(order)}
                    data-customer-history-status={order.customer_history_status}
                  >
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
                          {order.is_split
                            ? ` · 包裹 ${order.package_sequence}/${order.package_count}`
                            : ""}
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
              layout="auto"
              minWidth="min-w-max"
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
                      getWarehouseStockIssueForOrders={getWarehouseStockIssueForOrders}
                      logisticsMethods={logisticsMethods}
                      onHandleWarehouseChangeForOrders={handleWarehouseChangeForOrders}
                      onHandleLogisticsMethodChangeForOrders={handleLogisticsMethodChangeForOrders}
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
          onCreateReshipOrder={() => void handleOpenReshipOrder(detailOrder)}
        />
      )}

      {reshipTargetOrder && (
        <ReshipOrderModal
          originalOrder={reshipTargetOrder}
          relatedOrders={reshipRelatedOrders}
          productSkus={productSkus}
          products={products}
          onClose={() => {
            setReshipTargetOrder(null);
            setReshipRelatedOrders([]);
          }}
          onSuccess={handleReshipSuccess}
          setErrorMessage={setErrorMessage}
        />
      )}

      {splitOrderLines && (
        <SplitOrderModal
          orders={splitOrderLines}
          saving={busyKey === "save-order-split"}
          onClose={() => {
            if (busyKey !== "save-order-split") setSplitOrderLines(null);
          }}
          onSave={(packages) => void handleSaveOrderSplit(packages)}
        />
      )}
    </section>
  );
}
