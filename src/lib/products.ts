import { getSupabaseClient } from "./supabase";
import type {
  Product,
  ProductDraft,
  ProductItem,
  ProductSku,
  ProductSkuDraft,
  ProductSkuDraftLink,
  ProductSkuItemLink,
  ProductTransferRecord,
  SavedProfitCalculation,
} from "../types";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";

const requestTimeoutMs = 15000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function withTimeout<T>(promise: PromiseLike<T>, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}超时，请稍后重试`)),
      requestTimeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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

export async function fetchProducts() {
  const { supabase } = await requireSession();
  const pageSize = 1000;
  const rows: Product[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await withTimeout(
      supabase
        .from("products")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1),
      "加载商品",
    );

    if (error) throw error;

    const chunk = (data ?? []) as Product[];
    rows.push(...chunk);

    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return rows;
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
      const product = productById as Product;
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
  return data as Product;
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
      .select("*")
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
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: true }),
    "加载 SKU",
  );

  if (error) throw error;

  const baseSkus = data as Omit<ProductSku, "component_links">[];
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
    .select("*")
    .in("product_id", productIds)
    .order("created_at", { ascending: true });

  if (error) throw error;
  const baseSkus = data as Omit<ProductSku, "component_links">[];
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
      .select(),
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

    const { data: createdSku, error: skuError } = await withTimeout(
      supabase
        .from("product_skus")
        .insert({
          ...skuPayload,
          product_id: productId,
        })
        .select()
        .single(),
      "保存 SKU",
    );
    if (skuError) throw skuError;

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
      ...(createdSku as Omit<ProductSku, "component_links">),
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
) {
  const normalizedProduct = {
    ...product,
    product_code: product.product_code.trim(),
  };
  await assertProductCodeAvailable(normalizedProduct.product_code);

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase.from("products").insert(normalizedProduct).select().single(),
    "保存商品",
  );
  if (error) throw error;

  const itemIdsByKey = await insertItems(data.id, items);
  await insertSkus(data.id, skus, itemIdsByKey);
  return data as Product;
}

export async function updateProduct(
  productId: string,
  product: ProductDraft,
  items: ProductItem[],
  skus: ProductSkuDraft[],
) {
  const normalizedProduct = {
    ...product,
    product_code: product.product_code.trim(),
  };
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
              .select("*")
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

  const { error } = await withTimeout(
    supabase.from("products").update(normalizedProduct).eq("id", productId),
    "更新商品",
  );
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
  const allProducts = await fetchProducts();
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
