import { describe, expect, it } from "vitest";
import { createWorkbookFromSheets } from "./tabular-parser";
import { parseActualShippingFeeWorkbook } from "./actual-shipping-fee-parser";

describe("parseActualShippingFeeWorkbook", () => {
  it("parses Japan Post rows and preserves the source precision", () => {
    const workbook = createWorkbookFromSheets([{
      name: "已完成订单",
      data: [
        ["Temu 订单号", "物流单号", "运费（人名币）"],
        ["PO-1", "628656895230", 9.317],
        ["PO-2", "628656895231", 8.47],
      ],
    }]);

    const result = parseActualShippingFeeWorkbook(workbook);

    expect(result.carrier).toBe("japan_post");
    expect(result.records).toEqual([
      { tracking_no: "628656895230", amount_rmb: 9.317, source_row_number: 2 },
      { tracking_no: "628656895231", amount_rmb: 8.47, source_row_number: 3 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("parses OCS rows and excludes the final summary row", () => {
    const header = Array.from({ length: 55 }, () => null as string | null);
    header[2] = "运单号";
    header[54] = "总计数";
    const order = Array.from({ length: 55 }, () => null as string | number | null);
    order[2] = 655583479574;
    order[54] = 16.5;
    const summary = Array.from({ length: 55 }, () => null as string | number | null);
    summary[2] = 5073;
    summary[54] = 85636.1;
    const workbook = createWorkbookFromSheets([{ name: "Sheet1", data: [header, order, summary] }]);

    const result = parseActualShippingFeeWorkbook(workbook);

    expect(result.carrier).toBe("ocs_yamato");
    expect(result.records).toEqual([
      { tracking_no: "655583479574", amount_rmb: 16.5, source_row_number: 2 },
    ]);
    expect(result.issues).toEqual([
      { rowNumber: 3, trackingNo: "5073", reason: "不是有效物流单号，可能是汇总行" },
    ]);
  });

  it("skips every occurrence of a duplicate tracking number", () => {
    const workbook = createWorkbookFromSheets([{
      name: "已完成订单",
      data: [
        ["物流单号", "运费（人民币）"],
        ["628656895230", 9.317],
        ["628656895230", 9.5],
      ],
    }]);

    const result = parseActualShippingFeeWorkbook(workbook);

    expect(result.records).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.reason.includes("重复"))).toBe(true);
  });

  it("rejects unrelated spreadsheets", () => {
    const workbook = createWorkbookFromSheets([{ name: "Sheet1", data: [["订单号", "金额"]] }]);
    expect(() => parseActualShippingFeeWorkbook(workbook)).toThrow("无法识别运费表格");
  });
});

