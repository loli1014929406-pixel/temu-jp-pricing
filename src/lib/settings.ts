import { getSupabaseClient } from "./supabase";
import { defaultSettings } from "./defaults";
import type { PricingSettings } from "../types";
import {
  fetchCurrentAccountPermission,
  getPermissionCapabilities,
} from "./permissions";

type FetchSettingsOptions = {
  createIfMissing?: boolean;
};

export async function fetchSettings(
  userId: string,
  options: FetchSettingsOptions = {},
) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("pricing_settings")
    .select("*")
    .eq("owner_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    return data as PricingSettings;
  }

  const canCreate =
    options.createIfMissing ??
    getPermissionCapabilities(await fetchCurrentAccountPermission()).canEdit;

  if (!canCreate) {
    return {
      ...defaultSettings,
      owner_id: userId,
    } as PricingSettings;
  }

  const { data: created, error: insertError } = await supabase
    .from("pricing_settings")
    .insert({
      ...defaultSettings,
    })
    .select()
    .single();

  if (insertError) throw insertError;
  return created as PricingSettings;
}

export async function saveSettings(userId: string, settings: PricingSettings) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("pricing_settings").upsert(
    {
      ...settings,
    },
    { onConflict: "owner_id" },
  );

  if (error) throw error;
}
