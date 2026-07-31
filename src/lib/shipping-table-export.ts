import {
  getOrderFileImportFieldMeta,
  type OrderFileImportTemplate,
  type ShippingExportField,
} from "./order-file-import-templates";
import { resolveHeaderColumn } from "./order-file-import-parser";
import {
  createWorkbookFromSheets,
  type Workbook,
  type Worksheet,
} from "./tabular-parser";

export type ShippingExportRow = Partial<Record<
  ShippingExportField,
  string | number
>>;

export type ShippingExportRows = {
  Sheet1: ShippingExportRow[];
  Sheet2: ShippingExportRow[];
};

function cloneWorksheet(worksheet: Worksheet): Worksheet {
  return {
    ...worksheet,
    data: worksheet.data.map((row) => [...row]),
    columnWidths: worksheet.columnWidths
      ? [...worksheet.columnWidths]
      : undefined,
  };
}

function getMappingWorksheet(
  workbook: Pick<Workbook, "worksheets">,
  template: OrderFileImportTemplate,
  defaultWorksheetName: string,
  mappingWorksheetName: string,
) {
  const requestedName =
    mappingWorksheetName.trim() ||
    defaultWorksheetName.trim() ||
    template.worksheet_name.trim();
  const worksheet = requestedName
    ? workbook.worksheets.find((item) => item.name === requestedName)
    : workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(
      requestedName
        ? `表格中找不到字段映射指定的工作表“${requestedName}”。`
        : "表格中没有可写入的工作表",
    );
  }
  return worksheet;
}

export function fillShippingExportWorkbook(
  workbook: Pick<Workbook, "worksheets">,
  template: OrderFileImportTemplate,
  rows: ShippingExportRows,
) {
  if (template.import_type !== "shipping_export") {
    throw new Error("当前模板不是下载发货表格模板");
  }

  const startRow = Math.max(1, Math.trunc(template.start_row));
  const fields = getOrderFileImportFieldMeta("shipping_export");
  const outputMappings = fields.map((field) => {
    const mapping = template.field_mappings[field.key];
    const worksheet = getMappingWorksheet(
      workbook,
      template,
      field.worksheetName ?? "",
      mapping?.worksheetName ?? "",
    );
    const column =
      mapping?.sourceType === "header"
        ? resolveHeaderColumn(
            worksheet,
            mapping.headerAliases,
            startRow,
          ).column
        : mapping?.column ?? null;
    if (field.required && (!mapping || !column || column < 1)) {
      throw new Error(
        `模板无法确定“${worksheet.name}”中必填字段“${field.label}”的写入列。`,
      );
    }
    if (mapping?.sourceType === "fixed" && !mapping.fixedValue.trim()) {
      throw new Error(`请为字段“${field.label}”填写固定值。`);
    }
    return {
      field: field.key as ShippingExportField,
      label: field.label,
      worksheet,
      mapping,
      column,
    };
  });

  const usedColumns = new Map<string, string>();
  outputMappings.forEach(({ label, worksheet, column }) => {
    if (!column) return;
    const key = `${worksheet.name}\u0000${column}`;
    const existing = usedColumns.get(key);
    if (existing) {
      throw new Error(
        `“${worksheet.name}”中的字段“${existing}”和“${label}”不能同时写入第 ${column} 列。`,
      );
    }
    usedColumns.set(key, label);
  });

  const worksheets = workbook.worksheets.map(cloneWorksheet);
  const mappingGroups = new Map<
    string,
    typeof outputMappings
  >();
  outputMappings.forEach((mapping) => {
    const current = mappingGroups.get(mapping.worksheet.name) ?? [];
    current.push(mapping);
    mappingGroups.set(mapping.worksheet.name, current);
  });

  mappingGroups.forEach((mappings, worksheetName) => {
    const targetWorksheet = worksheets.find(
      (worksheet) => worksheet.name === worksheetName,
    );
    if (!targetWorksheet) {
      throw new Error(`无法复制下载模板工作表“${worksheetName}”`);
    }
    const rowKind =
      mappings[0]?.field.startsWith("shipment_") ? "Sheet1" : "Sheet2";
    if (
      mappings.some(
        (mapping) =>
          mapping.field.startsWith("shipment_") !== (rowKind === "Sheet1"),
      )
    ) {
      throw new Error(
        `工作表“${worksheetName}”不能同时承载包裹行和商品明细行。`,
      );
    }
    const maximumColumn = Math.max(
      0,
      ...mappings.map((mapping) => mapping.column ?? 0),
      ...targetWorksheet.data
        .slice(0, startRow - 1)
        .map((row) => row.length),
    );
    const generatedRows = rows[rowKind].map((row) => {
      const outputRow: Array<string | number | null> =
        Array(maximumColumn).fill(null);
      mappings.forEach(({ field, mapping, column }) => {
        if (!mapping || !column) return;
        outputRow[column - 1] =
          mapping.sourceType === "fixed"
            ? mapping.fixedValue
            : row[field] ?? "";
      });
      return outputRow;
    });
    targetWorksheet.data = [
      ...targetWorksheet.data.slice(0, startRow - 1),
      ...generatedRows,
    ];
  });

  return createWorkbookFromSheets(worksheets);
}
