import readXlsxFile from "read-excel-file/web-worker";

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

export function createWorkbookFromSheets(sheets: Worksheet[]): Workbook {
  return {
    sheets,
    worksheets: sheets,
    getWorksheet(sheetName: string) {
      return sheets.find((sheet) => sheet.name === sheetName);
    },
  };
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

function normalizeHeaderCell(value: SpreadsheetCell) {
  return String(normalizeCellValue(value) ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function getNonEmptyCellCount(row: SpreadsheetRow) {
  return row.filter((cell) => String(normalizeCellValue(cell) ?? "").trim()).length;
}

function findHeaderRowIndex(rows: SpreadsheetRow[]) {
  let bestIndex = -1;
  let bestCount = 0;

  rows.slice(0, 30).forEach((row, index) => {
    const count = getNonEmptyCellCount(row);
    if (count > bestCount) {
      bestIndex = index;
      bestCount = count;
    }
  });

  return bestIndex >= 0 ? bestIndex : 0;
}

export function worksheetToObjects(worksheet: Worksheet): Record<string, unknown>[] {
  const headerRowIndex = findHeaderRowIndex(worksheet.data);
  const headerRow = worksheet.data[headerRowIndex] ?? [];
  const dataRows = worksheet.data.slice(headerRowIndex + 1);
  const headers = headerRow.map(normalizeHeaderCell);

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
  const sheets = await readXlsxFile(file);
  return createWorkbookFromSheets(
    sheets.map((sheet) => ({
      name: sheet.sheet,
      data: sheet.data as SpreadsheetRow[],
    })),
  );
}

function countUnquotedDelimiters(line: string, delimiter: string) {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];
    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) count += 1;
  }

  return count;
}

function detectDelimitedTextSeparator(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
  const delimiters = [",", "\t", ";"] as const;
  const scores = delimiters.map((delimiter) => ({
    delimiter,
    score: lines.reduce(
      (total, line) => total + countUnquotedDelimiters(line, delimiter),
      0,
    ),
  }));

  return scores.sort((left, right) => right.score - left.score)[0]?.delimiter ?? ",";
}

export function parseCsvRows(text: string, delimiter = detectDelimitedTextSeparator(text)) {
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
    if (char === delimiter && !inQuotes) {
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

export async function parseTabularFile(file: File) {
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    const rows = parseCsvRows(await file.text());
    return worksheetToObjects({ name: file.name, data: rows });
  }

  const workbook = await readXlsxWorkbook(file);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel 文件里没有可读取的工作表");
  return worksheetToObjects(worksheet);
}
