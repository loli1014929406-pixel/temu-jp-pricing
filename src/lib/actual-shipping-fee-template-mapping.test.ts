import { describe, expect, it } from "vitest";
import type { ActualShippingFeeImportTemplateInput } from "./actual-shipping-fee-templates";
import {
  bindActualShippingFeeColumn,
  clearAllActualShippingFeeFieldMappings,
  clearActualShippingFeeFieldMapping,
  getActualShippingFeeFieldMapping,
  setActualShippingFeeFixedMapping,
} from "./actual-shipping-fee-template-mapping";

function draft(): ActualShippingFeeImportTemplateInput {
  return {
    name: "测试模板",
    worksheet_name: "Sheet1",
    start_row: 2,
    tracking_source_type: "fixed",
    tracking_column: null,
    tracking_fixed_value: "TRACKING",
    amount_source_type: "fixed",
    amount_column: null,
    amount_fixed_value: 9.5,
    logistics_method_source_type: "fixed",
    logistics_method_column: null,
    logistics_method_fixed_id: "method-id",
  };
}

describe("actual shipping fee template mapping", () => {
  it("binds each website field to one selected spreadsheet column", () => {
    const tracking = bindActualShippingFeeColumn(draft(), "tracking", 8);
    const amount = bindActualShippingFeeColumn(tracking, "amount", 25);
    const logistics = bindActualShippingFeeColumn(amount, "logistics_method", 3);

    expect(getActualShippingFeeFieldMapping(logistics, "tracking")).toEqual({
      sourceType: "column",
      column: 8,
      fixedValue: "",
    });
    expect(getActualShippingFeeFieldMapping(logistics, "amount")).toEqual({
      sourceType: "column",
      column: 25,
      fixedValue: null,
    });
    expect(getActualShippingFeeFieldMapping(logistics, "logistics_method")).toEqual({
      sourceType: "column",
      column: 3,
      fixedValue: null,
    });
  });

  it("switches a selected field to fixed value without affecting other fields", () => {
    const columnDraft = bindActualShippingFeeColumn(draft(), "tracking", 8);
    const fixedDraft = setActualShippingFeeFixedMapping(columnDraft, "tracking");

    expect(fixedDraft.tracking_source_type).toBe("fixed");
    expect(fixedDraft.tracking_column).toBeNull();
    expect(fixedDraft.amount_fixed_value).toBe(9.5);
    expect(fixedDraft.logistics_method_fixed_id).toBe("method-id");
  });

  it("clears one mapping or every mapping", () => {
    const trackingCleared = clearActualShippingFeeFieldMapping(draft(), "tracking");
    expect(trackingCleared.tracking_column).toBeNull();
    expect(trackingCleared.tracking_fixed_value).toBe("");
    expect(trackingCleared.amount_fixed_value).toBe(9.5);

    const allCleared = clearAllActualShippingFeeFieldMappings(draft());
    expect(allCleared).toMatchObject({
      tracking_source_type: "column",
      tracking_column: null,
      tracking_fixed_value: "",
      amount_source_type: "column",
      amount_column: null,
      amount_fixed_value: null,
      logistics_method_source_type: "column",
      logistics_method_column: null,
      logistics_method_fixed_id: null,
    });
  });
});
