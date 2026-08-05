import { describe, expect, it } from "vitest";
import { getSimpleProductSkuValidation } from "./simple-product-sku-transfer";

describe("simple product SKU transfer", () => {
  it("accepts Chinese template headers and keeps price numeric", () => {
    const result = getSimpleProductSkuValidation([
      {
        商品编号: "zn016",
        SKU编号: "zn016-black",
        中文名称: "运动护腕",
        英文名称: "Sports Wristband",
        材质: "Polyester",
        订货价格: "2.50",
        英文订货链接: "https://example.com/black",
      },
    ]);

    expect(result.valid).toBe(true);
    expect(result.records[0]).toMatchObject({
      product_code: "zn016",
      sku_code: "zn016-black",
      purchase_price_rmb: 2.5,
      purchase_url: "https://example.com/black",
    });
  });

  it("rejects duplicate SKU codes in one upload", () => {
    const result = getSimpleProductSkuValidation([
      {
        商品编号: "zn016",
        SKU编号: "same-sku",
        中文名称: "商品",
        英文名称: "Product",
        材质: "Polyester",
        订货价格: 1,
      },
      {
        商品编号: "zn017",
        SKU编号: "same-sku",
        中文名称: "商品二",
        英文名称: "Product Two",
        材质: "Cotton",
        订货价格: 2,
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("第 3 行 SKU编号“same-sku”在文件中重复");
  });

  it("rejects missing required fields and invalid prices", () => {
    const result = getSimpleProductSkuValidation([
      { 商品编号: "zn016", SKU编号: "sku-1", 订货价格: "not-a-number" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "第 2 行缺少中文名称",
      "第 2 行缺少英文名称",
      "第 2 行缺少材质",
      "第 2 行订货价格必须是大于等于 0 的数字",
    ]));
  });
});
