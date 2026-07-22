import { describe, expect, it } from "vitest";
import type { LogisticsMethodConfig } from "../types";
import { calculateDynamicMethodCost } from "./shipping-costs";

function buildQuantityTierMethod(
  quantityPrices: number[],
  currency: "RMB" | "JPY" = "JPY",
): LogisticsMethodConfig {
  return {
    id: "quantity-tier-last-leg",
    name: "按件数测试",
    type: "last_leg",
    formula: "quantity_tier",
    params: { quantityPrices, currency, billingUnit: "ticket" },
    isActive: true,
  };
}

describe("quantity-tier shipping cost", () => {
  it("uses the freely configured price for each item-count tier", () => {
    const method = buildQuantityTierMethod([200, 269, 269]);

    expect(calculateDynamicMethodCost(method, 100, 0.0415, 1)).toBeCloseTo(8.3);
    expect(calculateDynamicMethodCost(method, 200, 0.0415, 2)).toBeCloseTo(11.1635);
    expect(calculateDynamicMethodCost(method, 300, 0.0415, 3)).toBeCloseTo(11.1635);
  });

  it("uses the last configured tier when quantity exceeds it", () => {
    const method = buildQuantityTierMethod([123, 456], "RMB");

    expect(calculateDynamicMethodCost(method, 9999, 0.0415, 1)).toBe(123);
    expect(calculateDynamicMethodCost(method, 9999, 0.0415, 2)).toBe(456);
    expect(calculateDynamicMethodCost(method, 9999, 0.0415, 4)).toBe(456);
  });

  it("returns zero when the shipment has no items", () => {
    const method = buildQuantityTierMethod([200, 269]);

    expect(calculateDynamicMethodCost(method, 0, 0.0415, 0)).toBe(0);
  });
});
