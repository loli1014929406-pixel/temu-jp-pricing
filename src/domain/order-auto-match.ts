import type {
  LogisticsMethod,
  ProductSku,
  ProductWarehouseShippingLimit,
  Warehouse,
  WarehouseLogisticsMethod,
  WarehouseSku,
} from "../types";

export type AutoMatchShipmentLine = {
  label: string;
  quantity: number;
  sku: ProductSku | null;
};

export type AutoMatchFulfillment = {
  warehouse: Warehouse;
  logisticsMethod: LogisticsMethod;
  sku: ProductSku;
  quantity: number;
};

export type AutoMatchFulfillmentResult =
  | { status: "matched"; match: AutoMatchFulfillment }
  | { status: "blocked"; reason: string }
  | { status: "unmatched"; reason: string };

function normalizeLimit(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 1;
}

function sortParticipatingWarehouses(warehouses: Warehouse[]) {
  return warehouses
    .filter(
      (warehouse) =>
        warehouse.auto_match_enabled &&
        warehouse.auto_match_priority !== null &&
        warehouse.auto_match_priority > 0,
    )
    .sort((left, right) => {
      const priorityDifference =
        (left.auto_match_priority ?? Number.MAX_SAFE_INTEGER) -
        (right.auto_match_priority ?? Number.MAX_SAFE_INTEGER);
      if (priorityDifference !== 0) return priorityDifference;
      return left.id.localeCompare(right.id);
    });
}

function getPreferredThreeCmMethod(
  warehouseId: string,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  const methodsById = new Map(
    logisticsMethods
      .filter(
        (method) =>
          method.is_active &&
          method.leg_type === "last_leg" &&
          method.parcel_type === "three_cm_only",
      )
      .map((method) => [method.id, method]),
  );

  const sortedLinks = warehouseLogisticsMethods
    .filter((link) => link.warehouse_id === warehouseId)
    .sort((left, right) => {
      if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
      if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
      return left.id.localeCompare(right.id);
    });

  for (const link of sortedLinks) {
    const method = methodsById.get(link.logistics_method_id);
    if (method) return method;
  }
  return null;
}

export function matchSingleSkuThreeCmShipment({
  lines,
  warehouses,
  logisticsMethods,
  warehouseLogisticsMethods,
  warehouseSkus,
  productWarehouseShippingLimits,
  availableStockByKey,
}: {
  lines: AutoMatchShipmentLine[];
  warehouses: Warehouse[];
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
  warehouseSkus: WarehouseSku[];
  productWarehouseShippingLimits: ProductWarehouseShippingLimit[];
  availableStockByKey?: Map<string, number>;
}): AutoMatchFulfillmentResult {
  if (lines.length === 0) {
    return { status: "blocked", reason: "包裹没有商品，不能自动匹配。" };
  }

  const unresolvedLine = lines.find((line) => !line.sku?.id || !line.sku.product_id);
  if (unresolvedLine) {
    return {
      status: "blocked",
      reason: `商品 ${unresolvedLine.label} 没有精确匹配到 SKU，不能自动匹配。`,
    };
  }

  const skuIds = new Set(lines.map((line) => line.sku?.id).filter(Boolean));
  if (skuIds.size !== 1) {
    return {
      status: "blocked",
      reason: "多 SKU 包裹不参与自动匹配，请手动选择仓库和尾程。",
    };
  }

  const sku = lines[0].sku as ProductSku;
  const quantity = lines.reduce(
    (total, line) => total + Math.max(1, Math.trunc(Number(line.quantity) || 0)),
    0,
  );
  const participatingWarehouses = sortParticipatingWarehouses(warehouses);
  if (participatingWarehouses.length === 0) {
    return {
      status: "unmatched",
      reason: "没有已启用且设置优先级的自动匹配仓库。",
    };
  }

  const stockByKey = new Map(
    warehouseSkus.map((stock) => [
      `${stock.warehouse_id}:${stock.sku_id}`,
      stock.stock_quantity,
    ]),
  );
  const limitByWarehouseId = new Map(
    productWarehouseShippingLimits
      .filter((limit) => limit.product_id === sku.product_id)
      .map((limit) => [limit.warehouse_id, normalizeLimit(limit.max_units_per_parcel)]),
  );
  const reasons: string[] = [];

  for (const warehouse of participatingWarehouses) {
    const maxUnits = limitByWarehouseId.get(warehouse.id) ?? 1;
    if (maxUnits <= 0 || quantity > maxUnits) {
      reasons.push(`${warehouse.name} 的 3cm 最大数为 ${maxUnits}`);
      continue;
    }

    const stockKey = `${warehouse.id}:${sku.id}`;
    const stockQuantity =
      availableStockByKey?.get(stockKey) ?? stockByKey.get(stockKey) ?? 0;
    if (stockQuantity < quantity) {
      reasons.push(`${warehouse.name} 库存不足`);
      continue;
    }

    const logisticsMethod = getPreferredThreeCmMethod(
      warehouse.id,
      logisticsMethods,
      warehouseLogisticsMethods,
    );
    if (!logisticsMethod) {
      reasons.push(`${warehouse.name} 没有已分类并绑定的 3cm 尾程`);
      continue;
    }

    return {
      status: "matched",
      match: {
        warehouse,
        logisticsMethod,
        sku,
        quantity,
      },
    };
  }

  return {
    status: "unmatched",
    reason:
      reasons.length > 0
        ? `${reasons.join("；")}。`
        : "没有仓库同时满足 3cm 上限、库存和尾程规则。",
  };
}
