import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, useParams } from "react-router-dom";
import {
  addWarehouseProductInventory,
  createWarehouse,
  deleteWarehouse,
  fetchWarehouseItemStockAdjustments,
  fetchWarehouseItemStocks,
  fetchWarehouseSkus,
  fetchWarehouses,
  removeWarehouseProduct,
  updateWarehouse,
  updateWarehouseItemStock,
} from "../lib/inventory";
import {
  fetchProductItemsByProductIds,
  fetchProductSkusByProductIds,
  fetchProducts,
} from "../lib/products";
import type {
  Product,
  ProductItem,
  ProductSku,
  Warehouse,
  WarehouseItemStock,
  WarehouseItemStockAdjustment,
  WarehouseSku,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { PageHeader } from "../components/ui";
import { readDraft, useDraftPersistence } from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";

type InventoryPageProps = {
  user: User;
};

type InventoryDraft = {
  draftWarehouseName: string;
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
      Object.values(draft.selectedProductIds).some(Boolean) ||
      Object.values(draft.itemStockReasonDrafts).some((value) => value.trim()) ||
      Object.values(draft.warehouseNameDrafts).some((value) => value.trim()) ||
      Object.entries(draft.itemStockDrafts).some(
        ([itemId, value]) => stockValuesById[itemId] !== undefined && value !== stockValuesById[itemId],
      ),
  );
}

function getInventoryErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error, fallback);
  return message.includes("public.warehouses") ||
    message.includes("public.warehouse_skus") ||
    message.includes("public.warehouse_item_stocks") ||
    message.includes("public.warehouse_item_stock_adjustments")
    ? "库存数据库还没有初始化，请先执行最新的库存表迁移"
    : message;
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
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [warehouseItemStockAdjustments, setWarehouseItemStockAdjustments] = useState<
    WarehouseItemStockAdjustment[]
  >([]);
  const [draftWarehouseName, setDraftWarehouseName] = useState(restoredDraft?.draftWarehouseName ?? "");
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

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const [nextProducts, nextWarehouses] = await Promise.all([
          fetchProducts(),
          fetchWarehouses(),
        ]);
        const [
          nextItems,
          nextSkus,
          nextWarehouseSkus,
          nextWarehouseItemStocks,
          nextWarehouseItemStockAdjustments,
        ] =
          await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchWarehouseSkus(nextWarehouses.map((warehouse) => warehouse.id)),
          fetchWarehouseItemStocks(nextWarehouses.map((warehouse) => warehouse.id)),
          fetchWarehouseItemStockAdjustments(nextWarehouses.map((warehouse) => warehouse.id)),
        ]);

        if (active) {
          setProducts(nextProducts);
          setProductItems(nextItems);
          setSkus(nextSkus);
          setWarehouses(nextWarehouses);
          setWarehouseSkus(nextWarehouseSkus);
          setWarehouseItemStocks(nextWarehouseItemStocks);
          setWarehouseItemStockAdjustments(nextWarehouseItemStockAdjustments);
          const latestDraft = readDraft<InventoryDraft>(draftKey);
          const serverStockValues = Object.fromEntries(
            nextWarehouseItemStocks.map((item) => [item.id, String(item.stock_quantity)]),
          );
          setItemStockDrafts({
            ...serverStockValues,
            ...(latestDraft?.itemStockDrafts ?? {}),
          });
          setItemStockReasonDrafts(latestDraft?.itemStockReasonDrafts ?? {});
          setSelectedProductIds(latestDraft?.selectedProductIds ?? {});
          setWarehouseNameDrafts(latestDraft?.warehouseNameDrafts ?? {});
          setDraftWarehouseName(latestDraft?.draftWarehouseName ?? "");
          if (hasInventoryDraft(latestDraft, serverStockValues)) {
            setDraftNotice("已恢复上次未保存的库存编辑草稿。");
          }
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getInventoryErrorMessage(error, "加载库存失败"));
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

  const inventoryDraftValue = useMemo<InventoryDraft>(
    () => ({
      draftWarehouseName,
      selectedProductIds,
      itemStockDrafts,
      itemStockReasonDrafts,
      warehouseNameDrafts,
    }),
    [
      draftWarehouseName,
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

  function getSkuDisplayCode(sku?: ProductSku) {
    if (!sku?.id) return "--";
    return skuDisplayCodesById[sku.id] || sku.sku_code || "--";
  }

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
      skuDisplayCodesById,
      skusById,
      warehouseSkusByWarehouseId,
    ],
  );

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
    const productSkuIds = (skusByProductId[productId] ?? []).flatMap((sku) =>
      sku.id ? [sku.id] : [],
    );
    const productItemIds = itemIdsByProductId[productId] ?? [];

    setBusyKey(`add-product-${warehouseId}`);
    setErrorMessage("");
    try {
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

    const nextStock = Math.max(0, Number(itemStockDrafts[item.id] || 0));
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

                {canEdit && (
                  <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
                    <select
                      value={selectedProductIds[warehouse.id] ?? ""}
                      onChange={(event) =>
                        setSelectedProductIds((current) => ({
                          ...current,
                          [warehouse.id]: event.target.value,
                        }))
                      }
                      className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                    >
                      <option value="">选择商品编号</option>
                      {sortedProducts.map((product) => {
                        const isAssigned = assignedProductIds.has(product.id);
                        return (
                        <option key={product.id} value={product.id} disabled={isAssigned}>
                          {product.product_code} · {product.product_name_cn}
                          {isAssigned ? "（已在仓库）" : ""}
                        </option>
                        );
                      })}
                    </select>
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
                                                            min="0"
                                                            step="1"
                                                            type="number"
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
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
