import { getSupabaseClient } from "./supabase";
import { defaultSettings } from "./defaults";
import type { PricingSettings } from "../types";

export async function fetchSettings(userId: string) {
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
