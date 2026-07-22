import type { PricingSettings } from "../types";

export type SettingsDraftState = {
  settings: PricingSettings;
  baseSettings: PricingSettings;
};

function isSettingsDraftState(value: unknown): value is SettingsDraftState {
  return (
    typeof value === "object" &&
    value !== null &&
    "settings" in value &&
    "baseSettings" in value
  );
}

export function resolveSettingsDraft(
  draft: unknown,
  currentSettings: PricingSettings,
): PricingSettings | null {
  if (!isSettingsDraftState(draft)) return null;

  return JSON.stringify(draft.baseSettings) === JSON.stringify(currentSettings)
    ? draft.settings
    : null;
}
