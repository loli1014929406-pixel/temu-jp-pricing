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

function getDecodedTextScore(workbook: XLSX.WorkBook) {
  const text = workbook.SheetNames.map((name) =>
    JSON.stringify(
      XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        raw: true,
        defval: "",
        blankrows: true,
      }),
    ),
  ).join("\n");

  // Wrong legacy-codepage guesses commonly produce replacement/private-use
  // characters. Penalize those so GBK and Shift-JIS files can be selected
  // without asking the user to configure an encoding manually.
  return (
    (text.match(/[\uFFFD\uF8FF]/g)?.length ?? 0) * 1000 +
    (text.match(/[\uFF61-\uFF9F]/g)?.length ?? 0)
  );
}

function readLegacyCsv(bytes: Uint8Array) {
  const candidates = ["shift_jis", "gb18030"].map((encoding) => {
    const text = new TextDecoder(encoding).decode(bytes);
    const source = XLSX.read(text, { type: "string", raw: true });
    return { source, score: getDecodedTextScore(source) };
  });

  return candidates.sort((left, right) => left.score - right.score)[0].source;
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
      : readLegacyCsv(bytes);
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
