import { getSupabaseClient } from "./supabase";
import { defaultSettings } from "./defaults";
import type { LogisticsMethodConfig, PricingSettings } from "../types";
import { syncLogisticsMethodsFromSettings } from "./logistics-methods";
import {
  fetchCurrentAccountPermission,
  getPermissionCapabilities,
} from "./permissions";

type FetchSettingsOptions = {
  createIfMissing?: boolean;
};

const basePricingSettingsSelectFields =
  "id, owner_id, packaging_cost_rmb, exchange_rate_rmb_per_jpy, temu_shipping_subsidy_jpy, sf_first_weight_kg, sf_first_price_rmb, sf_extra_price_per_kg_rmb, huaian_air_price_per_kg_rmb, ocs_price_per_kg_rmb, osaka_lastmile_jpy, fukuoka_lastmile_jpy, test_ocs_3cm_first_price_rmb, test_ocs_3cm_extra_price_per_100g_rmb, test_ocs_small_parcel_first_price_rmb, test_ocs_small_parcel_extra_price_per_500g_rmb, target_profit_rate, target_post_ad_profit_rate, ocs_tariff_rate";

const pricingSettingsSelectFields = `${basePricingSettingsSelectFields}, first_leg_methods, last_leg_methods`;
const dynamicLogisticsSettingsStoragePrefix = "pricing-logistics-config:v2";

const logisticsFormulas = [
  "sf",
  "flat_rmb",
  "flat_rmb_tariff",
  "flat_jpy",
  "fixed_rmb",
  "ocs_3cm",
  "ocs_small",
] as const satisfies readonly LogisticsMethodConfig["formula"][];

function isDynamicSettingsColumnError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  const lowerMessage = message.toLowerCase();
  return (
    (lowerMessage.includes("first_leg_methods") ||
      lowerMessage.includes("last_leg_methods")) &&
    (lowerMessage.includes("schema cache") ||
      lowerMessage.includes("column") ||
      lowerMessage.includes("could not find"))
  );
}

function normalizeLogisticsMethodConfigs(
  value: unknown,
  fallback: LogisticsMethodConfig[] | undefined,
  type: LogisticsMethodConfig["type"],
): LogisticsMethodConfig[] {
  if (!Array.isArray(value)) {
    return (fallback ?? []).map((method) => ({ ...method, params: { ...method.params } }));
  }

  return value
    .map((row, index): LogisticsMethodConfig | null => {
      if (typeof row !== "object" || row === null) return null;
      const item = row as Partial<LogisticsMethodConfig>;
      const formula = logisticsFormulas.includes(item.formula as LogisticsMethodConfig["formula"])
        ? (item.formula as LogisticsMethodConfig["formula"])
        : null;
      if (!formula) return null;

      const params = (
        typeof item.params === "object" && item.params !== null
          ? item.params
          : {}
      ) as LogisticsMethodConfig["params"];
      return {
        id:
          typeof item.id === "string" && item.id.trim()
            ? item.id
            : `${type}-${index + 1}`,
        db_method_id:
          typeof item.db_method_id === "string" && item.db_method_id.trim()
            ? item.db_method_id
            : undefined,
        name: String(item.name ?? ""),
        type,
        formula,
        params: {
          price: typeof params.price === "number" ? params.price : undefined,
          currency: params.currency === "RMB" || params.currency === "JPY" ? params.currency : undefined,
          billingUnit:
            params.billingUnit === "kg" ||
            params.billingUnit === "100g" ||
            params.billingUnit === "500g" ||
            params.billingUnit === "ticket"
              ? params.billingUnit
              : undefined,
          tariffRate: typeof params.tariffRate === "number" ? params.tariffRate : undefined,
          firstWeight: typeof params.firstWeight === "number" ? params.firstWeight : undefined,
          firstPrice: typeof params.firstPrice === "number" ? params.firstPrice : undefined,
          extraPrice: typeof params.extraPrice === "number" ? params.extraPrice : undefined,
        },
        isActive: item.isActive ?? true,
      };
    })
    .filter((method): method is LogisticsMethodConfig => Boolean(method));
}

function getDynamicLogisticsSettingsStorageKey(userId: string) {
  return `${dynamicLogisticsSettingsStoragePrefix}:${userId}`;
}

function canUseLocalStorage() {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function hasOwnField(value: unknown, field: string) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, field)
  );
}

function readCachedDynamicLogisticsSettings(userId: string) {
  if (!canUseLocalStorage()) return {};

  try {
    const cached = window.localStorage.getItem(getDynamicLogisticsSettingsStorageKey(userId));
    if (!cached) return {};
    const parsed = JSON.parse(cached) as Partial<PricingSettings>;

    return {
      first_leg_methods: normalizeLogisticsMethodConfigs(
        parsed.first_leg_methods,
        undefined,
        "first_leg",
      ),
      last_leg_methods: normalizeLogisticsMethodConfigs(
        parsed.last_leg_methods,
        undefined,
        "last_leg",
      ),
    };
  } catch {
    return {};
  }
}

function writeCachedDynamicLogisticsSettings(userId: string, settings: PricingSettings) {
  if (!canUseLocalStorage()) return;

  window.localStorage.setItem(
    getDynamicLogisticsSettingsStorageKey(userId),
    JSON.stringify({
      first_leg_methods: normalizeLogisticsMethodConfigs(
        settings.first_leg_methods,
        defaultSettings.first_leg_methods,
        "first_leg",
      ),
      last_leg_methods: normalizeLogisticsMethodConfigs(
        settings.last_leg_methods,
        defaultSettings.last_leg_methods,
        "last_leg",
      ),
    }),
  );
}

function applyCachedDynamicLogisticsSettings(userId: string, settings: unknown) {
  if (hasOwnField(settings, "first_leg_methods") && hasOwnField(settings, "last_leg_methods")) {
    const normalized = normalizeSettings(settings as Partial<PricingSettings>);
    writeCachedDynamicLogisticsSettings(userId, normalized);
    return normalized;
  }

  const cached = readCachedDynamicLogisticsSettings(userId);
  return normalizeSettings({
    ...(settings as Partial<PricingSettings>),
    ...cached,
  });
}

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
    first_leg_methods: normalizeLogisticsMethodConfigs(
      settings.first_leg_methods,
      defaultSettings.first_leg_methods,
      "first_leg",
    ),
    last_leg_methods: normalizeLogisticsMethodConfigs(
      settings.last_leg_methods,
      defaultSettings.last_leg_methods,
      "last_leg",
    ),
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
  const settingsResult = await supabase
    .from("pricing_settings")
    .select(pricingSettingsSelectFields)
    .eq("owner_id", userId)
    .maybeSingle();
  let data: unknown = settingsResult.data;
  let error = settingsResult.error;

  if (error && isDynamicSettingsColumnError(error)) {
    const fallbackResult = await supabase
      .from("pricing_settings")
      .select(basePricingSettingsSelectFields)
      .eq("owner_id", userId)
      .maybeSingle();
    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  if (error) throw error;

  if (data) {
    return applyCachedDynamicLogisticsSettings(userId, data);
  }

  const canCreate =
    options.createIfMissing ??
    getPermissionCapabilities(await fetchCurrentAccountPermission()).canEdit;

  if (!canCreate) {
    return applyCachedDynamicLogisticsSettings(userId, { ...defaultSettings, owner_id: userId });
  }

  const insertResult = await supabase
    .from("pricing_settings")
    .insert({
      ...defaultSettings,
    })
    .select(pricingSettingsSelectFields)
    .single();
  let created: unknown = insertResult.data;
  let insertError = insertResult.error;

  if (insertError && isDynamicSettingsColumnError(insertError)) {
    const { first_leg_methods, last_leg_methods, ...baseDefaultSettings } = defaultSettings;
    void first_leg_methods;
    void last_leg_methods;

    const fallbackResult = await supabase
      .from("pricing_settings")
      .insert({
        ...baseDefaultSettings,
      })
      .select(basePricingSettingsSelectFields)
      .single();
    created = fallbackResult.data;
    insertError = fallbackResult.error;
  }

  if (insertError) throw insertError;
  return applyCachedDynamicLogisticsSettings(userId, created);
}

export async function saveSettings(userId: string, settings: PricingSettings) {
  const supabase = getSupabaseClient();
  const previousSettings = await fetchSettings(userId, { createIfMissing: false });
  const normalizedSettings = normalizeSettings(settings);
  const syncedMethods = await syncLogisticsMethodsFromSettings(
    normalizedSettings,
    previousSettings,
  );
  const settingsToSave = normalizeSettings({
    ...normalizedSettings,
    ...syncedMethods,
  });
  const { error } = await supabase.from("pricing_settings").upsert(
    {
      ...settingsToSave,
      owner_id: userId,
    },
    { onConflict: "owner_id" },
  );

  if (!error) {
    writeCachedDynamicLogisticsSettings(userId, settingsToSave);
    return;
  }
  if (!isDynamicSettingsColumnError(error)) throw error;

  const { first_leg_methods, last_leg_methods, ...baseSettings } = settingsToSave;
  void first_leg_methods;
  void last_leg_methods;

  const { error: fallbackError } = await supabase.from("pricing_settings").upsert(
    {
      ...baseSettings,
      owner_id: userId,
    },
    { onConflict: "owner_id" },
  );

  if (fallbackError) throw fallbackError;
  writeCachedDynamicLogisticsSettings(userId, settingsToSave);
}
