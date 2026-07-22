import { describe, expect, it } from "vitest";
import {
  emptyTemuOrderStageCounts,
  normalizeOrderCustomerHistoryStatus,
  normalizeTemuOrdersPageOptions,
} from "./orders";

describe("Temu order page options", () => {
  it("normalizes paging and filter input before calling the RPC", () => {
    expect(
      normalizeTemuOrdersPageOptions({
        page: -2,
        pageSize: 500,
        searchQuery: "  ORDER-1  ",
        warehouseId: "  warehouse-id  ",
        logisticsMethod: "  OCS Yamato  ",
        stage: "shipped",
        urgentOnly: true,
        sortKey: "delivery_deadline",
        sortDirection: "desc",
      }),
    ).toEqual({
      page: 1,
      pageSize: 100,
      searchQuery: "ORDER-1",
      warehouseId: "warehouse-id",
      logisticsMethod: "OCS Yamato",
      stage: "shipped",
      urgentOnly: true,
      sortKey: "delivery_deadline",
      sortDirection: "desc",
    });
  });

  it("uses stable defaults and independent empty stage counts", () => {
    expect(normalizeTemuOrdersPageOptions({ page: 1, pageSize: 20 })).toEqual({
      page: 1,
      pageSize: 20,
      searchQuery: "",
      warehouseId: "",
      logisticsMethod: "",
      stage: "all",
      urgentOnly: false,
      sortKey: "ship_deadline",
      sortDirection: "asc",
    });
    expect(emptyTemuOrderStageCounts).toEqual({
      all: 0,
      pending_assignment: 0,
      new_order: 0,
      pending_shipping: 0,
      shipped: 0,
      uploaded_temu: 0,
      completed: 0,
    });
  });

  it("accepts only customer-history signals returned by the order RPC", () => {
    expect(normalizeOrderCustomerHistoryStatus("repeat_customer")).toBe(
      "repeat_customer",
    );
    expect(normalizeOrderCustomerHistoryStatus("refund_order")).toBe(
      "refund_order",
    );
    expect(normalizeOrderCustomerHistoryStatus("refund_customer")).toBe(
      "refund_customer",
    );
    expect(normalizeOrderCustomerHistoryStatus("unexpected")).toBe("normal");
    expect(normalizeOrderCustomerHistoryStatus(undefined)).toBe("normal");
  });
});
