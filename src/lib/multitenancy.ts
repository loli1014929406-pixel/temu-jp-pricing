import { getSupabaseClient } from "./supabase";

export type Enterprise = {
  id: string;
  code: string;
  name: string;
  status: "active" | "suspended" | "archived";
};

export type Shop = {
  id: string;
  enterprise_id: string;
  code: string;
  name: string;
  platform: string;
  status: "active" | "suspended" | "archived";
};

export type MultitenantContext = {
  userId: string;
  isPlatformOwner: boolean;
  enterpriseOwnerIds: string[];
  operatorShopId: string | null;
  currentShopId: string | null;
  permissionMode: "legacy" | "tenant";
};

export type TenantBootstrap = {
  context: MultitenantContext;
  enterprises: Enterprise[];
  shops: Shop[];
  legacyFallback: boolean;
};

type RawContext = {
  user_id?: unknown;
  is_platform_owner?: unknown;
  enterprise_owner_ids?: unknown;
  operator_shop_id?: unknown;
  current_shop_id?: unknown;
  permission_mode?: unknown;
};

function stringOrNull(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

export function normalizeMultitenantContext(value: unknown): MultitenantContext {
  const raw = (value && typeof value === "object" ? value : {}) as RawContext;
  return {
    userId: stringOrNull(raw.user_id) ?? "",
    isPlatformOwner: raw.is_platform_owner === true,
    enterpriseOwnerIds: Array.isArray(raw.enterprise_owner_ids)
      ? raw.enterprise_owner_ids.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [],
    operatorShopId: stringOrNull(raw.operator_shop_id),
    currentShopId: stringOrNull(raw.current_shop_id),
    permissionMode: raw.permission_mode === "tenant" ? "tenant" : "legacy",
  };
}

function isMissingMultitenantRpc(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.message?.includes("current_multitenant_context") === true
  );
}

function legacyBootstrap(userId: string): TenantBootstrap {
  return {
    context: {
      userId,
      isPlatformOwner: false,
      enterpriseOwnerIds: [],
      operatorShopId: null,
      currentShopId: null,
      permissionMode: "legacy",
    },
    enterprises: [],
    shops: [],
    legacyFallback: true,
  };
}

export async function fetchTenantBootstrap(userId: string): Promise<TenantBootstrap> {
  const supabase = getSupabaseClient();
  const { data: contextData, error: contextError } = await supabase.rpc(
    "current_multitenant_context",
  );

  if (contextError) {
    if (isMissingMultitenantRpc(contextError)) return legacyBootstrap(userId);
    throw contextError;
  }

  const [enterpriseResult, shopResult] = await Promise.all([
    supabase
      .from("enterprises")
      .select("id, code, name, status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("shops")
      .select("id, enterprise_id, code, name, platform, status")
      .eq("status", "active")
      .order("name"),
  ]);
  if (enterpriseResult.error) throw enterpriseResult.error;
  if (shopResult.error) throw shopResult.error;

  return {
    context: normalizeMultitenantContext(contextData),
    enterprises: (enterpriseResult.data ?? []) as Enterprise[],
    shops: (shopResult.data ?? []) as Shop[],
    legacyFallback: false,
  };
}

export async function setCurrentShopContext(shopId: string) {
  const { data, error } = await getSupabaseClient().rpc(
    "set_current_shop_context",
    { p_shop_id: shopId },
  );
  if (error) throw error;
  return data;
}

export async function clearCurrentShopContext() {
  const { error } = await getSupabaseClient().rpc("clear_current_shop_context");
  if (error && !isMissingMultitenantRpc(error)) throw error;
}

export function getEffectiveShopId(bootstrap: TenantBootstrap) {
  const explicit = bootstrap.context.currentShopId;
  if (explicit) return explicit;
  if (bootstrap.context.isPlatformOwner) return null;
  if (bootstrap.context.operatorShopId) return bootstrap.context.operatorShopId;

  const ownerShops = bootstrap.shops.filter((shop) =>
    bootstrap.context.enterpriseOwnerIds.includes(shop.enterprise_id),
  );
  return ownerShops.length === 1 ? ownerShops[0].id : null;
}

export function buildTenantScopeKey(
  userId: string,
  enterpriseId: string | null,
  shopId: string | null,
) {
  return [userId || "signed-out", enterpriseId || "all-enterprises", shopId || "all-shops"]
    .map(encodeURIComponent)
    .join(":");
}

export function buildTenantStorageKey(
  prefix: string,
  userId: string,
  shopId: string | null,
) {
  return `${prefix}:${buildTenantScopeKey(userId, null, shopId)}`;
}
