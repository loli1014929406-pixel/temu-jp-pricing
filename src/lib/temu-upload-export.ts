import {
  getOrderFileImportFieldMeta,
  type OrderFileImportTemplate,
  type TemuUploadExportField,
} from "./order-file-import-templates";
import { resolveOrderFileTemplateMappings } from "./order-file-import-parser";
import {
  createWorkbookFromSheets,
  type Workbook,
  type Worksheet,
} from "./tabular-parser";

export type TemuUploadExportRow = Record<TemuUploadExportField, string | number>;

function getTargetWorksheet(
  workbook: Pick<Workbook, "worksheets">,
  template: Pick<OrderFileImportTemplate, "worksheet_name">,
) {
  const requestedName = template.worksheet_name.trim();
  if (requestedName) {
    const worksheet = workbook.worksheets.find(
      (item) => item.name === requestedName,
    );
    if (!worksheet) {
      throw new Error(
        `表格中找不到模板指定的工作表“${requestedName}”，请修改模板的工作表。`,
      );
    }
    return worksheet;
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("表格中没有可写入的工作表");
  return worksheet;
}

function cloneWorksheet(worksheet: Worksheet): Worksheet {
  return {
    ...worksheet,
    data: worksheet.data.map((row) => [...row]),
    columnWidths: worksheet.columnWidths
      ? [...worksheet.columnWidths]
      : undefined,
  };
}

export function fillTemuUploadExportWorkbook(
  workbook: Pick<Workbook, "worksheets">,
  template: OrderFileImportTemplate,
  rows: TemuUploadExportRow[],
) {
  if (template.import_type !== "temu_upload") {
    throw new Error("当前模板不是下载上传表格模板");
  }

  const sourceWorksheet = getTargetWorksheet(workbook, template);
  const resolvedMappings = resolveOrderFileTemplateMappings(
    sourceWorksheet,
    template,
  );
  const fields = getOrderFileImportFieldMeta("temu_upload");
  const outputMappings = fields.map((field) => {
    const resolved = resolvedMappings.find((item) => item.field === field.key);
    const mapping = template.field_mappings[field.key];
    const column =
      mapping?.sourceType === "fixed"
        ? mapping.column
        : resolved?.resolvedColumn ?? null;
    if (field.required && (!mapping || !column || column < 1)) {
      throw new Error(
        `模板无法确定必填字段“${field.label}”的写入列，请检查工作表、开始行或字段映射。`,
      );
    }
    if (mapping?.sourceType === "fixed" && !mapping.fixedValue.trim()) {
      throw new Error(`请为字段“${field.label}”填写固定值。`);
    }
    return {
      field: field.key as TemuUploadExportField,
      mapping,
      column,
    };
  });

  const usedColumns = new Map<number, string>();
  outputMappings.forEach(({ field, column }) => {
    if (!column) return;
    const existing = usedColumns.get(column);
    if (existing) {
      throw new Error(
        `字段“${existing}”和“${field}”不能同时写入第 ${column} 列。`,
      );
    }
    usedColumns.set(column, field);
  });

  const startRow = Math.max(1, Math.trunc(template.start_row));
  const maximumColumn = Math.max(
    0,
    ...outputMappings.map((mapping) => mapping.column ?? 0),
    ...(sourceWorksheet.data
      .slice(0, startRow - 1)
      .map((row) => row.length)),
  );
  const generatedRows = rows.map((row) => {
    const outputRow: Array<string | number | null> =
      Array(maximumColumn).fill(null);
    outputMappings.forEach(({ field, mapping, column }) => {
      if (!mapping || !column) return;
      outputRow[column - 1] =
        mapping.sourceType === "fixed"
          ? mapping.fixedValue
          : row[field];
    });
    return outputRow;
  });

  const worksheets = workbook.worksheets.map(cloneWorksheet);
  const targetWorksheet = worksheets.find(
    (worksheet) => worksheet.name === sourceWorksheet.name,
  );
  if (!targetWorksheet) throw new Error("无法复制下载模板工作表");
  targetWorksheet.data = [
    ...targetWorksheet.data.slice(0, startRow - 1),
    ...generatedRows,
  ];

  return createWorkbookFromSheets(worksheets);
}
