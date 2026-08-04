import { getSupabaseClient } from "./supabase";

export type SharedInventoryGroup = {
  id: string;
  enterprise_id: string;
  code: string;
  name: string;
  base_unit_name: string;
  status: string;
};

export type SharedInventoryMember = {
  id: string;
  group_id: string;
  enterprise_id: string;
  shop_id: string;
  sku_id: string;
  base_units_per_sale_unit: number;
  joined_at: string;
};

export type SharedInventoryBalance = {
  id: string;
  group_id: string;
  enterprise_id: string;
  stock_location_id: string;
  quantity_base_units: number;
};

export type SharedInventoryReferenceData = {
  groups: SharedInventoryGroup[];
  members: SharedInventoryMember[];
  balances: SharedInventoryBalance[];
  locations: Array<{ id: string; enterprise_id: string; code: string; name: string }>;
  shops: Array<{ id: string; enterprise_id: string; name: string }>;
  products: Array<{ id: string; shop_id: string; product_code: string; product_name_cn: string }>;
  skus: Array<{
    id: string;
    shop_id: string;
    product_id: string;
    sku_code: string;
    attributes: Record<string, string>;
  }>;
  warehouses: Array<{
    id: string;
    shop_id: string;
    name: string;
    stock_location_id: string | null;
  }>;
  warehouseSkus: Array<{
    id: string;
    shop_id: string;
    warehouse_id: string;
    product_id: string;
    sku_id: string;
    stock_quantity: number;
  }>;
};

export async function fetchSharedInventoryReferenceData(
  shopId: string,
): Promise<SharedInventoryReferenceData> {
  const supabase = getSupabaseClient();
  const [
    groups,
    members,
    balances,
    locations,
    shops,
    products,
    skus,
    warehouses,
    warehouseSkus,
  ] = await Promise.all([
    supabase
      .from("shared_inventory_groups")
      .select("id, enterprise_id, code, name, base_unit_name, status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("shared_inventory_group_members")
      .select("id, group_id, enterprise_id, shop_id, sku_id, base_units_per_sale_unit, joined_at")
      .is("left_at", null)
      .order("joined_at"),
    supabase
      .from("shared_inventory_balances")
      .select("id, group_id, enterprise_id, stock_location_id, quantity_base_units"),
    supabase.from("stock_locations").select("id, enterprise_id, code, name"),
    supabase.from("shops").select("id, enterprise_id, name"),
    supabase
      .from("products")
      .select("id, shop_id, product_code, product_name_cn")
      .eq("shop_id", shopId)
      .order("product_code"),
    supabase
      .from("product_skus")
      .select("id, shop_id, product_id, sku_code, attributes")
      .eq("shop_id", shopId)
      .order("sku_code"),
    supabase
      .from("warehouses")
      .select("id, shop_id, name, stock_location_id")
      .eq("shop_id", shopId)
      .order("name"),
    supabase
      .from("warehouse_skus")
      .select("id, shop_id, warehouse_id, product_id, sku_id, stock_quantity")
      .eq("shop_id", shopId)
      .order("warehouse_id"),
  ]);

  const firstError = [
    groups.error,
    members.error,
    balances.error,
    locations.error,
    shops.error,
    products.error,
    skus.error,
    warehouses.error,
    warehouseSkus.error,
  ].find(Boolean);
  if (firstError) throw firstError;

  return {
    groups: (groups.data ?? []) as SharedInventoryGroup[],
    members: (members.data ?? []) as SharedInventoryMember[],
    balances: (balances.data ?? []) as SharedInventoryBalance[],
    locations: (locations.data ?? []) as SharedInventoryReferenceData["locations"],
    shops: (shops.data ?? []) as SharedInventoryReferenceData["shops"],
    products: (products.data ?? []) as SharedInventoryReferenceData["products"],
    skus: (skus.data ?? []) as SharedInventoryReferenceData["skus"],
    warehouses: (warehouses.data ?? []) as SharedInventoryReferenceData["warehouses"],
    warehouseSkus: (warehouseSkus.data ?? []) as SharedInventoryReferenceData["warehouseSkus"],
  };
}

export async function createSharedInventoryGroup(input: {
  code: string;
  name: string;
  baseUnitName: string;
}) {
  const { data, error } = await getSupabaseClient().rpc(
    "create_shared_inventory_group",
    {
      p_code: input.code,
      p_name: input.name,
      p_base_unit_name: input.baseUnitName,
    },
  );
  if (error) throw error;
  return data;
}

export async function joinSharedInventoryGroup(input: {
  groupId: string;
  skuId: string;
  baseUnitsPerSaleUnit: number;
  transfers: Array<{ warehouse_sku_id: string; quantity: number }>;
  reason: string;
  requestKey: string;
}) {
  const { data, error } = await getSupabaseClient().rpc(
    "join_shared_inventory_group",
    {
      p_group_id: input.groupId,
      p_sku_id: input.skuId,
      p_base_units_per_sale_unit: input.baseUnitsPerSaleUnit,
      p_transfers: input.transfers,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    },
  );
  if (error) throw error;
  return data;
}

export async function leaveSharedInventoryGroup(input: {
  memberId: string;
  transfers: Array<{ warehouse_sku_id: string; quantity: number }>;
  reason: string;
  requestKey: string;
}) {
  const { data, error } = await getSupabaseClient().rpc(
    "leave_shared_inventory_group",
    {
      p_group_member_id: input.memberId,
      p_transfers: input.transfers,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    },
  );
  if (error) throw error;
  return data;
}
