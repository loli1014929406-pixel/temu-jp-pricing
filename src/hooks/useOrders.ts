import type { User } from "@supabase/supabase-js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  fetchWarehouseItemStocks,
  fetchWarehouses,
  fetchWarehouseSkus,
} from "../lib/inventory";
import {
  fetchLogisticsMethods,
  fetchWarehouseLogisticsMethods,
  normalizeLogisticsMethodName,
} from "../lib/logistics-methods";
import { fetchTemuOrders } from "../lib/orders";
import {
  fetchProducts,
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
} from "../lib/products";
import type {
  Product,
  ProductItem,
  ProductSku,
  LogisticsMethod,
  TemuOrderRecord,
  Warehouse,
  WarehouseItemStock,
  WarehouseLogisticsMethod,
  WarehouseSku,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { isSameDraft, readDraft, useDraftPersistence } from "./use-draft-persistence";

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
] as const satisfies readonly (keyof OrderDraft)[];

type UseOrdersResult = {
  orders: TemuOrderRecord[];
  warehouses: Warehouse[];
  products: Product[];
  productItems: ProductItem[];
  productSkus: ProductSku[];
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
  warehouseSkus: WarehouseSku[];
  warehouseItemStocks: WarehouseItemStock[];
  drafts: Record<string, OrderDraft>;
  selectedOrderIds: string[];
  bulkWarehouseId: string;
  bulkLogisticsMethod: string;
  loading: boolean;
  errorMessage: string;
  draftNotice: string;
  currentTime: Date;
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
  replaceOrders: (nextOrders: TemuOrderRecord[]) => void;
  removeOrders: (orderIds: string[]) => void;
  mergeOrders: (nextOrders: TemuOrderRecord[]) => void;
  replaceDraftsFromOrders: (nextOrders: TemuOrderRecord[]) => void;
  clearDrafts: (orderIds?: string[]) => void;
  applyWarehouseItemStockUpdates: (nextStocks: WarehouseItemStock[]) => void;
  fetchLatestOrders: () => Promise<TemuOrderRecord[]>;
  fetchLatestProductsAndSkus: () => Promise<{
    products: Product[];
    productSkus: ProductSku[];
  }>;
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
  };
}

function hasOrdersDraft(draft: OrdersDraftState | null | undefined) {
  return Boolean(
    draft &&
      (Object.keys(draft.drafts).length > 0 ||
        draft.selectedOrderIds.length > 0 ||
        draft.bulkWarehouseId ||
        draft.bulkLogisticsMethod),
  );
}

export function getOrdersErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error, fallback);
  if (message.includes("sku_code")) {
    return "订单管理数据库还没有新增 SKU 货号字段，请在 Supabase SQL Editor 执行最新订单迁移以启用精准自动匹配";
  }
  if (
    message.includes("public.temu_orders") ||
    message.includes("logistics_methods") ||
    message.includes("warehouse_logistics_methods") ||
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

async function loadLatestOrders() {
  return dedupeOrdersByOrderLine(await fetchTemuOrders());
}

async function loadLatestProductsAndSkus() {
  const products = await fetchProducts();
  const productSkus = await fetchProductSkusByProductIds(
    products.map((product) => product.id),
  );

  return { products, productSkus };
}

export function useOrders(user: User) {
  const draftKey = `orders-draft:v1:${user.id}`;
  const restoredDraftRef = useRef(readDraft<OrdersDraftState>(draftKey));
  const restoredDraft = restoredDraftRef.current;
  const [orders, setOrders] = useState<TemuOrderRecord[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [productSkus, setProductSkus] = useState<ProductSku[]>([]);
  const [logisticsMethods, setLogisticsMethods] = useState<LogisticsMethod[]>([]);
  const [warehouseLogisticsMethods, setWarehouseLogisticsMethods] = useState<
    WarehouseLogisticsMethod[]
  >([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>(restoredDraft?.drafts ?? {});
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>(
    restoredDraft?.selectedOrderIds ?? [],
  );
  const [bulkWarehouseId, setBulkWarehouseId] = useState(
    restoredDraft?.bulkWarehouseId ?? "",
  );
  const [bulkLogisticsMethod, setBulkLogisticsMethod] = useState(
    restoredDraft?.bulkLogisticsMethod ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    hasOrdersDraft(restoredDraft) ? "已恢复上次未保存的订单编辑草稿。" : "",
  );
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");
      try {
        const [nextOrders, nextWarehouses, nextProducts, nextLogisticsMethods] =
          await Promise.all([
            loadLatestOrders(),
            fetchWarehouses(),
            fetchProducts(),
            fetchLogisticsMethods(),
          ]);
        const productIds = nextProducts.map((product) => product.id);
        const warehouseIds = nextWarehouses.map((warehouse) => warehouse.id);
        const [
          nextProductItems,
          nextProductSkus,
          nextWarehouseSkus,
          nextWarehouseItemStocks,
          nextWarehouseLogisticsMethods,
        ] = await Promise.all([
          fetchProductItemsByProductIds(productIds),
          fetchProductSkusByProductIds(productIds),
          fetchWarehouseSkus(warehouseIds),
          fetchWarehouseItemStocks(warehouseIds),
          fetchWarehouseLogisticsMethods(warehouseIds),
        ]);

        if (!active) return;

        setOrders(nextOrders);
        setWarehouses(nextWarehouses);
        setProducts(nextProducts);
        setProductItems(nextProductItems);
        setProductSkus(nextProductSkus);
        setLogisticsMethods(nextLogisticsMethods);
        setWarehouseLogisticsMethods(nextWarehouseLogisticsMethods);
        setWarehouseSkus(nextWarehouseSkus);
        setWarehouseItemStocks(nextWarehouseItemStocks);

        const latestDraft = readDraft<OrdersDraftState>(draftKey);
        setDrafts(restoreDraftMapFromOrders(nextOrders, latestDraft?.drafts));
        setBulkWarehouseId(latestDraft?.bulkWarehouseId ?? "");
        setBulkLogisticsMethod(latestDraft?.bulkLogisticsMethod ?? "");
        setSelectedOrderIds(latestDraft?.selectedOrderIds ?? []);
        if (hasOrdersDraft(latestDraft)) {
          setDraftNotice("已恢复上次未保存的订单编辑草稿。");
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getOrdersErrorMessage(error, "加载订单失败"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
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

  useDraftPersistence(draftKey, ordersDraftValue, {
    enabled: !loading,
    shouldPersist: (draft) =>
      Object.keys(draft.drafts).length > 0 ||
      draft.selectedOrderIds.length > 0 ||
      Boolean(draft.bulkWarehouseId || draft.bulkLogisticsMethod),
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

  function replaceOrders(nextOrders: TemuOrderRecord[]) {
    setOrders(nextOrders);
  }

  function removeOrders(orderIds: string[]) {
    if (orderIds.length === 0) return;
    const targetIds = new Set(orderIds);
    setOrders((current) => current.filter((order) => !targetIds.has(order.id)));
  }

  function mergeOrders(nextOrders: TemuOrderRecord[]) {
    const previousOrdersById = new Map(orders.map((order) => [order.id, order]));
    setOrders((current) =>
      current.map(
        (order) => nextOrders.find((nextOrder) => nextOrder.id === order.id) ?? order,
      ),
    );
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

  function applyWarehouseItemStockUpdates(nextStocks: WarehouseItemStock[]) {
    if (nextStocks.length === 0) return;

    setWarehouseItemStocks((current) =>
      current.map(
        (item) => nextStocks.find((nextItem) => nextItem.id === item.id) ?? item,
      ),
    );
  }

  async function fetchLatestOrders() {
    return loadLatestOrders();
  }

  async function fetchLatestProductsAndSkus() {
    return loadLatestProductsAndSkus();
  }

  return {
    orders,
    warehouses,
    products,
    productItems,
    productSkus,
    logisticsMethods,
    warehouseLogisticsMethods,
    warehouseSkus,
    warehouseItemStocks,
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
    replaceOrders,
    removeOrders,
    mergeOrders,
    replaceDraftsFromOrders,
    clearDrafts,
    applyWarehouseItemStockUpdates,
    fetchLatestOrders,
    fetchLatestProductsAndSkus,
  } satisfies UseOrdersResult;
}
