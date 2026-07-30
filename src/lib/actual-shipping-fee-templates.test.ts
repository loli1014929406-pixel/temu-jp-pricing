import { describe, expect, it } from "vitest";
import { getActualShippingFeeTemplateDeleteMode } from "./actual-shipping-fee-templates";

describe("actual shipping fee template deletion", () => {
  it("soft deletes auto-generated templates so initialization cannot recreate them", () => {
    expect(getActualShippingFeeTemplateDeleteMode({ is_system: true })).toBe("soft");
  });

  it("keeps hard deletion for user-created templates", () => {
    expect(getActualShippingFeeTemplateDeleteMode({ is_system: false })).toBe("hard");
  });
});
