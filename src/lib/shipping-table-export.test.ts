import { describe, expect, it } from "vitest";
import type {
  OrderFileFieldMapping,
  OrderFileImportTemplate,
  ShippingExportField,
} from "./order-file-import-templates";
import {
  fillShippingExportWorkbook,
  type ShippingExportRow,
} from "./shipping-table-export";
import { createWorkbookFromSheets } from "./tabular-parser";

const sheet1Headers = [
  "收件人",
  "收件人地址",
  "收件邮编",
  "收件电话",
  "件数",
  "目的地(可以都填TYO)",
  "订单号",
  "服务类型(不填写默认B2C)",
  "店铺名称",
  "店铺备注",
  "发件人",
  "发件人地址",
  "发件人电话",
  "发件人邮编",
  "店铺",
  "自定义重量",
  "是否带电(0:不带电/1:带电)",
  "平台名称",
  "生产销售单位",
  "生产销售单位统一编码",
];

const sheet2Headers = [
  "订单号",
  "商品代码",
  "品名",
  "描述",
  "商品数量",
  "单价",
  "币值",
  "编制方式",
  "HS_CODE",
  "原产国",
  "货架号",
  "采购编号",
  "样式颜色",
  "客户备注",
  "URL",
  "PRIMARYKEY",
  "国内申报价值",
  "国内申报币值",
];

const fields = [
  "shipment_recipient_name",
  "shipment_address",
  "shipment_postal_code",
  "shipment_phone",
  "shipment_package_count",
  "shipment_destination",
  "shipment_order_no",
  "shipment_service_type",
  "shipment_store_name",
  "shipment_store_note",
  "shipment_sender_name",
  "shipment_sender_address",
  "shipment_sender_phone",
  "shipment_sender_postal_code",
  "shipment_store",
  "shipment_custom_weight",
  "shipment_has_battery",
  "shipment_platform_name",
  "shipment_sales_unit",
  "shipment_sales_unit_code",
  "item_order_no",
  "item_code",
  "item_name",
  "item_description",
  "item_quantity",
  "item_unit_price",
  "item_currency",
  "item_compilation_method",
  "item_hs_code",
  "item_origin_country",
  "item_shelf_no",
  "item_purchase_no",
  "item_style_color",
  "item_customer_note",
  "item_url",
  "item_primary_key",
  "item_domestic_declared_value",
  "item_domestic_currency",
] as const satisfies readonly ShippingExportField[];

function mapping(
  worksheetName: "Sheet1" | "Sheet2",
  column: number,
  alias: string,
): OrderFileFieldMapping {
  return {
    sourceType: "header",
    column,
    fixedValue: "",
    headerAliases: [alias],
    worksheetName,
  };
}

function template(): OrderFileImportTemplate {
  const fieldMappings = Object.fromEntries(
    fields.map((field, index) => {
      const isShipment = field.startsWith("shipment_");
      const headers = isShipment ? sheet1Headers : sheet2Headers;
      const column = isShipment ? index + 1 : index - sheet1Headers.length + 1;
      return [
        field,
        mapping(
          isShipment ? "Sheet1" : "Sheet2",
          column,
          headers[column - 1] ?? "",
        ),
      ];
    }),
  );
  return {
    id: "template-1",
    user_id: "user-1",
    import_type: "shipping_export",
    name: "现有发货表格模板",
    worksheet_name: "Sheet1",
    start_row: 2,
    field_mappings: fieldMappings,
    is_system: true,
    system_key: "legacy_shipping_export",
    deleted_at: null,
    created_at: "",
    updated_at: "",
  };
}

function emptyRow(): ShippingExportRow {
  return Object.fromEntries(fields.map((field) => [field, ""])) as ShippingExportRow;
}

describe("shipping workbook export", () => {
  it("writes package rows and item rows to their own mapped worksheets", () => {
    const workbook = createWorkbookFromSheets([
      { name: "Sheet1", data: [sheet1Headers, ["sample"]] },
      { name: "Sheet2", data: [sheet2Headers, ["sample"]] },
    ]);
    const packageRow = {
      ...emptyRow(),
      shipment_recipient_name: "山田太郎",
      shipment_order_no: "PO-1",
    };
    const itemRow = {
      ...emptyRow(),
      item_order_no: "PO-1",
      item_name: "Cap",
      item_quantity: 2,
    };

    const output = fillShippingExportWorkbook(workbook, template(), {
      Sheet1: [packageRow],
      Sheet2: [itemRow],
    });

    expect(output.worksheets[0]?.data[1]?.[0]).toBe("山田太郎");
    expect(output.worksheets[0]?.data[1]?.[6]).toBe("PO-1");
    expect(output.worksheets[1]?.data[1]?.[0]).toBe("PO-1");
    expect(output.worksheets[1]?.data[1]?.[2]).toBe("Cap");
    expect(output.worksheets[1]?.data[1]?.[4]).toBe(2);
    expect(workbook.worksheets[0]?.data[1]).toEqual(["sample"]);
  });

  it("rejects package and item fields mapped into the same worksheet", () => {
    const invalid = template();
    invalid.field_mappings.item_order_no = {
      sourceType: "column",
      column: 21,
      fixedValue: "",
      headerAliases: [],
      worksheetName: "Sheet1",
    };
    const workbook = createWorkbookFromSheets([
      { name: "Sheet1", data: [sheet1Headers] },
      { name: "Sheet2", data: [sheet2Headers] },
    ]);

    expect(() =>
      fillShippingExportWorkbook(workbook, invalid, {
        Sheet1: [],
        Sheet2: [],
      }),
    ).toThrow("不能同时承载包裹行和商品明细行");
  });
});
