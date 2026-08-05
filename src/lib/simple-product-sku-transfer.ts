import type { SimpleProductSkuInfoDraft } from "../types";
import { addObjectSheet, createWorkbook, readTabularFileObjects } from "./excel";

export const simpleProductSkuHeaders = [
  "商品编号",
  "SKU编号",
  "中文名称",
  "英文名称",
  "材质",
  "订货价格",
  "英文订货链接",
] as const;

const headerAliases: Record<string, keyof SimpleProductSkuInfoDraft> = {
  "商品编号": "product_code",
  "product_code": "product_code",
  SKU编号: "sku_code",
  sku编号: "sku_code",
  sku_code: "sku_code",
  中文名称: "product_name_cn",
  product_name_cn: "product_name_cn",
  英文名称: "product_name_en",
  product_name_en: "product_name_en",
  材质: "material",
  material: "material",
  订货价格: "purchase_price_rmb",
  purchase_price_rmb: "purchase_price_rmb",
  英文订货链接: "purchase_url",
  订货链接: "purchase_url",
  purchase_url: "purchase_url",
};

function valueText(value: unknown) {
  return String(value ?? "").trim();
}

function parsePrice(value: unknown) {
  if (typeof value === "number") return value;
  const text = valueText(value).replace(/,/g, "");
  if (!text) return Number.NaN;
  return Number(text);
}

function getSourceValue(source: Record<string, unknown>, field: keyof SimpleProductSkuInfoDraft) {
  const aliases = Object.entries(headerAliases)
    .filter(([, value]) => value === field)
    .map(([header]) => header);
  const sourceKey = Object.keys(source).find((key) => aliases.includes(key.trim()));
  return sourceKey ? source[sourceKey] : undefined;
}

export function getSimpleProductSkuValidation(data: unknown) {
  const errors: string[] = [];
  if (!Array.isArray(data) || data.length === 0) {
    return { valid: false, errors: ["文件中没有可导入的商品 SKU 数据"], records: [] };
  }

  const records: SimpleProductSkuInfoDraft[] = [];
  const seenSkuCodes = new Set<string>();
  data.forEach((raw, index) => {
    const source = raw as Record<string, unknown>;
    const productCode = getSourceValue(source, "product_code");
    const skuCode = getSourceValue(source, "sku_code");
    const productNameCn = getSourceValue(source, "product_name_cn");
    const productNameEn = getSourceValue(source, "product_name_en");
    const material = getSourceValue(source, "material");
    const purchasePrice = getSourceValue(source, "purchase_price_rmb");
    const purchaseUrl = getSourceValue(source, "purchase_url");
    const rowNumber = index + 2;
    const normalized: SimpleProductSkuInfoDraft = {
      product_code: valueText(productCode),
      sku_code: valueText(skuCode),
      product_name_cn: valueText(productNameCn),
      product_name_en: valueText(productNameEn),
      material: valueText(material),
      purchase_price_rmb: parsePrice(purchasePrice),
      purchase_url: valueText(purchaseUrl),
    };
    const required: Array<[keyof SimpleProductSkuInfoDraft, string]> = [
      ["product_code", "商品编号"],
      ["sku_code", "SKU编号"],
      ["product_name_cn", "中文名称"],
      ["product_name_en", "英文名称"],
      ["material", "材质"],
    ];
    required.forEach(([key, label]) => {
      if (!String(normalized[key] ?? "").trim()) errors.push(`第 ${rowNumber} 行缺少${label}`);
    });
    if (!Number.isFinite(normalized.purchase_price_rmb) || normalized.purchase_price_rmb < 0) {
      errors.push(`第 ${rowNumber} 行订货价格必须是大于等于 0 的数字`);
    }
    if (normalized.sku_code && seenSkuCodes.has(normalized.sku_code)) {
      errors.push(`第 ${rowNumber} 行 SKU编号“${normalized.sku_code}”在文件中重复`);
    }
    if (normalized.sku_code) seenSkuCodes.add(normalized.sku_code);
    records.push(normalized);
  });

  return { valid: errors.length === 0, errors, records };
}

export async function buildSimpleProductSkuTemplate() {
  const workbook = await createWorkbook();
  addObjectSheet(
    workbook,
    "简化商品SKU",
    [
      {
        商品编号: "示例商品编号",
        SKU编号: "示例SKU编号",
        中文名称: "示例中文名称",
        英文名称: "Example Product",
        材质: "Polyester",
        订货价格: 0,
        英文订货链接: "https://example.com/purchase",
      },
    ],
    { headers: [...simpleProductSkuHeaders], columnWidths: [18, 20, 24, 24, 20, 14, 44] },
  );
  addObjectSheet(
    workbook,
    "填写说明",
    [
      { 说明: "每一行对应一个 SKU，SKU编号在当前店铺内必须唯一。" },
      { 说明: "订货价格和英文订货链接按 SKU 填写，不会修改现有完整商品资料。" },
      { 说明: "删除示例行后填写真实数据；订货价格必须是大于等于 0 的数字。" },
    ],
    { headers: ["说明"], columnWidths: [80] },
  );
  return workbook;
}

export async function buildSimpleProductSkuExport(records: SimpleProductSkuInfoDraft[]) {
  const workbook = await createWorkbook();
  addObjectSheet(
    workbook,
    "简化商品SKU",
    records.map((record) => ({
      商品编号: record.product_code,
      SKU编号: record.sku_code,
      中文名称: record.product_name_cn,
      英文名称: record.product_name_en,
      材质: record.material,
      订货价格: record.purchase_price_rmb,
      英文订货链接: record.purchase_url,
    })),
    { headers: [...simpleProductSkuHeaders], columnWidths: [18, 20, 24, 24, 20, 14, 44] },
  );
  return workbook;
}

export async function parseSimpleProductSkuFile(file: File) {
  const rows = await readTabularFileObjects(file);
  return getSimpleProductSkuValidation(rows);
}
