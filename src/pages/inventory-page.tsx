import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
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
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";

type InventoryPageProps = {
  user: User;
};

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
  const { canEdit, canDelete } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [skus, setSkus] = useState<ProductSku[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [warehouseItemStockAdjustments, setWarehouseItemStockAdjustments] = useState<
    WarehouseItemStockAdjustment[]
  >([]);
  const [draftWarehouseName, setDraftWarehouseName] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Record<string, string>>({});
  const [itemStockDrafts, setItemStockDrafts] = useState<Record<string, string>>({});
  const [itemStockReasonDrafts, setItemStockReasonDrafts] = useState<Record<string, string>>({});
  const [expandedSkuIds, setExpandedSkuIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

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
          setItemStockDrafts(
            Object.fromEntries(
              nextWarehouseItemStocks.map((item) => [item.id, String(item.stock_quantity)]),
            ),
          );
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
  }, [user.id]);

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

  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>((groups, sku) => {
    if (!sku.product_id) return groups;
    groups[sku.product_id] ??= [];
    groups[sku.product_id].push(sku);
    return groups;
  }, {});

  const warehouseSkusByWarehouseId = warehouseSkus.reduce<
    Record<string, WarehouseSku[]>
  >((groups, item) => {
    groups[item.warehouse_id] ??= [];
    groups[item.warehouse_id].push(item);
    return groups;
  }, {});

  const warehouseItemStocksByKey = useMemo(
    () =>
      Object.fromEntries(
        warehouseItemStocks.map((item) => [`${item.warehouse_id}:${item.item_id}`, item]),
      ),
    [warehouseItemStocks],
  );

  const warehouseItemStockAdjustmentsByKey = warehouseItemStockAdjustments.reduce<
    Record<string, WarehouseItemStockAdjustment[]>
  >((groups, adjustment) => {
    const key = `${adjustment.warehouse_id}:${adjustment.item_id}`;
    groups[key] ??= [];
    groups[key].push(adjustment);
    return groups;
  }, {});

  const itemIdsByProductId = productItems.reduce<Record<string, string[]>>((groups, item) => {
    if (!item.product_id || !item.id) return groups;
    groups[item.product_id] ??= [];
    groups[item.product_id].push(item.id);
    return groups;
  }, {});

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
      <PageHeader title="仓储库存" description="按仓库查看 SKU 与配件库存" />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
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

      {loading ? (
        <div className="text-sm text-slate-500">加载中...</div>
      ) : warehouses.length === 0 ? (
        <div className="empty-state">
          暂无仓库
        </div>
      ) : (
        <div className="grid gap-5">
          {warehouses.map((warehouse) => {
            const items = warehouseSkusByWarehouseId[warehouse.id] ?? [];
            const assignedProductIds = new Set(items.map((item) => item.product_id));
            const availableProducts = products.filter(
              (product) => !assignedProductIds.has(product.id),
            );

            return (
              <section key={warehouse.id} className="surface-card grid gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)]">
                    <input
                      value={warehouse.name}
                      readOnly={!canEdit}
                      onChange={(event) =>
                        setWarehouses((current) =>
                          current.map((item) =>
                            item.id === warehouse.id
                              ? { ...item, name: event.target.value }
                              : item,
                          ),
                        )
                      }
                      onBlur={() => {
                        if (canEdit) {
                          void handleUpdateWarehouse(warehouse, {
                            name: warehouse.name.trim() || warehouse.name,
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
                      {availableProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.product_code} · {product.product_name_cn}
                        </option>
                      ))}
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
                          <th className="px-4 py-3 font-medium">产品名称</th>
                          <th className="px-4 py-3 font-medium">SKU 编号</th>
                          <th className="px-4 py-3 font-medium">销售规格</th>
                          <th className="px-4 py-3 font-medium">SKU 库存</th>
                          <th className="px-4 py-3 font-medium">查看配件</th>
                          <th className="px-4 py-3 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                              暂无商品
                            </td>
                          </tr>
                        ) : (
                          items.map((item) => {
                            const product = productsById[item.product_id];
                            const sku = skusById[item.sku_id];
                            return (
                              <Fragment key={item.id}>
                                <tr>
                                  <td className="px-4 py-3">{product?.product_code ?? "--"}</td>
                                  <td className="px-4 py-3">{product?.product_name_cn ?? "--"}</td>
                                  <td className="px-4 py-3">{sku?.sku_code ?? "--"}</td>
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
                                  <tr className="border-t border-line bg-slate-50/60">
                                    <td colSpan={7} className="px-4 py-4">
                                      <div className="overflow-hidden rounded-md border border-line bg-white">
                                        <table className="min-w-full text-left text-sm">
                                          <thead className="bg-slate-50 text-slate-500">
                                            <tr>
                                              <th className="px-4 py-3 font-medium">配件名称</th>
                                              <th className="px-4 py-3 font-medium">配件规格</th>
                                              <th className="px-4 py-3 font-medium">单个 SKU 用量</th>
                                              <th className="px-4 py-3 font-medium">仓库配件库存</th>
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
