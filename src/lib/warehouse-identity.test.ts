import { describe, expect, it } from "vitest";
import type { Warehouse } from "../types";
import { getSuzhouWarehouse } from "./warehouse-identity";

function warehouse(id: string, name: string): Warehouse {
  return {
    id,
    owner_id: "owner-1",
    name,
    auto_match_enabled: true,
    auto_match_priority: 1,
    created_at: "",
    updated_at: "",
  };
}

describe("getSuzhouWarehouse", () => {
  it("resolves the exact 苏州 warehouse instead of the auto-match priority warehouse", () => {
    const suzhou = warehouse("suzhou", "苏州");
    expect(getSuzhouWarehouse([warehouse("fukuoka", "福冈"), suzhou])).toEqual(suzhou);
  });

  it("does not infer a warehouse from a similar name", () => {
    expect(getSuzhouWarehouse([warehouse("suzhou-alias", "苏州仓")])).toBeNull();
  });
});
