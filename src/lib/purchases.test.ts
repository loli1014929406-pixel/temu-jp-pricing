import { describe, expect, it } from "vitest";
import type { PurchaseOrder, PurchaseOrderItem, PurchasePackage } from "../types";
import { buildLegacyPurchaseOrdersPage, getReceiptStatus } from "./purchases";

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

describe("buildLegacyPurchaseOrdersPage", () => {
  function order(
    id: string,
    status: PurchaseOrder["status"],
    totalCost: number,
    alibabaOrderNo: string,
  ) {
    return {
      id,
      order_code: `PO-${id}`,
      purchased_at: status === "pending" ? "2026-07-01" : "2026-07-02",
      total_cost_rmb: totalCost,
      status,
      sources: [{ alibaba_order_no: alibabaOrderNo }],
      items: [{ product_code: `P-${id}`, product_name_cn: `商品 ${id}` }],
      packages: status === "received" ? [purchasePackage("received", [[id, 1]])] : [],
    } as PurchaseOrder;
  }

  it("keeps server fallback paging and summaries aligned with the filtered set", () => {
    const result = buildLegacyPurchaseOrdersPage(
      [order("2", "received", 20, "A-2"), order("1", "pending", 10, "A-1")],
      { page: 1, pageSize: 1, search: "A-" },
    );

    expect(result.orders.map((row) => row.id)).toEqual(["1"]);
    expect(result.totalCount).toBe(2);
    expect(result.summary).toMatchObject({
      pendingOrderCount: 1,
      receivedOrderCount: 1,
      packageCount: 1,
      receivedPackageCount: 1,
      totalCostRmb: 30,
    });
  });
});
