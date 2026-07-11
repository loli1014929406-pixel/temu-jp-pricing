import { describe, expect, it } from "vitest";
import type { PurchaseOrderItem, PurchasePackage } from "../types";
import { getReceiptStatus } from "./purchases";

function item(id: string, quantity: number) {
  return { id, quantity } as PurchaseOrderItem;
}

function purchasePackage(
  status: PurchasePackage["status"],
  quantities: Array<[string, number]>,
) {
  return {
    status,
    items: quantities.map(([orderItemId, quantity]) => ({
      order_item_id: orderItemId,
      quantity,
    })),
  } as PurchasePackage;
}

describe("getReceiptStatus", () => {
  it("keeps an order pending when no received package contains stock", () => {
    expect(
      getReceiptStatus(
        [item("a", 2)],
        [purchasePackage("pending", [["a", 2]])],
      ),
    ).toBe("pending");
  });

  it("marks an order partially received when only part of its quantity arrived", () => {
    expect(
      getReceiptStatus(
        [item("a", 3), item("b", 1)],
        [purchasePackage("received", [["a", 2]])],
      ),
    ).toBe("partially_received");
  });

  it("sums multiple received packages before marking an order received", () => {
    expect(
      getReceiptStatus(
        [item("a", 3), item("b", 1)],
        [
          purchasePackage("received", [["a", 1], ["b", 1]]),
          purchasePackage("received", [["a", 2]]),
        ],
      ),
    ).toBe("received");
  });
});
