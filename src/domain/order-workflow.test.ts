import { describe, expect, it } from "vitest";
import type { TemuOrderRecord } from "../types";
import {
  getOrderStage,
  isShippingTrackingStage,
  shouldReserveOrderInventory,
} from "./order-workflow";

function order(overrides: Partial<TemuOrderRecord> = {}) {
  return {
    order_status: "",
    actual_signed_time: "",
    actual_ship_time: "",
    logistics_tracking_no: "",
    label_printed_at: "",
    warehouse_id: null,
    warehouse_name: "",
    ...overrides,
  } as TemuOrderRecord;
}

describe("order workflow", () => {
  it.each([
    [order(), "pending_assignment"],
    [order({ warehouse_name: "苏州" }), "new_order"],
    [order({ label_printed_at: "2026-07-10" }), "pending_shipping"],
    [order({ logistics_tracking_no: "TRACK-1" }), "shipped"],
    [order({ order_status: "上传Temu", logistics_tracking_no: "TRACK-1" }), "uploaded_temu"],
    [order({ order_status: "已上传Temu" }), "uploaded_temu"],
    [order({ order_status: "上传Temu", actual_signed_time: "2026-07-10" }), "completed"],
  ])("assigns the expected stage", (record, expected) => {
    expect(getOrderStage(record)).toBe(expected);
  });

  it("only treats shipped and uploaded orders as tracking stages", () => {
    expect(isShippingTrackingStage("shipped")).toBe(true);
    expect(isShippingTrackingStage("uploaded_temu")).toBe(true);
    expect(isShippingTrackingStage("completed")).toBe(false);
  });

  it("reserves inventory after an order leaves pending assignment", () => {
    expect(shouldReserveOrderInventory("pending_assignment")).toBe(false);
    expect(shouldReserveOrderInventory("new_order")).toBe(true);
    expect(shouldReserveOrderInventory("completed")).toBe(true);
  });
});
