import { getSupabaseClient } from "./supabase";
import type {
  Product,
  ProductDraft,
  ProductItem,
  ProductSku,
  ProductSkuDraft,
  ProductSkuDraftLink,
  ProductSkuItemLink,
  ProductWarehouseShippingLimit,
  ProductTransferRecord,
  SavedProfitCalculation,
} from "../types";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";
import { upsertProductWarehouseShippingLimits } from "./product-warehouse-shipping-limits";
import { withTimeout } from "./supabase-helpers";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FetchProductsOptions = {
  includeNotSelling?: boolean;
};

async function requireSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  return { supabase, session };
}

function normalizeProductDraft(product: ProductDraft): ProductDraft {
  const productNameCn = product.product_name_cn.trim();
  const comboName = product.combo_name.trim() || productNameCn;
  const comboDescription = product.combo_description.trim() || comboName || productNameCn;
  const titleJp = product.title_jp.trim() || productNameCn;
  const maxUnitsPerParcel = Math.max(
    1,
    Math.trunc(Number(product.max_units_per_parcel) || 1),
  );

  return {
    ...product,
    product_code: product.product_code.trim(),
    product_name_cn: productNameCn,
    product_name_en: product.product_name_en.trim(),
    material_en: product.material_en.trim(),
    material_cn: product.material_cn.trim(),
    combo_name: comboName,
    combo_description: comboDescription,
    title_jp: titleJp,
    is_selling: product.is_selling !== false,
    max_units_per_parcel: maxUnitsPerParcel,
  };
}

function normalizeProductRow(row: Partial<Product>): Product {
  return {
    id: String(row.id ?? ""),
    owner_id: String(row.owner_id ?? ""),
    product_code: String(row.product_code ?? ""),
    product_name_cn: String(row.product_name_cn ?? ""),
    product_name_en: String(row.product_name_en ?? ""),
    material_en: String(row.material_en ?? ""),
    material_cn: String(row.material_cn ?? ""),
    combo_name: String(row.combo_name ?? ""),
    combo_description: String(row.combo_description ?? ""),
    title_jp: String(row.title_jp ?? ""),
    package_length_cm: Number(row.package_length_cm ?? 0),
    package_width_cm: Number(row.package_width_cm ?? 0),
    package_height_cm: Number(row.package_height_cm ?? 0),
    package_weight_g: Number(row.package_weight_g ?? 0),
    max_units_per_parcel: Math.max(
      1,
      Math.trunc(Number(row.max_units_per_parcel) || 1),
    ),
    is_selling: row.is_selling !== false,
    notes: row.notes ?? "",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function isMissingProductSellingColumnError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return message.includes("is_selling");
}

function isMissingTemuImageColumnError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return message.includes("temu_image_url");
}

function normalizeSkuRow<T extends Partial<ProductSku>>(sku: T): T & { temu_image_url: string } {
  return {
    ...sku,
    temu_image_url: String(sku.temu_image_url ?? ""),
  };
}

function withoutSkuTemuImageUrl<T extends Partial<ProductSku>>(sku: T) {
  const { temu_image_url, ...legacySku } = sku;
  void temu_image_url;
  return legacySku;
}

function isMissingProductParcelCapacityColumnError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return message.includes("max_units_per_parcel");
}

function withoutProductParcelCapacity<T extends Partial<ProductDraft>>(product: T) {
  const { max_units_per_parcel, ...legacyProduct } = product;
  void max_units_per_parcel;
  return legacyProduct;
}

function withoutProductSellingStatus<T extends Partial<ProductDraft>>(product: T) {
  const { is_selling, ...legacyProduct } = product;
  void is_selling;
  return legacyProduct;
}

function getCompatibleProductPayload(
  product: ProductDraft,
  options: { omitParcelCapacity?: boolean; omitSellingStatus?: boolean },
) {
  let payload: Partial<ProductDraft> = product;

  if (options.omitParcelCapacity) {
    payload = withoutProductParcelCapacity(payload);
  }
  if (options.omitSellingStatus) {
    payload = withoutProductSellingStatus(payload);
  }

  return payload;
}

function getMissingProductParcelCapacityColumnMessage() {
  return "商品数据库还没有新增“3cm快递可发几个”字段，请先执行最新商品迁移。";
}

function getMissingProductSellingColumnMessage() {
  return "商品数据库还没有新增“是否售卖”字段，请先执行最新商品迁移。";
}

export async function fetchProducts(options: FetchProductsOptions = {}) {
  const { supabase } = await requireSession();
  const pageSize = 1000;
  const rows: Product[] = [];
  let from = 0;

  while (true) {
    const buildRequest = (filterSelling: boolean) => {
      let request = supabase
        .from("products")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);

      if (filterSelling) {
        request = request.eq("is_selling", true);
      }

      return request;
    };

    let result = await withTimeout(
      buildRequest(!options.includeNotSelling),
      "加载商品",
    );
    if (
      result.error &&
      !options.includeNotSelling &&
      isMissingProductSellingColumnError(result.error)
    ) {
      result = await withTimeout(buildRequest(false), "加载商品");
    }
    const { data, error } = result;

    if (error) throw error;

    const chunk = ((data ?? []) as Partial<Product>[]).map(normalizeProductRow);
    rows.push(...chunk);

    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

export async function fetchSellingProducts() {
  return fetchProducts();
}

export async function fetchAllProducts() {
  return fetchProducts({ includeNotSelling: true });
}

export type ProductSellingFilter = "selling" | "not_selling" | "all";

export type FetchProductsPaginatedOptions = {
  page: number;
  pageSize: number;
  searchQuery?: string;
  materialFilter?: string;
  sellingFilter?: ProductSellingFilter;
};

export async function fetchProductsPaginated(options: FetchProductsPaginatedOptions) {
  const { supabase } = await requireSession();
  const { page, pageSize, searchQuery, materialFilter, sellingFilter } = options;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let request = supabase.from("products").select("*", { count: "exact" });

  if (sellingFilter === "selling") request = request.eq("is_selling", true);
  if (sellingFilter === "not_selling") request = request.eq("is_selling", false);

  if (searchQuery) {
    const escaped = searchQuery.replace(/[%_\\]/g, "\\$&").replace(/"/g, '""');
    request = request.or(`product_code.ilike."%${escaped}%",product_name_cn.ilike."%${escaped}%",material_cn.ilike."%${escaped}%",material_en.ilike."%${escaped}%"`);
  }

  if (materialFilter) {
    // using generic ilike to be safe, or exact match if needed. eq is safer.
    const escapedMat = materialFilter.replace(/"/g, '""');
    request = request.or(`material_cn.eq."${escapedMat}",material_en.eq."${escapedMat}"`);
  }

  request = request.order("created_at", { ascending: false }).range(from, to);

  // We should handle the missing column error gracefully just like fetchProducts does.
  let result = await withTimeout(request, "加载商品列表");
  
  if (result.error && isMissingProductSellingColumnError(result.error) && sellingFilter !== "not_selling") {
    // Fallback if is_selling doesn't exist
    let fallbackRequest = supabase.from("products").select("*", { count: "exact" });
    if (searchQuery) {
      const escaped = searchQuery.replace(/[%_\\]/g, "\\$&").replace(/"/g, '""');
      fallbackRequest = fallbackRequest.or(`product_code.ilike."%${escaped}%",product_name_cn.ilike."%${escaped}%",material_cn.ilike."%${escaped}%",material_en.ilike."%${escaped}%"`);
    }
    if (materialFilter) {
      const escapedMat = materialFilter.replace(/"/g, '""');
      fallbackRequest = fallbackRequest.or(`material_cn.eq."${escapedMat}",material_en.eq."${escapedMat}"`);
    }
    fallbackRequest = fallbackRequest.order("created_at", { ascending: false }).range(from, to);
    result = await withTimeout(fallbackRequest, "加载商品列表");
  }

  const { data, error, count } = result;
  if (error) throw error;

  return {
    data: ((data ?? []) as Partial<Product>[]).map(normalizeProductRow),
    count: count ?? 0,
  };
}

export async function fetchProductsByIds(productIds: string[]) {
  if (productIds.length === 0) return [] as Product[];

  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .in("id", productIds)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as Partial<Product>[]).map(normalizeProductRow);
}

export async function searchProducts(keyword: string, limit: number = 20) {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return [];
  }

  const escaped = trimmed.replace(/[%_\\]/g, '\\$&');

  const { supabase } = await requireSession();
  const buildRequest = (filterSelling: boolean) => {
    let request = supabase
      .from("products")
      .select("*")
      .or(`product_code.ilike."%${escaped.replace(/"/g, '""')}%",product_name_cn.ilike."%${escaped.replace(/"/g, '""')}%"`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (filterSelling) {
      request = request.eq("is_selling", true);
    }

    return request;
  };

  let result = await withTimeout(buildRequest(true), "搜索商品");
  if (result.error && isMissingProductSellingColumnError(result.error)) {
    result = await withTimeout(buildRequest(false), "搜索商品");
  }
  const { data, error } = result;

  if (error) throw error;
  return ((data ?? []) as Partial<Product>[]).map(normalizeProductRow);
}

export async function updateProductSellingStatus(productId: string, isSelling: boolean) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("products")
      .update({ is_selling: isSelling })
      .eq("id", productId)
      .select("*")
      .single(),
    "更新商品售卖状态",
  );

  if (error && isMissingProductSellingColumnError(error)) {
    throw new Error(getMissingProductSellingColumnMessage());
  }
  if (error) throw error;
  return normalizeProductRow(data as Partial<Product>);
}

export function getProductRouteKey(product: Pick<Product, "id" | "product_code">) {
  return encodeURIComponent(product.product_code.trim() || product.id);
}

export function getProductRoutePath(
  product: Pick<Product, "id" | "product_code">,
  suffix: string,
) {
  return `/products/${getProductRouteKey(product)}${suffix}`;
}

export async function fetchProduct(productKey: string) {
  const { supabase } = await requireSession();
  const trimmedProductKey = productKey.trim();

  if (uuidPattern.test(trimmedProductKey)) {
    const { data: productById, error: productByIdError } = await withTimeout(
      supabase
        .from("products")
        .select("*")
        .eq("id", trimmedProductKey)
        .maybeSingle(),
      "加载商品",
    );

    if (productByIdError) throw productByIdError;
    if (productById) {
      const product = normalizeProductRow(productById as Partial<Product>);
      if (product.product_code.trim()) {
        throw new Error("请使用商品编号访问该商品");
      }
      return product;
    }
  }

  const { data, error } = await withTimeout(
    supabase
      .from("products")
      .select("*")
      .eq("product_code", trimmedProductKey)
      .single(),
    "加载商品",
  );

  if (error) throw error;
  return normalizeProductRow(data as Partial<Product>);
}

async function assertProductCodeAvailable(productCode: string, excludedProductId?: string) {
  const code = productCode.trim();
  if (!code) {
    throw new Error("商品编号不能为空");
  }

  const { supabase } = await requireSession();
  let request = supabase
    .from("products")
    .select("id")
    .eq("product_code", code);

  if (excludedProductId) {
    request = request.neq("id", excludedProductId);
  }

  const { data, error } = await withTimeout(request.limit(1), "检查商品编号");
  if (error) throw error;
  if (data.length > 0) {
    throw new Error(`商品编号“${code}”已存在，请换一个编号`);
  }
}

export async function fetchProductItems(productId: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("product_items")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: true }),
    "加载配件库",
  );

  if (error) throw error;
  return data as ProductItem[];
}

export async function fetchProductItemsByProductIds(productIds: string[]) {
  if (productIds.length === 0) return [] as ProductItem[];

  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("product_items")
    .select("*")
    .in("product_id", productIds)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data as ProductItem[];
}

async function fetchSkuLinks(skuIds: string[]) {
  if (skuIds.length === 0) return [] as ProductSkuItemLink[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("product_sku_items")
      .select("sku_id, item_id, quantity")
      .in("sku_id", skuIds),
    "加载 SKU 配件映射",
  );

  if (error) throw error;
  return data as ProductSkuItemLink[];
}

export async function fetchProductSkus(productId: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("product_skus")
      .select("id, product_id, owner_id, sku_code, temu_image_url, attributes, notes")
      .eq("product_id", productId)
      .order("created_at", { ascending: true }),
    "加载 SKU",
  );

  if (error) throw error;

  const baseSkus = (data as Omit<ProductSku, "component_links">[]).map(normalizeSkuRow);
  const links = await fetchSkuLinks(
    baseSkus.flatMap((sku) => (sku.id ? [sku.id] : [])),
  );
  const linksBySkuId = links.reduce<Record<string, ProductSkuItemLink[]>>(
    (groups, link) => {
      if (!link.sku_id) return groups;
      groups[link.sku_id] ??= [];
      groups[link.sku_id].push(link);
      return groups;
    },
    {},
  );

  return baseSkus.map((sku) => ({
    ...sku,
    component_links: sku.id ? linksBySkuId[sku.id] ?? [] : [],
  }));
}

export async function fetchProductSkusByProductIds(productIds: string[]) {
  if (productIds.length === 0) return [] as ProductSku[];

  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("product_skus")
    .select("id, product_id, owner_id, sku_code, temu_image_url, attributes, notes")
    .in("product_id", productIds)
    .order("created_at", { ascending: true });

  if (error) throw error;
  const baseSkus = (data as Omit<ProductSku, "component_links">[]).map(normalizeSkuRow);
  const links = await fetchSkuLinks(
    baseSkus.flatMap((sku) => (sku.id ? [sku.id] : [])),
  );
  const linksBySkuId = links.reduce<Record<string, ProductSkuItemLink[]>>(
    (groups, link) => {
      if (!link.sku_id) return groups;
      groups[link.sku_id] ??= [];
      groups[link.sku_id].push(link);
      return groups;
    },
    {},
  );

  return baseSkus.map((sku) => ({
    ...sku,
    component_links: sku.id ? linksBySkuId[sku.id] ?? [] : [],
  }));
}

async function insertItems(productId: string, items: ProductItem[]) {
  const { supabase } = await requireSession();
  if (items.length === 0) return new Map<string, string>();

  const { data, error } = await withTimeout(
    supabase
      .from("product_items")
      .insert(
        items.map(({ id, product_id, owner_id, ...item }) => {
          void id;
          void product_id;
          void owner_id;
          return { ...item, product_id: productId };
        }),
      )
      .select("id"),
    "保存配件库",
  );

  if (error) throw error;

  return new Map(
    (data as ProductItem[]).map((item, index) => [
      items[index]?.id ?? `new-${index}`,
      item.id as string,
    ]),
  );
}

async function insertSkus(
  productId: string,
  skus: ProductSkuDraft[],
  itemIdsByKey: Map<string, string>,
) {
  const { supabase } = await requireSession();
  const createdSkus: ProductSku[] = [];

  for (const sku of skus) {
    const { component_links, id, product_id, owner_id, ...skuPayload } = sku;
    void id;
    void product_id;
    void owner_id;

    let { data: createdSku, error: skuError } = await withTimeout(
      supabase
        .from("product_skus")
        .insert({
          ...skuPayload,
          product_id: productId,
        })
        .select("id, sku_code, attributes, temu_image_url")
        .single(),
      "保存 SKU",
    );
    if (skuError && isMissingTemuImageColumnError(skuError) && !skuPayload.temu_image_url) {
      const legacySkuResult = await withTimeout(
        supabase
          .from("product_skus")
          .insert({
            ...withoutSkuTemuImageUrl(skuPayload),
            product_id: productId,
          })
          .select("id, sku_code, attributes, temu_image_url")
          .single(),
        "保存 SKU",
      );
      createdSku = legacySkuResult.data;
      skuError = legacySkuResult.error;
    }
    if (skuError && isMissingTemuImageColumnError(skuError)) {
      throw new Error("商品 SKU 数据库还没有新增 Temu 图片链接字段，请先执行最新商品迁移。");
    }
    if (skuError) throw skuError;
    if (!createdSku) throw new Error("保存 SKU 失败，未返回保存结果。");

    const linkRows = component_links
      .map((link) => ({
        sku_id: createdSku.id,
        item_id: itemIdsByKey.get(link.item_key) ?? link.item_key,
        quantity: link.quantity,
      }))
      .filter((link) => Boolean(link.item_id));

    if (linkRows.length > 0) {
      const { error: linkError } = await withTimeout(
        supabase.from("product_sku_items").insert(linkRows),
        "保存 SKU 配件映射",
      );
      if (linkError) throw linkError;
    }

    createdSkus.push({
      ...normalizeSkuRow(createdSku as Omit<ProductSku, "component_links">),
      component_links: [],
    });
  }

  return createdSkus;
}

function getSkuIdentity(sku: Pick<ProductSku, "sku_code" | "attributes">) {
  return JSON.stringify({
    sku_code: sku.sku_code,
    attributes: Object.fromEntries(Object.entries(sku.attributes).sort(([left], [right]) =>
      left.localeCompare(right),
    )),
  });
}

export async function createProduct(
  product: ProductDraft,
  items: ProductItem[],
  skus: ProductSkuDraft[],
  warehouseShippingLimits: ProductWarehouseShippingLimit[] = [],
) {
  const normalizedProduct = normalizeProductDraft(product);
  await assertProductCodeAvailable(normalizedProduct.product_code);

  const { supabase } = await requireSession();
  let data: { id: string } | null = null;
  let error: unknown = null;
  let omitParcelCapacity = false;
  let omitSellingStatus = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await withTimeout(
      supabase
        .from("products")
        .insert(
          getCompatibleProductPayload(normalizedProduct, {
            omitParcelCapacity,
            omitSellingStatus,
          }),
        )
        .select("id")
        .single<{ id: string }>(),
      "保存商品",
    );
    data = result.data;
    error = result.error;

    if (
      error &&
      isMissingProductParcelCapacityColumnError(error) &&
      normalizedProduct.max_units_per_parcel === 1 &&
      !omitParcelCapacity
    ) {
      omitParcelCapacity = true;
      continue;
    }
    if (
      error &&
      isMissingProductSellingColumnError(error) &&
      normalizedProduct.is_selling &&
      !omitSellingStatus
    ) {
      omitSellingStatus = true;
      continue;
    }

    break;
  }
  if (error && isMissingProductParcelCapacityColumnError(error)) {
    throw new Error(getMissingProductParcelCapacityColumnMessage());
  }
  if (error && isMissingProductSellingColumnError(error)) {
    throw new Error(getMissingProductSellingColumnMessage());
  }
  if (error) throw error;

  const itemIdsByKey = await insertItems(data!.id, items);
  await insertSkus(data!.id, skus, itemIdsByKey);
  await upsertProductWarehouseShippingLimits(data!.id, warehouseShippingLimits);
  return data as Product;
}

export async function updateProduct(
  productId: string,
  product: ProductDraft,
  items: ProductItem[],
  skus: ProductSkuDraft[],
  warehouseShippingLimits: ProductWarehouseShippingLimit[] = [],
) {
  const normalizedProduct = normalizeProductDraft(product);
  await assertProductCodeAvailable(normalizedProduct.product_code, productId);

  const { supabase } = await requireSession();
  const existingSkus = await fetchProductSkus(productId);
  const existingCalculationsByIdentity = new Map<string, SavedProfitCalculation>();
  const existingCalculationRows = await Promise.all(
    existingSkus.flatMap((sku) =>
      sku.id
        ? [
            supabase
              .from("profit_calculations")
              .select("temu_price_rmb, traffic_discount_rate, activity_discount_rate, coupon_discount_rate")
              .eq("sku_id", sku.id)
              .maybeSingle(),
          ]
        : [],
    ),
  );

  existingSkus.forEach((sku, index) => {
    const calculation = existingCalculationRows[index]?.data as SavedProfitCalculation | null;
    if (calculation) {
      existingCalculationsByIdentity.set(getSkuIdentity(sku), calculation);
      if (isLegacyDefaultSkuCode(sku.sku_code)) {
        existingCalculationsByIdentity.set(
          getSkuIdentity({
            ...sku,
            sku_code: buildDefaultSkuCode(normalizedProduct.product_code, index),
          }),
          calculation,
        );
      }
    }
  });

  let error: unknown = null;
  let omitParcelCapacity = false;
  let omitSellingStatus = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await withTimeout(
      supabase
        .from("products")
        .update(
          getCompatibleProductPayload(normalizedProduct, {
            omitParcelCapacity,
            omitSellingStatus,
          }),
        )
        .eq("id", productId),
      "更新商品",
    );
    error = result.error;

    if (
      error &&
      isMissingProductParcelCapacityColumnError(error) &&
      normalizedProduct.max_units_per_parcel === 1 &&
      !omitParcelCapacity
    ) {
      omitParcelCapacity = true;
      continue;
    }
    if (
      error &&
      isMissingProductSellingColumnError(error) &&
      normalizedProduct.is_selling &&
      !omitSellingStatus
    ) {
      omitSellingStatus = true;
      continue;
    }

    break;
  }
  if (error && isMissingProductParcelCapacityColumnError(error)) {
    throw new Error(getMissingProductParcelCapacityColumnMessage());
  }
  if (error && isMissingProductSellingColumnError(error)) {
    throw new Error(getMissingProductSellingColumnMessage());
  }
  if (error) throw error;

  const { error: deleteSkuError } = await withTimeout(
    supabase.from("product_skus").delete().eq("product_id", productId),
    "清理旧 SKU",
  );
  if (deleteSkuError) throw deleteSkuError;

  const { error: deleteItemError } = await withTimeout(
    supabase.from("product_items").delete().eq("product_id", productId),
    "清理旧配件库",
  );
  if (deleteItemError) throw deleteItemError;

  const itemIdsByKey = await insertItems(productId, items);
  const createdSkus = await insertSkus(productId, skus, itemIdsByKey);

  const calculationsToRestore = createdSkus.flatMap((sku) => {
    if (!sku.id) return [];
    const previous = existingCalculationsByIdentity.get(getSkuIdentity(sku));
    return previous
      ? [
          {
            product_id: productId,
            sku_id: sku.id,
            temu_price_rmb: previous.temu_price_rmb,
            traffic_discount_rate: previous.traffic_discount_rate,
            activity_discount_rate: previous.activity_discount_rate,
            coupon_discount_rate: previous.coupon_discount_rate ?? 0,
            result_json: {},
          },
        ]
      : [];
  });

  if (calculationsToRestore.length > 0) {
    const { error: restoreCalculationError } = await withTimeout(
      supabase.from("profit_calculations").insert(calculationsToRestore),
      "恢复利润测算输入",
    );
    if (restoreCalculationError) throw restoreCalculationError;
  }

  await upsertProductWarehouseShippingLimits(productId, warehouseShippingLimits);
}

export async function deleteProduct(productId: string) {
  const { supabase } = await requireSession();
  const { error } = await withTimeout(
    supabase
      .from("products")
      .delete()
      .eq("id", productId),
    "删除商品",
  );
  if (error) throw error;
}

export async function exportProductsData(
  productIds?: string[],
): Promise<ProductTransferRecord[]> {
  const allProducts = await fetchProducts({ includeNotSelling: true });
  const products =
    productIds && productIds.length > 0
      ? allProducts.filter((product) => productIds.includes(product.id))
      : allProducts;
  const [items, skus] = await Promise.all([
    fetchProductItemsByProductIds(products.map((product) => product.id)),
    fetchProductSkusByProductIds(products.map((product) => product.id)),
  ]);

  const itemsByProductId = items.reduce<Record<string, ProductItem[]>>(
    (groups, item) => {
      if (!item.product_id) return groups;
      groups[item.product_id] ??= [];
      groups[item.product_id].push(item);
      return groups;
    },
    {},
  );
  const skusByProductId = skus.reduce<Record<string, ProductSku[]>>(
    (groups, sku) => {
      if (!sku.product_id) return groups;
      groups[sku.product_id] ??= [];
      groups[sku.product_id].push(sku);
      return groups;
    },
    {},
  );

  return products.map((product) => {
    const {
      id,
      owner_id,
      created_at,
      updated_at,
      ...draft
    } = product;
    void id;
    void owner_id;
    void created_at;
    void updated_at;

    const productItems = itemsByProductId[product.id] ?? [];
    const itemIndexById = new Map(
      productItems.flatMap((item, index) => (item.id ? [[item.id, index]] : [])),
    );

    return {
      ...draft,
      items: productItems.map(({ id: itemId, product_id, owner_id: itemOwnerId, ...item }) => {
        void itemId;
        void product_id;
        void itemOwnerId;
        return item;
      }),
      skus: (skusByProductId[product.id] ?? []).map(
        ({ id: skuId, product_id, owner_id: skuOwnerId, component_links, ...sku }) => {
          void skuId;
          void product_id;
          void skuOwnerId;
          return {
            ...sku,
            component_links: component_links.flatMap((link) => {
              const itemIndex = itemIndexById.get(link.item_id);
              return itemIndex === undefined
                ? []
                : [{ item_index: itemIndex, quantity: link.quantity }];
            }),
          };
        },
      ),
    };
  });
}

export async function importProductsData(records: ProductTransferRecord[]) {
  for (const record of records) {
    const { items, skus, ...product } = record;
    await createProduct(
      product,
      items,
      skus.map((sku) => ({
        ...sku,
        component_links: sku.component_links.map((link) => ({
          item_key: `new-${link.item_index}`,
          quantity: link.quantity,
        })),
      })),
    );
  }
}

export async function updateSkuCode(skuId: string, skuCode: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("product_skus")
      .update({ sku_code: skuCode.trim() })
      .eq("id", skuId)
      .select("id, product_id, owner_id, sku_code, attributes, notes")
      .single(),
    "更新 SKU 货号",
  );
  if (error) throw error;
  return data;
}
