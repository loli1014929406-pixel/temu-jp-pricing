import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import {
  getWarehouseLastLegMethodNames,
  isLastLegMethodAllowedForWarehouse,
} from "./warehouse-logistics";
import type { LogisticsMethod, WarehouseLogisticsMethod } from "../types";

const warehouseId = "33333333-3333-4333-8333-333333333333";
const ownerId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-07-16T00:00:00.000Z";

const logisticsMethods: LogisticsMethod[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    owner_id: ownerId,
    name: "顺丰",
    is_active: true,
    sort_order: 0,
    created_at: createdAt,
    updated_at: createdAt,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    owner_id: ownerId,
    name: "OCS Yamato",
    is_active: true,
    sort_order: 1,
    created_at: createdAt,
    updated_at: createdAt,
  },
];

const warehouseLinks: WarehouseLogisticsMethod[] = logisticsMethods.map(
  (method, index) => ({
    id: `55555555-5555-4555-8555-55555555555${index}`,
    warehouse_id: warehouseId,
    logistics_method_id: method.id,
    owner_id: ownerId,
    is_default: index === 0,
    sort_order: index,
    created_at: createdAt,
    updated_at: createdAt,
  }),
);

describe("warehouse last-leg methods", () => {
  it("returns only tail-shipping methods bound to the selected warehouse", () => {
    expect(
      getWarehouseLastLegMethodNames(
        warehouseId,
        defaultSettings,
        logisticsMethods,
        warehouseLinks,
      ),
    ).toEqual(["OCS Yamato"]);

    expect(
      isLastLegMethodAllowedForWarehouse(
        warehouseId,
        "顺丰",
        defaultSettings,
        logisticsMethods,
        warehouseLinks,
      ),
    ).toBe(false);
  });
});
