import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import {
  addWarehouseProductInventory,
  createWarehouse,
  deleteWarehouse,
  fetchWarehouseInventoryPage,
  fetchWarehouses,
  removeWarehouseProduct,
  updateWarehouse,
  updateWarehouseItemStock,
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
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { PageHeader } from "../components/ui";
import { readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import { AsyncProductSelect } from "../components/inventory/AsyncProductSelect";

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

function parseStockDraftValue(item: WarehouseItemStock, value: string) {
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
  const visibleWarehouses = warehouseSlug
    ? routeWarehouse
      ? [routeWarehouse]
      : []
    : warehouses;
  const routeWarehouseLabel = warehouseSlug
    ? routeWarehouse?.name ?? getWarehouseRouteLabel(warehouseSlug)
    : "";
  const pageTitle = routeWarehouseLabel ? `${routeWarehouseLabel}仓库存` : "仓储库存";
  const pageDescription = routeWarehouseLabel
    ? `仅显示${routeWarehouseLabel}仓库的 SKU 与配件库存`
    : "显示全部仓库的 SKU 与配件库存";


  const [warehousePages, setWarehousePages] = useState<Record<string, number>>({});
  const [warehouseHasMore, setWarehouseHasMore] = useState<Record<string, boolean>>({});

  const loadWarehousePage = useCallback(async (warehouseId: string, targetPage: number) => {
    try {
      const data = await fetchWarehouseInventoryPage(warehouseId, targetPage, 20);
      setWarehouseSkus(curr => {
        const newItems = data.warehouseSkus.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });
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
      setWarehouseItemStocks(curr => {
        const newItems = data.warehouseItemStocks.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });
      setWarehouseItemStockAdjustments(curr => {
        const newItems = data.warehouseItemStockAdjustments.filter(s => !curr.some(c => c.id === s.id));
        return [...curr, ...newItems];
      });

      setWarehousePages(curr => ({ ...curr, [warehouseId]: targetPage }));
      setWarehouseHasMore(curr => ({ ...curr, [warehouseId]: data.hasMore }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "加载仓库数据失败"));
    }
  }, []);

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

        if (active) {
          setWarehouses(nextWarehouses);
          setLogisticsMethods(nextLogisticsMethods);
          setWarehouseLogisticsMethods(nextWarehouseLogisticsMethods);

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
      if (warehousePages[warehouse.id] === undefined) {
        setWarehousePages(curr => ({ ...curr, [warehouse.id]: 1 }));
        void loadWarehousePage(warehouse.id, 1);
      }
    }
  }, [visibleWarehouses, warehousePages, loadWarehousePage]);


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

    const confirmed = window.confirm(`确认删除仓库“${warehouse.name}”吗？`);
    if (!confirmed) return;

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
    const confirmed = window.confirm(
      `确认从仓库中删除商品编号“${product?.product_code ?? ""}”吗？`,
    );
    if (!confirmed) return;

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

  async function handleSaveItemStock(item: WarehouseItemStock) {
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
    setBusyKey(`item-stock-${item.id}`);
    setErrorMessage("");
    try {
      const { item: nextItem, adjustment } = await updateWarehouseItemStock(
        item,
        nextStock,
        reason,
      );
      setWarehouseItemStocks((current) =>
        current.map((entry) => (entry.id === item.id ? nextItem : entry)),
      );
      setWarehouseItemStockAdjustments((current) => [adjustment, ...current]);
      setItemStockDrafts((current) => ({
        ...current,
        [item.id]: String(nextItem.stock_quantity),
      }));
      setItemStockReasonDrafts((current) => ({ ...current, [item.id]: "" }));
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "更新库存失败"));
    } finally {
      setBusyKey("");
    }
  }

  function getSkuAvailableStock(warehouseId: string, sku?: ProductSku) {
    if (!sku || sku.component_links.length === 0) return 0;

    const possibleStocks = sku.component_links.flatMap((link) => {
      if (link.quantity <= 0) return [];
      const itemStock = warehouseItemStocksByKey[`${warehouseId}:${link.item_id}`];
      return [Math.floor((itemStock?.stock_quantity ?? 0) / link.quantity)];
    });

    return possibleStocks.length > 0 ? Math.min(...possibleStocks) : 0;
  }

  return (
    <section className="grid gap-5">
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
        <section className="surface-card p-3">
          <div className="flex flex-wrap gap-2">
            <Link
              to="/inventory"
              className={`inline-flex h-10 items-center rounded-md border px-4 text-sm font-semibold transition ${
                !warehouseSlug
                  ? "border-sky-200 bg-sky-50 text-sky-700"
                  : "border-line bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              全部
            </Link>
            {warehouses.map((warehouse) => {
              const isActive = routeWarehouse?.id === warehouse.id;
              return (
                <Link
                  key={warehouse.id}
                  to={`/inventory/${getWarehouseRouteSlug(warehouse)}`}
                  className={`inline-flex h-10 items-center rounded-md border px-4 text-sm font-semibold transition ${
                    isActive
                      ? "border-sky-200 bg-sky-50 text-sky-700"
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

      {canEdit && (
        <section className="surface-card grid gap-4 p-5">
          <h2 className="text-base font-semibold text-ink">新增仓库</h2>
          <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
            <input
              value={draftWarehouseName}
              onChange={(event) => setDraftWarehouseName(event.target.value)}
              placeholder="仓库名称"
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={() => void handleCreateWarehouse()}
              disabled={!draftWarehouseName.trim() || busyKey === "create-warehouse"}
              className="btn-primary"
            >
              <Plus size={18} />
              增加仓库
            </button>
          </div>
        </section>
      )}

      {canEdit && (
        <section className="surface-card grid gap-4 p-5">
          <h2 className="text-base font-semibold text-ink">发货方式选项</h2>
          <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
            <input
              value={draftLogisticsMethodName}
              onChange={(event) => setDraftLogisticsMethodName(event.target.value)}
              placeholder="发货方式名称"
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={() => void handleCreateLogisticsMethod()}
              disabled={
                !draftLogisticsMethodName.trim() ||
                busyKey === "create-logistics-method"
              }
              className="btn-primary"
            >
              <Plus size={18} />
              增加发货方式
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeLogisticsMethods.length === 0 ? (
              <span className="text-sm text-slate-500">暂无发货方式</span>
            ) : (
              activeLogisticsMethods.map((method) => (
                <span
                  key={method.id}
                  className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600"
                >
                  {method.name}
                </span>
              ))
            )}
          </div>
        </section>
      )}

      {canEdit && (
        <section className="surface-card flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">库存调拨</h2>
            <p className="mt-1 text-sm text-slate-500">
              调拨多个 SKU、填写调拨日期，并查看调拨记录。
            </p>
          </div>
          <Link to="/inventory/transfer" className="btn-primary">
            <Plus size={18} />
            去库存调拨
          </Link>
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
          {visibleWarehouses.map((warehouse) => {
            const items = warehouseSkusByWarehouseId[warehouse.id] ?? [];
            const assignedProductIds = new Set(items.map((item) => item.product_id));
            const sortedItems = sortedWarehouseSkusByWarehouseId[warehouse.id] ?? [];

            return (
              <section key={warehouse.id} className="surface-card grid gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)]">
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
                          void handleUpdateWarehouse(warehouse, {
                            name: nextName,
                          });
                        }
                      }}
                      className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteWarehouse(warehouse)}
                      disabled={busyKey === `warehouse-${warehouse.id}`}
                      className="btn-danger"
                    >
                      <Trash2 size={18} />
                      删除仓库
                    </button>
                  )}
                </div>

                <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-sm font-semibold text-slate-700">
                    可用发货方式
                  </div>
                  {activeLogisticsMethods.length === 0 ? (
                    <div className="text-sm text-slate-500">暂无发货方式</div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {activeLogisticsMethods.map((method) => {
                        const methodIds =
                          warehouseLogisticsMethodIdsByWarehouseId[warehouse.id] ?? [];
                        const checked = methodIds.includes(method.id);
                        return (
                          <label
                            key={method.id}
                            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700"
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
                                  method,
                                  event.target.checked,
                                )
                              }
                              className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                            />
                            {method.name}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {canEdit && (
                  <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">

                    <div className="flex-1">
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
                      className="btn-secondary"
                    >
                      <Plus size={18} />
                      增加商品编号
                    </button>
                  </div>
                )}

                {warehousePages[warehouse.id] === undefined ? (
                  <div className="flex justify-center p-8">
                    <button
                      type="button"
                      onClick={() => {
                        setWarehousePages(curr => ({ ...curr, [warehouse.id]: 1 }));
                        void loadWarehousePage(warehouse.id, 1);
                      }}
                      className="rounded-full border border-line bg-white px-6 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                    >
                      加载此仓库库存
                    </button>
                  </div>
                ) : (
                  <div className="table-card shadow-none">
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="px-4 py-3 font-medium">商品编号</th>
                          <th className="product-name-col px-4 py-3 font-medium">产品名称</th>
                          <th className="px-4 py-3 font-medium">SKU编号</th>
                          <th className="px-4 py-3 font-medium">销售规格</th>
                          <th className="px-4 py-3 font-medium">SKU库存</th>
                          <th className="px-4 py-3 font-medium">查看配件</th>
                          <th className="px-4 py-3 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedItems.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                              暂无商品
                            </td>
                          </tr>
                        ) : (
                          sortedItems.map((item) => {
                            const product = productsById[item.product_id];
                            const sku = skusById[item.sku_id];
                            return (
                              <Fragment key={item.id}>
                                <tr>
                                  <td className="px-4 py-3">{product?.product_code ?? "--"}</td>
                                  <td className="product-name-col px-4 py-3">{product?.product_name_cn ?? "--"}</td>
                                  <td className="px-4 py-3">{getSkuDisplayCode(sku)}</td>
                                  <td className="px-4 py-3">
                                    {sku && Object.keys(sku.attributes).length > 0 ? (
                                      <div className="grid gap-1">
                                        {Object.entries(sku.attributes).map(([name, value]) => (
                                          <span key={name}>
                                            {name}：{value}
                                          </span>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-slate-500">无规格</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 font-medium">
                                    {getSkuAvailableStock(warehouse.id, sku)}
                                  </td>
                                  <td className="px-4 py-3">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedSkuIds((current) => ({
                                          ...current,
                                          [item.id]: !current[item.id],
                                        }))
                                      }
                                      className="btn-secondary h-10 px-3"
                                    >
                                      {expandedSkuIds[item.id] ? (
                                        <ChevronUp size={16} />
                                      ) : (
                                        <ChevronDown size={16} />
                                      )}
                                      查看配件
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
                                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                                        aria-label={`删除商品编号 ${product?.product_code ?? ""}`}
                                        title="删除商品编号"
                                      >
                                        <Trash2 size={16} />
                                      </button>
                                    )}
                                  </td>
                                </tr>
                                {expandedSkuIds[item.id] && (
                                  <tr className="is-selected border-t border-line">
                                    <td colSpan={7} className="px-4 py-4">
                                      <div className="overflow-hidden rounded-md border border-line bg-white">
                                        <table className="data-table">
                                          <thead>
                                            <tr>
                                              <th className="px-4 py-3 font-medium">配件名称</th>
                                              <th className="px-4 py-3 font-medium">配件规格</th>
                                              <th className="px-4 py-3 font-medium">SKU用量</th>
                                              <th className="px-4 py-3 font-medium">配件库存</th>
                                              <th className="px-4 py-3 font-medium">编辑原因</th>
                                              <th className="px-4 py-3 font-medium">编辑记录</th>
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
                                                return (
                                                  <tr key={link.item_id} className="border-t border-line">
                                                    <td className="px-4 py-3">
                                                      {component?.item_name ?? "--"}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                      {component?.item_spec || "--"}
                                                    </td>
                                                    <td className="px-4 py-3">{link.quantity}</td>
                                                    <td className="px-4 py-3">
                                                      {itemStock ? (
                                                        <div className="flex items-center gap-2">
                                                          <input
                                                            step="1"
                                                            type="number"
                                                            placeholder="+/- 调整"
                                                            disabled={!canEdit}
                                                            value={
                                                              itemStockDrafts[itemStock.id] ??
                                                              String(itemStock.stock_quantity)
                                                            }
                                                            onChange={(event) =>
                                                              setItemStockDrafts((current) => ({
                                                                ...current,
                                                                [itemStock.id]: event.target.value,
                                                              }))
                                                            }
                                                            className="h-10 w-28 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                                                          />
                                                          {canEdit && (
                                                            <button
                                                              type="button"
                                                              onClick={() =>
                                                                void handleSaveItemStock(itemStock)
                                                              }
                                                              disabled={
                                                                busyKey ===
                                                                  `item-stock-${itemStock.id}` ||
                                                                !itemStockReasonDrafts[
                                                                  itemStock.id
                                                                ]?.trim()
                                                              }
                                                              className="h-10 rounded-md bg-ink px-3 text-sm text-white disabled:opacity-60"
                                                            >
                                                              保存
                                                            </button>
                                                          )}
                                                        </div>
                                                      ) : (
                                                        <span className="text-slate-500">0</span>
                                                      )}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                      {itemStock ? (
                                                        <input
                                                          value={
                                                            itemStockReasonDrafts[itemStock.id] ?? ""
                                                          }
                                                          disabled={!canEdit}
                                                          onChange={(event) =>
                                                            setItemStockReasonDrafts((current) => ({
                                                              ...current,
                                                              [itemStock.id]: event.target.value,
                                                            }))
                                                          }
                                                          placeholder="填写编辑原因"
                                                          className="h-10 min-w-40 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                                                        />
                                                      ) : (
                                                        <span className="text-slate-500">--</span>
                                                      )}
                                                    </td>
                                                    <td className="px-4 py-3 align-top">
                                                      {itemStock ? (
                                                        <div className="grid min-w-56 gap-2 text-xs text-slate-600">
                                                          {(
                                                            warehouseItemStockAdjustmentsByKey[
                                                              `${warehouse.id}:${link.item_id}`
                                                            ] ?? []
                                                          )
                                                            .slice(0, 3)
                                                            .map((adjustment) => (
                                                              <div
                                                                key={adjustment.id}
                                                                className="rounded-md bg-slate-50 px-2 py-1.5"
                                                              >
                                                                <div>
                                                                  {adjustment.previous_quantity} →{" "}
                                                                  {adjustment.next_quantity}
                                                                  （
                                                                  {adjustment.change_quantity > 0
                                                                    ? "+"
                                                                    : ""}
                                                                  {adjustment.change_quantity}）
                                                                </div>
                                                                <div className="mt-1 text-slate-500">
                                                                  {adjustment.reason}
                                                                </div>
                                                              </div>
                                                            ))}
                                                          {(
                                                            warehouseItemStockAdjustmentsByKey[
                                                              `${warehouse.id}:${link.item_id}`
                                                            ] ?? []
                                                          ).length === 0 && (
                                                            <span className="text-slate-500">
                                                              暂无记录
                                                            </span>
                                                          )}
                                                        </div>
                                                      ) : (
                                                        <span className="text-slate-500">--</span>
                                                      )}
                                                    </td>
                                                  </tr>
                                                );
                                              })
                                            ) : (
                                              <tr>
                                                <td
                                                  colSpan={6}
                                                  className="px-4 py-6 text-center text-slate-500"
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
                    </table>
                  </div>
                </div>
                )}
                {warehousePages[warehouse.id] !== undefined && warehouseHasMore[warehouse.id] && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadWarehousePage(warehouse.id, (warehousePages[warehouse.id] ?? 1) + 1)}
                      className="rounded-full border border-line bg-white px-6 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                    >
                      加载更多商品
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
