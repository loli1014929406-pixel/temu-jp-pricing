import { describe, expect, it } from "vitest";
import { getTrackingUrl } from "./OrderTableRow";

describe("getTrackingUrl", () => {
  it("links a Suzhou warehouse tracking number to OCS", () => {
    expect(
      getTrackingUrl(
        {
          logistics_tracking_no: "655587861504",
          warehouse_id: "suzhou-warehouse-id",
        },
        "suzhou-warehouse-id",
      ),
    ).toBe(
      "https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do?cwbno=655587861504",
    );
  });

  it.each([
    ["Kobe", "kobe-warehouse-id"],
    ["Fukuoka", "fukuoka-warehouse-id"],
    ["Nagoya", "nagoya-warehouse-id"],
    ["missing warehouse", null],
  ])("does not link a %s tracking number", (_label, warehouseId) => {
    expect(
      getTrackingUrl(
        {
          logistics_tracking_no: "766112489321",
          warehouse_id: warehouseId,
        },
        "suzhou-warehouse-id",
      ),
    ).toBe("");
  });

  it("does not link when the exact Suzhou warehouse ID cannot be resolved", () => {
    expect(
      getTrackingUrl(
        {
          logistics_tracking_no: "655587861504",
          warehouse_id: "suzhou-warehouse-id",
        },
        "",
      ),
    ).toBe("");
  });
});
