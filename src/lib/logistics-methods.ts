import type { LogisticsMethod, WarehouseLogisticsMethod } from "../types";
import { requireSession, withTimeout } from "./supabase-helpers";

const logisticsMethodSelect =
  "id, owner_id, name, is_active, sort_order, created_at, updated_at";
const warehouseLogisticsMethodSelect =
  "id, warehouse_id, logistics_method_id, owner_id, is_default, sort_order, created_at, updated_at";

export function normalizeLogisticsMethodName(value: string) {
  const text = value.trim();
  if (text === "OCS 昆山3cm" || text === "OCS 昆山 3cm") return "OCS 3cm";
  if (text === "OCS 昆山小包") return "OCS 小包";
  return text;
}

export function dedupeLogisticsMethodNames(methods: string[]) {
  const names = new Map<string, string>();
  methods.forEach((method) => {
    const normalized = normalizeLogisticsMethodName(method);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!names.has(key)) names.set(key, normalized);
  });
  return Array.from(names.values());
}

export async function fetchLogisticsMethods() {
  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("logistics_methods")
      .select(logisticsMethodSelect)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    "加载发货方式",
  );

  if (error) throw error;
  return data as LogisticsMethod[];
}

export async function createLogisticsMethod(name: string) {
  const normalizedName = normalizeLogisticsMethodName(name);
  if (!normalizedName) throw new Error("请填写发货方式名称");

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("logistics_methods")
      .insert({
        name: normalizedName,
      })
      .select(logisticsMethodSelect)
      .single(),
    "新增发货方式",
  );

  if (error) throw error;
  return data as LogisticsMethod;
}

export async function fetchWarehouseLogisticsMethods(warehouseIds: string[]) {
  if (warehouseIds.length === 0) return [] as WarehouseLogisticsMethod[];

  const { supabase } = await requireSession();
  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_logistics_methods")
      .select(warehouseLogisticsMethodSelect)
      .in("warehouse_id", warehouseIds)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    "加载仓库发货方式",
  );

  if (error) throw error;
  return data as WarehouseLogisticsMethod[];
}

export async function replaceWarehouseLogisticsMethods(
  warehouseId: string,
  logisticsMethodIds: string[],
) {
  const methodIds = Array.from(
    new Set(logisticsMethodIds.map((methodId) => methodId.trim()).filter(Boolean)),
  );
  const { supabase } = await requireSession();
  const { error: deleteError } = await withTimeout(
    supabase.from("warehouse_logistics_methods").delete().eq("warehouse_id", warehouseId),
    "保存仓库发货方式",
  );

  if (deleteError) throw deleteError;
  if (methodIds.length === 0) return [] as WarehouseLogisticsMethod[];

  const { data, error } = await withTimeout(
    supabase
      .from("warehouse_logistics_methods")
      .insert(
        methodIds.map((methodId, index) => ({
          warehouse_id: warehouseId,
          logistics_method_id: methodId,
          is_default: index === 0,
          sort_order: index,
        })),
      )
      .select(warehouseLogisticsMethodSelect),
    "保存仓库发货方式",
  );

  if (error) throw error;
  return data as WarehouseLogisticsMethod[];
}

export function getWarehouseLogisticsMethodNames(
  warehouseId: string,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  const methodsById = new Map(
    logisticsMethods
      .filter((method) => method.is_active)
      .map((method) => [method.id, method]),
  );
  const sortedLinks = warehouseLogisticsMethods
    .filter((item) => item.warehouse_id === warehouseId)
    .sort((left, right) => {
      if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
      if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
      return left.created_at.localeCompare(right.created_at);
    });

  return dedupeLogisticsMethodNames(
    sortedLinks.flatMap((link) => {
      const method = methodsById.get(link.logistics_method_id);
      return method ? [method.name] : [];
    }),
  );
}

export function isLogisticsMethodAllowedForWarehouse(
  warehouseId: string,
  logisticsMethod: string,
  logisticsMethods: LogisticsMethod[],
  warehouseLogisticsMethods: WarehouseLogisticsMethod[],
) {
  const method = normalizeLogisticsMethodName(logisticsMethod);
  if (!method) return true;
  return getWarehouseLogisticsMethodNames(
    warehouseId,
    logisticsMethods,
    warehouseLogisticsMethods,
  ).includes(method);
}
