import type { TemuOrderImportRow } from "./orders";
import { requireSession, withTimeout } from "./supabase-helpers";

export type OrderFileImportKind =
  | "orders"
  | "tracking"
  | "temu_upload"
  | "shipping_export";
export type OrderFileMappingSource = "column" | "fixed" | "header";
export type TemuOrderImportField = keyof TemuOrderImportRow;
export type TrackingFileImportField =
  | "order_no"
  | "sub_order_no"
  | "tracking_no";
export type TemuUploadExportField =
  | "order_no"
  | "sub_order_no"
  | "fulfillment_quantity"
  | "tracking_no"
  | "carrier"
  | "warehouse_name";
export type ShippingExportField =
  | "shipment_recipient_name"
  | "shipment_address"
  | "shipment_postal_code"
  | "shipment_phone"
  | "shipment_package_count"
  | "shipment_destination"
  | "shipment_order_no"
  | "shipment_service_type"
  | "shipment_store_name"
  | "shipment_store_note"
  | "shipment_sender_name"
  | "shipment_sender_address"
  | "shipment_sender_phone"
  | "shipment_sender_postal_code"
  | "shipment_store"
  | "shipment_custom_weight"
  | "shipment_has_battery"
  | "shipment_platform_name"
  | "shipment_sales_unit"
  | "shipment_sales_unit_code"
  | "item_order_no"
  | "item_code"
  | "item_name"
  | "item_description"
  | "item_quantity"
  | "item_unit_price"
  | "item_currency"
  | "item_compilation_method"
  | "item_hs_code"
  | "item_origin_country"
  | "item_shelf_no"
  | "item_purchase_no"
  | "item_style_color"
  | "item_customer_note"
  | "item_url"
  | "item_primary_key"
  | "item_domestic_declared_value"
  | "item_domestic_currency";
export type OrderFileImportField =
  | TemuOrderImportField
  | TrackingFileImportField
  | TemuUploadExportField
  | ShippingExportField;

export type OrderFileFieldMapping = {
  sourceType: OrderFileMappingSource;
  column: number | null;
  fixedValue: string;
  headerAliases: string[];
  worksheetName?: string;
};

export type OrderFileImportTemplate = {
  id: string;
  user_id: string;
  import_type: OrderFileImportKind;
  name: string;
  worksheet_name: string;
  start_row: number;
  field_mappings: Record<string, OrderFileFieldMapping>;
  is_system: boolean;
  system_key: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderFileImportTemplateInput = Pick<
  OrderFileImportTemplate,
  "import_type" | "name" | "worksheet_name" | "start_row" | "field_mappings"
>;

export type OrderFileImportFieldMeta = {
  key: OrderFileImportField;
  label: string;
  required: boolean;
  worksheetName?: string;
};

export const orderImportColumnAliases = {
  order_no: ["订单号", "主订单号", "订单编号", "订单ID", "Order ID"],
  sub_order_no: ["子订单号", "子订单编号", "子订单ID", "Sub Order ID", "Sub-order ID"],
  order_status: ["订单状态", "状态", "Order Status"],
  sku_code: ["SKU货号", "SKU 货号", "SKU", "SKU ID", "商品SKU", "商家SKU"],
  fulfillment_quantity: ["应履约件数", "商品数量", "数量", "购买数量", "件数", "商品件数"],
  product_attributes: ["商品属性", "商品规格", "销售属性", "SKU属性", "规格"],
  recipient_name: [
    "收货人姓名",
    "收件人姓名",
    "收货人",
    "收件人",
    "CONSIGNEE_NAME",
    "CONSIGNEE NAME",
    "Recipient Name",
  ],
  recipient_phone: [
    "收货人联系方式",
    "收件人联系方式",
    "收货电话",
    "收件电话",
    "联系电话",
    "电话",
    "CONTACT_TEL",
    "CONTACT TEL",
    "Recipient Phone",
  ],
  email: ["邮箱", "电子邮箱", "Email", "E-mail"],
  province: ["省份", "都道府县", "都道府県", "州/省", "Province"],
  city: ["城市", "市区町村", "市", "City"],
  district: ["区县", "区町村", "区", "District"],
  address_line1: [
    "详细地址1",
    "详细地址 1",
    "地址1",
    "收货地址1",
    "收件地址1",
    "收件人地址",
    "收货地址",
    "地址",
    "住所1",
    "DELIVERY_ADDR_JP",
    "DELIVERY ADDR JP",
  ],
  address_line2: ["详细地址2", "详细地址 2", "地址2", "收货地址2", "收件地址2", "住所2"],
  postal_code: [
    "收货地址邮编",
    "邮编",
    "收件邮编",
    "收货邮编",
    "郵便番号",
    "POSTCODE",
    "Postal Code",
    "Zip Code",
  ],
  latest_ship_time: ["要求最晚发货时间", "最晚发货时间", "发货截止时间", "Latest Ship Time"],
  actual_ship_time: ["实际发货时间", "Actual Ship Time"],
  estimated_delivery_time: ["预计送达时间", "预计送达日期", "Estimated Delivery Time"],
} satisfies Record<TemuOrderImportField, readonly string[]>;

export const trackingImportColumnAliases = {
  order_no: ["订单号", "主订单号", "REF_NO", "REF NO", "Order ID"],
  sub_order_no: ["子订单号", "子订单编号", "Sub Order ID", "Sub-order ID"],
  tracking_no: [
    "CWB_NO",
    "CWB NO",
    "跟踪单号",
    "物流单号",
    "运单号",
    "单号",
    "お問い合わせ番号",
    "Tracking No",
    "Tracking Number",
  ],
} satisfies Record<TrackingFileImportField, readonly string[]>;

const optionalOrderFields = new Set<TemuOrderImportField>([
  "sub_order_no",
  "sku_code",
  "fulfillment_quantity",
  "product_attributes",
]);

const orderFieldLabels = {
  order_no: "订单号",
  sub_order_no: "子订单号",
  order_status: "订单状态",
  sku_code: "SKU货号",
  fulfillment_quantity: "应履约件数",
  product_attributes: "商品属性",
  recipient_name: "收货人姓名",
  recipient_phone: "收货人联系方式",
  email: "邮箱",
  province: "省份",
  city: "城市",
  district: "区县",
  address_line1: "详细地址1",
  address_line2: "详细地址2",
  postal_code: "收货地址邮编",
  latest_ship_time: "要求最晚发货时间",
  actual_ship_time: "实际发货时间",
  estimated_delivery_time: "预计送达时间",
} satisfies Record<TemuOrderImportField, string>;

export const orderFileImportFieldMeta: OrderFileImportFieldMeta[] = (
  Object.keys(orderImportColumnAliases) as TemuOrderImportField[]
).map((key) => ({
  key,
  label: orderFieldLabels[key],
  required: !optionalOrderFields.has(key),
}));

export const trackingFileImportFieldMeta: OrderFileImportFieldMeta[] = [
  { key: "order_no", label: "订单号", required: true },
  { key: "sub_order_no", label: "子订单号（拆包时必填）", required: false },
  { key: "tracking_no", label: "物流单号", required: true },
];

export const temuUploadExportColumnAliases = {
  order_no: ["订单号"],
  sub_order_no: ["子订单号"],
  fulfillment_quantity: ["商品件数"],
  tracking_no: ["跟踪单号"],
  carrier: ["物流承运商"],
  warehouse_name: ["发货仓库名称"],
} satisfies Record<TemuUploadExportField, string[]>;

export const temuUploadExportFieldMeta: OrderFileImportFieldMeta[] = [
  { key: "order_no", label: "订单号", required: true },
  { key: "sub_order_no", label: "子订单号", required: true },
  { key: "fulfillment_quantity", label: "商品件数", required: true },
  { key: "tracking_no", label: "跟踪单号", required: true },
  { key: "carrier", label: "物流承运商", required: true },
  { key: "warehouse_name", label: "发货仓库名称", required: true },
];

const shippingSheet1Fields = [
  ["shipment_recipient_name", "收件人"],
  ["shipment_address", "收件人地址"],
  ["shipment_postal_code", "收件邮编"],
  ["shipment_phone", "收件电话"],
  ["shipment_package_count", "件数"],
  ["shipment_destination", "目的地(可以都填TYO)"],
  ["shipment_order_no", "订单号"],
  ["shipment_service_type", "服务类型(不填写默认B2C)"],
  ["shipment_store_name", "店铺名称"],
  ["shipment_store_note", "店铺备注"],
  ["shipment_sender_name", "发件人"],
  ["shipment_sender_address", "发件人地址"],
  ["shipment_sender_phone", "发件人电话"],
  ["shipment_sender_postal_code", "发件人邮编"],
  ["shipment_store", "店铺"],
  ["shipment_custom_weight", "自定义重量"],
  ["shipment_has_battery", "是否带电(0:不带电/1:带电)"],
  ["shipment_platform_name", "平台名称"],
  ["shipment_sales_unit", "生产销售单位"],
  ["shipment_sales_unit_code", "生产销售单位统一编码"],
] as const satisfies ReadonlyArray<readonly [ShippingExportField, string]>;

const shippingSheet2Fields = [
  ["item_order_no", "订单号"],
  ["item_code", "商品代码"],
  ["item_name", "品名"],
  ["item_description", "描述"],
  ["item_quantity", "商品数量"],
  ["item_unit_price", "单价"],
  ["item_currency", "币值"],
  ["item_compilation_method", "编制方式"],
  ["item_hs_code", "HS_CODE"],
  ["item_origin_country", "原产国"],
  ["item_shelf_no", "货架号"],
  ["item_purchase_no", "采购编号"],
  ["item_style_color", "样式颜色"],
  ["item_customer_note", "客户备注"],
  ["item_url", "URL"],
  ["item_primary_key", "PRIMARYKEY"],
  ["item_domestic_declared_value", "国内申报价值"],
  ["item_domestic_currency", "国内申报币值"],
] as const satisfies ReadonlyArray<readonly [ShippingExportField, string]>;

export const shippingExportColumnAliases = Object.fromEntries([
  ...shippingSheet1Fields,
  ...shippingSheet2Fields,
].map(([key, label]) => [key, [label]])) as Record<
  ShippingExportField,
  string[]
>;

export const shippingExportFieldMeta: OrderFileImportFieldMeta[] = [
  ...shippingSheet1Fields.map(([key, label]) => ({
    key,
    label,
    required: true,
    worksheetName: "Sheet1",
  })),
  ...shippingSheet2Fields.map(([key, label]) => ({
    key,
    label,
    required: true,
    worksheetName: "Sheet2",
  })),
];

export function getOrderFileImportFieldMeta(kind: OrderFileImportKind) {
  if (kind === "orders") return orderFileImportFieldMeta;
  if (kind === "tracking") return trackingFileImportFieldMeta;
  if (kind === "temu_upload") return temuUploadExportFieldMeta;
  return shippingExportFieldMeta;
}

export function getOrderFileImportColumnAliases(
  kind: OrderFileImportKind,
  field: OrderFileImportField,
) {
  if (kind === "orders") {
    return orderImportColumnAliases[field as TemuOrderImportField] ?? [];
  }
  if (kind === "tracking") {
    return trackingImportColumnAliases[field as TrackingFileImportField] ?? [];
  }
  if (kind === "temu_upload") {
    return temuUploadExportColumnAliases[field as TemuUploadExportField] ?? [];
  }
  return shippingExportColumnAliases[field as ShippingExportField] ?? [];
}

export function createEmptyOrderFileMapping(
  worksheetName = "",
): OrderFileFieldMapping {
  return {
    sourceType: "column",
    column: null,
    fixedValue: "",
    headerAliases: [],
    worksheetName,
  };
}

export function createEmptyOrderFileTemplate(
  kind: OrderFileImportKind,
  worksheetName = "",
): OrderFileImportTemplateInput {
  return {
    import_type: kind,
    name: "",
    worksheet_name: worksheetName,
    start_row: 2,
    field_mappings: Object.fromEntries(
      getOrderFileImportFieldMeta(kind).map((field) => [
        field.key,
        createEmptyOrderFileMapping(field.worksheetName),
      ]),
    ),
  };
}

function normalizeMapping(value: unknown): OrderFileFieldMapping {
  const mapping = value && typeof value === "object"
    ? value as Partial<OrderFileFieldMapping>
    : {};
  const sourceType =
    mapping.sourceType === "fixed" || mapping.sourceType === "header"
      ? mapping.sourceType
      : "column";
  return {
    sourceType,
    column:
      typeof mapping.column === "number" && Number.isFinite(mapping.column)
        ? Math.max(1, Math.trunc(mapping.column))
        : null,
    fixedValue: String(mapping.fixedValue ?? ""),
    headerAliases: Array.isArray(mapping.headerAliases)
      ? mapping.headerAliases.map((alias) => String(alias).trim()).filter(Boolean)
      : [],
    worksheetName: String(mapping.worksheetName ?? ""),
  };
}

function normalizeTemplate(
  row: Partial<OrderFileImportTemplate>,
): OrderFileImportTemplate {
  const kind: OrderFileImportKind =
    row.import_type === "tracking" ||
    row.import_type === "temu_upload" ||
    row.import_type === "shipping_export"
      ? row.import_type
      : "orders";
  const rawMappings =
    row.field_mappings && typeof row.field_mappings === "object"
      ? row.field_mappings
      : {};
  const mappings = Object.fromEntries(
    getOrderFileImportFieldMeta(kind).map((field) => [
      field.key,
      normalizeMapping(rawMappings[field.key]),
    ]),
  );
  return {
    id: String(row.id ?? ""),
    user_id: String(row.user_id ?? ""),
    import_type: kind,
    name: String(row.name ?? ""),
    worksheet_name: String(row.worksheet_name ?? ""),
    start_row: Math.max(1, Number(row.start_row ?? 2)),
    field_mappings: mappings,
    is_system: Boolean(row.is_system),
    system_key: String(row.system_key ?? ""),
    deleted_at: row.deleted_at ? String(row.deleted_at) : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

const templateSelect = [
  "id",
  "user_id",
  "import_type",
  "name",
  "worksheet_name",
  "start_row",
  "field_mappings",
  "is_system",
  "system_key",
  "deleted_at",
  "created_at",
  "updated_at",
].join(", ");

export async function ensureDefaultOrderFileImportTemplates(
  kind?: OrderFileImportKind,
) {
  const { supabase } = await requireSession();
  const { error } = await withTimeout(
    supabase.rpc("ensure_temu_order_file_import_default_templates"),
    "初始化订单文件默认模板",
    { requestKind: "rpc" },
  );
  if (error && !["42883", "PGRST202"].includes(error.code ?? "")) throw error;
  if (kind === "temu_upload") {
    const { error: exportError } = await withTimeout(
      supabase.rpc("ensure_temu_upload_export_default_template"),
      "初始化下载上传表格默认模板",
      { requestKind: "rpc" },
    );
    if (
      exportError &&
      !["42883", "PGRST202"].includes(exportError.code ?? "")
    ) {
      throw exportError;
    }
  }

  if (kind === "shipping_export") {
    const { error: shippingError } = await withTimeout(
      supabase.rpc("ensure_shipping_export_default_template"),
      "初始化下载发货表格默认模板",
      { requestKind: "rpc" },
    );
    if (
      shippingError &&
      !["42883", "PGRST202"].includes(shippingError.code ?? "")
    ) {
      throw shippingError;
    }
  }
}

export async function fetchOrderFileImportTemplates(
  kind: OrderFileImportKind,
) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("temu_order_file_import_templates")
      .select(templateSelect)
      .eq("import_type", kind)
      .is("deleted_at", null)
      .order("is_system", { ascending: false })
      .order("updated_at", { ascending: false }),
    "加载订单文件导入模板",
  );
  if (error) {
    if (["42P01", "PGRST205"].includes(error.code ?? "")) {
      throw new Error("订单文件模板数据库尚未初始化，请先执行最新 Supabase migration。");
    }
    throw error;
  }
  return (data ?? []).map((row) =>
    normalizeTemplate(row as Partial<OrderFileImportTemplate>),
  );
}

export async function saveOrderFileImportTemplate(
  input: OrderFileImportTemplateInput,
  templateId?: string,
) {
  const { supabase, session } = await requireSession();
  const payload = {
    ...input,
    name: input.name.trim(),
    worksheet_name: input.worksheet_name.trim(),
  };
  const query = templateId
    ? supabase
        .from("temu_order_file_import_templates")
        .update(payload)
        .eq("id", templateId)
    : supabase
        .from("temu_order_file_import_templates")
        .insert({ ...payload, user_id: session.user.id });
  const { data, error } = await withTimeout(
    query.select(templateSelect).single(),
    templateId ? "更新订单文件导入模板" : "新增订单文件导入模板",
  );
  if (error) throw error;
  return normalizeTemplate(data as Partial<OrderFileImportTemplate>);
}

export async function deleteOrderFileImportTemplate(
  template: Pick<OrderFileImportTemplate, "id" | "is_system">,
) {
  const { supabase } = await requireSession();
  const query = template.is_system
    ? supabase
        .from("temu_order_file_import_templates")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", template.id)
    : supabase
        .from("temu_order_file_import_templates")
        .delete()
        .eq("id", template.id);
  const { error } = await withTimeout(query, "删除订单文件导入模板");
  if (error) throw error;
}
