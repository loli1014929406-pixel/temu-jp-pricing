import type { ProductTransferRecord } from "../types";

type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateTransferRecords(data: unknown): data is ProductTransferRecord[] {
  if (!Array.isArray(data)) return false;

  return data.every((record) => {
    if (typeof record !== "object" || record === null) return false;
    const candidate = record as Record<string, unknown>;
    return (
      typeof candidate.product_code === "string" &&
      typeof candidate.product_name_cn === "string" &&
      Array.isArray(candidate.items) &&
      Array.isArray(candidate.skus)
    );
  });
}

export function getTransferValidation(data: unknown): ValidationResult {
  if (!validateTransferRecords(data)) {
    return {
      valid: false,
      errors: ["文件结构不正确，缺少商品主信息、配件或 SKU 数据"],
    };
  }

  const errors: string[] = [];
  data.forEach((record, productIndex) => {
    if (record.items.length === 0) {
      errors.push(`第 ${productIndex + 1} 个商品没有配件`);
    }
    if (record.skus.length === 0) {
      errors.push(`第 ${productIndex + 1} 个商品没有 SKU`);
    }
    record.skus.forEach((sku, skuIndex) => {
      if (!sku.sku_code) {
        errors.push(`第 ${productIndex + 1} 个商品的第 ${skuIndex + 1} 个 SKU 没有编号`);
      }
      sku.component_links.forEach((link) => {
        if (link.item_index < 0 || link.item_index >= record.items.length) {
          errors.push(
            `第 ${productIndex + 1} 个商品的 SKU ${sku.sku_code || skuIndex + 1} 关联了不存在的配件`,
          );
        }
      });
    });
  });

  return { valid: errors.length === 0, errors };
}

export async function buildWorkbook(records: ProductTransferRecord[]) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  type DetailRow = {
    product_index: number;
    product_code: string;
    product_name_cn: string;
    combo_name: string;
    sku_index: number;
    sku_code: string;
    sku_attributes: string;
    item_name: string;
    item_spec: string;
    item_quantity: number | null;
    item_weight_g: number | null;
    purchase_price_rmb: number | null;
    purchase_shipping_fee_per_500g_rmb: number | null;
    purchase_url: string;
  };

  const productRows = records.map((record, product_index) => ({
    product_index,
    product_code: record.product_code,
    product_name_cn: record.product_name_cn,
    product_name_en: record.product_name_en,
    material_en: record.material_en,
    material_cn: record.material_cn,
    combo_name: record.combo_name,
    combo_description: record.combo_description,
    title_jp: record.title_jp,
    package_length_cm: record.package_length_cm,
    package_width_cm: record.package_width_cm,
    package_height_cm: record.package_height_cm,
    package_weight_g: record.package_weight_g,
    notes: record.notes,
  }));
  const itemRows = records.flatMap((record, product_index) =>
    record.items.map((item, item_index) => ({
      product_index,
      item_index,
      ...item,
    })),
  );
  const skuRows = records.flatMap((record, product_index) =>
    record.skus.map((sku, sku_index) => ({
      product_index,
      sku_index,
      sku_code: sku.sku_code,
      attributes_text: Object.entries(sku.attributes)
        .map(([name, value]) => `${name}:${value}`)
        .join(", "),
      attributes_json: JSON.stringify(sku.attributes),
      notes: sku.notes,
    })),
  );
  const linkRows = records.flatMap((record, product_index) =>
    record.skus.flatMap((sku, sku_index) =>
      sku.component_links.map((link) => ({
        product_index,
        sku_index,
        sku_code: sku.sku_code,
        item_index: link.item_index,
        item_name: record.items[link.item_index]?.item_name ?? "",
        item_spec: record.items[link.item_index]?.item_spec ?? "",
        quantity: link.quantity,
      })),
    ),
  );
  const previewRows = records.flatMap((record, product_index) =>
    record.skus.map((sku, sku_index) => ({
      product_index,
      product_code: record.product_code,
      product_name_cn: record.product_name_cn,
      product_name_en: record.product_name_en,
      material_en: record.material_en,
      material_cn: record.material_cn,
      sku_index,
      sku_code: sku.sku_code,
      attributes: Object.entries(sku.attributes)
        .map(([name, value]) => `${name}:${value}`)
        .join(", "),
      linked_items: sku.component_links
        .map((link) => {
          const item = record.items[link.item_index];
          return item
            ? `${item.item_name}${item.item_spec ? `(${item.item_spec})` : ""} x${link.quantity}`
            : "";
        })
        .filter(Boolean)
        .join("; "),
    })),
  );
  const detailRows: DetailRow[] = [];
  records.forEach((record, product_index) => {
    record.skus.forEach((sku, sku_index) => {
      const attributes = Object.entries(sku.attributes)
        .map(([name, value]) => `${name}:${value}`)
        .join(", ");
      const linkedRows = sku.component_links.map((link) => {
        const item = record.items[link.item_index];
        return {
          product_index,
          product_code: record.product_code,
          product_name_cn: record.product_name_cn,
          combo_name: record.combo_name,
          sku_index,
          sku_code: sku.sku_code,
          sku_attributes: attributes,
          item_name: item?.item_name ?? "",
          item_spec: item?.item_spec ?? "",
          item_quantity: link.quantity,
          item_weight_g: item?.item_weight_g ?? "",
          purchase_price_rmb: item?.purchase_price_rmb ?? "",
          purchase_shipping_fee_per_500g_rmb:
            item?.purchase_shipping_fee_per_500g_rmb ?? "",
          purchase_url: item?.purchase_url ?? "",
        };
      });

      if (linkedRows.length > 0) {
        detailRows.push(...linkedRows);
      } else {
        detailRows.push({
          product_index,
          product_code: record.product_code,
          product_name_cn: record.product_name_cn,
          combo_name: record.combo_name,
          sku_index,
          sku_code: sku.sku_code,
          sku_attributes: attributes,
          item_name: "",
          item_spec: "",
          item_quantity: null,
          item_weight_g: null,
          purchase_price_rmb: null,
          purchase_shipping_fee_per_500g_rmb: null,
          purchase_url: "",
        });
      }
    });
  });

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(detailRows),
    "商品明细",
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(productRows),
    "Products",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(itemRows),
    "Items",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(skuRows),
    "Skus",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(linkRows),
    "Links",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(previewRows),
    "Preview",
  );

  return workbook;
}

export async function parseTransferFile(file: File) {
  if (file.name.toLowerCase().endsWith(".json")) {
    return JSON.parse(await file.text()) as unknown;
  }

  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const products = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets.Products,
  );
  const items = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets.Items,
  );
  const skus = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets.Skus,
  );
  const links = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets.Links,
  );

  return products.map((product) => {
    const productIndex = Number(product.product_index);
    const { product_index, ...productFields } = product;
    void product_index;
    return {
      ...productFields,
      combo_name: String(productFields.combo_name ?? productFields.product_name_cn ?? ""),
      combo_description: String(
        productFields.combo_description ??
          productFields.combo_name ??
          productFields.product_name_cn ??
          "",
      ),
      title_jp: String(productFields.title_jp ?? productFields.product_name_cn ?? ""),
      product_name_en: String(productFields.product_name_en ?? ""),
      material_en: String(productFields.material_en ?? ""),
      material_cn: String(productFields.material_cn ?? ""),
      items: items
        .filter((item) => Number(item.product_index) === productIndex)
        .map(({ product_index: itemProductIndex, item_index, ...item }) => {
          void itemProductIndex;
          void item_index;
          return item;
        }),
      skus: skus
        .filter((sku) => Number(sku.product_index) === productIndex)
        .map((sku) => {
          const skuIndex = Number(sku.sku_index);
          return {
            sku_code: String(sku.sku_code ?? ""),
            attributes: JSON.parse(String(sku.attributes_json ?? "{}")) as Record<
              string,
              string
            >,
            notes: String(sku.notes ?? ""),
            component_links: links
              .filter(
                (link) =>
                  Number(link.product_index) === productIndex &&
                  Number(link.sku_index) === skuIndex,
              )
              .map((link) => ({
                item_index: Number(link.item_index),
                quantity: Number(link.quantity),
              })),
          };
        }),
    };
  });
}
