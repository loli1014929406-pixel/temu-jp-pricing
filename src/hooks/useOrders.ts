import type { User } from "@supabase/supabase-js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { fetchWarehouseSkus } from "../lib/inventory";
import { useAutoDismiss } from "./use-auto-dismiss";
import {
  normalizeLogisticsMethodName,
} from "../lib/logistics-methods";
import {
  emptyTemuOrderStageCounts,
  fetchTemuOrdersPage,
  type FetchTemuOrdersPageOptions,
  type TemuOrderStageCounts,
} from "../lib/orders";
import { fetchSettings } from "../lib/settings";
import type {
  Product,
  ProductItem,
  ProductSku,
  LogisticsMethod,
  TemuOrderRecord,
  Warehouse,
  WarehouseLogisticsMethod,
  WarehouseSku,
  PricingSettings,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { isSameDraft, readDraft, useDraftPersistence } from "./use-draft-persistence";
import {
  loadCachedProductDetails,
  loadCachedProducts,
  loadCachedProductSkus,
} from "../lib/cached-products";
import { loadCachedWarehouses } from "../lib/cached-warehouses";
import {
  loadCachedLogisticsMethods,
  loadCachedWarehouseLogisticsMethods,
} from "../lib/cached-logistics";

export type OrderDraft = Pick<
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
  | "actual_shipping_fee_rmb"
>;

export type OrdersDraftState = {
  drafts: Record<string, OrderDraft>;
  selectedOrderIds: string[];
  bulkWarehouseId: string;
  bulkLogisticsMethod: string;
};

const orderDraftFields = [
  "order_status",
  "warehouse_id",
  "warehouse_name",
  "logistics_method",
  "label_printed_at",
  "logistics_tracking_no",
  "logistics_status",
  "actual_ship_time",
  "actual_signed_time",
  "actual_shipping_fee_rmb",
] as const satisfies readonly (keyof OrderDraft)[];

const serverManagedDraftFields = [
  "order_status",
  "label_printed_at",
  "logistics_tracking_no",
  "logistics_status",
  "actual_ship_time",
  "actual_signed_time",
] as const satisfies readonly (keyof OrderDraft)[];

const serverManagedDraftFieldSet = new Set<keyof OrderDraft>(serverManagedDraftFields);

const restoredEditableDraftFields = [
  "warehouse_id",
  "warehouse_name",
  "logistics_method",
  "actual_shipping_fee_rmb",
] as const satisfies readonly (keyof OrderDraft)[];

type UseOrdersResult = {
  allOrders: TemuOrderRecord[];
  totalOrderCount: number;
  totalOrderLineCount: number;
  stageCounts: TemuOrderStageCounts;
  urgentUnuploadedCount: number;
  warehouses: Warehouse[];
  products: Product[];
  productItems: ProductItem[];
  productSkus: ProductSku[];
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
  warehouseSkus: WarehouseSku[];
  settings: PricingSettings | null;
  drafts: Record<string, OrderDraft>;
  selectedOrderIds: string[];
  bulkWarehouseId: string;
  bulkLogisticsMethod: string;
  loading: boolean;
  errorMessage: string;
  draftNotice: string;
  setSelectedOrderIds: Dispatch<SetStateAction<string[]>>;
  setBulkWarehouseId: Dispatch<SetStateAction<string>>;
  setBulkLogisticsMethod: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  updateDraftForOrders: <K extends keyof OrderDraft>(
    orderIds: string[],
    field: K,
    value: OrderDraft[K],
  ) => void;
  updateDraftFieldsForOrders: (orderIds: string[], values: Partial<OrderDraft>) => void;
  removeOrders: (orderIds: string[]) => void;
  mergeOrders: (nextOrders: TemuOrderRecord[]) => void;
  replaceDraftsFromOrders: (nextOrders: TemuOrderRecord[]) => void;
  clearDrafts: (orderIds?: string[]) => void;
  applyWarehouseSkuStockUpdates: (nextStocks: WarehouseSku[]) => void;
  fetchLatestProductsAndSkus: () => Promise<{
    products: Product[];
    productSkus: ProductSku[];
  }>;
  reloadOrders: () => void;
};

function normalizeSkuCode(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSalesSpec(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function normalizeLogisticsMethod(value: string) {
  return normalizeLogisticsMethodName(value);
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

const uploadedTemuOrderStatus = "上传Temu";
const legacyUploadedTemuOrderStatus = "已上传Temu";

function isUploadedTemuStatus(value: string) {
  const status = value.trim().toLowerCase();
  return (
    status === uploadedTemuOrderStatus.toLowerCase() ||
    status === legacyUploadedTemuOrderStatus.toLowerCase()
  );
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

export function toDraft(order: TemuOrderRecord): OrderDraft {
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
    actual_shipping_fee_rmb: order.actual_shipping_fee_rmb,
  };
}

export function createEmptyDraft(): OrderDraft {
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
    actual_shipping_fee_rmb: 0,
  };
}

function hasOrdersDraft(draft: OrdersDraftState | null | undefined) {
  return Boolean(draft && Object.keys(draft.drafts).length > 0);
}

export function getOrdersErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const code = String(error.code);
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "42703") {
      if (message.includes("actual_shipping_fee_rmb")) {
        return "订单管理数据库还没有新增实际运费字段，请先执行最新订单运费迁移";
      }
      if (message.includes("sku_code")) {
        return "订单管理数据库还没有新增 SKU 货号字段，请在 Supabase SQL Editor 执行最新订单迁移以启用精准自动匹配";
      }
      if (
        message.includes("warehouse_id") ||
        message.includes("logistics_method") ||
        message.includes("label_printed_at") ||
        message.includes("logistics_tracking_no") ||
        message.includes("logistics_status")
      ) {
        return "订单管理数据库还没有初始化最新流程字段，请先执行最新的订单表迁移";
      }
    }
    if (code === "42P01") {
      if (
        message.includes("logistics_methods") ||
        message.includes("warehouse_logistics_methods")
      ) {
        return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613000000_add_warehouse_logistics_methods.sql 迁移";
      }
      if (message.includes("public.temu_orders")) {
        return "订单管理数据库还没有初始化，请先执行最新的订单表迁移";
      }
      if (
        message.includes("warehouse_item_stocks") ||
        message.includes("warehouse_item_stock_adjustments")
      ) {
        return "库存数据库还没有初始化最新配件库存字段，请先执行最新的库存表迁移";
      }
    }
  }

  const message = getErrorMessage(error, fallback);
  if (message.includes("actual_shipping_fee_rmb") || message.includes("实际运费")) {
    return "订单管理数据库还没有新增实际运费字段，请先执行最新订单运费迁移";
  }
  if (message.includes("sku_code")) {
    return "订单管理数据库还没有新增 SKU 货号字段，请在 Supabase SQL Editor 执行最新订单迁移以启用精准自动匹配";
  }
  if (
    message.includes("logistics_methods") ||
    message.includes("warehouse_logistics_methods")
  ) {
    return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613000000_add_warehouse_logistics_methods.sql 迁移";
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

function buildDraftMap(orders: TemuOrderRecord[]) {
  return Object.fromEntries(orders.map((order) => [order.id, toDraft(order)])) as Record<
    string,
    OrderDraft
  >;
}

function setDraftField<K extends keyof OrderDraft>(
  draft: OrderDraft,
  field: K,
  value: OrderDraft[K],
) {
  draft[field] = value;
}

function syncDraftWithOrderUpdate(
  currentDraft: OrderDraft | undefined,
  previousOrder: TemuOrderRecord | undefined,
  nextOrder: TemuOrderRecord,
) {
  const nextOrderDraft = toDraft(nextOrder);
  if (!currentDraft) return nextOrderDraft;
  if (!previousOrder) return currentDraft;

  const previousOrderDraft = toDraft(previousOrder);
  const syncedDraft = { ...currentDraft };
  serverManagedDraftFields.forEach((field) => {
    setDraftField(syncedDraft, field, nextOrderDraft[field]);
  });
  orderDraftFields.forEach((field) => {
    if (
      !serverManagedDraftFieldSet.has(field) &&
      currentDraft[field] === previousOrderDraft[field]
    ) {
      setDraftField(syncedDraft, field, nextOrderDraft[field]);
    }
  });
  return syncedDraft;
}

function restoreDraftForOrder(
  order: TemuOrderRecord,
  restoredDraft: OrderDraft | undefined,
) {
  const draft = toDraft(order);
  if (!restoredDraft) return draft;

  restoredEditableDraftFields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(restoredDraft, field)) return;
    setDraftField(draft, field, restoredDraft[field]);
  });
  return draft;
}

function restoreDraftMapFromOrders(
  orders: TemuOrderRecord[],
  restoredDrafts: Record<string, OrderDraft> | undefined,
) {
  return Object.fromEntries(
    orders.map((order) => [
      order.id,
      restoreDraftForOrder(order, restoredDrafts?.[order.id]),
    ]),
  ) as Record<string, OrderDraft>;
}

async function loadLatestProductsAndSkus() {
  const products = await loadCachedProducts({ includeNotSelling: true });
  const productSkus = await loadCachedProductSkus(
    products.map((product) => product.id),
  );

  return { products, productSkus };
}

export function useOrders(user: User, orderQuery: FetchTemuOrdersPageOptions) {
  const draftKey = `orders-draft:v1:${user.id}`;
  const restoredDraftRef = useRef(readDraft<OrdersDraftState>(draftKey));
  const restoredDraft = restoredDraftRef.current;
  const knownOrdersByIdRef = useRef(new Map<string, TemuOrderRecord>());
  const [allOrders, setAllOrders] = useState<TemuOrderRecord[]>([]);
  const [totalOrderCount, setTotalOrderCount] = useState(0);
  const [totalOrderLineCount, setTotalOrderLineCount] = useState(0);
  const [stageCounts, setStageCounts] = useState<TemuOrderStageCounts>(
    emptyTemuOrderStageCounts,
  );
  const [urgentUnuploadedCount, setUrgentUnuploadedCount] = useState(0);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [productSkus, setProductSkus] = useState<ProductSku[]>([]);
  const [logisticsMethods, setLogisticsMethods] = useState<LogisticsMethod[]>([]);
  const [warehouseLogisticsMethods, setWarehouseLogisticsMethods] = useState<
    WarehouseLogisticsMethod[]
  >([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>(restoredDraft?.drafts ?? {});
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [bulkWarehouseId, setBulkWarehouseId] = useState("");
  const [bulkLogisticsMethod, setBulkLogisticsMethod] = useState("");
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [orderRefreshVersion, setOrderRefreshVersion] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    hasOrdersDraft(restoredDraft) ? "已恢复上次未保存的订单编辑草稿。" : "",
  );
  const {
    page: orderPage,
    pageSize: orderPageSize,
    searchQuery: orderSearchQuery,
    stage: orderStage,
    warehouseId: orderWarehouseId,
    logisticsMethod: orderLogisticsMethod,
    urgentOnly: orderUrgentOnly,
    sortKey: orderSortKey,
    sortDirection: orderSortDirection,
  } = orderQuery;
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));
  const loading = referenceLoading || ordersLoading;

  useEffect(() => {
    let active = true;

    async function load() {
      setReferenceLoading(true);
      setErrorMessage("");
      try {
        const [
          nextWarehouses,
          nextProducts,
          nextLogisticsMethods,
          fetchedSettings,
        ] =
          await Promise.all([
            loadCachedWarehouses(),
            loadCachedProducts({ includeNotSelling: true }),
            loadCachedLogisticsMethods(),
            fetchSettings(user.id).catch(() => null),
          ]);
        const productIds = nextProducts.map((product) => product.id);
        const warehouseIds = nextWarehouses.map((warehouse) => warehouse.id);
        const [
          [nextProductItems, nextProductSkus],
          nextWarehouseSkus,
          nextWarehouseLogisticsMethods,
        ] = await Promise.all([
          loadCachedProductDetails(productIds),
          fetchWarehouseSkus(warehouseIds),
          loadCachedWarehouseLogisticsMethods(warehouseIds),
        ]);

        if (!active) return;

        setWarehouses(nextWarehouses);
        setProducts(nextProducts);
        setProductItems(nextProductItems);
        setProductSkus(nextProductSkus);
        setLogisticsMethods(nextLogisticsMethods);
        setWarehouseLogisticsMethods(nextWarehouseLogisticsMethods);
        setWarehouseSkus(nextWarehouseSkus);
        setSettings(fetchedSettings);

        setBulkWarehouseId("");
        setBulkLogisticsMethod("");
        setSelectedOrderIds([]);
        if (hasOrdersDraft(restoredDraft)) {
          setDraftNotice("已恢复上次未保存的订单编辑草稿。");
        } else {
          setDraftNotice("");
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getOrdersErrorMessage(error, "加载订单失败"));
        }
      } finally {
        if (active) {
          setReferenceLoading(false);
        }
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [draftKey, restoredDraft, user.id]);

  useEffect(() => {
    let active = true;

    async function loadOrderPage() {
      setOrdersLoading(true);
      setErrorMessage("");
      try {
        const nextPage = await fetchTemuOrdersPage({
          page: orderPage,
          pageSize: orderPageSize,
          searchQuery: orderSearchQuery,
          stage: orderStage,
          warehouseId: orderWarehouseId,
          logisticsMethod: orderLogisticsMethod,
          urgentOnly: orderUrgentOnly,
          sortKey: orderSortKey,
          sortDirection: orderSortDirection,
        });
        if (!active) return;

        const nextOrders = dedupeOrdersByOrderLine(nextPage.orders);
        nextOrders.forEach((order) => knownOrdersByIdRef.current.set(order.id, order));
        setAllOrders(nextOrders);
        setTotalOrderCount(nextPage.totalCount);
        setTotalOrderLineCount(nextPage.totalLineCount);
        setStageCounts(nextPage.stageCounts);
        setUrgentUnuploadedCount(nextPage.urgentUnuploadedCount);
        setSelectedOrderIds([]);

        const latestDraft = readDraft<OrdersDraftState>(draftKey);
        setDrafts((current) => ({
          ...current,
          ...restoreDraftMapFromOrders(nextOrders, latestDraft?.drafts),
        }));
      } catch (error) {
        if (active) {
          setErrorMessage(getOrdersErrorMessage(error, "加载订单失败"));
        }
      } finally {
        if (active) {
          setOrdersLoading(false);
        }
      }
    }

    void loadOrderPage();

    return () => {
      active = false;
    };
  }, [
    draftKey,
    orderLogisticsMethod,
    orderPage,
    orderPageSize,
    orderSearchQuery,
    orderSortDirection,
    orderSortKey,
    orderStage,
    orderUrgentOnly,
    orderWarehouseId,
    orderRefreshVersion,
  ]);

  const ordersDraftValue = useMemo<OrdersDraftState>(
    () => {
      const ordersById = knownOrdersByIdRef.current;

      return {
        drafts: Object.fromEntries(
          Object.entries(drafts).filter(([orderId, draft]) => {
            const order = ordersById.get(orderId);
            return order ? !isSameDraft(draft, toDraft(order)) : true;
          }),
        ),
        selectedOrderIds,
        bulkWarehouseId,
        bulkLogisticsMethod,
      };
    },
    [bulkLogisticsMethod, bulkWarehouseId, drafts, selectedOrderIds],
  );

  useEffect(() => {
    if (!hasOrdersDraft(ordersDraftValue)) {
      setDraftNotice("");
    }
  }, [ordersDraftValue]);

  useDraftPersistence(draftKey, ordersDraftValue, {
    enabled: !loading,
    shouldPersist: hasOrdersDraft,
  });

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

  function mergeAllOrdersSnapshot(nextOrders: TemuOrderRecord[]) {
    setAllOrders((current) => {
      const nextById = new Map(nextOrders.map((order) => [order.id, order]));
      const merged = current.map((order) => nextById.get(order.id) ?? order);
      const currentIds = new Set(current.map((order) => order.id));
      nextOrders.forEach((order) => {
        if (!currentIds.has(order.id)) merged.push(order);
      });
      return merged;
    });
  }

  function removeOrders(orderIds: string[]) {
    if (orderIds.length === 0) return;
    const targetIds = new Set(orderIds);
    setAllOrders((current) => current.filter((order) => !targetIds.has(order.id)));
    targetIds.forEach((orderId) => knownOrdersByIdRef.current.delete(orderId));
    setDrafts((current) => {
      const next = { ...current };
      targetIds.forEach((orderId) => delete next[orderId]);
      return next;
    });
    setOrderRefreshVersion((current) => current + 1);
  }

  function mergeOrders(nextOrders: TemuOrderRecord[]) {
    const previousOrdersById = new Map(allOrders.map((order) => [order.id, order]));
    nextOrders.forEach((order) => knownOrdersByIdRef.current.set(order.id, order));
    mergeAllOrdersSnapshot(nextOrders);
    setDrafts((current) => {
      const next = { ...current };
      nextOrders.forEach((order) => {
        next[order.id] = syncDraftWithOrderUpdate(
          next[order.id],
          previousOrdersById.get(order.id),
          order,
        );
      });
      return next;
    });
    setOrderRefreshVersion((current) => current + 1);
  }

  function replaceDraftsFromOrders(nextOrders: TemuOrderRecord[]) {
    setDrafts(buildDraftMap(nextOrders));
  }

  function clearDrafts(orderIds?: string[]) {
    if (!orderIds || orderIds.length === 0) {
      setDrafts({});
      return;
    }

    const targetIds = new Set(orderIds);
    setDrafts((current) => {
      const next = { ...current };
      targetIds.forEach((orderId) => {
        delete next[orderId];
      });
      return next;
    });
  }

  function applyWarehouseSkuStockUpdates(nextStocks: WarehouseSku[]) {
    if (nextStocks.length === 0) return;

    setWarehouseSkus((current) =>
      current.map(
        (item) => nextStocks.find((nextItem) => nextItem.id === item.id) ?? item,
      ),
    );
  }

  async function fetchLatestProductsAndSkus() {
    return loadLatestProductsAndSkus();
  }

  function reloadOrders() {
    setOrderRefreshVersion((current) => current + 1);
  }

  return {
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
    mergeOrders,
    replaceDraftsFromOrders,
    clearDrafts,
    applyWarehouseSkuStockUpdates,
    fetchLatestProductsAndSkus,
    reloadOrders,
  } satisfies UseOrdersResult;
}
