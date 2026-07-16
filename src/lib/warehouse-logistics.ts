import type {
  LogisticsMethod,
  LogisticsMethodConfig,
  PricingSettings,
  WarehouseLogisticsMethod,
} from "../types";
import { calculateDynamicMethodCost } from "../utils/shipping-costs";
import { resolveFirstLegMethods, resolveLastLegMethods } from "./defaults";
import {
  dedupeLogisticsMethodNames,
  normalizeLogisticsMethodName,
} from "./logistics-methods";

export type WarehouseLogisticsConfigStatus = {
  firstLegs: LogisticsMethodConfig[];
  lastLegs: LogisticsMethodConfig[];
  hasFirstLeg: boolean;
  hasLastLeg: boolean;
  isComplete: boolean;
  issue: string;
};

function methodNameKey(value: string) {
  return normalizeLogisticsMethodName(value).toLowerCase();
}

function sortWarehouseLinks(
  links: WarehouseLogisticsMethod[],
): WarehouseLogisticsMethod[] {
  return [...links].sort((left, right) => {
    if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
    if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
    return left.created_at.localeCompare(right.created_at);
  });
}

function findConfigForMethod(
  method: LogisticsMethod,
  configs: LogisticsMethodConfig[],
) {
  return configs.find((config) => {
    if (!config.isActive) return false;
    if (config.db_method_id && config.db_method_id === method.id) return true;
    return methodNameKey(config.name) === methodNameKey(method.name);
  });
}

export function getWarehouseLogisticsConfigs(
  warehouseId: string | null | undefined,
  settings: PricingSettings | null | undefined,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  if (!warehouseId || !settings) {
    return {
      firstLegs: [] as LogisticsMethodConfig[],
      lastLegs: [] as LogisticsMethodConfig[],
    };
  }

  const methodsById = new Map(
    logisticsMethods
      .filter((method) => method.is_active)
      .map((method) => [method.id, method]),
  );
  const firstLegConfigs = resolveFirstLegMethods(settings);
  const lastLegConfigs = resolveLastLegMethods(settings);
  const firstLegs: LogisticsMethodConfig[] = [];
  const lastLegs: LogisticsMethodConfig[] = [];

  for (const link of sortWarehouseLinks(
    warehouseLogisticsMethods.filter((item) => item.warehouse_id === warehouseId),
  )) {
    const method = methodsById.get(link.logistics_method_id);
    if (!method) continue;

    const firstLeg = findConfigForMethod(method, firstLegConfigs);
    if (firstLeg) {
      firstLegs.push(firstLeg);
      continue;
    }

    const lastLeg = findConfigForMethod(method, lastLegConfigs);
    if (lastLeg) lastLegs.push(lastLeg);
  }

  return { firstLegs, lastLegs };
}

export function getWarehouseLogisticsConfigStatus(
  warehouseId: string | null | undefined,
  settings: PricingSettings | null | undefined,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
): WarehouseLogisticsConfigStatus {
  const { firstLegs, lastLegs } = getWarehouseLogisticsConfigs(
    warehouseId,
    settings,
    logisticsMethods,
    warehouseLogisticsMethods,
  );
  const hasFirstLeg = firstLegs.length > 0;
  const hasLastLeg = lastLegs.length > 0;
  const missing = [
    hasFirstLeg ? "" : "头程物流方式",
    hasLastLeg ? "" : "尾程物流方式",
  ].filter(Boolean);

  return {
    firstLegs,
    lastLegs,
    hasFirstLeg,
    hasLastLeg,
    isComplete: hasFirstLeg && hasLastLeg,
    issue: missing.length > 0 ? `仓库物流配置不完整：缺少${missing.join("、")}` : "",
  };
}

export function getWarehouseLastLegMethodNames(
  warehouseId: string | null | undefined,
  settings: PricingSettings | null | undefined,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  if (!warehouseId || !settings) return [];

  const methodsById = new Map(
    logisticsMethods
      .filter((method) => method.is_active)
      .map((method) => [method.id, method]),
  );
  const lastLegConfigs = resolveLastLegMethods(settings);
  const methodNames = sortWarehouseLinks(
    warehouseLogisticsMethods.filter((item) => item.warehouse_id === warehouseId),
  ).flatMap((link) => {
    const method = methodsById.get(link.logistics_method_id);
    return method && findConfigForMethod(method, lastLegConfigs) ? [method.name] : [];
  });

  return dedupeLogisticsMethodNames(methodNames);
}

export function isLastLegMethodAllowedForWarehouse(
  warehouseId: string | null | undefined,
  logisticsMethod: string,
  settings: PricingSettings | null | undefined,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  const normalizedMethod = normalizeLogisticsMethodName(logisticsMethod);
  if (!normalizedMethod) return true;
  return getWarehouseLastLegMethodNames(
    warehouseId,
    settings,
    logisticsMethods,
    warehouseLogisticsMethods,
  ).includes(normalizedMethod);
}

export function calculateHighestWarehouseFirstLegCostRmb({
  warehouseId,
  packageWeightG,
  settings,
  logisticsMethods,
  warehouseLogisticsMethods,
}: {
  warehouseId: string | null | undefined;
  packageWeightG: number;
  settings: PricingSettings | null | undefined;
  logisticsMethods: LogisticsMethod[];
  warehouseLogisticsMethods: WarehouseLogisticsMethod[];
}) {
  const status = getWarehouseLogisticsConfigStatus(
    warehouseId,
    settings,
    logisticsMethods,
    warehouseLogisticsMethods,
  );

  if (!settings || status.firstLegs.length === 0) return 0;

  return Math.max(
    ...status.firstLegs.map((method) =>
      calculateDynamicMethodCost(
        method,
        packageWeightG,
        settings.exchange_rate_rmb_per_jpy,
      ),
    ),
  );
}
