import type { Sheet, SheetData } from "write-excel-file/browser";

type SpreadsheetCell = string | number | boolean | Date | null | undefined;
type SpreadsheetRow = SpreadsheetCell[];

export type Worksheet = {
  name: string;
  data: SpreadsheetRow[];
  columnWidths?: number[];
};

export type Workbook = {
  sheets: Worksheet[];
  worksheets: Worksheet[];
  getWorksheet: (sheetName: string) => Worksheet | undefined;
};

function createWorkbookFromSheets(sheets: Worksheet[]): Workbook {
  return {
    sheets,
    worksheets: sheets,
    getWorksheet(sheetName: string) {
      return sheets.find((sheet) => sheet.name === sheetName);
    },
  };
}

function getHeadersFromRows(rows: Record<string, unknown>[], headers?: string[]) {
  return headers ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function toSpreadsheetCell(value: unknown): SpreadsheetCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

export async function createWorkbook() {
  return createWorkbookFromSheets([]);
}

export function addObjectSheet(
  workbook: Workbook,
  sheetName: string,
  rows: Record<string, unknown>[],
  options: { headers?: string[]; columnWidths?: number[] } = {},
) {
  const headers = getHeadersFromRows(rows, options.headers);
  const data: SpreadsheetRow[] = [
    headers,
    ...rows.map((row) => headers.map((header) => toSpreadsheetCell(row[header]))),
  ];
  const worksheet: Worksheet = {
    name: sheetName,
    data,
    columnWidths:
      options.columnWidths ??
      headers.map((header) => Math.max(12, Math.min(header.length + 6, 32))),
  };
  workbook.sheets.push(worksheet);
  return worksheet;
}

export async function downloadWorkbook(workbook: Workbook, filename: string) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const sheets: Sheet<Blob>[] = workbook.sheets.map((sheet) => ({
    sheet: sheet.name,
    data: sheet.data as SheetData,
    columns: sheet.columnWidths?.map((width) => ({ width })),
  }));
  await writeXlsxFile(sheets).toFile(filename);
}

function formatDateCell(value: Date) {
  const pad = (number: number) => String(number).padStart(2, "0");
  return (
    [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join("-") +
    ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  );
}

function normalizeCellValue(value: SpreadsheetCell) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDateCell(value);
  return value;
}

export function worksheetToObjects(worksheet: Worksheet) {
  const [headerRow = [], ...dataRows] = worksheet.data;
  const headers = headerRow.map((cell) =>
    String(normalizeCellValue(cell) ?? "").trim(),
  );

  return dataRows.flatMap((row) => {
    const objectRow = Object.fromEntries(
      headers.flatMap((header, index) =>
        header ? [[header, normalizeCellValue(row[index])]] : [],
      ),
    );
    return Object.values(objectRow).some((value) => String(value ?? "").trim())
      ? [objectRow]
      : [];
  });
}

export async function readXlsxWorkbook(file: File) {
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const sheets = await readXlsxFile(file);
  return createWorkbookFromSheets(
    sheets.map((sheet) => ({
      name: sheet.sheet,
      data: sheet.data as SpreadsheetRow[],
    })),
  );
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];
    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        value += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }
    value += char;
  }

  row.push(value);
  rows.push(row);
  return rows.filter((csvRow) => csvRow.some((cell) => cell.trim()));
}

export async function readTabularFileObjects(file: File) {
  if (file.name.toLowerCase().endsWith(".csv")) {
    const rows = parseCsvRows(await file.text());
    const headers =
      rows[0]?.map((header, index) =>
        (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim(),
      ) ?? [];
    return rows.slice(1).map((row) =>
      Object.fromEntries(
        headers.flatMap((header, index) =>
          header ? [[header, row[index] ?? ""]] : [],
        ),
      ),
    );
  }

  const workbook = await readXlsxWorkbook(file);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel 文件里没有可读取的工作表");
  return worksheetToObjects(worksheet);
}
