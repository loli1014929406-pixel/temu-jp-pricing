import type {
  SimpleProductSkuInfo,
  SimpleProductSkuInfoDraft,
} from "../types";
import { requireSession, withTimeout } from "./supabase-helpers";

export type SimpleProductSkuInfoQuery = {
  page: number;
  pageSize: number;
  searchQuery?: string;
};

function normalizeRow(row: Partial<SimpleProductSkuInfo>): SimpleProductSkuInfo {
  return {
    id: String(row.id ?? ""),
    enterprise_id: String(row.enterprise_id ?? ""),
    shop_id: String(row.shop_id ?? ""),
    owner_id: String(row.owner_id ?? ""),
    product_code: String(row.product_code ?? ""),
    sku_code: String(row.sku_code ?? ""),
    product_name_cn: String(row.product_name_cn ?? ""),
    product_name_en: String(row.product_name_en ?? ""),
    material: String(row.material ?? ""),
    purchase_price_rmb: Number(row.purchase_price_rmb ?? 0),
    purchase_url: String(row.purchase_url ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function escapeSearchValue(value: string) {
  return value.replace(/[\\%_(),]/g, (character) => `\\${character}`);
}

export async function fetchSimpleProductSkuInfos({
  page,
  pageSize,
  searchQuery = "",
}: SimpleProductSkuInfoQuery) {
  const { supabase } = await requireSession();
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let request = supabase
    .from("simple_product_sku_infos")
    .select("*", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(from, to);

  const keyword = searchQuery.trim();
  if (keyword) {
    const escaped = escapeSearchValue(keyword);
    request = request.or(
      `product_code.ilike."%${escaped}%",sku_code.ilike."%${escaped}%",product_name_cn.ilike."%${escaped}%",product_name_en.ilike."%${escaped}%",material.ilike."%${escaped}%"`,
    );
  }

  const { data, count, error } = await withTimeout(request, "加载简化商品资料");
  if (error) throw error;
  return {
    data: ((data ?? []) as Partial<SimpleProductSkuInfo>[]).map(normalizeRow),
    count: count ?? 0,
  };
}

export async function fetchAllSimpleProductSkuInfos() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("simple_product_sku_infos")
      .select("*")
      .order("product_code", { ascending: true })
      .order("sku_code", { ascending: true }),
    "导出简化商品资料",
  );
  if (error) throw error;
  return ((data ?? []) as Partial<SimpleProductSkuInfo>[]).map(normalizeRow);
}

export async function upsertSimpleProductSkuInfos(records: SimpleProductSkuInfoDraft[]) {
  if (records.length === 0) return [] as SimpleProductSkuInfo[];
  const { supabase } = await requireSession();
  const payload = records.map((record) => ({
    product_code: record.product_code.trim(),
    sku_code: record.sku_code.trim(),
    product_name_cn: record.product_name_cn.trim(),
    product_name_en: record.product_name_en.trim(),
    material: record.material.trim(),
    purchase_price_rmb: record.purchase_price_rmb,
    purchase_url: record.purchase_url.trim(),
  }));
  const { data, error } = await withTimeout(
    supabase
      .from("simple_product_sku_infos")
      .upsert(payload, { onConflict: "shop_id,sku_code" })
      .select("*"),
    "保存简化商品资料",
  );
  if (error) throw error;
  return ((data ?? []) as Partial<SimpleProductSkuInfo>[]).map(normalizeRow);
}

export async function deleteSimpleProductSkuInfo(id: string) {
  const { supabase } = await requireSession();
  const { error } = await withTimeout(
    supabase.from("simple_product_sku_infos").delete().eq("id", id),
    "删除简化商品资料",
  );
  if (error) throw error;
}
