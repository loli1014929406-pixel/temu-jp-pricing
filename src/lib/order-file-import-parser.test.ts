import { describe, expect, it } from "vitest";
import { createWorkbookFromSheets } from "./tabular-parser";
import { parseOrderFileImportWorkbook } from "./order-file-import-parser";
import type { OrderFileImportTemplate } from "./order-file-import-templates";

function template(
  overrides: Partial<OrderFileImportTemplate>,
): OrderFileImportTemplate {
  return {
    id: "template-1",
    user_id: "user-1",
    import_type: "tracking",
    name: "测试模板",
    worksheet_name: "",
    start_row: 2,
    field_mappings: {
      order_no: {
        sourceType: "header",
        column: null,
        fixedValue: "",
        headerAliases: ["订单号", "REF_NO"],
      },
      sub_order_no: {
        sourceType: "header",
        column: null,
        fixedValue: "",
        headerAliases: ["子订单号"],
      },
      tracking_no: {
        sourceType: "header",
        column: null,
        fixedValue: "",
        headerAliases: ["物流单号", "CWB_NO"],
      },
    },
    is_system: true,
    system_key: "legacy_tracking",
    deleted_at: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("order file import parser", () => {
  it("uses an existing header-based template without rebinding columns", () => {
    const workbook = createWorkbookFromSheets([
      {
        name: "Sheet1",
        data: [
          ["CWB_NO", "REF_NO", "子订单号"],
          ["628600000001", "PO-1", "SUB-1"],
        ],
      },
    ]);

    const result = parseOrderFileImportWorkbook(workbook, template({}));

    expect(result.rows).toEqual([
      {
        sourceRowNumber: 2,
        values: {
          order_no: "PO-1",
          sub_order_no: "SUB-1",
          tracking_no: "628600000001",
        },
      },
    ]);
    expect(
      result.resolvedMappings.map((mapping) => [
        mapping.field,
        mapping.resolvedColumn,
      ]),
    ).toEqual([
      ["order_no", 2],
      ["sub_order_no", 3],
      ["tracking_no", 1],
    ]);
  });

  it("supports exact column bindings and fixed values for saved templates", () => {
    const workbook = createWorkbookFromSheets([
      {
        name: "物流",
        data: [
          ["任意标题", "单号"],
          ["ignore", "628600000002"],
        ],
      },
    ]);
    const result = parseOrderFileImportWorkbook(
      workbook,
      template({
        worksheet_name: "物流",
        field_mappings: {
          order_no: {
            sourceType: "fixed",
            column: null,
            fixedValue: "PO-2",
            headerAliases: [],
          },
          sub_order_no: {
            sourceType: "fixed",
            column: null,
            fixedValue: "",
            headerAliases: [],
          },
          tracking_no: {
            sourceType: "column",
            column: 2,
            fixedValue: "",
            headerAliases: [],
          },
        },
      }),
    );

    expect(result.rows[0].values).toEqual({
      order_no: "PO-2",
      sub_order_no: "",
      tracking_no: "628600000002",
    });
  });

  it("combines ordered source columns with a space", () => {
    const result = parseOrderFileImportWorkbook(
      createWorkbookFromSheets([
        {
          name: "Sheet1",
          data: [
            ["姓", "名", "订单号"],
            ["山田", "太郎", "PO-3"],
          ],
        },
      ]),
      template({
        field_mappings: {
          order_no: {
            sourceType: "column",
            column: 3,
            fixedValue: "",
            headerAliases: [],
          },
          sub_order_no: {
            sourceType: "fixed",
            column: null,
            fixedValue: "SUB-3",
            headerAliases: [],
          },
          tracking_no: {
            sourceType: "column",
            column: 1,
            columns: [1, 2],
            fixedValue: "",
            headerAliases: [],
          },
        },
      }),
    );

    expect(result.rows[0].values.tracking_no).toBe("山田 太郎");
  });

  it("blocks preview when a required header cannot be resolved", () => {
    const workbook = createWorkbookFromSheets([
      {
        name: "Sheet1",
        data: [["订单号"], ["PO-1"]],
      },
    ]);

    expect(() =>
      parseOrderFileImportWorkbook(workbook, template({})),
    ).toThrow("物流单号");
  });
});
