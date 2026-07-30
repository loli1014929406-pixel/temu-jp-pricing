import { describe, expect, it } from "vitest";
import { createWorkbookFromSheets } from "./tabular-parser";
import { parseActualShippingFeeWorkbook } from "./actual-shipping-fee-parser";
import type { ActualShippingFeeImportTemplate } from "./actual-shipping-fee-templates";

const logisticsMethods = [
  { id: "11111111-1111-4111-8111-111111111111", name: "福冈 Japan Post" },
  { id: "22222222-2222-4222-8222-222222222222", name: "OCS Yamato" },
];

function template(
  overrides: Partial<ActualShippingFeeImportTemplate> = {},
): ActualShippingFeeImportTemplate {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "测试模板",
    worksheet_name: "已完成订单",
    start_row: 2,
    tracking_source_type: "column",
    tracking_column: 2,
    tracking_fixed_value: "",
    amount_source_type: "column",
    amount_column: 3,
    amount_fixed_value: null,
    logistics_method_source_type: "fixed",
    logistics_method_column: null,
    logistics_method_fixed_id: logisticsMethods[0].id,
    is_system: false,
    system_key: "",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("parseActualShippingFeeWorkbook", () => {
  it("maps Japan Post columns and preserves the source precision", () => {
    const workbook = createWorkbookFromSheets([{
      name: "已完成订单",
      data: [
        ["Temu 订单号", "物流单号", "运费（人名币）"],
        ["PO-1", "628656895230", 9.317],
        ["PO-2", "628656895231", 8.47],
      ],
    }]);

    const result = parseActualShippingFeeWorkbook(workbook, template(), logisticsMethods);

    expect(result.templateName).toBe("测试模板");
    expect(result.records).toEqual([
      {
        tracking_no: "628656895230",
        amount_rmb: 9.317,
        logistics_method_id: logisticsMethods[0].id,
        source_row_number: 2,
      },
      {
        tracking_no: "628656895231",
        amount_rmb: 8.47,
        logistics_method_id: logisticsMethods[0].id,
        source_row_number: 3,
      },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("maps OCS by the configured column numbers and excludes a summary row", () => {
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

    const result = parseActualShippingFeeWorkbook(
      workbook,
      template({
        worksheet_name: "Sheet1",
        tracking_column: 3,
        amount_column: 55,
        logistics_method_fixed_id: logisticsMethods[1].id,
      }),
      logisticsMethods,
    );

    expect(result.records).toEqual([
      {
        tracking_no: "655583479574",
        amount_rmb: 16.5,
        logistics_method_id: logisticsMethods[1].id,
        source_row_number: 2,
      },
    ]);
    expect(result.issues).toEqual([
      { rowNumber: 3, trackingNo: "5073", reason: "不是有效物流单号，可能是标题或汇总行" },
    ]);
  });

  it("resolves a logistics method from a source column", () => {
    const workbook = createWorkbookFromSheets([{
      name: "Sheet1",
      data: [
        ["单号", "运费", "方式"],
        ["628656895230", "9.317", "OCS 3cm"],
      ],
    }]);

    const result = parseActualShippingFeeWorkbook(
      workbook,
      template({
        worksheet_name: "Sheet1",
        tracking_column: 1,
        amount_column: 2,
        logistics_method_source_type: "column",
        logistics_method_column: 3,
        logistics_method_fixed_id: null,
      }),
      logisticsMethods,
    );

    expect(result.records[0].logistics_method_id).toBe(logisticsMethods[1].id);
  });

  it("skips every occurrence of a duplicate tracking number", () => {
    const workbook = createWorkbookFromSheets([{
      name: "已完成订单",
      data: [
        ["订单", "物流单号", "运费"],
        ["A", "628656895230", 9.317],
        ["B", "628656895230", 9.5],
      ],
    }]);

    const result = parseActualShippingFeeWorkbook(workbook, template(), logisticsMethods);

    expect(result.records).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.reason.includes("重复"))).toBe(true);
  });

  it("rejects a missing configured worksheet", () => {
    const workbook = createWorkbookFromSheets([{ name: "Sheet1", data: [["订单号", "金额"]] }]);
    expect(() =>
      parseActualShippingFeeWorkbook(workbook, template(), logisticsMethods),
    ).toThrow("找不到模板指定的工作表");
  });
});

