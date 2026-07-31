import {
  getOrderFileImportFieldMeta,
  type OrderFileFieldMapping,
  type OrderFileImportField,
  type OrderFileImportTemplate,
} from "./order-file-import-templates";
import type { Workbook, Worksheet } from "./tabular-parser";

export type OrderFileMappedRow = {
  sourceRowNumber: number;
  values: Record<string, string>;
};

export type ResolvedOrderFileMapping = {
  field: OrderFileImportField;
  mapping: OrderFileFieldMapping;
  resolvedColumn: number | null;
  matchedHeader: string;
};

export type ParsedOrderFileImport = {
  sheetName: string;
  totalRowCount: number;
  rows: OrderFileMappedRow[];
  resolvedMappings: ResolvedOrderFileMapping[];
};

export async function readOrderFileImportWorkbook(file: File) {
  const { readActualShippingFeeWorkbook } = await import(
    "./actual-shipping-fee-workbook"
  );
  return readActualShippingFeeWorkbook(file);
}

function normalizeCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const pad = (number: number) => String(number).padStart(2, "0");
    return (
      [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join("-") +
      ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  return String(value).replace(/^\uFEFF/, "").trim();
}

export function normalizeTemuOrderImportValue(
  field: OrderFileImportField,
  value: string,
) {
  if (
    field === "actual_ship_time" &&
    ["--", "—", "－"].includes(value.trim())
  ) {
    return "";
  }
  return value;
}

function normalizeHeader(value: unknown) {
  return normalizeCell(value).toLowerCase().replace(/\s+/g, " ");
}

function getWorksheet(
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
  if (!worksheet) throw new Error("表格中没有可读取的工作表");
  return worksheet;
}

export function resolveHeaderColumn(
  worksheet: Worksheet,
  aliases: string[],
  startRow: number,
) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader).filter(Boolean));
  if (normalizedAliases.size === 0) {
    return { column: null, header: "" };
  }
  const headerRows = worksheet.data.slice(0, Math.max(0, startRow - 1));
  for (let rowIndex = headerRows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = headerRows[rowIndex] ?? [];
    const columnIndex = row.findIndex((cell) =>
      normalizedAliases.has(normalizeHeader(cell)),
    );
    if (columnIndex >= 0) {
      return {
        column: columnIndex + 1,
        header: normalizeCell(row[columnIndex]),
      };
    }
  }
  return { column: null, header: "" };
}

export function resolveOrderFileTemplateMappings(
  worksheet: Worksheet,
  template: Pick<
    OrderFileImportTemplate,
    "import_type" | "start_row" | "field_mappings"
  >,
): ResolvedOrderFileMapping[] {
  const startRow = Math.max(1, Math.trunc(template.start_row));
  return getOrderFileImportFieldMeta(template.import_type).map((field) => {
    const mapping = template.field_mappings[field.key];
    if (!mapping) {
      return {
        field: field.key,
        mapping: {
          sourceType: "column",
          column: null,
          fixedValue: "",
          headerAliases: [],
        },
        resolvedColumn: null,
        matchedHeader: "",
      };
    }
    if (mapping.sourceType === "fixed") {
      return {
        field: field.key,
        mapping,
        resolvedColumn: null,
        matchedHeader: "",
      };
    }
    if (mapping.sourceType === "column") {
      return {
        field: field.key,
        mapping,
        resolvedColumn: mapping.column,
        matchedHeader: "",
      };
    }
    const resolved = resolveHeaderColumn(
      worksheet,
      mapping.headerAliases,
      startRow,
    );
    return {
      field: field.key,
      mapping,
      resolvedColumn: resolved.column,
      matchedHeader: resolved.header,
    };
  });
}

function readMappedValue(
  row: Worksheet["data"][number],
  mapping: ResolvedOrderFileMapping,
) {
  if (mapping.mapping.sourceType === "fixed") {
    return mapping.mapping.fixedValue;
  }
  if (!mapping.resolvedColumn || mapping.resolvedColumn < 1) return "";
  return normalizeCell(row[mapping.resolvedColumn - 1]);
}

export function parseOrderFileImportWorkbook(
  workbook: Pick<Workbook, "worksheets">,
  template: OrderFileImportTemplate,
): ParsedOrderFileImport {
  const worksheet = getWorksheet(workbook, template);
  const startRow = Math.max(1, Math.trunc(template.start_row));
  const fieldMeta = getOrderFileImportFieldMeta(template.import_type);
  const resolvedMappings = resolveOrderFileTemplateMappings(
    worksheet,
    template,
  );
  const unresolvedRequiredField = fieldMeta.find((field) => {
    if (!field.required) return false;
    const resolved = resolvedMappings.find((item) => item.field === field.key);
    if (!resolved) return true;
    if (resolved.mapping.sourceType === "fixed") {
      return !resolved.mapping.fixedValue.trim();
    }
    return !resolved.resolvedColumn;
  });
  if (unresolvedRequiredField) {
    throw new Error(
      `模板无法在当前文件中读取必填字段“${unresolvedRequiredField.label}”，请检查工作表、开始行或字段映射。`,
    );
  }

  const rows = worksheet.data.slice(startRow - 1).flatMap((row, index) => {
    const values = Object.fromEntries(
      resolvedMappings.map((mapping) => [
        mapping.field,
        template.import_type === "orders"
          ? normalizeTemuOrderImportValue(
              mapping.field,
              readMappedValue(row, mapping),
            )
          : readMappedValue(row, mapping),
      ]),
    );
    if (!Object.values(values).some((value) => value.trim())) return [];
    return [{
      sourceRowNumber: startRow + index,
      values,
    }];
  });

  return {
    sheetName: worksheet.name,
    totalRowCount: rows.length,
    rows,
    resolvedMappings,
  };
}
