import { describe, expect, it } from "vitest";
import type { LogisticsMethodConfig, PricingSettings } from "../types";
import {
  initializeDefaultLogisticsSelections,
  validateDefaultLogisticsSelections,
} from "./default-pricing-logistics";
import { defaultSettings } from "./defaults";

function method(
  id: string,
  name: string,
  type: LogisticsMethodConfig["type"],
  dbMethodId?: string,
): LogisticsMethodConfig {
  return {
    id,
    db_method_id: dbMethodId,
    name,
    type,
    formula: type === "first_leg" ? "flat_rmb" : "fixed_rmb",
    params: { price: 1 },
    isActive: true,
  };
}

describe("default pricing logistics selections", () => {
  it("initializes legacy settings to OCS RMB/kg plus Kobe Yamato3cm", () => {
    const settings = initializeDefaultLogisticsSelections({
      ...defaultSettings,
      first_leg_methods: [
        method("sf", "顺丰", "first_leg"),
        method(
          "ocs",
          "重命名头程",
          "first_leg",
          "287baa57-4cab-46e3-8cfe-d00dc274bedd",
        ),
      ],
      last_leg_methods: [
        method("osaka", "大阪Japan Post", "last_leg"),
        method(
          "kobe",
          "重命名尾程",
          "last_leg",
          "4712d2ae-5d3d-42fd-ae7a-d5468a375e22",
        ),
      ],
    });

    expect(settings.first_leg_methods?.find((item) => item.isDefault)?.id).toBe(
      "ocs",
    );
    expect(settings.last_leg_methods?.find((item) => item.isDefault)?.id).toBe(
      "kobe",
    );
  });

  it("blocks saving when a selected default method is inactive", () => {
    const settings: PricingSettings = {
      ...defaultSettings,
      first_leg_methods: defaultSettings.first_leg_methods?.map((item) => ({
        ...item,
        isActive: item.isDefault ? false : item.isActive,
      })),
    };

    expect(validateDefaultLogisticsSelections(settings)).toBe(
      "默认头程物流方式已停用，请重新选择。",
    );
  });

  it("blocks saving after the selected default method is deleted", () => {
    const settings: PricingSettings = {
      ...defaultSettings,
      last_leg_methods: defaultSettings.last_leg_methods?.filter(
        (item) => !item.isDefault,
      ),
    };

    expect(validateDefaultLogisticsSelections(settings)).toBe(
      "请选择一个默认尾程物流方式。",
    );
  });
});
