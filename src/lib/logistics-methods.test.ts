import { describe, expect, it } from "vitest";
import {
  getLogisticsMethodRenameIntents,
  normalizeLogisticsMethodName,
} from "./logistics-methods";
import type { LogisticsMethod, LogisticsMethodConfig } from "../types";

describe("normalizeLogisticsMethodName", () => {
  it.each(["OCS 3cm", "OCS 昆山3cm", "OCS 昆山 3cm", "OCS Yamato"])(
    "normalizes the historical alias %s",
    (value) => {
      expect(normalizeLogisticsMethodName(value)).toBe("OCS Yamato");
    },
  );
});

const yamatoMethod: LogisticsMethod = {
  id: "11111111-1111-4111-8111-111111111111",
  owner_id: "22222222-2222-4222-8222-222222222222",
  name: "OCS Yamato",
  is_active: true,
  sort_order: 10,
  created_at: "2026-07-14T00:00:00.000Z",
  updated_at: "2026-07-14T00:00:00.000Z",
};

function buildConfig(id: string, name: string): LogisticsMethodConfig {
  return {
    id,
    db_method_id: yamatoMethod.id,
    name,
    type: "last_leg",
    formula: "ocs_3cm",
    params: {},
    isActive: true,
  };
}

describe("getLogisticsMethodRenameIntents", () => {
  it("treats one edited config as the rename source for every config sharing the master id", () => {
    const previousFirst = buildConfig("first", "OCS Yamato");
    const previousLast = buildConfig("last", "OCS Yamato");
    const nextFirst = buildConfig("first", "Yamato 宅急便");
    const nextLast = buildConfig("last", "OCS Yamato");

    const intents = getLogisticsMethodRenameIntents(
      { first_leg_methods: [nextFirst], last_leg_methods: [nextLast] },
      { first_leg_methods: [previousFirst], last_leg_methods: [previousLast] },
      [yamatoMethod],
    );

    expect(intents.get(yamatoMethod.id)).toBe("Yamato 宅急便");
  });

  it("recognizes a first rename before the settings config has a database id", () => {
    const previous = { ...buildConfig("last", "OCS Yamato"), db_method_id: undefined };
    const next = { ...previous, name: "Yamato 宅急便" };

    const intents = getLogisticsMethodRenameIntents(
      { last_leg_methods: [next] },
      { last_leg_methods: [previous] },
      [yamatoMethod],
    );

    expect(intents.get(yamatoMethod.id)).toBe("Yamato 宅急便");
  });

  it("rejects conflicting names for the same master method", () => {
    const previousFirst = buildConfig("first", "OCS Yamato");
    const previousLast = buildConfig("last", "OCS Yamato");

    expect(() =>
      getLogisticsMethodRenameIntents(
        {
          first_leg_methods: [buildConfig("first", "名称 A")],
          last_leg_methods: [buildConfig("last", "名称 B")],
        },
        { first_leg_methods: [previousFirst], last_leg_methods: [previousLast] },
        [yamatoMethod],
      ),
    ).toThrow("同一发货方式不能同时改成");
  });
});
