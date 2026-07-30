import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { createWorkbookFromSheets, type Workbook, type Worksheet } from "./tabular-parser";

XLSX.set_cptable(cptable);

const supportedExtensions = new Set(["csv", "xls", "xlsx"]);

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function workbookFromSheetJs(source: XLSX.WorkBook): Workbook {
  const worksheets: Worksheet[] = source.SheetNames.map((name) => ({
    name,
    data: XLSX.utils.sheet_to_json(source.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    }) as Worksheet["data"],
  }));
  return createWorkbookFromSheets(worksheets);
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function readActualShippingFeeWorkbookBytes(
  bytes: Uint8Array,
  fileName: string,
): Workbook {
  const extension = getExtension(fileName);
  if (!supportedExtensions.has(extension)) {
    throw new Error("仅支持 CSV、XLS、XLSX 文件");
  }

  if (extension === "csv") {
    const utf8Text = decodeUtf8(bytes);
    const source = utf8Text !== null
      ? XLSX.read(utf8Text.replace(/^\uFEFF/, ""), { type: "string", raw: true })
      : XLSX.read(bytes, { type: "array", codepage: 932, raw: true });
    return workbookFromSheetJs(source);
  }

  return workbookFromSheetJs(
    XLSX.read(bytes, {
      type: "array",
      raw: true,
      cellDates: false,
      codepage: 932,
    }),
  );
}
export async function readActualShippingFeeWorkbook(file: File) {
  return readActualShippingFeeWorkbookBytes(
    new Uint8Array(await file.arrayBuffer()),
    file.name,
  );
}
