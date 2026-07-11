import type { TemuOrderRecord } from "../types";

export type OrderStage =
  | "all"
  | "pending_assignment"
  | "new_order"
  | "pending_shipping"
  | "shipped"
  | "uploaded_temu"
  | "completed";

export type PersistedOrderStage = Exclude<OrderStage, "all">;

export const orderStageDefinitions = [
  { key: "all", label: "全部", tone: "neutral" },
  { key: "pending_assignment", label: "待分配", tone: "warning" },
  { key: "new_order", label: "新订单", tone: "info" },
  { key: "pending_shipping", label: "待发货", tone: "warning" },
  { key: "shipped", label: "已发货", tone: "success" },
  { key: "uploaded_temu", label: "上传Temu", tone: "info" },
  { key: "completed", label: "已完成", tone: "neutral" },
] satisfies Array<{
  key: OrderStage;
  label: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
}>;

export const uploadedTemuOrderStatus = "上传Temu";
const legacyUploadedTemuOrderStatus = "已上传Temu";
const uploadedTemuOrderStatuses = new Set([
  uploadedTemuOrderStatus.toLowerCase(),
  legacyUploadedTemuOrderStatus.toLowerCase(),
]);

export function isUploadedTemuStatus(value: string) {
  return uploadedTemuOrderStatuses.has(value.trim().toLowerCase());
}

export function getOrderStage(order: TemuOrderRecord): PersistedOrderStage {
  if (order.actual_signed_time.trim()) return "completed";
  if (isUploadedTemuStatus(order.order_status)) return "uploaded_temu";
  if (order.actual_ship_time.trim() || order.logistics_tracking_no.trim()) return "shipped";
  if (order.label_printed_at.trim()) return "pending_shipping";
  if (order.warehouse_id || order.warehouse_name.trim()) return "new_order";
  return "pending_assignment";
}

export function isShippingTrackingStage(stage: OrderStage) {
  return stage === "shipped" || stage === "uploaded_temu";
}

export function shouldReserveOrderInventory(stage: PersistedOrderStage) {
  return stage !== "pending_assignment";
}

export function getOrderStageDefinition(stage: OrderStage) {
  return (
    orderStageDefinitions.find((definition) => definition.key === stage) ??
    orderStageDefinitions[0]
  );
}
