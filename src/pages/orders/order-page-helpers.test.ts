import { describe, expect, it } from "vitest";
import type { TemuOrderRecord } from "../../types";
import { buildOrderDisplayRowsWithDrafts } from "./order-page-helpers";

function order(
  overrides: Partial<TemuOrderRecord>,
): TemuOrderRecord {
  return {
    id: "item-1",
    source_order_id: "source-1",
    shipment_id: "shipment-1",
    shipment_item_id: "item-1",
    package_sequence: 1,
    package_count: 1,
    is_split: false,
    order_no: "PO-1",
    sub_order_no: "SUB-1",
    sku_code: "SKU-1",
    product_attributes: "",
    fulfillment_quantity: 1,
    order_status: "",
    warehouse_id: null,
    warehouse_name: "",
    logistics_method_id: null,
    logistics_method: "",
    label_printed_at: "",
    logistics_tracking_no: "",
    logistics_status: "",
    actual_ship_time: "",
    actual_signed_time: "",
    actual_shipping_fee_rmb: 0,
    ...overrides,
  } as TemuOrderRecord;
}

describe("order display rows", () => {
  it("renders split packages independently even when they share an order and source line", () => {
    const rows = buildOrderDisplayRowsWithDrafts(
      [
        order({
          id: "item-1",
          shipment_item_id: "item-1",
          shipment_id: "shipment-1",
          package_sequence: 1,
          package_count: 2,
          is_split: true,
          fulfillment_quantity: 1,
        }),
        order({
          id: "item-2",
          shipment_item_id: "item-2",
          shipment_id: "shipment-2",
          package_sequence: 2,
          package_count: 2,
          is_split: true,
          fulfillment_quantity: 2,
        }),
      ],
      {},
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.quantity)).toEqual([1, 2]);
    expect(rows.map((row) => row.primaryOrder.package_sequence)).toEqual([1, 2]);
  });

  it("keeps unsplit multi-line orders as one row", () => {
    const rows = buildOrderDisplayRowsWithDrafts(
      [
        order({ id: "item-1", shipment_item_id: "item-1" }),
        order({
          id: "item-2",
          source_order_id: "source-2",
          shipment_item_id: "item-2",
          sub_order_no: "SUB-2",
          sku_code: "SKU-2",
          fulfillment_quantity: 2,
        }),
      ],
      {},
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
  });

  it("renders confirmed merged orders as one row with the persisted primary order", () => {
    const combined = {
      combined_shipment_id: "combined-1",
      combined_shipment_no: "MC-20260801-ABC",
      combined_primary_shipment_id: "shipment-2",
      combined_primary_order_no: "PO-2",
      combined_member_count: 2,
      is_combined_shipment: true,
    };
    const rows = buildOrderDisplayRowsWithDrafts(
      [
        order({ ...combined, combined_is_primary: false }),
        order({
          ...combined,
          id: "item-2",
          source_order_id: "source-2",
          shipment_id: "shipment-2",
          shipment_item_id: "item-2",
          order_no: "PO-2",
          sub_order_no: "SUB-2",
          combined_is_primary: true,
          fulfillment_quantity: 2,
        }),
      ],
      {},
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].primaryOrder.order_no).toBe("PO-2");
  });
});
