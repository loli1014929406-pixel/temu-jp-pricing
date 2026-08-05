import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readActualShippingFeeWorkbookBytes } from "./actual-shipping-fee-workbook";

describe("readActualShippingFeeWorkbookBytes", () => {
  it("reads a UTF-8 CSV workbook", () => {
    const workbook = readActualShippingFeeWorkbookBytes(
      new TextEncoder().encode("物流单号,实际运费\n628656895230,9.317"),
      "运费.csv",
    );

    expect(workbook.worksheets[0].data).toEqual([
      ["物流单号", "实际运费"],
      ["628656895230", "9.317"],
    ]);
  });

  it("reads a GBK CSV workbook used by Chinese ecommerce exports", () => {
    const workbook = readActualShippingFeeWorkbookBytes(
      // “订单号,商品名称\nPO-1,蓝色” encoded as GBK.
      new Uint8Array([
        0xB6, 0xA9, 0xB5, 0xA5, 0xBA, 0xC5, 0x2C, 0xC9, 0xCC, 0xC6,
        0xB7, 0xC3, 0xFB, 0xB3, 0xC6, 0x0A, 0x50, 0x4F, 0x2D, 0x31, 0x2C, 0xC0,
        0xB6, 0xC9, 0xAB,
      ]),
      "订单.csv",
    );

    expect(workbook.worksheets[0].data).toEqual([
      ["订单号", "商品名称"],
      ["PO-1", "蓝色"],
    ]);
  });

  it.each(["xls", "xlsx"] as const)("reads an %s workbook", (extension) => {
    const source = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      source,
      XLSX.utils.aoa_to_sheet([
        ["物流单号", "实际运费"],
        ["628656895230", 9.317],
      ]),
      "运费",
    );
    const bytes = XLSX.write(source, {
      type: "array",
      bookType: extension,
    }) as Uint8Array;

    const workbook = readActualShippingFeeWorkbookBytes(bytes, `运费.${extension}`);

    expect(workbook.worksheets[0].name).toBe("运费");
    expect(workbook.worksheets[0].data[1]).toEqual(["628656895230", 9.317]);
  });

  it("rejects unsupported files", () => {
    expect(() =>
      readActualShippingFeeWorkbookBytes(new Uint8Array(), "运费.txt"),
    ).toThrow("仅支持 CSV、XLS、XLSX 文件");
  });
});
