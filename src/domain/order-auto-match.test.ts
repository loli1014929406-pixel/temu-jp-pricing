import { describe, expect, it } from "vitest";
import type {
  LogisticsMethod,
  ProductSku,
  ProductWarehouseShippingLimit,
  Warehouse,
  WarehouseLogisticsMethod,
  WarehouseSku,
} from "../types";
import { matchSingleSkuThreeCmShipment } from "./order-auto-match";

const now = "2026-07-28T00:00:00.000Z";

function warehouse(
  id: string,
  name: string,
  priority: number | null,
  enabled = priority !== null,
): Warehouse {
  return {
    id,
    name,
    owner_id: "owner",
    auto_match_enabled: enabled,
    auto_match_priority: priority,
    created_at: now,
    updated_at: now,
  };
}

function sku(id = "sku-1", productId = "product-1"): ProductSku {
  return {
    id,
    product_id: productId,
    sku_code: id,
    temu_image_url: "",
    attributes: {},
    notes: "",
    component_links: [],
  };
}

function method(
  id: string,
  parcelType: LogisticsMethod["parcel_type"],
): LogisticsMethod {
  return {
    id,
    owner_id: "owner",
    name: id,
    is_active: true,
    sort_order: 0,
    leg_type: "last_leg",
    parcel_type: parcelType,
    created_at: now,
    updated_at: now,
  };
}

function link(
  warehouseId: string,
  methodId: string,
  sortOrder: number,
): WarehouseLogisticsMethod {
  return {
    id: `${warehouseId}-${methodId}`,
    warehouse_id: warehouseId,
    logistics_method_id: methodId,
    owner_id: "owner",
    is_default: sortOrder === 0,
    sort_order: sortOrder,
    created_at: now,
    updated_at: now,
  };
}

function stock(
  warehouseId: string,
  skuId: string,
  quantity: number,
): WarehouseSku {
  return {
    id: `${warehouseId}-${skuId}`,
    warehouse_id: warehouseId,
    product_id: "product-1",
    sku_id: skuId,
    owner_id: "owner",
    stock_quantity: quantity,
    created_at: now,
    updated_at: now,
  };
}

function limit(
  warehouseId: string,
  maxUnits: number,
): ProductWarehouseShippingLimit {
  return {
    product_id: "product-1",
    warehouse_id: warehouseId,
    max_units_per_parcel: maxUnits,
  };
}

const warehouses = [
  warehouse("kobe", "神户", 1),
  warehouse("fukuoka", "福冈", 2),
  warehouse("nagoya", "名古屋", 3),
  warehouse("suzhou", "苏州", 4),
];
const threeCm = method("three-cm", "three_cm_only");
const standard = method("standard", "standard");

function run(
  overrides: Partial<Parameters<typeof matchSingleSkuThreeCmShipment>[0]> = {},
) {
  const exactSku = sku();
  return matchSingleSkuThreeCmShipment({
    lines: [{ label: "sku-1", quantity: 2, sku: exactSku }],
    warehouses,
    logisticsMethods: [threeCm, standard],
    warehouseLogisticsMethods: warehouses.flatMap((item) => [
      link(item.id, threeCm.id, 1),
      link(item.id, standard.id, 2),
    ]),
    warehouseSkus: warehouses.map((item) => stock(item.id, exactSku.id as string, 10)),
    productWarehouseShippingLimits: warehouses.map((item) => limit(item.id, 3)),
    ...overrides,
  });
}

describe("matchSingleSkuThreeCmShipment", () => {
  it("uses the highest-priority eligible warehouse", () => {
    const result = run();
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.match.warehouse.id).toBe("kobe");
      expect(result.match.logisticsMethod.id).toBe("three-cm");
    }
  });

  it("continues to the next priority when the first warehouse lacks stock", () => {
    const result = run({
      warehouseSkus: [
        stock("kobe", "sku-1", 1),
        stock("fukuoka", "sku-1", 2),
      ],
    });
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.match.warehouse.id).toBe("fukuoka");
    }
  });

  it("keeps quantities above every 3cm maximum unmatched without using standard tail methods", () => {
    const result = run({
      lines: [{ label: "sku-1", quantity: 4, sku: sku() }],
    });
    expect(result.status).toBe("unmatched");
  });

  it("blocks multi-SKU shipments", () => {
    const result = run({
      lines: [
        { label: "sku-1", quantity: 1, sku: sku("sku-1") },
        { label: "sku-2", quantity: 1, sku: sku("sku-2") },
      ],
    });
    expect(result).toEqual({
      status: "blocked",
      reason: "多 SKU 包裹不参与自动匹配，请手动选择仓库和尾程。",
    });
  });

  it("treats zero as disabled for that product and warehouse", () => {
    const result = run({
      productWarehouseShippingLimits: [
        limit("kobe", 0),
        limit("fukuoka", 3),
      ],
    });
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.match.warehouse.id).toBe("fukuoka");
    }
  });

  it("uses a missing product-warehouse limit as the default of one", () => {
    const result = run({
      lines: [{ label: "sku-1", quantity: 2, sku: sku() }],
      productWarehouseShippingLimits: [],
    });
    expect(result.status).toBe("unmatched");
  });

  it("does not use ordinary or unclassified tail methods", () => {
    const result = run({
      logisticsMethods: [standard, method("unclassified", null)],
      warehouseLogisticsMethods: warehouses.flatMap((item) => [
        link(item.id, standard.id, 0),
        link(item.id, "unclassified", 1),
      ]),
    });
    expect(result.status).toBe("unmatched");
  });

  it("uses warehouse tail-method order when multiple 3cm methods are bound", () => {
    const alternate = method("alternate-three-cm", "three_cm_only");
    const result = run({
      logisticsMethods: [threeCm, alternate],
      warehouseLogisticsMethods: [
        link("kobe", threeCm.id, 2),
        link("kobe", alternate.id, 1),
      ],
    });
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.match.logisticsMethod.id).toBe(alternate.id);
    }
  });
});
