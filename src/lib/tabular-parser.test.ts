import { describe, expect, it } from "vitest";
import { parseCsvRows, worksheetToObjects } from "./tabular-parser";

describe("tabular parser", () => {
  it("uses the widest early row as the header row", () => {
    const rows = worksheetToObjects({
      name: "orders",
      data: [
        ["Temu order export"],
        ["导出时间", "2026-06-19"],
        ["订单号", "订单状态", "收货人姓名"],
        ["PO-1", "待发货", "山田太郎"],
      ],
    });

    expect(rows).toEqual([
      {
        订单号: "PO-1",
        订单状态: "待发货",
        收货人姓名: "山田太郎",
      },
    ]);
  });

  it("detects tab-separated text", () => {
    expect(parseCsvRows("订单号\t物流单号\nPO-1\tJP123")).toEqual([
      ["订单号", "物流单号"],
      ["PO-1", "JP123"],
    ]);
  });

  it("strips BOM from the first header cell", () => {
    const rows = worksheetToObjects({
      name: "orders",
      data: [
        ["\uFEFF订单号", "订单状态"],
        ["PO-1", "待发货"],
      ],
    });

    expect(Object.keys(rows[0] ?? {})).toEqual(["订单号", "订单状态"]);
  });
});
