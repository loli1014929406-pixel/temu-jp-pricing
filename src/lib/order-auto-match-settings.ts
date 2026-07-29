import type { OrderAutoMatchSettings } from "../types";
import { requireSession, withTimeout } from "./supabase-helpers";

const orderAutoMatchSettingsSelect =
  "id, enabled, updated_by, created_at, updated_at";

function isMissingAutoMatchSettingsError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("order_auto_match_settings") &&
    (normalized.includes("schema cache") ||
      normalized.includes("does not exist") ||
      normalized.includes("could not find"))
  );
}

export function createDisabledOrderAutoMatchSettings(): OrderAutoMatchSettings {
  return {
    id: true,
    enabled: false,
    updated_by: null,
    created_at: "",
    updated_at: "",
  };
}

export async function fetchOrderAutoMatchSettings() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("order_auto_match_settings")
      .select(orderAutoMatchSettingsSelect)
      .eq("id", true)
      .maybeSingle(),
    "加载订单自动匹配开关",
  );

  if (error && isMissingAutoMatchSettingsError(error)) {
    return createDisabledOrderAutoMatchSettings();
  }
  if (error) throw error;
  return (data as OrderAutoMatchSettings | null) ?? createDisabledOrderAutoMatchSettings();
}

export async function updateOrderAutoMatchEnabled(enabled: boolean) {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("order_auto_match_settings")
      .update({ enabled })
      .eq("id", true)
      .select(orderAutoMatchSettingsSelect)
      .single(),
    enabled ? "启用订单自动匹配" : "暂停订单自动匹配",
  );

  if (error) throw error;
  return data as OrderAutoMatchSettings;
}
