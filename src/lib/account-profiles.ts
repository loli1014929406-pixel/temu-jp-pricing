import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession, withTimeout } from "./supabase-helpers";
import { normalizeAccountPermission, type AccountPermissionLevel } from "./permissions";
import type { AccountProfile } from "../types";

const userCodeChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const generatedUsernameDigits = 3;

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
}

function isMissingAccountProfilesTableError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("account_profiles") &&
    (message.includes("schema cache") ||
      message.includes("does not exist") ||
      message.includes("relation") ||
      message.includes("could not find"))
  );
}

function normalizeAccountProfile(row: Partial<AccountProfile>): AccountProfile {
  return {
    id: row.id,
    owner_id: String(row.owner_id ?? ""),
    username: String(row.username ?? ""),
    user_code: String(row.user_code ?? ""),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function formatAccountProfileDisplay(profile: AccountProfile | null | undefined) {
  const username = profile?.username?.trim() || "未设置";
  const userCode = profile?.user_code?.trim() || "未知";
  return `${username}（${userCode}）`;
}

export function generateUserCode() {
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += userCodeChars[Math.floor(Math.random() * userCodeChars.length)];
  }
  return code;
}

function getGeneratedUsernamePrefix(permission: AccountPermissionLevel) {
  return permission === "admin" ? "admin" : "user";
}

function getGeneratedUsernameSequence(username: string, prefix: string) {
  if (!username.startsWith(prefix)) return null;

  const sequenceText = username.slice(prefix.length);
  if (!/^\d+$/.test(sequenceText)) return null;

  const sequence = Number(sequenceText);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function formatGeneratedUsername(prefix: string, sequence: number) {
  return `${prefix}${String(sequence).padStart(generatedUsernameDigits, "0")}`;
}

async function fetchCurrentAccountPermissionForUsername(supabase: SupabaseClient) {
  const { data, error } = await withTimeout(
    supabase.rpc("current_account_permission"),
    "加载用户权限",
  );

  if (error) return "viewer" as AccountPermissionLevel;
  return normalizeAccountPermission(data);
}

async function generateUsername(supabase: SupabaseClient) {
  const permission = await fetchCurrentAccountPermissionForUsername(supabase);
  const prefix = getGeneratedUsernamePrefix(permission);
  const { data, error } = await withTimeout(
    supabase
      .from("account_profiles")
      .select("username")
      .like("username", `${prefix}%`),
    "生成用户名",
  );

  if (error) throw error;

  const maxSequence = ((data ?? []) as Array<{ username?: unknown }>).reduce(
    (max, row) => {
      const sequence = getGeneratedUsernameSequence(String(row.username ?? ""), prefix);
      return sequence === null ? max : Math.max(max, sequence);
    },
    0,
  );

  return formatGeneratedUsername(prefix, maxSequence + 1);
}

export async function fetchAccountProfilesByOwnerIds(ownerIds: string[]) {
  const uniqueOwnerIds = Array.from(new Set(ownerIds.filter(Boolean)));
  if (uniqueOwnerIds.length === 0) return new Map<string, AccountProfile>();

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("account_profiles")
      .select("id, owner_id, username, user_code, created_at, updated_at")
      .in("owner_id", uniqueOwnerIds),
    "加载创建用户",
  );

  if (error && isMissingAccountProfilesTableError(error)) {
    return new Map<string, AccountProfile>();
  }
  if (error) throw error;

  return new Map(
    ((data ?? []) as Partial<AccountProfile>[]).map((row) => {
      const profile = normalizeAccountProfile(row);
      return [profile.owner_id, profile];
    }),
  );
}

async function isUserCodeAvailable(userCode: string) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("account_profiles")
      .select("owner_id")
      .eq("user_code", userCode)
      .maybeSingle(),
    "检查用户ID",
  );

  if (error) throw error;
  return !data;
}

export async function fetchOrCreateCurrentAccountProfile() {
  const { supabase, session } = await requireSession();
  const ownerId = session.user.id;
  const existingResult = await withTimeout(
    supabase
      .from("account_profiles")
      .select("id, owner_id, username, user_code, created_at, updated_at")
      .eq("owner_id", ownerId)
      .maybeSingle(),
    "加载用户资料",
  );

  if (existingResult.error && isMissingAccountProfilesTableError(existingResult.error)) {
    throw new Error("数据库还没有 account_profiles 表，请先执行最新迁移。");
  }
  if (existingResult.error) throw existingResult.error;
  if (existingResult.data) {
    return normalizeAccountProfile(existingResult.data as Partial<AccountProfile>);
  }

  const username = await generateUsername(supabase);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const userCode = generateUserCode();
    if (!(await isUserCodeAvailable(userCode))) continue;

    const { data, error } = await withTimeout(
      supabase
        .from("account_profiles")
        .insert({
          owner_id: ownerId,
          username,
          user_code: userCode,
        })
        .select("id, owner_id, username, user_code, created_at, updated_at")
        .single(),
      "创建用户资料",
    );

    if (!error) return normalizeAccountProfile(data as Partial<AccountProfile>);
    if (!getErrorMessage(error).toLowerCase().includes("duplicate")) throw error;
  }

  throw new Error("生成用户ID失败，请重试。");
}

export async function updateCurrentAccountProfileUsername(username: string) {
  const profile = await fetchOrCreateCurrentAccountProfile();
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("account_profiles")
      .update({ username: username.trim() })
      .eq("owner_id", profile.owner_id)
      .select("id, owner_id, username, user_code, created_at, updated_at")
      .single(),
    "保存用户名",
  );

  if (error) throw error;
  return normalizeAccountProfile(data as Partial<AccountProfile>);
}
