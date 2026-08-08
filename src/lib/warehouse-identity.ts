import type { Warehouse } from "../types";

export function getPrimaryAutoMatchWarehouse(warehouses: Warehouse[]) {
  return (
    warehouses
      .filter(
        (warehouse) =>
          warehouse.auto_match_enabled &&
          warehouse.auto_match_priority !== null &&
          warehouse.auto_match_priority > 0,
      )
      .sort((left, right) => {
        const priorityDifference =
          (left.auto_match_priority ?? Number.MAX_SAFE_INTEGER) -
          (right.auto_match_priority ?? Number.MAX_SAFE_INTEGER);
        if (priorityDifference !== 0) return priorityDifference;
        return left.id.localeCompare(right.id);
      })[0] ?? null
  );
}

export function getSuzhouWarehouse(warehouses: Warehouse[]) {
  return warehouses.find((warehouse) => warehouse.name === "苏州") ?? null;
}
