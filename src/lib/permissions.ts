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
