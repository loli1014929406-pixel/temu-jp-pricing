import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link } from "react-router-dom";
import {
  fetchWarehouseItemStockAdjustments,
  fetchWarehouseItemStocks,
  fetchWarehouseSkus,
  fetchWarehouses,
  transferWarehouseInventory,
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
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";
import { getErrorMessage } from "../utils/errors";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";

type InventoryTransferPageProps = {
  user: User;
};

type TransferSkuLineDraft = {
  skuId: string;
  quantity: string;
};

type TransferAdjustmentEntry = {
  adjustment: WarehouseItemStockAdjustment;
  direction: "out" | "in";
};

type TransferRecord = {
  key: string;
  createdAt: string;
  transferDate: string;
  sourceWarehouseName: string;
  destinationWarehouseName: string;
  trackingNo: string;
  skuSummary: string;
  adjustments: TransferAdjustmentEntry[];
};

function getTodayInputValue() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
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

function getTransferReasonInfo(reason: string) {
  const outPrefix = "库存调拨出库：";
  const inPrefix = "库存调拨入库：";

  if (reason.startsWith(outPrefix)) {
    return { direction: "out" as const, detail: reason.slice(outPrefix.length) };
  }
  if (reason.startsWith(inPrefix)) {
    return { direction: "in" as const, detail: reason.slice(inPrefix.length) };
  }
  return null;
}

function parseTransferReasonDetail(detail: string, fallbackDate: string) {
  const parts = detail
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean);
  const route = parts[0] ?? "";
  const [sourceWarehouseName = "--", destinationWarehouseName = "--"] = route
    .split(" -> ")
    .map((part) => part.trim());
  const transferDate =
    parts.find((part) => part.startsWith("调拨日期："))?.replace("调拨日期：", "").trim() ||
    fallbackDate;
  const trackingNo =
    parts.find((part) => part.startsWith("快递单号："))?.replace("快递单号：", "").trim() ||
    "--";
  const skuSummary =
    parts
      .slice(1)
      .filter(
        (part) =>
          !part.startsWith("调拨日期：") && !part.startsWith("快递单号："),
      )
      .join(" / ") || "--";

  return {
    sourceWarehouseName,
    destinationWarehouseName,
    transferDate,
    trackingNo,
    skuSummary,
  };
}

function formatDateTime(value: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function InventoryTransferPage({ user: _user }: InventoryTransferPageProps) {
  void _user;
  const { canEdit } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [skus, setSkus] = useState<ProductSku[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [warehouseItemStocks, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
  const [warehouseItemStockAdjustments, setWarehouseItemStockAdjustments] = useState<
    WarehouseItemStockAdjustment[]
  >([]);
  const [transferSourceWarehouseId, setTransferSourceWarehouseId] = useState("");
  const [transferDestinationWarehouseId, setTransferDestinationWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState(getTodayInputValue());
  const [transferTrackingNo, setTransferTrackingNo] = useState("");
  const [transferSkuId, setTransferSkuId] = useState("");
  const [transferQuantity, setTransferQuantity] = useState("1");
  const [transferSkuLines, setTransferSkuLines] = useState<TransferSkuLineDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const productCodeCollator = useMemo(
    () => new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }),
    [],
  );

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
        const warehouseIds = nextWarehouses.map((warehouse) => warehouse.id);
        const [
          nextItems,
          nextSkus,
          nextWarehouseSkus,
          nextWarehouseItemStocks,
          nextWarehouseItemStockAdjustments,
        ] = await Promise.all([
          fetchProductItemsByProductIds(nextProducts.map((product) => product.id)),
          fetchProductSkusByProductIds(nextProducts.map((product) => product.id)),
          fetchWarehouseSkus(warehouseIds),
          fetchWarehouseItemStocks(warehouseIds),
          fetchWarehouseItemStockAdjustments(warehouseIds),
        ]);

        if (!active) return;
        setProducts(nextProducts);
        setProductItems(nextItems);
        setSkus(nextSkus);
        setWarehouses(nextWarehouses);
        setWarehouseSkus(nextWarehouseSkus);
        setWarehouseItemStocks(nextWarehouseItemStocks);
        setWarehouseItemStockAdjustments(nextWarehouseItemStockAdjustments);
        setTransferSourceWarehouseId((current) =>
          current && nextWarehouses.some((warehouse) => warehouse.id === current)
            ? current
            : nextWarehouses[0]?.id ?? "",
        );
        setTransferDestinationWarehouseId((current) =>
          current && nextWarehouses.some((warehouse) => warehouse.id === current)
            ? current
            : nextWarehouses[1]?.id ?? "",
        );
      } catch (error) {
        if (active) {
          setErrorMessage(getInventoryErrorMessage(error, "加载库存调拨失败"));
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
  }, []);

  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  const productItemsById = useMemo(
    () =>
      Object.fromEntries(
        productItems.flatMap((item) => (item.id ? [[item.id, item]] : [])),
      ),
    [productItems],
  );

  const skusById = useMemo(
    () => Object.fromEntries(skus.flatMap((sku) => (sku.id ? [[sku.id, sku]] : []))),
    [skus],
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

  const warehousesById = useMemo(
    () => Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, warehouse])),
    [warehouses],
  );

  const warehouseItemStocksByKey = useMemo(
    () =>
      Object.fromEntries(
        warehouseItemStocks.map((item) => [`${item.warehouse_id}:${item.item_id}`, item]),
      ),
    [warehouseItemStocks],
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
            return productCodeCollator.compare(rightSkuCode, leftSkuCode);
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

  function getSkuAvailableStock(warehouseId: string, sku?: ProductSku) {
    if (!sku || sku.component_links.length === 0) return 0;

    const possibleStocks = sku.component_links.flatMap((link) => {
      if (link.quantity <= 0) return [];
      const itemStock = warehouseItemStocksByKey[`${warehouseId}:${link.item_id}`];
      return [Math.floor((itemStock?.stock_quantity ?? 0) / link.quantity)];
    });

    return possibleStocks.length > 0 ? Math.min(...possibleStocks) : 0;
  }

  function handleTransferSourceWarehouseChange(warehouseId: string) {
    setTransferSourceWarehouseId(warehouseId);
    setTransferSkuId("");
    setTransferQuantity("1");
    setTransferSkuLines([]);
    setTransferDestinationWarehouseId((current) =>
      current && current !== warehouseId
        ? current
        : warehouses.find((warehouse) => warehouse.id !== warehouseId)?.id ?? "",
    );
  }

  const transferSourceWarehouse = warehouses.find(
    (warehouse) => warehouse.id === transferSourceWarehouseId,
  );
  const transferDestinationWarehouse = warehouses.find(
    (warehouse) => warehouse.id === transferDestinationWarehouseId,
  );
  const transferSkuOptions = transferSourceWarehouseId
    ? sortedWarehouseSkusByWarehouseId[transferSourceWarehouseId] ?? []
    : [];
  const selectedTransferWarehouseSku = transferSkuOptions.find(
    (item) => item.sku_id === transferSkuId,
  );
  const selectedTransferSku = transferSkuId ? skusById[transferSkuId] : undefined;
  const selectedTransferProduct = selectedTransferWarehouseSku
    ? productsById[selectedTransferWarehouseSku.product_id]
    : undefined;
  const selectedTransferAvailableQuantity =
    transferSourceWarehouse && selectedTransferSku
      ? getSkuAvailableStock(transferSourceWarehouse.id, selectedTransferSku)
      : 0;
  const selectedTransferQuantity = Math.trunc(Number(transferQuantity) || 0);
  const transferSkuLineDetails = transferSkuLines.flatMap((line) => {
    const warehouseSku = transferSkuOptions.find((item) => item.sku_id === line.skuId);
    const sku = skusById[line.skuId];
    const product = warehouseSku ? productsById[warehouseSku.product_id] : undefined;
    if (!warehouseSku || !sku || !product) return [];

    const quantity = Math.trunc(Number(line.quantity) || 0);
    const availableQuantity = transferSourceWarehouse
      ? getSkuAvailableStock(transferSourceWarehouse.id, sku)
      : 0;
    const skuLabel = `${product.product_code} ${getSkuDisplayCode(sku)}`.trim();
    return [
      {
        warehouseSku,
        sku,
        product,
        skuLabel,
        quantity,
        availableQuantity,
        draft: line,
      },
    ];
  });

  const canAddTransferLine =
    canEdit &&
    Boolean(
      selectedTransferWarehouseSku &&
        selectedTransferSku &&
        selectedTransferProduct &&
        selectedTransferQuantity > 0 &&
        selectedTransferAvailableQuantity >=
          selectedTransferQuantity +
            transferSkuLines
              .filter((line) => line.skuId === transferSkuId)
              .reduce((total, line) => total + Math.trunc(Number(line.quantity) || 0), 0),
    );

  const canSubmitTransfer =
    canEdit &&
    Boolean(
      transferSourceWarehouse &&
        transferDestinationWarehouse &&
        transferSourceWarehouse.id !== transferDestinationWarehouse.id &&
        transferSkuLineDetails.length > 0 &&
        transferSkuLineDetails.length === transferSkuLines.length &&
        transferDate &&
        transferTrackingNo.trim() &&
        transferSkuLineDetails.every(
          (line) =>
            line.quantity > 0 &&
            line.availableQuantity >= line.quantity &&
            line.sku.component_links.length > 0,
        ),
    );

  const transferRecords = useMemo(() => {
    const recordsByKey = new Map<string, TransferRecord>();

    warehouseItemStockAdjustments.forEach((adjustment) => {
      const reasonInfo = getTransferReasonInfo(adjustment.reason);
      if (!reasonInfo) return;

      const createdAt = adjustment.created_at || "";
      const fallbackDate = createdAt.slice(0, 10) || "--";
      const detail = parseTransferReasonDetail(reasonInfo.detail, fallbackDate);
      const existing = recordsByKey.get(reasonInfo.detail);
      const record =
        existing ??
        ({
          key: reasonInfo.detail,
          createdAt,
          ...detail,
          adjustments: [],
        } satisfies TransferRecord);

      if (createdAt && (!record.createdAt || createdAt > record.createdAt)) {
        record.createdAt = createdAt;
      }
      record.adjustments.push({
        adjustment,
        direction: reasonInfo.direction,
      });
      recordsByKey.set(reasonInfo.detail, record);
    });

    return Array.from(recordsByKey.values()).sort((left, right) => {
      const byTransferDate = right.transferDate.localeCompare(left.transferDate);
      if (byTransferDate !== 0) return byTransferDate;
      return right.createdAt.localeCompare(left.createdAt);
    });
  }, [warehouseItemStockAdjustments]);

  function handleAddTransferSkuLine() {
    const sku = skusById[transferSkuId];
    const quantity = Math.trunc(Number(transferQuantity) || 0);
    if (!transferSourceWarehouseId || !sku) {
      setErrorMessage("请选择要调拨的 SKU。");
      return;
    }
    if (quantity <= 0) {
      setErrorMessage("请输入要添加的 SKU 数量。");
      return;
    }
    if (sku.component_links.length === 0) {
      setErrorMessage("该 SKU 没有维护配件组成，不能调拨库存。");
      return;
    }

    const existingQuantity = transferSkuLines
      .filter((line) => line.skuId === transferSkuId)
      .reduce((total, line) => total + Math.trunc(Number(line.quantity) || 0), 0);
    const availableQuantity = getSkuAvailableStock(transferSourceWarehouseId, sku);
    const nextQuantity = existingQuantity + quantity;
    if (availableQuantity < nextQuantity) {
      setErrorMessage(`调出仓库 SKU 库存不足：当前 ${availableQuantity}，需要 ${nextQuantity}。`);
      return;
    }

    setErrorMessage("");
    setSuccessMessage("");
    setTransferSkuLines((current) => {
      const existingLine = current.find((line) => line.skuId === transferSkuId);
      if (existingLine) {
        return current.map((line) =>
          line.skuId === transferSkuId
            ? { ...line, quantity: String(nextQuantity) }
            : line,
        );
      }
      return [...current, { skuId: transferSkuId, quantity: String(quantity) }];
    });
    setTransferSkuId("");
    setTransferQuantity("1");
  }

  function handleTransferLineQuantityChange(skuId: string, quantity: string) {
    setTransferSkuLines((current) =>
      current.map((line) => (line.skuId === skuId ? { ...line, quantity } : line)),
    );
  }

  function handleRemoveTransferSkuLine(skuId: string) {
    setTransferSkuLines((current) => current.filter((line) => line.skuId !== skuId));
  }

  function mergeWarehouseSkus(nextRows: WarehouseSku[]) {
    if (nextRows.length === 0) return;

    setWarehouseSkus((current) => {
      const rowsByKey = new Map(
        current.map((item) => [`${item.warehouse_id}:${item.sku_id}`, item]),
      );
      nextRows.forEach((item) => {
        rowsByKey.set(`${item.warehouse_id}:${item.sku_id}`, item);
      });
      return Array.from(rowsByKey.values());
    });
  }

  function mergeWarehouseItemStocks(nextRows: WarehouseItemStock[]) {
    if (nextRows.length === 0) return;

    setWarehouseItemStocks((current) => {
      const rowsByKey = new Map(
        current.map((item) => [`${item.warehouse_id}:${item.item_id}`, item]),
      );
      nextRows.forEach((item) => {
        rowsByKey.set(`${item.warehouse_id}:${item.item_id}`, item);
      });
      return Array.from(rowsByKey.values());
    });
  }

  async function handleTransferInventory() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能调拨库存。");
      return;
    }

    const sourceWarehouse = warehouses.find(
      (warehouse) => warehouse.id === transferSourceWarehouseId,
    );
    const destinationWarehouse = warehouses.find(
      (warehouse) => warehouse.id === transferDestinationWarehouseId,
    );
    const trackingNo = transferTrackingNo.trim();

    if (!sourceWarehouse || !destinationWarehouse) {
      setErrorMessage("请选择调出仓库和调入仓库。");
      return;
    }
    if (sourceWarehouse.id === destinationWarehouse.id) {
      setErrorMessage("调出仓库和调入仓库不能相同。");
      return;
    }
    if (transferSkuLineDetails.length === 0) {
      setErrorMessage("请至少添加一个要调拨的 SKU。");
      return;
    }
    if (transferSkuLineDetails.length !== transferSkuLines.length) {
      setErrorMessage("调拨明细中有无法识别的 SKU，请删除后重新添加。");
      return;
    }
    if (!transferDate) {
      setErrorMessage("请选择调拨日期。");
      return;
    }
    if (!trackingNo) {
      setErrorMessage("请填写调拨快递单号。");
      return;
    }
    const missingComponentLine = transferSkuLineDetails.find(
      (line) => line.sku.component_links.length === 0,
    );
    if (missingComponentLine) {
      setErrorMessage(`SKU ${missingComponentLine.skuLabel} 没有维护配件组成，不能调拨库存。`);
      return;
    }
    const invalidQuantityLine = transferSkuLineDetails.find((line) => line.quantity <= 0);
    if (invalidQuantityLine) {
      setErrorMessage(`SKU ${invalidQuantityLine.skuLabel} 的调拨数量需要大于 0。`);
      return;
    }
    const insufficientLine = transferSkuLineDetails.find(
      (line) => line.availableQuantity < line.quantity,
    );
    if (insufficientLine) {
      setErrorMessage(
        `SKU ${insufficientLine.skuLabel} 库存不足：当前 ${insufficientLine.availableQuantity}，需要 ${insufficientLine.quantity}。`,
      );
      return;
    }

    setBusyKey("transfer-inventory");
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const result = await transferWarehouseInventory({
        sourceWarehouseId: sourceWarehouse.id,
        destinationWarehouseId: destinationWarehouse.id,
        sourceWarehouseName: sourceWarehouse.name,
        destinationWarehouseName: destinationWarehouse.name,
        transferDate,
        trackingNo,
        lines: transferSkuLineDetails.map((line) => ({
          productId: line.product.id,
          skuId: line.sku.id || line.warehouseSku.sku_id,
          skuLabel: line.skuLabel,
          quantity: line.quantity,
          items: line.sku.component_links.map((link) => ({
            itemId: link.item_id,
            quantity: link.quantity * line.quantity,
          })),
        })),
      });

      mergeWarehouseSkus(result.warehouseSkus);
      mergeWarehouseItemStocks(result.itemStocks);
      setWarehouseItemStockAdjustments((current) => [
        ...result.adjustments,
        ...current,
      ]);
      setTransferQuantity("1");
      setTransferSkuId("");
      setTransferSkuLines([]);
      setTransferTrackingNo("");
      setSuccessMessage("库存调拨已保存。");
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "库存调拨失败"));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section className="grid gap-5">
      <PageHeader
        title="库存调拨"
        description="从一个仓库调拨多个 SKU 到另一个仓库，并记录调拨日期和快递单号"
        actions={
          <Link to="/inventory" className="btn-secondary">
            返回库存
          </Link>
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {successMessage}
        </div>
      )}

      <section className="surface-card grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">新增调拨</h2>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
            已选 {transferSkuLineDetails.length} 个 SKU
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>调出仓库</span>
            <select
              value={transferSourceWarehouseId}
              onChange={(event) => handleTransferSourceWarehouseChange(event.target.value)}
              disabled={!canEdit || loading}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            >
              <option value="">选择仓库</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>调入仓库</span>
            <select
              value={transferDestinationWarehouseId}
              onChange={(event) => setTransferDestinationWarehouseId(event.target.value)}
              disabled={!canEdit || loading}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            >
              <option value="">选择仓库</option>
              {warehouses.map((warehouse) => (
                <option
                  key={warehouse.id}
                  value={warehouse.id}
                  disabled={warehouse.id === transferSourceWarehouseId}
                >
                  {warehouse.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>调拨日期</span>
            <input
              type="date"
              value={transferDate}
              onChange={(event) => setTransferDate(event.target.value)}
              disabled={!canEdit || loading}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>快递单号</span>
            <input
              value={transferTrackingNo}
              onChange={(event) => setTransferTrackingNo(event.target.value)}
              disabled={!canEdit || loading}
              placeholder="调拨快递单号"
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_120px_auto]">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>SKU</span>
            <select
              value={transferSkuId}
              onChange={(event) => setTransferSkuId(event.target.value)}
              disabled={!canEdit || !transferSourceWarehouseId || loading}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            >
              <option value="">选择 SKU</option>
              {transferSkuOptions.map((item) => {
                const product = productsById[item.product_id];
                const sku = skusById[item.sku_id];
                const availableQuantity = getSkuAvailableStock(
                  transferSourceWarehouseId,
                  sku,
                );
                return (
                  <option key={item.id} value={item.sku_id}>
                    {product?.product_code ?? "--"} · {getSkuDisplayCode(sku)}
                    {" · 库存 "}
                    {availableQuantity}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            <span>数量</span>
            <input
              min="1"
              max={selectedTransferAvailableQuantity || undefined}
              step="1"
              type="number"
              value={transferQuantity}
              onChange={(event) => setTransferQuantity(event.target.value)}
              disabled={!canEdit || loading}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleAddTransferSkuLine}
              disabled={!canAddTransferLine || busyKey === "transfer-inventory"}
              className="btn-primary h-11 w-full xl:w-auto"
            >
              <Plus size={18} />
              添加SKU
            </button>
          </div>
        </div>
        {transferSkuLineDetails.length > 0 ? (
          <div className="table-card shadow-none">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left">SKU</th>
                    <th className="px-4 py-3 text-left">可调拨</th>
                    <th className="px-4 py-3 text-left">调拨数量</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {transferSkuLineDetails.map((line) => (
                    <tr key={line.draft.skuId}>
                      <td className="px-4 py-3 font-medium text-ink">
                        {line.skuLabel}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {line.availableQuantity}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          min="1"
                          max={line.availableQuantity || undefined}
                          step="1"
                          type="number"
                          value={line.draft.quantity}
                          onChange={(event) =>
                            handleTransferLineQuantityChange(
                              line.draft.skuId,
                              event.target.value,
                            )
                          }
                          disabled={!canEdit || loading}
                          className="h-10 w-28 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-slate-100"
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveTransferSkuLine(line.draft.skuId)}
                          disabled={!canEdit || loading}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-rose-200 bg-white text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
                          title="移除SKU"
                          aria-label={`移除 ${line.skuLabel}`}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-slate-500">
            暂无调拨 SKU
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleTransferInventory()}
            disabled={!canSubmitTransfer || busyKey === "transfer-inventory"}
            className="btn-primary h-11 w-full md:w-auto"
          >
            调拨库存
          </button>
        </div>
        {warehouses.length < 2 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
            请先新增目标仓库后再调拨库存。
          </div>
        )}
      </section>

      <section className="surface-card grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">调拨记录</h2>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">
            {transferRecords.length} 条记录
          </span>
        </div>
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : transferRecords.length === 0 ? (
          <div className="empty-state">暂无调拨记录</div>
        ) : (
          <div className="table-card shadow-none">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left">调拨日期</th>
                    <th className="px-4 py-3 text-left">调拨路线</th>
                    <th className="px-4 py-3 text-left">快递单号</th>
                    <th className="px-4 py-3 text-left">SKU</th>
                    <th className="px-4 py-3 text-left">调拨记录</th>
                  </tr>
                </thead>
                <tbody>
                  {transferRecords.map((record) => (
                    <tr key={record.key}>
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-ink">{record.transferDate}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {formatDateTime(record.createdAt)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-ink">
                          {record.sourceWarehouseName} → {record.destinationWarehouseName}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        {record.trackingNo}
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        {record.skuSummary}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="grid gap-1">
                          {record.adjustments.map(({ adjustment, direction }) => {
                            const warehouse = warehousesById[adjustment.warehouse_id];
                            const item = productItemsById[adjustment.item_id];
                            const changeLabel =
                              adjustment.change_quantity > 0
                                ? `+${adjustment.change_quantity}`
                                : String(adjustment.change_quantity);
                            return (
                              <div key={adjustment.id} className="text-sm text-slate-700">
                                <span className="font-medium text-ink">
                                  {direction === "out" ? "出库" : "入库"}
                                </span>
                                {" · "}
                                {warehouse?.name ?? "--"}
                                {" · "}
                                {item?.item_name ?? "--"}
                                {item?.item_spec ? `（${item.item_spec}）` : ""}
                                {" · "}
                                <span
                                  className={
                                    adjustment.change_quantity < 0
                                      ? "font-medium text-rose-600"
                                      : "font-medium text-emerald-600"
                                  }
                                >
                                  {changeLabel}
                                </span>
                                {" · "}
                                {adjustment.previous_quantity} → {adjustment.next_quantity}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
