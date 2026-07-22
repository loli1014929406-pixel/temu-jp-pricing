import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { resolveSettingsDraft, type SettingsDraftState } from "./settings-draft";

function cloneDefaultSettings() {
  return structuredClone(defaultSettings);
}

describe("resolveSettingsDraft", () => {
  it("restores an unsaved draft when the server settings have not changed", () => {
    const baseSettings = cloneDefaultSettings();
    const editedSettings = {
      ...cloneDefaultSettings(),
      target_profit_rate: 0.4,
    };
    const draft: SettingsDraftState = {
      settings: editedSettings,
      baseSettings,
    };

    expect(resolveSettingsDraft(draft, cloneDefaultSettings())).toEqual(editedSettings);
  });

  it("discards a draft when the server has a newly added logistics method", () => {
    const baseSettings = cloneDefaultSettings();
    const draft: SettingsDraftState = {
      settings: {
        ...cloneDefaultSettings(),
        target_profit_rate: 0.4,
      },
      baseSettings,
    };
    const currentSettings = cloneDefaultSettings();
    currentSettings.last_leg_methods = [
      ...(currentSettings.last_leg_methods ?? []),
      {
        id: "kobe-yamato-last-leg",
        db_method_id: "4712d2ae-5d3d-42fd-ae7a-d5468a375e22",
        name: "神户 Yamato",
        type: "last_leg",
        formula: "flat_jpy",
        params: { price: 200, currency: "JPY", billingUnit: "ticket" },
        isActive: true,
      },
    ];

    expect(resolveSettingsDraft(draft, currentSettings)).toBeNull();
  });

  it("does not treat the legacy plain settings value as a restorable draft", () => {
    expect(resolveSettingsDraft(cloneDefaultSettings(), cloneDefaultSettings())).toBeNull();
  });
});
