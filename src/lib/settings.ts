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

function normalizeSettings(settings: Partial<PricingSettings>): PricingSettings {
  const normalized: PricingSettings = {
    packaging_cost_rmb:
      settings.packaging_cost_rmb ?? defaultSettings.packaging_cost_rmb,
    exchange_rate_rmb_per_jpy:
      settings.exchange_rate_rmb_per_jpy ??
      defaultSettings.exchange_rate_rmb_per_jpy,
    temu_shipping_subsidy_jpy:
      settings.temu_shipping_subsidy_jpy ??
      defaultSettings.temu_shipping_subsidy_jpy,
    sf_first_weight_kg:
      settings.sf_first_weight_kg ?? defaultSettings.sf_first_weight_kg,
    sf_first_price_rmb:
      settings.sf_first_price_rmb ?? defaultSettings.sf_first_price_rmb,
    sf_extra_price_per_kg_rmb:
      settings.sf_extra_price_per_kg_rmb ??
      defaultSettings.sf_extra_price_per_kg_rmb,
    huaian_air_price_per_kg_rmb:
      settings.huaian_air_price_per_kg_rmb ??
      defaultSettings.huaian_air_price_per_kg_rmb,
    ocs_price_per_kg_rmb:
      settings.ocs_price_per_kg_rmb ?? defaultSettings.ocs_price_per_kg_rmb,
    osaka_lastmile_jpy:
      settings.osaka_lastmile_jpy ?? defaultSettings.osaka_lastmile_jpy,
    fukuoka_lastmile_jpy:
      settings.fukuoka_lastmile_jpy ?? defaultSettings.fukuoka_lastmile_jpy,
    test_ocs_3cm_first_price_rmb:
      settings.test_ocs_3cm_first_price_rmb ??
      defaultSettings.test_ocs_3cm_first_price_rmb,
    test_ocs_3cm_extra_price_per_100g_rmb:
      settings.test_ocs_3cm_extra_price_per_100g_rmb ??
      defaultSettings.test_ocs_3cm_extra_price_per_100g_rmb,
    test_ocs_small_parcel_first_price_rmb:
      settings.test_ocs_small_parcel_first_price_rmb ??
      defaultSettings.test_ocs_small_parcel_first_price_rmb,
    test_ocs_small_parcel_extra_price_per_500g_rmb:
      settings.test_ocs_small_parcel_extra_price_per_500g_rmb ??
      defaultSettings.test_ocs_small_parcel_extra_price_per_500g_rmb,
    target_profit_rate:
      settings.target_profit_rate ?? defaultSettings.target_profit_rate,
    target_post_ad_profit_rate:
      settings.target_post_ad_profit_rate ??
      defaultSettings.target_post_ad_profit_rate,
  };

  if (settings.id) normalized.id = settings.id;
  if (settings.owner_id) normalized.owner_id = settings.owner_id;
  if (typeof settings.ocs_tariff_rate !== "undefined") {
    normalized.ocs_tariff_rate = settings.ocs_tariff_rate;
  }

  return normalized;
}

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
    return normalizeSettings(data as PricingSettings);
  }

  const canCreate =
    options.createIfMissing ??
    getPermissionCapabilities(await fetchCurrentAccountPermission()).canEdit;

  if (!canCreate) {
    return normalizeSettings({ ...defaultSettings, owner_id: userId });
  }

  const { data: created, error: insertError } = await supabase
    .from("pricing_settings")
    .insert({
      ...defaultSettings,
    })
    .select()
    .single();

  if (insertError) throw insertError;
  return normalizeSettings(created as PricingSettings);
}

export async function saveSettings(userId: string, settings: PricingSettings) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("pricing_settings").upsert(
    {
      ...normalizeSettings(settings),
      owner_id: userId,
    },
    { onConflict: "owner_id" },
  );

  if (error) throw error;
}
