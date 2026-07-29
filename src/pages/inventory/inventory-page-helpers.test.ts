import { describe, expect, it } from "vitest";
import type { Warehouse } from "../../types";
import {
  getWarehouseRouteSlug,
  isWarehouseRouteMatch,
} from "./inventory-page-helpers";

const warehouse: Warehouse = {
  id: "11111111-1111-4111-8111-111111111111",
  owner_id: "22222222-2222-4222-8222-222222222222",
  name: "福冈",
  auto_match_enabled: true,
  auto_match_priority: 2,
  created_at: "2026-07-28T00:00:00.000Z",
  updated_at: "2026-07-28T00:00:00.000Z",
};

describe("warehouse inventory routes", () => {
  it("uses the immutable warehouse id as the route key", () => {
    expect(getWarehouseRouteSlug(warehouse)).toBe(warehouse.id);
  });

  it("does not accept names, aliases, or similar text", () => {
    expect(isWarehouseRouteMatch(warehouse, warehouse.id)).toBe(true);
    expect(isWarehouseRouteMatch(warehouse, "福冈")).toBe(false);
    expect(isWarehouseRouteMatch(warehouse, "福岡")).toBe(false);
    expect(isWarehouseRouteMatch(warehouse, "fukuoka")).toBe(false);
  });
});
