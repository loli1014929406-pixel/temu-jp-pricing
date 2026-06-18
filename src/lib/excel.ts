import type { Sheet, SheetData } from "write-excel-file/browser";
import type { Workbook, Worksheet } from "./tabular-parser";

export type { Workbook, Worksheet };

export function createWorkbookFromSheets(sheets: Worksheet[]): Workbook {
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

function toSpreadsheetCell(value: unknown) {
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

export async function createWorkbook(): Promise<Workbook> {
  return createWorkbookFromSheets([]);
}

export function addObjectSheet(
  workbook: Workbook,
  sheetName: string,
  rows: Record<string, unknown>[],
  options: { headers?: string[]; columnWidths?: number[] } = {},
) {
  const headers = getHeadersFromRows(rows, options.headers);
  const data = [
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

export async function readTabularFileObjects(file: File): Promise<Record<string, unknown>[]> {
  if (typeof window !== "undefined" && window.Worker) {
    return new Promise((resolve, reject) => {
      let worker: Worker | null = null;
      let handled = false;

      const cleanup = () => {
        if (worker) {
          worker.terminate();
          worker = null;
        }
      };

      try {
        worker = new Worker(new URL("../workers/excel.worker.ts", import.meta.url), { type: "module" });

        worker.onmessage = (e) => {
          if (handled) return;
          handled = true;
          cleanup();

          if (e.data.error) {
            reject(new Error(e.data.error));
          } else {
            resolve(e.data.result);
          }
        };

        worker.onmessageerror = async (e) => {
          if (handled) return;
          handled = true;
          cleanup();
          console.warn("Worker message error during execution. Falling back to main thread:", e);
          const { parseTabularFile } = await import("./tabular-parser");
          resolve(parseTabularFile(file));
        };

        worker.onerror = async (e) => {
          if (handled) return;
          handled = true;
          cleanup();
          console.warn("Worker error during instantiation/execution. Falling back to main thread:", e.message);
          const { parseTabularFile } = await import("./tabular-parser");
          resolve(parseTabularFile(file));
        };

        worker.postMessage({ file });
      } catch (err) {
        if (handled) return;
        handled = true;
        cleanup();
        console.warn("Worker creation failed. Falling back to main thread:", err);
        import("./tabular-parser").then(({ parseTabularFile }) => {
          resolve(parseTabularFile(file));
        }).catch(reject);
      }
    });
  }

  const { parseTabularFile } = await import("./tabular-parser");
  return parseTabularFile(file);
}
