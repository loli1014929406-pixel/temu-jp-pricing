import { describe, expect, it } from "vitest";
import {
  getOrderCustomerHistoryMeta,
  getOrderCustomerHistoryTitle,
  visibleOrderCustomerHistoryStatuses,
} from "./order-customer-history";

describe("order customer history presentation", () => {
  it("keeps the three highlighted states in the required priority legend", () => {
    expect(visibleOrderCustomerHistoryStatuses).toEqual([
      "refund_order",
      "refund_customer",
      "repeat_customer",
    ]);
  });

  it("falls back to the normal style when no signal is present", () => {
    expect(getOrderCustomerHistoryMeta(undefined)).toMatchObject({
      label: "正常订单",
      rowClassName: "",
    });
  });

  it("includes both reversal amounts in the refund-order hover text", () => {
    expect(
      getOrderCustomerHistoryTitle({
        customer_history_status: "refund_order",
        customer_sales_reversal: -25.5,
        customer_freight_reversal: -3,
      }),
    ).toBe("实际退款订单：销售冲回 ¥-25.50，运费冲回 ¥-3.00");
  });
});
