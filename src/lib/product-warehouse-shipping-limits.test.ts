import { describe, expect, it } from "vitest";
import { normalizeWarehouseShippingLimit } from "./product-warehouse-shipping-limits";

describe("normalizeWarehouseShippingLimit", () => {
  it("allows zero to disable 3cm matching for one product and warehouse", () => {
    expect(normalizeWarehouseShippingLimit(0)).toBe(0);
  });

  it("defaults missing and invalid values to one", () => {
    expect(normalizeWarehouseShippingLimit(undefined)).toBe(1);
    expect(normalizeWarehouseShippingLimit(Number.NaN)).toBe(1);
  });
});
