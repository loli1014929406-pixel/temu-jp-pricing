import { getSupabaseClient } from "./supabase";
import type { Product, ProductDraft, ProductItem } from "../types";

const requestTimeoutMs = 15000;

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

export async function fetchProducts() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("owner_id", session.user.id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data as Product[];
}

export async function fetchProduct(productId: string) {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .eq("owner_id", session.user.id)
    .single();

  if (error) throw error;
  return data as Product;
}

export async function fetchProductItems(productId: string) {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  const { data, error } = await supabase
    .from("product_items")
    .select("*")
    .eq("product_id", productId)
    .eq("owner_id", session.user.id)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data as ProductItem[];
}

export async function createProduct(
  product: ProductDraft,
  items: ProductItem[],
) {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  const { data, error } = await withTimeout(
    supabase.from("products").insert(product).select().single(),
    "保存商品",
  );

  if (error) throw error;

  if (items.length > 0) {
    const { error: itemError } = await withTimeout(
      supabase.from("product_items").insert(
        items.map(({ id, product_id, owner_id, ...item }) => ({
          ...item,
          product_id: data.id,
        })),
      ),
      "保存商品配件",
    );
    if (itemError) throw itemError;
  }

  return data as Product;
}

export async function updateProduct(
  productId: string,
  product: ProductDraft,
  items: ProductItem[],
) {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    throw new Error("当前登录已失效，请重新登录");
  }

  const { error } = await withTimeout(
    supabase.from("products").update(product).eq("id", productId),
    "更新商品",
  );

  if (error) throw error;

  const { error: deleteError } = await withTimeout(
    supabase.from("product_items").delete().eq("product_id", productId),
    "清理旧配件",
  );

  if (deleteError) throw deleteError;

  if (items.length > 0) {
    const { error: insertError } = await withTimeout(
      supabase.from("product_items").insert(
        items.map(({ id, product_id, owner_id, ...item }) => ({
          ...item,
          product_id: productId,
        })),
      ),
      "保存新配件",
    );
    if (insertError) throw insertError;
  }
}
