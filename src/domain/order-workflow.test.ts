import { describe, expect, it } from "vitest";
import type { TemuOrderRecord } from "../types";
import {
  buildPendingAssignmentResetUpdates,
  getOrderFulfillmentAssignmentIssue,
  getOrderStage,
  getSplitOrderFulfillmentIssue,
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
    logistics_method_id: null,
    logistics_method: "",
    ...overrides,
  } as TemuOrderRecord;
}

describe("order workflow", () => {
  it.each([
    [order(), "pending_assignment"],
    [order({ warehouse_name: "苏州" }), "pending_assignment"],
    [order({ logistics_method: "OCS Yamato" }), "pending_assignment"],
    [order({ warehouse_name: "苏州", logistics_method: "OCS Yamato" }), "new_order"],
    [order({ label_printed_at: "2026-07-10" }), "pending_shipping"],
    [order({ logistics_tracking_no: "TRACK-1" }), "shipped"],
    [order({ order_status: "上传Temu", logistics_tracking_no: "TRACK-1" }), "uploaded_temu"],
    [order({ order_status: "已上传Temu" }), "uploaded_temu"],
    [order({ order_status: "上传Temu", actual_signed_time: "2026-07-10" }), "completed"],
  ])("assigns the expected stage", (record, expected) => {
    expect(getOrderStage(record)).toBe(expected);
  });

  it("requires both a warehouse and a shipping method before leaving pending assignment", () => {
    expect(getOrderFulfillmentAssignmentIssue(order())).toBe("还没有分配发货仓库。");
    expect(
      getOrderFulfillmentAssignmentIssue(order({ warehouse_name: "苏州" })),
    ).toBe("还没有分配发货方式。");
    expect(
      getOrderFulfillmentAssignmentIssue(order({
        warehouse_name: "苏州",
        logistics_method: "OCS Yamato",
      })),
    ).toBe("");
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

  it("clears stable assignment identities when returning an order to pending assignment", () => {
    const assignedOrder = order({
      order_status: "新订单",
      warehouse_id: "warehouse-1",
      warehouse_name: "苏州",
      logistics_method_id: "method-1",
      logistics_method: "OCS Yamato",
    });

    const resetOrder = {
      ...assignedOrder,
      ...buildPendingAssignmentResetUpdates(),
    };

    expect(resetOrder).toMatchObject({
      warehouse_id: null,
      warehouse_name: "",
      logistics_method_id: null,
      logistics_method: "",
    });
    expect(getOrderStage(resetOrder)).toBe("pending_assignment");
  });

  it("allows a multi-line main order to use one warehouse and one shipping method", () => {
    const orders = [
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-1",
        warehouse_name: "苏州",
        logistics_method_id: "method-1",
        logistics_method: "OCS Yamato",
      }),
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-1",
        warehouse_name: "苏州",
        logistics_method_id: "method-1",
        logistics_method: "OCS Yamato",
      }),
    ];

    expect(getSplitOrderFulfillmentIssue(orders)).toBe("");
  });

  it("blocks a multi-line main order from being split across warehouses", () => {
    const orders = [
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-1",
        warehouse_name: "苏州",
        logistics_method_id: "method-1",
        logistics_method: "OCS Yamato",
      }),
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-2",
        warehouse_name: "福冈",
        logistics_method_id: "method-1",
        logistics_method: "OCS Yamato",
      }),
    ];

    expect(getSplitOrderFulfillmentIssue(orders)).toContain("必须使用同一发货仓库");
  });

  it("blocks a multi-line main order from using different shipping methods", () => {
    const orders = [
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-1",
        warehouse_name: "苏州",
        logistics_method_id: "method-1",
        logistics_method: "OCS Yamato",
      }),
      order({
        order_no: "PO-1",
        warehouse_id: "warehouse-1",
        warehouse_name: "苏州",
        logistics_method_id: "method-2",
        logistics_method: "OCS 小包",
      }),
    ];

    expect(getSplitOrderFulfillmentIssue(orders)).toContain("必须使用同一发货方式");
  });
});
