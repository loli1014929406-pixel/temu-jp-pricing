import { ChevronDown, ChevronUp, Plus, Trash2, Settings, Search, MapPin, Truck, ArrowLeftRight, Edit3 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import {
  addWarehouseProductInventory,
  createWarehouse,
  deleteWarehouse,
  fetchWarehouseItemStockAdjustmentsForItems,
  fetchWarehouseInventoryPage,
  fetchWarehouses,
  removeWarehouseProduct,
  updateWarehouse,
  updateWarehouseSkuStockQuantity,
} from "../lib/inventory";
import {
  createLogisticsMethod,
  fetchLogisticsMethods,
  fetchWarehouseLogisticsMethods,
  normalizeLogisticsMethodName,
  replaceWarehouseLogisticsMethods,
} from "../lib/logistics-methods";
import {
  fetchProductsByIds,
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
} from "../lib/products";
import type {
  Product,
  ProductItem,
  ProductSku,
  LogisticsMethod,
  Warehouse,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
  WarehouseLogisticsMethod,
  WarehouseSku,
  LogisticsMethodConfig,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { confirmAction, confirmDelete, confirmSave } from "../utils/confirmations";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { PageHeader, StandardTable } from "../components/ui";
import { readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { AsyncProductSelect } from "../components/inventory/AsyncProductSelect";
import { fetchSettings } from "../lib/settings";
import { defaultFirstLegMethods, defaultLastLegMethods } from "../lib/defaults";

type InventoryPageProps = {
  user: User;
};

type InventoryDraft = {
  draftWarehouseName: string;
  draftLogisticsMethodName: string;
  selectedProductIds: Record<string, string>;
  itemStockDrafts: Record<string, string>;
  itemStockReasonDrafts: Record<string, string>;
  warehouseNameDrafts: Record<string, string>;
};

const knownWarehouseSlugRules = [
  { slug: "suzhou", names: ["苏州", "suzhou"] },
  { slug: "fugang", names: ["福冈", "福岡", "fugang", "fukuoka"] },
] as const;

function normalizeWarehouseRouteText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[仓庫库]/g, "");
}

function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getWarehouseRouteSlug(warehouse: Pick<Warehouse, "name" | "id">) {
  const normalizedName = normalizeWarehouseRouteText(warehouse.name);
  const knownRule = knownWarehouseSlugRules.find((rule) =>
    rule.names.some((name) => normalizeWarehouseRouteText(name) === normalizedName),
  );
  if (knownRule) return knownRule.slug;

  const asciiSlug = warehouse.name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return asciiSlug || encodeURIComponent(warehouse.name.trim() || warehouse.id);
}

function isWarehouseRouteMatch(warehouse: Warehouse, routeSlug: string) {
  const decodedRouteSlug = decodeRouteSegment(routeSlug);
  const normalizedRouteSlug = normalizeWarehouseRouteText(decodedRouteSlug);
  const normalizedWarehouseName = normalizeWarehouseRouteText(warehouse.name);
  const normalizedGeneratedSlug = normalizeWarehouseRouteText(
    decodeRouteSegment(getWarehouseRouteSlug(warehouse)),
  );

  return (
    normalizedRouteSlug === normalizedGeneratedSlug ||
    normalizedRouteSlug === normalizedWarehouseName
  );
}

function getWarehouseRouteLabel(routeSlug: string) {
  const decodedRouteSlug = decodeRouteSegment(routeSlug);
  const normalizedRouteSlug = normalizeWarehouseRouteText(decodedRouteSlug);
  const knownRule = knownWarehouseSlugRules.find(
    (rule) => normalizeWarehouseRouteText(rule.slug) === normalizedRouteSlug,
  );
  return knownRule?.names[0] ?? decodedRouteSlug;
}

function hasInventoryDraft(
  draft: InventoryDraft | null | undefined,
  stockValuesById: Record<string, string> = {},
) {
  if (!draft) return false;

  return Boolean(
    draft.draftWarehouseName.trim() ||
      draft.draftLogisticsMethodName?.trim() ||
      Object.values(draft.selectedProductIds).some(Boolean) ||
      Object.values(draft.itemStockReasonDrafts).some((value) => value.trim()) ||
      Object.values(draft.warehouseNameDrafts).some((value) => value.trim()) ||
      Object.entries(draft.itemStockDrafts).some(
        ([itemId, value]) => stockValuesById[itemId] === undefined || value !== stockValuesById[itemId],
      ),
  );
}

function getInventoryErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const code = String(error.code);
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "42P01") {
      if (
        message.includes("public.logistics_methods") ||
        message.includes("public.warehouse_logistics_methods")
      ) {
        return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613_add_warehouse_logistics_methods.sql 迁移";
      }
      if (
        message.includes("public.warehouses") ||
        message.includes("public.warehouse_skus") ||
        message.includes("public.warehouse_item_stocks") ||
        message.includes("public.warehouse_item_stock_adjustments")
      ) {
        return "库存数据库还没有初始化，请先执行最新的库存表迁移";
      }
    }
  }

  const message = getErrorMessage(error, fallback);
  if (
    message.includes("public.logistics_methods") ||
    message.includes("public.warehouse_logistics_methods")
  ) {
    return "仓库发货方式数据库还没有完整初始化，请完整执行 20260613_add_warehouse_logistics_methods.sql 迁移";
  }
  return message.includes("public.warehouses") ||
    message.includes("public.warehouse_skus") ||
    message.includes("public.warehouse_item_stocks") ||
    message.includes("public.warehouse_item_stock_adjustments")
    ? "库存数据库还没有初始化，请先执行最新的库存表迁移"
    : message;
}

function parseStockDraftValue(item: Pick<WarehouseItemStock, "stock_quantity">, value: string) {
  const text = value.trim();
  if (!text) {
    return { stockQuantity: item.stock_quantity, errorMessage: "" };
  }

  const quantity = Number(text);
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity)) {
    return { stockQuantity: item.stock_quantity, errorMessage: "请填写整数库存数量。" };
  }

  const isDeltaInput = /^[+-]/.test(text);
  const stockQuantity = isDeltaInput ? item.stock_quantity + quantity : quantity;
  if (stockQuantity < 0) {
    return {
      stockQuantity: item.stock_quantity,
      errorMessage: `库存不能小于 0，当前库存 ${item.stock_quantity}。`,
    };
  }

  return { stockQuantity, errorMessage: "" };
}

export function InventoryPage({ user }: InventoryPageProps) {
  const { warehouseSlug } = useParams();
  const { canEdit, canDelete } = usePermissions();
  const draftKey = `inventory-draft:v1:${user.id}`;
  const restoredDraftRef = useRef(readDraft<InventoryDraft>(draftKey));
  const restoredDraft = restoredDraftRef.current;
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [skus, setSkus] = useState<ProductSku[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [logisticsMethods, setLogisticsMethods] = useState<LogisticsMethod[]>([]);
  const [warehouseLogisticsMethods, setWarehouseLogisticsMethods] = useState<
    WarehouseLogisticsMethod[]
  >([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [warehouseItemStockAdjustments, setWarehouseItemStockAdjustments] = useState<
    WarehouseItemStockAdjustment[]
  >([]);
  const [draftWarehouseName, setDraftWarehouseName] = useState(restoredDraft?.draftWarehouseName ?? "");
  const [draftLogisticsMethodName, setDraftLogisticsMethodName] = useState(
    restoredDraft?.draftLogisticsMethodName ?? "",
  );
  const [selectedProductIds, setSelectedProductIds] = useState<Record<string, string>>(
    restoredDraft?.selectedProductIds ?? {},
  );
  const [itemStockDrafts, setItemStockDrafts] = useState<Record<string, string>>(
    restoredDraft?.itemStockDrafts ?? {},
  );
  const [itemStockReasonDrafts, setItemStockReasonDrafts] = useState<Record<string, string>>(
    restoredDraft?.itemStockReasonDrafts ?? {},
  );
  const [warehouseNameDrafts, setWarehouseNameDrafts] = useState<Record<string, string>>(
    restoredDraft?.warehouseNameDrafts ?? {},
  );
  const [expandedSkuIds, setExpandedSkuIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    hasInventoryDraft(restoredDraft) ? "已恢复上次未保存的库存编辑草稿。" : "",
  );
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));
  const [searchQuery, setSearchQuery] = useState("");
  const [editingWarehouseId, setEditingWarehouseId] = useState<string | null>(null);
  const [showWarehouseSettings, setShowWarehouseSettings] = useState(false);
  const [settingsFirstLegs, setSettingsFirstLegs] = useState<LogisticsMethodConfig[]>([]);
  const [settingsLastLegs, setSettingsLastLegs] = useState<LogisticsMethodConfig[]>([]);
  const productCodeCollator = useMemo(
    () => new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }),
    [],
  );
  const routeWarehouse = useMemo(
    () =>
      warehouseSlug
        ? warehouses.find((warehouse) => isWarehouseRouteMatch(warehouse, warehouseSlug)) ??
          null
        : null,
    [warehouseSlug, warehouses],
  );
  const visibleWarehouses = useMemo(
    () =>
      warehouseSlug
        ? routeWarehouse
          ? [routeWarehouse]
          : []
        : warehouses,
    [routeWarehouse, warehouseSlug, warehouses],
  );
  const routeWarehouseLabel = warehouseSlug
    ? routeWarehouse?.name ?? getWarehouseRouteLabel(warehouseSlug)
    : "";
  const pageTitle = routeWarehouseLabel ? `${routeWarehouseLabel}仓库存` : "仓储库存";
  const pageDescription = routeWarehouseLabel
    ? `仅显示${routeWarehouseLabel}仓库的 SKU 与配件库存`
    : "显示全部仓库的 SKU 与配件库存";


  const PAGE_SIZE_OPTIONS = [20, 30, 50, 100] as const;
  const [pageSize, setPageSize] = useState<number>(20);
  const [warehousePages, setWarehousePages] = useState<Record<string, number>>({});
  const [warehouseTotals, setWarehouseTotals] = useState<Record<string, number>>({});
  const [warehouseLoadedSearches, setWarehouseLoadedSearches] = useState<Record<string, string>>({});
  const [warehousePageLoading, setWarehousePageLoading] = useState<Record<string, boolean>>({});
  const [adjustmentsLoadingKeys, setAdjustmentsLoadingKeys] = useState<Record<string, boolean>>({});
  const [loadedAdjustmentKeys, setLoadedAdjustmentKeys] = useState<Record<string, boolean>>({});

  const loadWarehousePage = useCallback(async (warehouseId: string, targetPage: number, size?: number) => {
    const effectiveSize = size ?? pageSize;
    setWarehousePageLoading(curr => ({ ...curr, [warehouseId]: true }));
    setErrorMessage("");
    try {
      const data = await fetchWarehouseInventoryPage(warehouseId, targetPage, effectiveSize, searchQuery);

      // Replace SKUs for this warehouse with the new page's data
      setWarehouseSkus(curr => [
        ...curr.filter(s => s.warehouse_id !== warehouseId),
        ...data.warehouseSkus,
      ]);
      setProducts(curr => {
        const newItems = data.products.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });
      setSkus(curr => {
        const newItems = data.skus.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });
      setProductItems(curr => {
        const newItems = data.productItems.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });
      // Replace item stocks for this warehouse
      setWarehouseItemStocks(curr => [
        ...curr.filter(s => s.warehouse_id !== warehouseId),
        ...data.warehouseItemStocks,
      ]);
      // Replace adjustments for this warehouse
      setWarehouseItemStockAdjustments(curr => [
        ...curr.filter(s => s.warehouse_id !== warehouseId),
        ...data.warehouseItemStockAdjustments,
      ]);

      setWarehousePages(curr => ({ ...curr, [warehouseId]: targetPage }));
      setWarehouseTotals(curr => ({ ...curr, [warehouseId]: data.total }));
      setWarehouseLoadedSearches(curr => ({ ...curr, [warehouseId]: searchQuery.trim() }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "加载仓库数据失败"));
    } finally {
      setWarehousePageLoading(curr => ({ ...curr, [warehouseId]: false }));
    }
  }, [pageSize, searchQuery]);

  useEffect(() => {
    let active = true;

    async function loadDictionaries() {
      setLoading(true);
      setErrorMessage("");
      try {
        const [nextWarehouses, nextLogisticsMethods] = await Promise.all([
          fetchWarehouses(),
          fetchLogisticsMethods(),
        ]);
        const nextWarehouseLogisticsMethods = await fetchWarehouseLogisticsMethods(
          nextWarehouses.map((warehouse) => warehouse.id)
        );

        let nextSettings = null;
        try {
          nextSettings = await fetchSettings(user.id);
        } catch (e) {
          console.error("Failed to fetch settings in inventory page:", e);
        }

        const firstLegs: LogisticsMethodConfig[] =
          nextSettings?.first_leg_methods || defaultFirstLegMethods;
        const lastLegs: LogisticsMethodConfig[] =
          nextSettings?.last_leg_methods || defaultLastLegMethods;
        const updatedDbLogisticsMethods = [...nextLogisticsMethods];

        if (active) {
          setWarehouses(nextWarehouses);
          setLogisticsMethods(updatedDbLogisticsMethods);
          setWarehouseLogisticsMethods(nextWarehouseLogisticsMethods);
          setSettingsFirstLegs(firstLegs);
          setSettingsLastLegs(lastLegs);

          const latestDraft = readDraft<InventoryDraft>(draftKey);
          setItemStockDrafts(latestDraft?.itemStockDrafts ?? {});
          setItemStockReasonDrafts(latestDraft?.itemStockReasonDrafts ?? {});
          setSelectedProductIds(latestDraft?.selectedProductIds ?? {});
          setWarehouseNameDrafts(latestDraft?.warehouseNameDrafts ?? {});
          setDraftWarehouseName(latestDraft?.draftWarehouseName ?? "");
          setDraftLogisticsMethodName(latestDraft?.draftLogisticsMethodName ?? "");
          if (hasInventoryDraft(latestDraft)) {
            setDraftNotice("已恢复上次未保存的库存编辑草稿。");
          }
        }
      } catch (error) {
        if (active) setErrorMessage(getInventoryErrorMessage(error, "加载基础数据失败"));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDictionaries();
    return () => { active = false; };
  }, [draftKey, user.id]);

  useEffect(() => {
    if (visibleWarehouses.length === 1) {
      const warehouse = visibleWarehouses[0];
      if (warehouseTotals[warehouse.id] === undefined) {
        void loadWarehousePage(warehouse.id, 1);
      }
    }
  }, [visibleWarehouses, warehouseTotals, loadWarehousePage]);

  useEffect(() => {
    if (visibleWarehouses.length !== 1) return;
    const warehouse = visibleWarehouses[0];
    if (warehouseTotals[warehouse.id] === undefined) return;
    if ((warehouseLoadedSearches[warehouse.id] ?? "") === searchQuery.trim()) return;
    void loadWarehousePage(warehouse.id, 1);
  }, [searchQuery, visibleWarehouses, warehouseLoadedSearches, warehouseTotals, loadWarehousePage]);



  const inventoryDraftValue = useMemo<InventoryDraft>(
    () => ({
      draftWarehouseName,
      draftLogisticsMethodName,
      selectedProductIds,
      itemStockDrafts,
      itemStockReasonDrafts,
      warehouseNameDrafts,
    }),
    [
      draftWarehouseName,
      draftLogisticsMethodName,
      itemStockDrafts,
      itemStockReasonDrafts,
      selectedProductIds,
      warehouseNameDrafts,
    ],
  );

  const stockValuesById = useMemo(
    () =>
      Object.fromEntries(
        warehouseItemStocks.map((item) => [item.id, String(item.stock_quantity)]),
      ),
    [warehouseItemStocks],
  );

  useDraftPersistence(
    draftKey,
    inventoryDraftValue,
    {
      enabled: !loading,
      shouldPersist: (draft) => hasInventoryDraft(draft, stockValuesById),
    },
  );

  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  const skusById = useMemo(
    () => Object.fromEntries(skus.flatMap((sku) => (sku.id ? [[sku.id, sku]] : []))),
    [skus],
  );

  const productItemsById = useMemo(
    () =>
      Object.fromEntries(
        productItems.flatMap((item) => (item.id ? [[item.id, item]] : [])),
      ),
    [productItems],
  );

  const skusByProductId = useMemo(
    () =>
      skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
        if (!sku.product_id) return groups;
        groups[sku.product_id] ??= [];
        groups[sku.product_id].push(sku);
        return groups;
      }, {}),
    [skus],
  );

  const skuDisplayCodesById = useMemo(() => {
    const codesById: Record<string, string> = {};

    Object.entries(skusByProductId).forEach(([productId, productSkus]) => {
      const product = productsById[productId];
      productSkus.forEach((sku, index) => {
        if (!sku.id) return;
        codesById[sku.id] =
          product && isLegacyDefaultSkuCode(sku.sku_code)
            ? buildDefaultSkuCode(product.product_code, index)
            : sku.sku_code;
      });
    });

    return codesById;
  }, [productsById, skusByProductId]);

  const getSkuDisplayCode = useCallback(
    (sku?: ProductSku) => {
      if (!sku?.id) return "--";
      return skuDisplayCodesById[sku.id] || sku.sku_code || "--";
    },
    [skuDisplayCodesById],
  );

  const warehouseSkusByWarehouseId = useMemo(
    () =>
      warehouseSkus.reduce<Record<string, WarehouseSku[]>>((groups, item) => {
        groups[item.warehouse_id] ??= [];
        groups[item.warehouse_id].push(item);
        return groups;
      }, {}),
    [warehouseSkus],
  );

  const warehouseItemStocksByKey = useMemo(
    () =>
      Object.fromEntries(
        warehouseItemStocks.map((item) => [`${item.warehouse_id}:${item.item_id}`, item]),
      ),
    [warehouseItemStocks],
  );

  const warehouseItemStockAdjustmentsByKey = useMemo(
    () =>
      warehouseItemStockAdjustments.reduce<
        Record<string, WarehouseItemStockAdjustment[]>
      >((groups, adjustment) => {
        const key = `${adjustment.warehouse_id}:${adjustment.item_id}`;
        groups[key] ??= [];
        groups[key].push(adjustment);
        return groups;
      }, {}),
    [warehouseItemStockAdjustments],
  );

  const activeLogisticsMethods = useMemo(
    () =>
      logisticsMethods
        .filter((method) => method.is_active)
        .sort((left, right) => {
          if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
          return left.created_at.localeCompare(right.created_at);
        }),
    [logisticsMethods],
  );

  const warehouseLogisticsMethodIdsByWarehouseId = useMemo(
    () =>
      warehouseLogisticsMethods.reduce<Record<string, string[]>>((groups, item) => {
        groups[item.warehouse_id] ??= [];
        groups[item.warehouse_id].push(item.logistics_method_id);
        return groups;
      }, {}),
    [warehouseLogisticsMethods],
  );

  const itemIdsByProductId = useMemo(
    () =>
      productItems.reduce<Record<string, string[]>>((groups, item) => {
        if (!item.product_id || !item.id) return groups;
        groups[item.product_id] ??= [];
        groups[item.product_id].push(item.id);
        return groups;
      }, {}),
    [productItems],
  );

  const sortedProducts = useMemo(
    () =>
      [...products].sort((left, right) => {
        const byProductCode = productCodeCollator.compare(
          right.product_code,
          left.product_code,
        );
        if (byProductCode !== 0) return byProductCode;
        return right.created_at.localeCompare(left.created_at);
      }),
    [productCodeCollator, products],
  );

  const sortedWarehouseSkusByWarehouseId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(warehouseSkusByWarehouseId).map(([warehouseId, items]) => [
          warehouseId,
          [...items].sort((left, right) => {
            const leftProductCode = productsById[left.product_id]?.product_code ?? "";
            const rightProductCode = productsById[right.product_id]?.product_code ?? "";
            const byProductCode = productCodeCollator.compare(
              rightProductCode,
              leftProductCode,
            );
            if (byProductCode !== 0) return byProductCode;

            const leftSkuCode = getSkuDisplayCode(skusById[left.sku_id]);
            const rightSkuCode = getSkuDisplayCode(skusById[right.sku_id]);
            const bySkuCode = productCodeCollator.compare(rightSkuCode, leftSkuCode);
            if (bySkuCode !== 0) return bySkuCode;

            return right.created_at.localeCompare(left.created_at);
          }),
        ]),
      ) as Record<string, WarehouseSku[]>,
    [
      productCodeCollator,
      productsById,
      skusById,
      warehouseSkusByWarehouseId,
      getSkuDisplayCode,
    ],
  );

  async function handleCreateLogisticsMethod() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能新增发货方式。");
      return;
    }

    const name = normalizeLogisticsMethodName(draftLogisticsMethodName);
    if (!name) return;

    const exists = logisticsMethods.some(
      (method) => normalizeLogisticsMethodName(method.name).toLowerCase() === name.toLowerCase(),
    );
    if (exists) {
      setErrorMessage(`发货方式“${name}”已存在。`);
      return;
    }
    if (!confirmSave(`确认新增发货方式“${name}”吗？`)) return;

    setBusyKey("create-logistics-method");
    setErrorMessage("");
    try {
      const method = await createLogisticsMethod(name);
      setLogisticsMethods((current) => [...current, method]);
      setDraftLogisticsMethodName("");
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "新增发货方式失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleToggleWarehouseLogisticsMethod(
    warehouse: Warehouse,
    method: LogisticsMethod,
    checked: boolean,
  ) {
    if (!canEdit) return;
    if (!confirmSave(`确认更新仓库“${warehouse.name}”的发货方式吗？`)) return;

    const currentMethodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
    const nextMethodIds = checked
      ? [...currentMethodIds, method.id]
      : currentMethodIds.filter((methodId) => methodId !== method.id);

    setBusyKey(`warehouse-logistics-${warehouse.id}`);
    setErrorMessage("");
    try {
      const nextLinks = await replaceWarehouseLogisticsMethods(warehouse.id, nextMethodIds);
      setWarehouseLogisticsMethods((current) => [
        ...current.filter((item) => item.warehouse_id !== warehouse.id),
        ...nextLinks,
      ]);
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "更新仓库发货方式失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleCreateWarehouse() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能新增仓库。");
      return;
    }

    const name = draftWarehouseName.trim();
    if (!name) return;
    if (!confirmSave(`确认新增仓库“${name}”吗？`)) return;

    setBusyKey("create-warehouse");
    setErrorMessage("");
    try {
      const warehouse = await createWarehouse(name);
      setWarehouses((current) => [...current, warehouse]);
      setDraftWarehouseName("");
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "新增仓库失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleUpdateWarehouse(
    warehouse: Warehouse,
    updates: Pick<Warehouse, "name">,
  ) {
    if (!canEdit) return;
    if (!confirmSave(`确认保存仓库“${warehouse.name}”的修改吗？`)) return;

    setBusyKey(`warehouse-${warehouse.id}`);
    setErrorMessage("");
    try {
      const nextWarehouse = await updateWarehouse(warehouse.id, updates);
      setWarehouses((current) =>
        current.map((item) => (item.id === warehouse.id ? nextWarehouse : item)),
      );
      setWarehouseNameDrafts((current) => {
        const { [warehouse.id]: _savedName, ...rest } = current;
        void _savedName;
        return rest;
      });
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "更新仓库失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDeleteWarehouse(warehouse: Warehouse) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

    if (!confirmDelete(`仓库“${warehouse.name}”`)) return;

    setBusyKey(`warehouse-${warehouse.id}`);
    setErrorMessage("");
    try {
      await deleteWarehouse(warehouse.id);
      setWarehouses((current) => current.filter((item) => item.id !== warehouse.id));
      setWarehouseLogisticsMethods((current) =>
        current.filter((item) => item.warehouse_id !== warehouse.id),
      );
      setWarehouseSkus((current) =>
        current.filter((item) => item.warehouse_id !== warehouse.id),
      );
      setSelectedProductIds((current) => {
        const { [warehouse.id]: _selectedProductId, ...rest } = current;
        void _selectedProductId;
        return rest;
      });
      setWarehouseNameDrafts((current) => {
        const { [warehouse.id]: _warehouseName, ...rest } = current;
        void _warehouseName;
        return rest;
      });
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "删除仓库失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleAddProduct(warehouseId: string) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能添加库存商品。");
      return;
    }

    const productId = selectedProductIds[warehouseId];
    if (!productId) return;
    if (!confirmAction("确认添加该商品到库存吗？")) return;

    setBusyKey(`add-product-${warehouseId}`);
    setErrorMessage("");
    try {
      const [nextProducts, nextSkus, nextItems] = await Promise.all([
        productsById[productId]
          ? Promise.resolve([productsById[productId]])
          : fetchProductsByIds([productId]),
        fetchProductSkusByProductIds([productId]),
        fetchProductItemsByProductIds([productId]),
      ]);

      if (nextProducts.length === 0) {
        setErrorMessage("未找到所选商品，请重新搜索后再试。");
        return;
      }

      const productSkuIds = nextSkus.flatMap((sku) => (sku.id ? [sku.id] : []));
      if (productSkuIds.length === 0) {
        setErrorMessage("该商品还没有 SKU，不能加入库存");
        return;
      }

      const productItemIds = nextItems.flatMap((item) => (item.id ? [item.id] : []));

      setProducts((current) => [
        ...current,
        ...nextProducts.filter((product) => !current.some((item) => item.id === product.id)),
      ]);
      setSkus((current) => [
        ...current,
        ...nextSkus.filter((sku) => !current.some((item) => item.id === sku.id)),
      ]);
      setProductItems((current) => [
        ...current,
        ...nextItems.filter((item) => !current.some((currentItem) => currentItem.id === item.id)),
      ]);

      const inventory = await addWarehouseProductInventory(
        warehouseId,
        productId,
        productSkuIds,
        productItemIds,
      );
      setWarehouseSkus((current) => [...current, ...inventory.skus]);
      setWarehouseItemStocks((current) => [...current, ...inventory.itemStocks]);
      setItemStockDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          inventory.itemStocks.map((item) => [item.id, String(item.stock_quantity)]),
        ),
      }));
      setSelectedProductIds((current) => ({ ...current, [warehouseId]: "" }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "添加库存商品失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleRemoveProduct(warehouseId: string, productId: string) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

    const product = productsById[productId];
    if (!confirmDelete(`仓库商品编号“${product?.product_code ?? ""}”`)) return;

    setBusyKey(`product-${warehouseId}-${productId}`);
    setErrorMessage("");
    try {
      await removeWarehouseProduct(warehouseId, productId, itemIdsByProductId[productId] ?? []);
      setWarehouseSkus((current) =>
        current.filter(
          (entry) => entry.warehouse_id !== warehouseId || entry.product_id !== productId,
        ),
      );
      setWarehouseItemStocks((current) =>
        current.filter(
          (entry) =>
            entry.warehouse_id !== warehouseId ||
            !(itemIdsByProductId[productId] ?? []).includes(entry.item_id),
        ),
      );
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "移除库存商品失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleSaveSkuStock(item: WarehouseSku) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新库存。");
      return;
    }

    const { stockQuantity: nextStock, errorMessage: stockDraftError } =
      parseStockDraftValue(item, itemStockDrafts[item.id] ?? String(item.stock_quantity));
    if (stockDraftError) {
      setErrorMessage(stockDraftError);
      return;
    }

    const reason = itemStockReasonDrafts[item.id]?.trim() ?? "";
    if (!reason) return;
    if (!confirmSave("确认保存本次 SKU 库存修改吗？")) return;
    setBusyKey(`sku-stock-${item.id}`);
    setErrorMessage("");
    try {
      const nextItem = await updateWarehouseSkuStockQuantity(item, nextStock);
      setWarehouseSkus((current) =>
        current.map((entry) => (entry.id === item.id ? nextItem : entry)),
      );
      setItemStockDrafts((current) => ({
        ...current,
        [item.id]: String(nextItem.stock_quantity),
      }));
      setItemStockReasonDrafts((current) => ({ ...current, [item.id]: "" }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "更新 SKU 库存失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleToggleSkuDetails(warehouseId: string, item: WarehouseSku, sku?: ProductSku) {
    const willExpand = !expandedSkuIds[item.id];
    setExpandedSkuIds((current) => ({
      ...current,
      [item.id]: willExpand,
    }));

    if (!willExpand || !sku?.component_links.length || loadedAdjustmentKeys[item.id]) return;

    const itemIds = sku.component_links.map((link) => link.item_id).filter(Boolean);
    setAdjustmentsLoadingKeys((current) => ({ ...current, [item.id]: true }));
    try {
      const adjustments = await fetchWarehouseItemStockAdjustmentsForItems(warehouseId, itemIds);
      setWarehouseItemStockAdjustments((current) => {
        const loadedItemIds = new Set(itemIds);
        return [
          ...current.filter(
            (adjustment) =>
              adjustment.warehouse_id !== warehouseId || !loadedItemIds.has(adjustment.item_id),
          ),
          ...adjustments,
        ];
      });
      setLoadedAdjustmentKeys((current) => ({ ...current, [item.id]: true }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "加载配件编辑记录失败"));
    } finally {
      setAdjustmentsLoadingKeys((current) => ({ ...current, [item.id]: false }));
    }
  }

  const findDbMethod = useCallback(
    (name: string) => {
      const normalizedName = normalizeLogisticsMethodName(name).toLowerCase();
      return logisticsMethods.find(
        (m) => normalizeLogisticsMethodName(m.name).toLowerCase() === normalizedName
      );
    },
    [logisticsMethods]
  );

  const getWarehouseAssignedLegs = useCallback(
    (warehouseId: string) => {
      const methodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouseId] ?? [];
      const firstLegs: string[] = [];
      const lastLegs: string[] = [];

      methodIds.forEach((methodId) => {
        const method = logisticsMethods.find((m) => m.id === methodId);
        if (!method) return;
        const normalizedName = normalizeLogisticsMethodName(method.name).toLowerCase();

        // Check if it exists in settingsFirstLegs
        const isFirstLeg = settingsFirstLegs.some(
          (m) => normalizeLogisticsMethodName(m.name).toLowerCase() === normalizedName
        );
        if (isFirstLeg) {
          firstLegs.push(method.name);
          return;
        }

        // Check if it exists in settingsLastLegs
        const isLastLeg = settingsLastLegs.some(
          (m) => normalizeLogisticsMethodName(m.name).toLowerCase() === normalizedName
        );
        if (isLastLeg) {
          lastLegs.push(method.name);
          return;
        }
      });

      return { firstLegs, lastLegs };
    },
    [warehouseLogisticsMethodIdsByWarehouseId, logisticsMethods, settingsFirstLegs, settingsLastLegs]
  );

  const filteredWarehouseSkusByWarehouseId = useMemo(() => {
    const result: Record<string, WarehouseSku[]> = {};
    Object.entries(sortedWarehouseSkusByWarehouseId).forEach(([warehouseId, sortedItems]) => {
      result[warehouseId] = sortedItems;
    });
    return result;
  }, [sortedWarehouseSkusByWarehouseId]);

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader title={pageTitle} description={pageDescription} />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}

      {!loading && warehouses.length > 0 && (
        <section className="rounded-lg bg-panel p-3 shadow-soft">
          <div className="flex flex-wrap gap-2">
            <Link
              to="/inventory"
              className={`inline-flex h-10 items-center rounded-lg border px-4 text-sm font-semibold transition ${
                !warehouseSlug
                  ? "border-violet-200 bg-violet-50 text-violet-700"
                  : "border-line bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              全部仓库
            </Link>
            {warehouses.map((warehouse) => {
              const isActive = routeWarehouse?.id === warehouse.id;
              return (
                <Link
                  key={warehouse.id}
                  to={`/inventory/${getWarehouseRouteSlug(warehouse)}`}
                  className={`inline-flex h-10 items-center rounded-lg border px-4 text-sm font-semibold transition ${
                    isActive
                      ? "border-violet-200 bg-violet-50 text-violet-700"
                      : "border-line bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {warehouse.name}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {!warehouseSlug && !loading && (
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
            <div>
              <div className="text-sm font-medium text-slate-500">仓库总数</div>
              <div className="mt-1 text-2xl font-bold text-ink">{warehouses.length} 个</div>
            </div>
            <div className="rounded-full bg-violet-50 p-3 text-violet-600">
              <MapPin size={24} />
            </div>
          </div>
          <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
            <div>
              <div className="text-sm font-medium text-slate-500">已分配商品 SKU 总数</div>
              <div className="mt-1 text-2xl font-bold text-ink">
                {Object.values(warehouseSkusByWarehouseId).reduce((acc, curr) => acc + curr.length, 0)} 个
              </div>
            </div>
            <div className="rounded-full bg-blue-50 p-3 text-blue-600">
              <Search size={24} />
            </div>
          </div>
          <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
            <div>
              <div className="text-sm font-medium text-slate-500">可用发货方式</div>
              <div className="mt-1 text-2xl font-bold text-ink">
                {settingsFirstLegs.length + settingsLastLegs.length} 个
              </div>
            </div>
            <div className="rounded-full bg-emerald-50 p-3 text-emerald-600">
              <Truck size={24} />
            </div>
          </div>
        </div>
      )}

      {/* Admin creation blocks: only show on all warehouses view & with permissions */}
      {!warehouseSlug && canEdit && (
        <section className="rounded-lg bg-panel grid gap-4 p-5 shadow-soft">
          <h2 className="text-base font-semibold text-ink">新增仓库</h2>
          <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
            <input
              value={draftWarehouseName}
              onChange={(event) => setDraftWarehouseName(event.target.value)}
              placeholder="例如: 苏州仓、福冈仓、大厦仓"
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={() => void handleCreateWarehouse()}
              disabled={!draftWarehouseName.trim() || busyKey === "create-warehouse"}
              className="btn-primary rounded-xl"
            >
              <Plus size={18} />
              增加仓库
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className="text-sm text-slate-500">加载中...</div>
      ) : warehouses.length === 0 ? (
        <div className="empty-state">
          暂无仓库
        </div>
      ) : warehouseSlug && visibleWarehouses.length === 0 ? (
        <div className="empty-state">
          未找到{routeWarehouseLabel}仓库
        </div>
      ) : (
        <div className="grid gap-5">
          {/* Main List Layout */}
          {!warehouseSlug ? (
            <div className="grid gap-5 md:grid-cols-2">
              {visibleWarehouses.map((warehouse) => {
                const skuCount = (warehouseSkusByWarehouseId[warehouse.id] ?? []).length;
                const { firstLegs, lastLegs } = getWarehouseAssignedLegs(warehouse.id);
                const totalAssignedLegs = firstLegs.length + lastLegs.length;

                return (
                  <div key={warehouse.id} className="rounded-lg bg-panel p-5 flex flex-col justify-between shadow-soft relative group">
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="rounded-lg bg-violet-50 p-2 text-violet-600">
                            <MapPin size={20} />
                          </div>
                          <h3 className="text-lg font-bold text-ink">{warehouse.name}</h3>
                        </div>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => setEditingWarehouseId(editingWarehouseId === warehouse.id ? null : warehouse.id)}
                            className={`p-2 rounded-lg border transition ${
                              editingWarehouseId === warehouse.id
                                ? "bg-violet-50 text-violet-600 border-violet-200"
                                : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
                            }`}
                            title="仓库属性设置"
                          >
                            <Settings size={18} />
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4 my-4 bg-slate-50 rounded-xl p-4 border border-line">
                        <div>
                          <div className="text-xs text-slate-500">SKU 种类</div>
                          <div className="mt-1 text-lg font-bold text-ink">{skuCount} 个</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500">关联配送方式</div>
                          <div className="mt-1 text-lg font-bold text-ink">{totalAssignedLegs} 个</div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="text-xs font-semibold text-slate-500">已关联发货方式：</div>
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-[10px] uppercase font-bold text-blue-600 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5 mt-0.5 shrink-0">头程</span>
                            <div className="flex flex-wrap gap-1.5">
                              {firstLegs.length === 0 ? (
                                <span className="text-xs text-slate-400">未设置头程</span>
                              ) : (
                                firstLegs.map((name) => (
                                  <span key={name} className="inline-flex items-center gap-1 rounded bg-blue-50 border border-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                                    <Truck size={12} />
                                    {name}
                                  </span>
                                ))
                              )}
                            </div>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-[10px] uppercase font-bold text-violet-600 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5 mt-0.5 shrink-0">尾程</span>
                            <div className="flex flex-wrap gap-1.5">
                              {lastLegs.length === 0 ? (
                                <span className="text-xs text-slate-400">未设置尾程</span>
                              ) : (
                                lastLegs.map((name) => (
                                  <span key={name} className="inline-flex items-center gap-1 rounded bg-violet-50 border border-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                                    <Truck size={12} />
                                    {name}
                                  </span>
                                ))
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {editingWarehouseId === warehouse.id && (
                      <div className="mt-4 border-t border-line pt-4 grid gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-xs font-semibold text-slate-700">重命名仓库：</span>
                            <input
                              value={warehouseNameDrafts[warehouse.id] ?? warehouse.name}
                              readOnly={!canEdit}
                              onChange={(event) =>
                                setWarehouseNameDrafts((current) => ({
                                  ...current,
                                  [warehouse.id]: event.target.value,
                                }))
                              }
                              onBlur={() => {
                                if (canEdit) {
                                  const nextName =
                                    (warehouseNameDrafts[warehouse.id] ?? warehouse.name).trim() ||
                                    warehouse.name;
                                  void handleUpdateWarehouse(warehouse, { name: nextName });
                                }
                              }}
                              className="h-8 max-w-xs rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-accent"
                            />
                          </div>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteWarehouse(warehouse)}
                              disabled={busyKey === `warehouse-${warehouse.id}`}
                              className="btn-danger h-8 text-xs px-2"
                            >
                              <Trash2 size={14} />
                              删除仓库
                            </button>
                          )}
                        </div>

                        <div className="grid gap-4 md:grid-cols-2 bg-slate-50 rounded-xl p-4 border border-line text-left">
                          <div className="grid gap-2">
                            <div className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-blue-500"></span>
                              可用头程物流 (First Leg)
                            </div>
                            {settingsFirstLegs.length === 0 ? (
                              <div className="text-[11px] text-slate-500">参数设置中未配置头程</div>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {settingsFirstLegs.map((config) => {
                                  const dbMethod = findDbMethod(config.name);
                                  if (!dbMethod) return null;
                                  const methodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
                                  const checked = methodIds.includes(dbMethod.id);
                                  return (
                                    <label
                                      key={config.name}
                                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium cursor-pointer transition select-none ${
                                        checked
                                          ? "border-blue-200 bg-blue-50 text-blue-700"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={
                                          !canEdit ||
                                          busyKey === `warehouse-logistics-${warehouse.id}`
                                        }
                                        onChange={(event) =>
                                          void handleToggleWarehouseLogisticsMethod(
                                            warehouse,
                                            dbMethod,
                                            event.target.checked,
                                          )
                                        }
                                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                      />
                                      {config.name}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          <div className="grid gap-2">
                            <div className="text-xs font-semibold text-violet-800 flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-violet-500"></span>
                              可用尾程物流 (Last Leg)
                            </div>
                            {settingsLastLegs.length === 0 ? (
                              <div className="text-[11px] text-slate-500">参数设置中未配置尾程</div>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {settingsLastLegs.map((config) => {
                                  const dbMethod = findDbMethod(config.name);
                                  if (!dbMethod) return null;
                                  const methodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
                                  const checked = methodIds.includes(dbMethod.id);
                                  return (
                                    <label
                                      key={config.name}
                                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium cursor-pointer transition select-none ${
                                        checked
                                          ? "border-violet-200 bg-violet-50 text-violet-700"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={
                                          !canEdit ||
                                          busyKey === `warehouse-logistics-${warehouse.id}`
                                        }
                                        onChange={(event) =>
                                          void handleToggleWarehouseLogisticsMethod(
                                            warehouse,
                                            dbMethod,
                                            event.target.checked,
                                          )
                                        }
                                        className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                                      />
                                      {config.name}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-5 pt-4 border-t border-line flex justify-end">
                      <Link
                        to={`/inventory/${getWarehouseRouteSlug(warehouse)}`}
                        className="inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
                      >
                        进入该仓库库存 →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Specific Warehouse Page View */
            visibleWarehouses.map((warehouse) => {
              const { firstLegs, lastLegs } = getWarehouseAssignedLegs(warehouse.id);
              const filteredItems = filteredWarehouseSkusByWarehouseId[warehouse.id] ?? [];
              const warehouseTotal = warehouseTotals[warehouse.id] ?? (warehouseSkusByWarehouseId[warehouse.id] ?? []).length;
              const hasSearch = Boolean(searchQuery.trim());

              return (
                <div key={warehouse.id} className="grid gap-5">
                  {/* KPI cards for warehouse page */}
                  <div className="grid gap-5 sm:grid-cols-3">
                    <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
                      <div>
                        <div className="text-sm font-medium text-slate-500">{hasSearch ? "筛选匹配 SKU 数" : "已分配商品 SKU 数"}</div>
                        <div className="mt-1 text-2xl font-bold text-ink">
                          {warehouseTotal} 个
                        </div>
                      </div>
                      <div className="rounded-full bg-blue-50 p-3 text-blue-600">
                        <Search size={24} />
                      </div>
                    </div>
                    <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
                      <div>
                        <div className="text-sm font-medium text-slate-500">已关联头程物流</div>
                        <div className="mt-1 text-2xl font-bold text-ink">
                          {firstLegs.length} 个
                        </div>
                      </div>
                      <div className="rounded-full bg-indigo-50 p-3 text-indigo-600">
                        <Truck size={24} />
                      </div>
                    </div>
                    <div className="rounded-lg bg-panel p-5 flex items-center justify-between shadow-soft">
                      <div>
                        <div className="text-sm font-medium text-slate-500">已关联尾程物流</div>
                        <div className="mt-1 text-2xl font-bold text-ink">
                          {lastLegs.length} 个
                        </div>
                      </div>
                      <div className="rounded-full bg-violet-50 p-3 text-violet-600">
                        <Truck size={24} />
                      </div>
                    </div>
                  </div>

                  {/* Action Control Board */}
                  <section className="grid gap-4 rounded-lg bg-panel p-5 shadow-soft">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setShowWarehouseSettings(!showWarehouseSettings)}
                          className={`inline-flex h-10 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition ${
                            showWarehouseSettings
                              ? "border-violet-200 bg-violet-50 text-violet-700"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <Settings size={16} />
                          仓库属性设置
                        </button>
                        {canEdit && (
                          <Link to="/inventory/transfer" className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition">
                            <ArrowLeftRight size={16} />
                            库存调拨
                          </Link>
                        )}
                      </div>

                      <div className="relative flex-1 max-w-md min-w-[260px]">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="搜索商品编号、产品名称或SKU编号..."
                          className="h-10 w-full rounded-xl border border-line bg-white pl-10 pr-4 text-sm outline-none transition focus:border-violet-600 focus:ring-2 focus:ring-violet-600/20"
                        />
                      </div>
                    </div>

                    {/* Collapsible settings drawer */}
                    {showWarehouseSettings && (
                      <div className="border-t border-line mt-4 pt-4 grid gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-sm font-semibold text-slate-700">重命名仓库：</span>
                            <input
                              value={warehouseNameDrafts[warehouse.id] ?? warehouse.name}
                              readOnly={!canEdit}
                              onChange={(event) =>
                                setWarehouseNameDrafts((current) => ({
                                  ...current,
                                  [warehouse.id]: event.target.value,
                                }))
                              }
                              onBlur={() => {
                                if (canEdit) {
                                  const nextName =
                                    (warehouseNameDrafts[warehouse.id] ?? warehouse.name).trim() ||
                                    warehouse.name;
                                  void handleUpdateWarehouse(warehouse, { name: nextName });
                                }
                              }}
                              className="h-9 max-w-xs rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-accent"
                            />
                          </div>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteWarehouse(warehouse)}
                              disabled={busyKey === `warehouse-${warehouse.id}`}
                              className="btn-danger h-9 text-xs"
                            >
                              <Trash2 size={16} />
                              删除仓库
                            </button>
                          )}
                        </div>

                        <div className="grid gap-4 md:grid-cols-2 bg-slate-50 rounded-xl p-4 border border-line">
                          {/* First Leg */}
                          <div className="grid gap-2">
                            <div className="text-sm font-semibold text-blue-800 flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full bg-blue-500"></span>
                              可用头程物流 (First Leg)
                            </div>
                            {settingsFirstLegs.length === 0 ? (
                              <div className="text-xs text-slate-500">参数设置中未配置头程</div>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {settingsFirstLegs.map((config) => {
                                  const dbMethod = findDbMethod(config.name);
                                  if (!dbMethod) return null;
                                  const methodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
                                  const checked = methodIds.includes(dbMethod.id);
                                  return (
                                    <label
                                      key={config.name}
                                      className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium cursor-pointer transition select-none ${
                                        checked
                                          ? "border-blue-200 bg-blue-50 text-blue-700"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={
                                          !canEdit ||
                                          busyKey === `warehouse-logistics-${warehouse.id}`
                                        }
                                        onChange={(event) =>
                                          void handleToggleWarehouseLogisticsMethod(
                                            warehouse,
                                            dbMethod,
                                            event.target.checked,
                                          )
                                        }
                                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                      />
                                      {config.name}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Last Leg */}
                          <div className="grid gap-2">
                            <div className="text-sm font-semibold text-violet-800 flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full bg-violet-500"></span>
                              可用尾程物流 (Last Leg)
                            </div>
                            {settingsLastLegs.length === 0 ? (
                              <div className="text-xs text-slate-500">参数设置中未配置尾程</div>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {settingsLastLegs.map((config) => {
                                  const dbMethod = findDbMethod(config.name);
                                  if (!dbMethod) return null;
                                  const methodIds = warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
                                  const checked = methodIds.includes(dbMethod.id);
                                  return (
                                    <label
                                      key={config.name}
                                      className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium cursor-pointer transition select-none ${
                                        checked
                                          ? "border-violet-200 bg-violet-50 text-violet-700"
                                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={
                                          !canEdit ||
                                          busyKey === `warehouse-logistics-${warehouse.id}`
                                        }
                                        onChange={(event) =>
                                          void handleToggleWarehouseLogisticsMethod(
                                            warehouse,
                                            dbMethod,
                                            event.target.checked,
                                          )
                                        }
                                        className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                                      />
                                      {config.name}
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Quick add product row */}
                    {canEdit && (
                      <div className="border-t border-line mt-2 pt-4 flex flex-wrap items-center gap-3">
                        <div className="flex-1 min-w-[240px]">
                          <AsyncProductSelect
                            value={selectedProductIds[warehouse.id] ?? ""}
                            onChange={(value) =>
                              setSelectedProductIds((current) => ({
                                ...current,
                                [warehouse.id]: value,
                              }))
                            }
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleAddProduct(warehouse.id)}
                          disabled={
                            !selectedProductIds[warehouse.id] ||
                            busyKey === `add-product-${warehouse.id}`
                          }
                          className="inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-60"
                        >
                          <Plus size={18} />
                          增加商品编号
                        </button>
                      </div>
                    )}
                  </section>

                  {/* Inventory Table card */}
                  {warehouseTotals[warehouse.id] === undefined ? (
                    <div className="surface-card flex justify-center p-10 rounded-xl shadow-sm">
                      <div className="flex items-center gap-3 text-slate-400">
                        <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span className="text-sm">加载库存中...</span>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg shadow-soft overflow-hidden bg-panel">
                      <div className="overflow-x-auto">
                        <StandardTable
                          page={warehousePages[warehouse.id] ?? 1}
                          pageSize={pageSize}
                          totalPages={Math.max(1, Math.ceil((warehouseTotals[warehouse.id] ?? 0) / pageSize))}
                          totalRecordCount={warehouseTotals[warehouse.id] ?? 0}
                          onPageChange={(page) => void loadWarehousePage(warehouse.id, page)}
                          onPageSizeChange={(newSize) => {
                            setPageSize(newSize);
                            void loadWarehousePage(warehouse.id, 1, newSize);
                          }}
                          loading={warehousePageLoading[warehouse.id] ?? false}
                        >
                          <thead>
                            <tr>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">商品编号</th>
                              <th className="bg-slate-50 product-name-col px-4 py-3 font-semibold text-left">产品名称</th>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">SKU编号</th>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">销售规格</th>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">SKU库存</th>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">查看配件</th>
                              <th className="bg-slate-50 px-4 py-3 font-semibold text-left">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line bg-white">
                            {filteredItems.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                                  暂无符合条件的商品
                                </td>
                              </tr>
                            ) : (
                              filteredItems.map((item) => {
                                const product = productsById[item.product_id];
                                const sku = skusById[item.sku_id];
                                return (
                                  <Fragment key={item.id}>
                                    <tr className="border-t border-line hover:bg-slate-50/50 transition">
                                      <td className="px-4 py-3 font-medium text-ink">{product?.product_code ?? "--"}</td>
                                      <td className="product-name-col px-4 py-3 text-slate-600">{product?.product_name_cn ?? "--"}</td>
                                      <td className="px-4 py-3 font-mono text-xs">{getSkuDisplayCode(sku)}</td>
                                      <td className="px-4 py-3 text-slate-600">
                                        {sku && Object.keys(sku.attributes).length > 0 ? (
                                          <div className="grid gap-1 text-xs">
                                            {Object.entries(sku.attributes).map(([name, value]) => (
                                              <span key={name}>
                                                {name}：{value}
                                              </span>
                                            ))}
                                          </div>
                                        ) : (
                                          <span className="text-slate-400">无规格</span>
                                        )}
                                      </td>
                                      <td className="px-4 py-3">
                                        <div className="flex flex-col gap-2">
                                          <div className="flex items-center gap-2">
                                            <input
                                              step="1"
                                              type="number"
                                              placeholder="+/- 调整"
                                              disabled={!canEdit}
                                              value={
                                                itemStockDrafts[item.id] ??
                                                String(item.stock_quantity)
                                              }
                                              onChange={(event) =>
                                                setItemStockDrafts((current) => ({
                                                  ...current,
                                                  [item.id]: event.target.value,
                                                }))
                                              }
                                              className="h-9 w-24 rounded-lg border border-line bg-white px-2 text-xs font-semibold text-ink outline-none transition focus:border-violet-600"
                                            />
                                            {canEdit && (
                                              <button
                                                type="button"
                                                onClick={() => void handleSaveSkuStock(item)}
                                                disabled={
                                                  busyKey === `sku-stock-${item.id}` ||
                                                  !itemStockReasonDrafts[item.id]?.trim()
                                                }
                                                className="h-9 rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-violet-700 transition disabled:opacity-60"
                                              >
                                                保存
                                              </button>
                                            )}
                                          </div>
                                          <input
                                            value={itemStockReasonDrafts[item.id] ?? ""}
                                            onChange={(event) =>
                                              setItemStockReasonDrafts((current) => ({
                                                ...current,
                                                [item.id]: event.target.value,
                                              }))
                                            }
                                            disabled={!canEdit}
                                            placeholder="校准原因"
                                            className="h-8 w-40 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-violet-600"
                                          />
                                        </div>
                                      </td>
                                      <td className="px-4 py-3">
                                        <button
                                          type="button"
                                          onClick={() => void handleToggleSkuDetails(warehouse.id, item, sku)}
                                          className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
                                            expandedSkuIds[item.id]
                                              ? "border-violet-200 bg-violet-50 text-violet-700"
                                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                          }`}
                                        >
                                          {expandedSkuIds[item.id] ? (
                                            <ChevronUp size={14} />
                                          ) : (
                                            <ChevronDown size={14} />
                                          )}
                                          {adjustmentsLoadingKeys[item.id] ? "加载中" : "查看配件"}
                                        </button>
                                      </td>
                                      <td className="px-4 py-3">
                                        {canDelete && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void handleRemoveProduct(warehouse.id, item.product_id)
                                            }
                                            disabled={
                                              busyKey === `product-${warehouse.id}-${item.product_id}`
                                            }
                                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-100 transition disabled:opacity-60"
                                            aria-label={`删除商品编号 ${product?.product_code ?? ""}`}
                                            title="删除商品编号"
                                          >
                                            <Trash2 size={15} />
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                    {expandedSkuIds[item.id] && (
                                      <tr className="bg-slate-50/50">
                                        <td colSpan={7} className="px-4 py-4">
                                          <div className="overflow-hidden rounded-xl border border-line bg-white shadow-inner">
                                            <table className="data-table">
                                              <thead>
                                                <tr className="bg-slate-50">
                                                  <th className="px-4 py-3 font-semibold text-left text-xs">配件名称</th>
                                                  <th className="px-4 py-3 font-semibold text-left text-xs">配件规格</th>
                                                  <th className="px-4 py-3 font-semibold text-left text-xs">SKU用量</th>
                                                  <th className="px-4 py-3 font-semibold text-left text-xs">配件库存参考</th>
                                                  <th className="px-4 py-3 font-semibold text-left text-xs">编辑记录</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {sku?.component_links.length ? (
                                                  sku.component_links.map((link) => {
                                                    const component = productItemsById[link.item_id];
                                                    const itemStock =
                                                      warehouseItemStocksByKey[
                                                        `${warehouse.id}:${link.item_id}`
                                                      ];
                                                    const itemAdjustments =
                                                      warehouseItemStockAdjustmentsByKey[
                                                        `${warehouse.id}:${link.item_id}`
                                                      ] ?? [];
                                                    const isLoadingAdjustments =
                                                      adjustmentsLoadingKeys[item.id] && !loadedAdjustmentKeys[item.id];
                                                    return (
                                                      <tr key={link.item_id} className="border-t border-line hover:bg-slate-50/50">
                                                        <td className="px-4 py-3 text-sm text-ink font-medium">
                                                          {component?.item_name ?? "--"}
                                                        </td>
                                                        <td className="px-4 py-3 text-xs text-slate-500">
                                                          {component?.item_spec || "--"}
                                                        </td>
                                                        <td className="px-4 py-3 text-sm font-semibold text-slate-700">{link.quantity}</td>
                                                        <td className="px-4 py-3 text-sm font-semibold text-slate-700">
                                                          {itemStock?.stock_quantity ?? 0}
                                                        </td>
                                                        <td className="px-4 py-3 align-top">
                                                          {itemStock ? (
                                                            <div className="grid min-w-56 gap-2 text-[11px] text-slate-600">
                                                              {itemAdjustments
                                                                .slice(0, 3)
                                                                .map((adjustment) => (
                                                                  <div
                                                                    key={adjustment.id}
                                                                    className="rounded-lg bg-slate-50 p-2 border border-slate-100"
                                                                  >
                                                                    <div className="font-semibold text-slate-700">
                                                                      {adjustment.previous_quantity} →{" "}
                                                                      {adjustment.next_quantity}
                                                                      （
                                                                      {adjustment.change_quantity > 0
                                                                        ? "+"
                                                                        : ""}
                                                                      {adjustment.change_quantity}）
                                                                    </div>
                                                                    <div className="mt-0.5 text-slate-500">
                                                                      {adjustment.reason}
                                                                    </div>
                                                                  </div>
                                                                ))}
                                                              {isLoadingAdjustments && (
                                                                <span className="text-slate-400">
                                                                  正在加载编辑记录...
                                                                </span>
                                                              )}
                                                              {!isLoadingAdjustments && itemAdjustments.length === 0 && (
                                                                <span className="text-slate-400">
                                                                  暂无编辑记录
                                                                </span>
                                                              )}
                                                            </div>
                                                          ) : (
                                                            <span className="text-slate-400">--</span>
                                                          )}
                                                        </td>
                                                      </tr>
                                                    );
                                                  })
                                                ) : (
                                                  <tr>
                                                    <td
                                                      colSpan={6}
                                                      className="px-4 py-6 text-center text-slate-400 text-xs"
                                                    >
                                                      该 SKU 暂无配件
                                                    </td>
                                                  </tr>
                                                )}
                                              </tbody>
                                            </table>
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })
                            )}
                          </tbody>
                        </StandardTable>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

