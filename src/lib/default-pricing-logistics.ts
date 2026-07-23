import type { LogisticsMethodConfig, PricingSettings } from "../types";

export const INITIAL_DEFAULT_FIRST_LEG_DB_ID =
  "287baa57-4cab-46e3-8cfe-d00dc274bedd";
export const INITIAL_DEFAULT_LAST_LEG_DB_ID =
  "4712d2ae-5d3d-42fd-ae7a-d5468a375e22";

const normalizeName = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, "");

function initializeSectionDefault(
  methods: LogisticsMethodConfig[],
  dbMethodId: string,
  fallbackName: string,
) {
  if (methods.some((method) => method.isDefault)) return methods;

  const fallbackNormalizedName = normalizeName(fallbackName);
  const selected =
    methods.find(
      (method) => method.isActive && method.db_method_id === dbMethodId,
    ) ??
    methods.find(
      (method) =>
        method.isActive && normalizeName(method.name) === fallbackNormalizedName,
    ) ??
    methods.find((method) => method.isActive);

  if (!selected) return methods;
  return methods.map((method) => ({
    ...method,
    isDefault: method.id === selected.id,
  }));
}

export function initializeDefaultLogisticsSelections(
  settings: PricingSettings,
): PricingSettings {
  return {
    ...settings,
    first_leg_methods: initializeSectionDefault(
      settings.first_leg_methods ?? [],
      INITIAL_DEFAULT_FIRST_LEG_DB_ID,
      "OCS RMB/kg",
    ),
    last_leg_methods: initializeSectionDefault(
      settings.last_leg_methods ?? [],
      INITIAL_DEFAULT_LAST_LEG_DB_ID,
      "神户 Yamato3cm",
    ),
  };
}

function getSingleDefault(methods: LogisticsMethodConfig[] | undefined) {
  const defaults = (methods ?? []).filter((method) => method.isDefault);
  return defaults.length === 1 ? defaults[0] : null;
}

export function getDefaultFirstLegMethod(settings: PricingSettings) {
  return getSingleDefault(settings.first_leg_methods);
}

export function getDefaultLastLegMethod(settings: PricingSettings) {
  return getSingleDefault(settings.last_leg_methods);
}

export function getDefaultPricingLogisticsSelection(settings: PricingSettings) {
  const firstLegMethod = getDefaultFirstLegMethod(settings);
  const lastLegMethod = getDefaultLastLegMethod(settings);
  return firstLegMethod && lastLegMethod
    ? { firstLegMethod, lastLegMethod }
    : null;
}

export function getDefaultPricingPlanKey(settings: PricingSettings) {
  const selection = getDefaultPricingLogisticsSelection(settings);
  return selection
    ? `${selection.firstLegMethod.id}_${selection.lastLegMethod.id}`
    : null;
}

export function validateDefaultLogisticsSelections(
  settings: PricingSettings,
): string | null {
  const firstDefaults = (settings.first_leg_methods ?? []).filter(
    (method) => method.isDefault,
  );
  const lastDefaults = (settings.last_leg_methods ?? []).filter(
    (method) => method.isDefault,
  );

  if (firstDefaults.length !== 1) {
    return "请选择一个默认头程物流方式。";
  }
  if (!firstDefaults[0].isActive) {
    return "默认头程物流方式已停用，请重新选择。";
  }
  if (lastDefaults.length !== 1) {
    return "请选择一个默认尾程物流方式。";
  }
  if (!lastDefaults[0].isActive) {
    return "默认尾程物流方式已停用，请重新选择。";
  }
  return null;
}
