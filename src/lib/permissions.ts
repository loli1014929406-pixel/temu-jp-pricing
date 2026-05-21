import { getSupabaseClient } from "./supabase";

export const accountPermissionLevels = ["admin", "editor", "viewer"] as const;

export type AccountPermissionLevel = (typeof accountPermissionLevels)[number];

export type AccountPermission = {
  email: string;
  permission_level: AccountPermissionLevel;
  created_at?: string;
  updated_at?: string;
};

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
    return "admin" as AccountPermissionLevel;
  }

  return normalizeAccountPermission(data);
}

export async function fetchAccountPermissions() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("account_permissions")
    .select("*")
    .order("email", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((item) => ({
    ...item,
    permission_level: normalizeAccountPermission(item.permission_level),
  })) as AccountPermission[];
}

export async function saveAccountPermission(
  email: string,
  permissionLevel: AccountPermissionLevel,
) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("请填写账号邮箱");
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("account_permissions").upsert(
    {
      email: normalizedEmail,
      permission_level: permissionLevel,
    },
    { onConflict: "email" },
  );

  if (error) throw error;
}

export async function deleteAccountPermission(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("account_permissions")
    .delete()
    .eq("email", normalizedEmail);

  if (error) throw error;
}
