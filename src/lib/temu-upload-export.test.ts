import { describe, expect, it } from "vitest";
import { createWorkbookFromSheets } from "./tabular-parser";
import {
  fillTemuUploadExportWorkbook,
  type TemuUploadExportRow,
} from "./temu-upload-export";
import type { OrderFileImportTemplate } from "./order-file-import-templates";
import type { OrderFileFieldMapping } from "./order-file-import-templates";

function template(
  mappings: OrderFileImportTemplate["field_mappings"],
): OrderFileImportTemplate {
  return {
    id: "template-1",
    user_id: "user-1",
    import_type: "temu_upload",
    name: "Temu 默认上传模板",
    worksheet_name: "Sheet1",
    start_row: 2,
    field_mappings: mappings,
    is_system: true,
    system_key: "legacy_temu_upload",
    deleted_at: null,
    created_at: "",
    updated_at: "",
  };
}

const rows: TemuUploadExportRow[] = [{
  order_no: "PO-1",
  sub_order_no: "SO-1",
  fulfillment_quantity: 2,
  tracking_no: "628600000001",
  carrier: "Yamato",
  warehouse_name: "Whale Cloud-JP",
}];

function headerMapping(alias: string) {
  return {
    sourceType: "header" as const,
    column: null,
    fixedValue: "",
    headerAliases: [alias],
  };
}

describe("Temu upload workbook export", () => {
  it("writes selected order values into columns resolved from the uploaded template", () => {
    const headers = [
      "子订单号",
      "订单号",
      "商品件数",
      "跟踪单号",
      "物流承运商",
      "发货仓库名称",
    ];
    const workbook = createWorkbookFromSheets([{
      name: "Sheet1",
      data: [headers, ["sample"]],
    }]);
    const output = fillTemuUploadExportWorkbook(
      workbook,
      template({
        order_no: headerMapping("订单号"),
        sub_order_no: headerMapping("子订单号"),
        fulfillment_quantity: headerMapping("商品件数"),
        tracking_no: headerMapping("跟踪单号"),
        carrier: headerMapping("物流承运商"),
        warehouse_name: headerMapping("发货仓库名称"),
      }),
      rows,
    );

    expect(output.worksheets[0]?.data).toEqual([
      headers,
      ["SO-1", "PO-1", 2, "628600000001", "Yamato", "Whale Cloud-JP"],
    ]);
    expect(workbook.worksheets[0]?.data[1]).toEqual(["sample"]);
  });

  it("writes a fixed value to its bound output column", () => {
    const workbook = createWorkbookFromSheets([{
      name: "Sheet1",
      data: [["订单号", "子订单号", "商品件数", "跟踪单号", "物流承运商", "发货仓库名称"]],
    }]);
    const mappings: Record<string, OrderFileFieldMapping> = Object.fromEntries(
      ["order_no", "sub_order_no", "fulfillment_quantity", "tracking_no", "carrier", "warehouse_name"]
        .map((field, index) => [
          field,
          {
            sourceType: "column" as const,
            column: index + 1,
            fixedValue: "",
            headerAliases: [],
          },
        ]),
    );
    mappings.warehouse_name = {
      sourceType: "fixed",
      column: 6,
      fixedValue: "固定仓库",
      headerAliases: [],
    };

    const output = fillTemuUploadExportWorkbook(
      workbook,
      template(mappings),
      rows,
    );

    expect(output.worksheets[0]?.data[1]?.[5]).toBe("固定仓库");
  });

  it("rejects two fields mapped to the same output column", () => {
    const workbook = createWorkbookFromSheets([{
      name: "Sheet1",
      data: [["订单号", "子订单号", "商品件数", "跟踪单号", "物流承运商", "发货仓库名称"]],
    }]);
    const mappings: Record<string, OrderFileFieldMapping> = Object.fromEntries(
      ["order_no", "sub_order_no", "fulfillment_quantity", "tracking_no", "carrier", "warehouse_name"]
        .map((field, index) => [
          field,
          {
            sourceType: "column" as const,
            column: index === 1 ? 1 : index + 1,
            fixedValue: "",
            headerAliases: [],
          },
        ]),
    );

    expect(() =>
      fillTemuUploadExportWorkbook(workbook, template(mappings), rows),
    ).toThrow("不能同时写入第 1 列");
  });
});
