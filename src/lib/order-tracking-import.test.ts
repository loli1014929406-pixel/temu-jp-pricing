import { describe, expect, it } from "vitest";
import type { TemuOrderRecord } from "../types";
import {
  buildTrackingImportPreview,
  type TrackingFileRecord,
} from "./order-tracking-import";

function order(
  overrides: Partial<TemuOrderRecord>,
): TemuOrderRecord {
  return {
    id: "line-1",
    source_order_id: "source-1",
    shipment_id: "shipment-1",
    shipment_item_id: "shipment-item-1",
    package_sequence: 1,
    package_count: 1,
    is_split: false,
    owner_id: "user-1",
    order_no: "PO-1",
    sub_order_no: "SUB-1",
    order_status: "待发货",
    sku_code: "SKU-1",
    warehouse_id: "warehouse-1",
    warehouse_name: "仓库",
    logistics_method_id: "method-1",
    logistics_method: "物流",
    label_printed_at: "2026-07-30 10:00:00",
    logistics_tracking_no: "",
    logistics_status: "",
    product_attributes: "",
    recipient_name: "",
    recipient_phone: "",
    email: "",
    province: "",
    city: "",
    district: "",
    address_line1: "",
    address_line2: "",
    postal_code: "",
    latest_ship_time: "",
    actual_ship_time: "",
    estimated_delivery_time: "",
    actual_signed_time: "",
    actual_shipping_fee_rmb: 0,
    fulfillment_quantity: 1,
    ...overrides,
  } as TemuOrderRecord;
}

function record(
  overrides: Partial<TrackingFileRecord>,
): TrackingFileRecord {
  return {
    sourceRowNumber: 2,
    orderNo: "PO-1",
    subOrderNo: "",
    trackingNo: "628600000001",
    ...overrides,
  };
}

describe("tracking file package matching", () => {
  it("matches an unsplit shipment by order number only", () => {
    const preview = buildTrackingImportPreview([record({})], [order({})]);

    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].shipmentId).toBe("shipment-1");
    expect(preview.rows[0].message).toBe("订单号匹配成功");
  });

  it("matches split shipments by order number and sub-order number", () => {
    const preview = buildTrackingImportPreview(
      [
        record({
          orderNo: "PO-SPLIT",
          subOrderNo: "SUB-2",
          trackingNo: "628600000002",
        }),
      ],
      [
        order({
          shipment_id: "shipment-1",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-1",
          package_sequence: 1,
          package_count: 2,
          is_split: true,
        }),
        order({
          id: "line-2",
          source_order_id: "source-2",
          shipment_id: "shipment-2",
          shipment_item_id: "shipment-item-2",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-2",
          package_sequence: 2,
          package_count: 2,
          is_split: true,
        }),
      ],
    );

    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].shipmentId).toBe("shipment-2");
    expect(preview.rows[0].packageSequence).toBe(2);
  });

  it("does not guess when a split row omits the sub-order number", () => {
    const preview = buildTrackingImportPreview(
      [record({ orderNo: "PO-SPLIT" })],
      [
        order({
          shipment_id: "shipment-1",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-1",
          package_sequence: 1,
          package_count: 2,
          is_split: true,
        }),
        order({
          shipment_id: "shipment-2",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-2",
          package_sequence: 2,
          package_count: 2,
          is_split: true,
        }),
      ],
    );

    expect(preview.matches).toHaveLength(0);
    expect(preview.rows[0].status).toBe("missing_sub_order_no");
  });

  it("skips an order and sub-order pair that exists in multiple packages", () => {
    const preview = buildTrackingImportPreview(
      [
        record({
          orderNo: "PO-SPLIT",
          subOrderNo: "SUB-1",
        }),
      ],
      [
        order({
          shipment_id: "shipment-1",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-1",
          package_sequence: 1,
          package_count: 2,
          is_split: true,
        }),
        order({
          id: "line-2",
          shipment_id: "shipment-2",
          shipment_item_id: "shipment-item-2",
          order_no: "PO-SPLIT",
          sub_order_no: "SUB-1",
          package_sequence: 2,
          package_count: 2,
          is_split: true,
        }),
      ],
    );

    expect(preview.matches).toHaveLength(0);
    expect(preview.rows[0].status).toBe("ambiguous_package");
  });

  it("skips duplicate tracking numbers as a group", () => {
    const preview = buildTrackingImportPreview(
      [
        record({ sourceRowNumber: 2, trackingNo: "628600000009" }),
        record({
          sourceRowNumber: 3,
          orderNo: "PO-2",
          trackingNo: "628600000009",
        }),
      ],
      [order({}), order({ shipment_id: "shipment-2", order_no: "PO-2" })],
    );

    expect(preview.matches).toHaveLength(0);
    expect(preview.rows.map((row) => row.status)).toEqual([
      "duplicate_tracking_no",
      "duplicate_tracking_no",
    ]);
  });
});
