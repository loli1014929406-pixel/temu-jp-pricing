import { getSupabaseClient } from "./supabase";

const accountPermissionLevels = ["admin", "editor", "viewer"] as const;

export type AccountPermissionLevel = (typeof accountPermissionLevels)[number];

export const accountPermissionLabels: Record<AccountPermissionLevel, string> = {
  admin: "所有权限",
  editor: "可编辑，不可删除",
  viewer: "只读查看",
};

export function normalizeAccountPermission(
  value: unknown,
): AccountPermissionLevel {
  return accountPermissionLevels.includes(value as AccountPermissionLevel)
    ? (value as AccountPermissionLevel)
    : "viewer";
}

export function getPermissionCapabilities(level: AccountPermissionLevel) {
  return {
    canEdit: level === "admin" || level === "editor",
    canDelete: level === "admin",
  };
}

export async function fetchCurrentAccountPermission() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("current_account_permission");

  if (error) {
    return "viewer" as AccountPermissionLevel;
  }

  return normalizeAccountPermission(data);
}

export const permissionResources = [
  "products",
  "pricing",
  "inventory",
  "purchases",
  "orders",
  "finance",
  "settings",
  "shops",
  "members",
  "diagnostics",
] as const;

export type PermissionResource = (typeof permissionResources)[number];
export type ResourcePermission = {
  resource: PermissionResource;
  action: string;
  allowed: boolean;
};

export function getPermissionResourceForPath(pathname: string): PermissionResource {
  if (pathname.startsWith("/orders")) return "orders";
  if (pathname.startsWith("/finance")) return "finance";
  if (pathname.startsWith("/inventory")) return "inventory";
  if (pathname.startsWith("/purchases")) return "purchases";
  if (pathname.startsWith("/parameter-settings")) return "settings";
  if (pathname.startsWith("/organization")) return "shops";
  if (pathname.startsWith("/enterprise-overview")) return "finance";
  if (pathname.startsWith("/admin/diagnostics")) return "diagnostics";
  if (
    pathname.startsWith("/declaration-prices") ||
    pathname.startsWith("/profit-calculation") ||
    pathname.startsWith("/test-shipping")
  ) {
    return "pricing";
  }
  return "products";
}

export function getPrimaryEditAction(resource: PermissionResource) {
  if (resource === "inventory") return "adjust";
  if (resource === "shops" || resource === "members") return "manage";
  if (resource === "diagnostics") return "view";
  return "update";
}

export async function fetchShopOperatorPermissions(
  userId: string,
  shopId: string,
) {
  const { data, error } = await getSupabaseClient()
    .from("shop_operator_permissions")
    .select("resource, action, allowed")
    .eq("user_id", userId)
    .eq("shop_id", shopId);
  if (error) throw error;
  return (data ?? []).filter(
    (item): item is ResourcePermission =>
      permissionResources.includes(item.resource as PermissionResource) &&
      typeof item.action === "string" &&
      typeof item.allowed === "boolean",
  );
}
