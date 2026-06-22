import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ExternalLink,
  Home,
  Info,
  Minus,
  PackageCheck,
  PackageOpen,
  Plus,
  Search,
  Trash2,
  Truck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Link } from "react-router-dom";
import {
  fetchWarehouseItemStockAdjustments,
  fetchWarehouseItemStocks,
  fetchWarehouseSkus,
  fetchWarehouses,
  getWarehouseTransferReasonInfo,
  parseWarehouseTransferReasonDetail,
  receiveWarehouseTransferInventory,
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
import type { WarehouseInventoryTransferMetadata } from "../lib/inventory";
import { PageHeader } from "../components/ui";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import { getErrorMessage } from "../utils/errors";
import { confirmAction } from "../utils/confirmations";
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
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceWarehouseName: string;
  destinationWarehouseName: string;
  trackingNo: string;
  skuSummary: string;
  metadata: WarehouseInventoryTransferMetadata | null;
  adjustments: TransferAdjustmentEntry[];
  itemSummaries: Array<{
    itemId: string;
    transferQuantity: number;
    receivedQuantity: number;
  }>;
  status: "in_transit" | "received";
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

function buildOcsTrackingUrl(trackingNo: string) {
  const normalizedTrackingNo = trackingNo.trim();
  if (!normalizedTrackingNo || normalizedTrackingNo === "--") return "";
  return `https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do?cwbno=${encodeURIComponent(
    normalizedTrackingNo,
  )}`;
}

function getTransferRecordBusyKey(record: TransferRecord) {
  return `receive-transfer-${record.metadata?.batchId ?? record.key}`;
}

function getProductCodeFromSkuSummaryLabel(label: string) {
  return label.trim().split(/\s+/)[0] ?? "";
}

export function InventoryTransferPage({ user: _user }: InventoryTransferPageProps) {
  void _user;
  const { canEdit } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [productItems, setProductItems] = useState<ProductItem[]>([]);
  const [skus, setSkus] = useState<ProductSku[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseSkus, setWarehouseSkus] = useState<WarehouseSku[]>([]);
  const [, setWarehouseItemStocks] = useState<WarehouseItemStock[]>([]);
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
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(successMessage, () => setSuccessMessage(""));
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

  const warehouseSkusByKey = useMemo(
    () =>
      Object.fromEntries(
        warehouseSkus.map((item) => [`${item.warehouse_id}:${item.sku_id}`, item]),
      ),
    [warehouseSkus],
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
    if (!sku?.id) return 0;
    return warehouseSkusByKey[`${warehouseId}:${sku.id}`]?.stock_quantity ?? 0;
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
      const reasonInfo = getWarehouseTransferReasonInfo(adjustment.reason);
      if (!reasonInfo) return;

      const createdAt = adjustment.created_at || "";
      const fallbackDate = createdAt.slice(0, 10) || "--";
      const detail = parseWarehouseTransferReasonDetail(reasonInfo.detail, fallbackDate);
      const existing = recordsByKey.get(reasonInfo.detail);
      const record =
        existing ??
        ({
          key: reasonInfo.detail,
          createdAt,
          sourceWarehouseId: detail.metadata?.sourceWarehouseId ?? "",
          destinationWarehouseId: detail.metadata?.destinationWarehouseId ?? "",
          ...detail,
          adjustments: [],
          itemSummaries: [],
          status: "in_transit",
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

    const records = Array.from(recordsByKey.values()).map((record) => {
      const itemSummaryMap = new Map<
        string,
        {
          itemId: string;
          transferQuantity: number;
          receivedQuantity: number;
        }
      >();

      record.adjustments.forEach(({ adjustment, direction }) => {
        const current = itemSummaryMap.get(adjustment.item_id) ?? {
          itemId: adjustment.item_id,
          transferQuantity: 0,
          receivedQuantity: 0,
        };
        const changeQuantity = Math.trunc(Number(adjustment.change_quantity) || 0);
        if (direction === "out") {
          current.transferQuantity += Math.max(0, -changeQuantity);
        } else {
          current.receivedQuantity += changeQuantity;
        }
        itemSummaryMap.set(adjustment.item_id, current);
      });

      const itemSummaries = Array.from(itemSummaryMap.values()).filter(
        (item) => item.transferQuantity > 0,
      );
      const status: TransferRecord["status"] =
        itemSummaries.length > 0 &&
          itemSummaries.every((item) => item.receivedQuantity >= item.transferQuantity)
          ? "received"
          : "in_transit";

      return {
        ...record,
        itemSummaries,
        status,
      };
    });

    return records.sort((left, right) => {
      const byTransferDate = right.transferDate.localeCompare(left.transferDate);
      if (byTransferDate !== 0) return byTransferDate;
      return right.createdAt.localeCompare(left.createdAt);
    });
  }, [warehouseItemStockAdjustments]);

  const inTransitTransferRecordCount = transferRecords.filter(
    (record) => record.status === "in_transit",
  ).length;

  const [recordFilter, setRecordFilter] = useState<"all" | "in_transit" | "received">("all");
  const filteredRecords = useMemo(() => {
    if (recordFilter === "all") return transferRecords;
    return transferRecords.filter((r) => r.status === recordFilter);
  }, [transferRecords, recordFilter]);

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
    if (
      !confirmAction(
        `确认从“${sourceWarehouse.name}”调拨库存到“${destinationWarehouse.name}”吗？`,
      )
    ) {
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
      setSuccessMessage("库存调拨已出库，签收后会加入调入仓库。");
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "库存调拨失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleReceiveTransferRecord(record: TransferRecord) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能签收调拨库存。");
      return;
    }
    if (record.status === "received") {
      setErrorMessage("该调拨记录已经签收。");
      return;
    }
    if (!record.metadata?.lines.length) {
      setErrorMessage(
        "该历史调拨记录缺少结构化 SKU 明细，不能自动签收。请先按实际调拨清单修复库存数据。",
      );
      return;
    }

    const destinationWarehouse =
      (record.destinationWarehouseId
        ? warehousesById[record.destinationWarehouseId]
        : undefined) ??
      warehouses.find((warehouse) => warehouse.name === record.destinationWarehouseName);
    if (!destinationWarehouse) {
      setErrorMessage("找不到调入仓库，不能签收入库。");
      return;
    }

    const receivableItems = record.itemSummaries
      .map((item) => ({
        itemId: item.itemId,
        quantity: item.transferQuantity,
      }))
      .filter((item) => item.quantity > 0);
    if (receivableItems.length === 0) {
      setErrorMessage("该调拨记录没有可签收的配件明细。");
      return;
    }

    if (
      !confirmAction(
        `确认签收快递单号“${record.trackingNo}”，并把库存加入“${destinationWarehouse.name}”吗？`,
      )
    ) {
      return;
    }

    const nextBusyKey = getTransferRecordBusyKey(record);
    setBusyKey(nextBusyKey);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const result = await receiveWarehouseTransferInventory({
        destinationWarehouseId: destinationWarehouse.id,
        reasonDetail: record.key,
        items: receivableItems,
        lines: record.metadata?.lines,
      });

      mergeWarehouseSkus(result.warehouseSkus);
      mergeWarehouseItemStocks(result.itemStocks);
      setWarehouseItemStockAdjustments((current) => [
        ...result.adjustments,
        ...current,
      ]);
      setSuccessMessage(
        result.adjustments.length > 0
          ? `已签收快递单号 ${record.trackingNo}，库存已加入 ${destinationWarehouse.name}。`
          : `快递单号 ${record.trackingNo} 已签收，无需重复入库。`,
      );
    } catch (error) {
      setErrorMessage(getInventoryErrorMessage(error, "调拨签收失败"));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="库存调拨"
        description="先从调出仓扣减库存，快递签收后再加入调入仓库"
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

      <section className="container-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-800">新建库存调拨</h2>
            <p className="mt-1 text-xs text-slate-500">
              选择调出和调入仓库，填写物流单号并添加调拨商品。
            </p>
          </div>
          <span className="rounded-full bg-accentSoft px-3 py-1 text-xs font-bold text-accentDeep">
            已选择 {transferSkuLineDetails.length} 个 SKU
          </span>
        </div>

        {/* Visual Warehouse Flow Connector Diagram */}
        <div className="flex flex-col items-center justify-between gap-6 rounded-2xl border border-slate-100 bg-slate-50/50 p-6 md:flex-row md:gap-12">
          {/* Source Warehouse Card */}
          <div className="flex flex-1 flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-white p-5 text-center shadow-sm w-full md:w-auto">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accentSoft text-accent">
              <Home size={24} />
            </div>
            <div className="w-full">
              <div className="text-xs font-semibold text-slate-400">调出仓库 (源仓)</div>
              <select
                value={transferSourceWarehouseId}
                onChange={(event) => handleTransferSourceWarehouseChange(event.target.value)}
                disabled={!canEdit || loading}
                className="mt-2 h-10 w-full rounded-xl border border-line bg-slate-50 px-3 text-center text-sm font-bold text-slate-800 outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10"
              >
                <option value="">选择仓库</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Connector Graphic */}
          <div className="flex flex-col items-center gap-2 text-slate-400 shrink-0">
            <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-accentDeep bg-accentSoft px-3 py-1.5 rounded-full border border-accentSoft shadow-sm animate-pulse">
              <Truck size={14} />
              <span>在途调拨运输</span>
            </div>
            <div className="hidden h-0.5 w-24 bg-gradient-to-r from-violet-200 via-indigo-300 to-indigo-200 md:block" />
            <div className="block h-8 w-0.5 bg-gradient-to-b from-violet-200 via-indigo-300 to-indigo-200 md:hidden" />
          </div>

          {/* Destination Warehouse Card */}
          <div className="flex flex-1 flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-white p-5 text-center shadow-sm w-full md:w-auto">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accentSoft text-accent">
              <Home size={24} />
            </div>
            <div className="w-full">
              <div className="text-xs font-semibold text-slate-400">调入仓库 (目的仓)</div>
              <select
                value={transferDestinationWarehouseId}
                onChange={(event) => setTransferDestinationWarehouseId(event.target.value)}
                disabled={!canEdit || loading}
                className="mt-2 h-10 w-full rounded-xl border border-line bg-slate-50 px-3 text-center text-sm font-bold text-slate-800 outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10"
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
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex flex-col gap-6">
            {/* Logistics and Date Card */}
            <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
              <h3 className="mb-4 text-sm font-bold text-slate-800 flex items-center gap-2">
                <ClipboardList size={16} className="text-slate-400" />
                <span>物流与时间</span>
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>调拨日期</span>
                  <div className="relative flex items-center">
                    <Calendar size={16} className="absolute left-3 text-slate-400" />
                    <input
                      type="date"
                      value={transferDate}
                      onChange={(event) => setTransferDate(event.target.value)}
                      disabled={!canEdit || loading}
                      className="h-11 w-full rounded-xl border border-line bg-slate-50 pl-10 pr-3 text-sm outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10 disabled:opacity-60"
                    />
                  </div>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>快递单号</span>
                  <div className="relative flex items-center">
                    <Truck size={16} className="absolute left-3 text-slate-400" />
                    <input
                      value={transferTrackingNo}
                      onChange={(event) => setTransferTrackingNo(event.target.value)}
                      disabled={!canEdit || loading}
                      placeholder="调拨快递单号"
                      className="h-11 w-full rounded-xl border border-line bg-slate-50 pl-10 pr-3 text-sm outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10 disabled:opacity-60"
                    />
                  </div>
                </label>
              </div>
            </div>

            {/* Add Item Form */}
            <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
              <h3 className="mb-4 text-sm font-bold text-slate-800 flex items-center gap-2">
                <Plus size={16} className="text-slate-400" />
                <span>添加调拨商品</span>
              </h3>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_120px_auto]">
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>选择 SKU</span>
                  <select
                    value={transferSkuId}
                    onChange={(event) => setTransferSkuId(event.target.value)}
                    disabled={!canEdit || !transferSourceWarehouseId || loading}
                    className="h-11 rounded-xl border border-line bg-slate-50 px-3 text-sm outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10 disabled:opacity-60"
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
                          {" · 库存: "}
                          {availableQuantity}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>数量</span>
                  <input
                    min="1"
                    max={selectedTransferAvailableQuantity || undefined}
                    step="1"
                    type="number"
                    value={transferQuantity}
                    onChange={(event) => setTransferQuantity(event.target.value)}
                    disabled={!canEdit || loading}
                    className="h-11 rounded-xl border border-line bg-slate-50 px-3 text-sm outline-none transition focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/10 disabled:opacity-60"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleAddTransferSkuLine}
                    disabled={!canAddTransferLine || busyKey === "transfer-inventory"}
                    className="btn-primary h-11 w-full sm:w-auto"
                  >
                    <Plus size={18} />
                    添加SKU
                  </button>
                </div>
              </div>
            </div>

            {!loading && warehouses.length < 2 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
                请先新增目标仓库后再调拨库存。
              </div>
            )}
          </div>

          {/* Transfer List Panel */}
          <div className="flex min-w-0 flex-col rounded-2xl border border-slate-100 bg-slate-50/50 p-5 shadow-inner">
            <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
              <h3 className="text-sm font-bold text-slate-800">调拨清单</h3>
              <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-bold text-slate-600">
                {transferSkuLineDetails.length} 项
              </span>
            </div>

            <div className="mt-4 grid min-h-[158px] gap-3 overflow-y-auto max-h-[380px] pr-1">
              {transferSkuLineDetails.length > 0 ? (
                transferSkuLineDetails.map((line) => (
                  <div
                    key={line.draft.skuId}
                    className="grid gap-3 rounded-xl border border-line bg-white p-3 shadow-sm transition-all hover:border-line sm:grid-cols-[minmax(0,1fr)_120px_36px] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="break-words text-sm font-bold text-slate-800">
                        {line.skuLabel}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-500">
                          可调拨 {line.availableQuantity}
                        </span>
                        {line.quantity > line.availableQuantity && (
                          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs font-semibold text-rose-600">
                            库存不足
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Custom quantity adjuster */}
                    <div className="flex items-center rounded-lg border border-line bg-slate-50 p-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          const val = Math.max(1, line.quantity - 1);
                          handleTransferLineQuantityChange(line.draft.skuId, String(val));
                        }}
                        disabled={!canEdit || loading || line.quantity <= 1}
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-30"
                      >
                        <Minus size={12} />
                      </button>
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
                        className="h-7 w-12 border-0 bg-transparent text-center text-xs font-bold text-slate-800 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const val = Math.min(line.availableQuantity, line.quantity + 1);
                          handleTransferLineQuantityChange(line.draft.skuId, String(val));
                        }}
                        disabled={!canEdit || loading || line.quantity >= line.availableQuantity}
                        className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-30"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveTransferSkuLine(line.draft.skuId)}
                      disabled={!canEdit || loading}
                      className="inline-flex h-9 w-full items-center justify-center rounded-lg border border-rose-100 bg-rose-50/50 text-rose-600 transition hover:bg-rose-100 disabled:opacity-60 sm:w-9"
                      title="移除SKU"
                      aria-label={`移除 ${line.skuLabel}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="flex min-h-[158px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-white/50 px-4 py-8 text-center text-slate-500">
                  <PackageOpen size={32} className="text-slate-300" />
                  <span className="text-sm font-medium">暂无调拨 SKU，请在左侧添加</span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleTransferInventory()}
              disabled={!canSubmitTransfer || busyKey === "transfer-inventory"}
              className="btn-primary mt-6 h-12 w-full text-base"
            >
              调拨出库
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4">
        {/* Sub-tab filter for records */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900">调拨记录</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
              {transferRecords.length}
            </span>
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setRecordFilter("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${recordFilter === "all"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
                }`}
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => setRecordFilter("in_transit")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${recordFilter === "in_transit"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
                }`}
            >
              <span>运输中</span>
              {inTransitTransferRecordCount > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">
                  {inTransitTransferRecordCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setRecordFilter("received")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${recordFilter === "received"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
                }`}
            >
              已签收
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : filteredRecords.length === 0 ? (
          <div className="empty-state">暂无调拨记录</div>
        ) : (
          <div className="grid gap-4">
            {filteredRecords.map((record) => {
              const trackingUrl = buildOcsTrackingUrl(record.trackingNo);
              const receiveBusyKey = getTransferRecordBusyKey(record);
              const isReceived = record.status === "received";
              const totalTransferQuantity = record.itemSummaries.reduce(
                (total, item) => total + item.transferQuantity,
                0,
              );
              const totalReceivedQuantity = record.itemSummaries.reduce(
                (total, item) =>
                  total +
                  Math.min(Math.max(0, item.receivedQuantity), item.transferQuantity),
                0,
              );
              const skuSummaryLabels = record.skuSummary
                .split("；")
                .map((label) => label.trim())
                .filter(Boolean);
              const actualProductCodes = new Set(
                record.itemSummaries.flatMap((item) => {
                  const productId = productItemsById[item.itemId]?.product_id;
                  const productCode = productId ? productsById[productId]?.product_code : "";
                  return productCode ? [productCode] : [];
                }),
              );
              const textOnlySkuLabels = skuSummaryLabels.filter((label) => {
                const productCode = getProductCodeFromSkuSummaryLabel(label);
                return productCode && actualProductCodes.size > 0 && !actualProductCodes.has(productCode);
              });
              const visibleSkuLabels =
                textOnlySkuLabels.length > 0
                  ? skuSummaryLabels.filter((label) => !textOnlySkuLabels.includes(label))
                  : skuSummaryLabels;
              const hasLegacyMissingMetadata = !record.metadata?.lines.length;
              const hasSummaryMismatch = textOnlySkuLabels.length > 0;

              return (
                <article
                  key={record.key}
                  className="rounded-2xl border border-line bg-white p-5 shadow-sm transition hover:shadow-md"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${isReceived
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700"
                          }`}
                      >
                        {isReceived ? <PackageCheck size={14} /> : <PackageOpen size={14} />}
                        {isReceived ? "已签收" : "运输中"}
                      </span>
                      <span className="text-xs text-slate-500 font-medium">
                        创建时间：{formatDateTime(record.createdAt)}
                      </span>
                    </div>

                    <div className="flex max-w-md flex-1 flex-wrap gap-1.5 sm:justify-end">
                      {visibleSkuLabels.map((skuLabel) => (
                        <span
                          key={skuLabel}
                          className="rounded-lg border border-slate-150 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-700"
                        >
                          {skuLabel}
                        </span>
                      ))}
                    </div>
                  </div>

                  {(hasLegacyMissingMetadata || hasSummaryMismatch) && (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                        <div className="grid gap-1">
                          {hasLegacyMissingMetadata && (
                            <span>
                              该历史调拨记录缺少结构化 SKU 明细，不能自动签收或作为完整 SKU 入库依据。
                            </span>
                          )}
                          {hasSummaryMismatch && (
                            <span>
                              文本摘要包含 {textOnlySkuLabels.join("、")}，但实际库存流水没有对应产品行。
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Visual Stepper Timeline */}
                  <div className="mt-6 grid gap-6 md:grid-cols-3 md:gap-4">
                    {/* Step 1: Outbound */}
                    <div className="relative flex gap-3.5 md:flex-col md:items-start">
                      <div className="flex flex-col items-center">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accentSoft text-accent ring-4 ring-white">
                          <PackageCheck size={18} />
                        </div>
                        <div className="h-full w-0.5 bg-slate-150 md:hidden" />
                      </div>
                      <div className="pt-1.5 md:pt-0">
                        <div className="text-xs font-bold text-slate-800">已从调出仓扣减</div>
                        <div className="mt-0.5 text-xs text-slate-500">{record.sourceWarehouseName}</div>
                        <div className="mt-1 text-[11px] text-slate-400 font-mono">{record.transferDate}</div>
                      </div>
                    </div>

                    {/* Step 2: Logistics / In Transit */}
                    <div className="relative flex gap-3.5 md:flex-col md:items-start">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-full ring-4 ring-white ${isReceived ? "bg-accentSoft text-accent" : "bg-amber-50 text-amber-600 animate-pulse"
                            }`}
                        >
                          <Truck size={18} />
                        </div>
                        <div className="h-full w-0.5 bg-slate-150 md:hidden" />
                      </div>
                      <div className="pt-1.5 md:pt-0">
                        <div className="text-xs font-bold text-slate-800">物流运输中</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-line">
                            {record.trackingNo}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(record.trackingNo);
                              alert("已复制快递单号：" + record.trackingNo);
                            }}
                            className="text-slate-400 hover:text-slate-700 transition"
                            title="复制单号"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                        {trackingUrl && (
                          <a
                            href={trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-accent hover:underline"
                          >
                            <span>查询物流轨迹</span>
                            <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Step 3: Destination Inbound / Sign */}
                    <div className="relative flex gap-3.5 md:flex-col md:items-start">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-full ring-4 ring-white ${isReceived ? "bg-emerald-600 text-white shadow-sm" : "bg-slate-100 text-slate-400"
                            }`}
                        >
                          <CheckCircle2 size={18} />
                        </div>
                      </div>
                      <div className="pt-1.5 flex-1 md:pt-0">
                        <div className="text-xs font-bold text-slate-800">
                          {isReceived ? "已签收入库" : "等待签收入库"}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{record.destinationWarehouseName}</div>
                        <div className="mt-2.5">
                          {canEdit && !isReceived ? (
                            <button
                              type="button"
                              onClick={() => void handleReceiveTransferRecord(record)}
                              disabled={busyKey === receiveBusyKey || hasLegacyMissingMetadata}
                              title={
                                hasLegacyMissingMetadata
                                  ? "历史调拨缺少结构化 SKU 明细，需先修复库存数据"
                                  : undefined
                              }
                              className="btn-primary h-8 px-4 text-xs font-bold"
                            >
                              {busyKey === receiveBusyKey ? "签收中..." : "确认签收"}
                            </button>
                          ) : isReceived ? (
                            <div className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                              <Check size={13} />
                              <span>入库进度：{totalReceivedQuantity} / {totalTransferQuantity} 签收完毕</span>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <Info size={13} />
                              暂无操作权限
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <details className="mt-5 border-t border-slate-100 pt-3 [&>summary::-webkit-details-marker]:hidden">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-bold text-slate-500">
                      <span>库存流动流水 · 共 {record.adjustments.length} 条流水</span>
                      <span className="rounded-lg bg-slate-100 hover:bg-slate-200 px-2.5 py-1 text-slate-600 transition">
                        展开明细
                      </span>
                    </summary>
                    <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto rounded-xl bg-slate-50/50 p-3 shadow-inner">
                      {record.adjustments.map(({ adjustment, direction }) => {
                        const warehouse = warehousesById[adjustment.warehouse_id];
                        const item = productItemsById[adjustment.item_id];
                        const changeLabel =
                          adjustment.change_quantity > 0
                            ? `+${adjustment.change_quantity}`
                            : String(adjustment.change_quantity);
                        const flowLabel =
                          direction === "out"
                            ? "出库"
                            : adjustment.change_quantity < 0
                              ? "撤销入库"
                              : "入库";
                        return (
                          <div
                            key={adjustment.id}
                            className="grid gap-2 rounded-xl border border-line bg-white px-4 py-3 text-xs text-slate-700 sm:grid-cols-[64px_minmax(0,1fr)_auto] sm:items-center shadow-sm"
                          >
                            <span
                              className={`inline-flex w-fit rounded-lg px-2 py-0.5 text-[10px] font-bold ${direction === "out"
                                  ? "bg-rose-50 text-rose-600"
                                  : "bg-emerald-50 text-emerald-600"
                                }`}
                            >
                              {flowLabel}
                            </span>
                            <div className="min-w-0">
                              <div className="font-bold text-slate-800">
                                {warehouse?.name ?? "--"}
                              </div>
                              <div className="break-words mt-0.5 text-slate-500 font-medium">
                                {item?.item_name ?? "--"}
                                {item?.item_spec ? `（${item.item_spec}）` : ""}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                              <span
                                className={`font-bold ${adjustment.change_quantity < 0
                                    ? "text-rose-600"
                                    : "text-emerald-600"
                                  }`}
                              >
                                {changeLabel}
                              </span>
                              <span className="font-mono text-slate-400">
                                {adjustment.previous_quantity} → {adjustment.next_quantity}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
