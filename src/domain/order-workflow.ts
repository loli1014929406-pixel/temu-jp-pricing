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

type OrderFulfillmentAssignment = Pick<
  TemuOrderRecord,
  | "order_no"
  | "warehouse_id"
  | "warehouse_name"
  | "logistics_method_id"
  | "logistics_method"
>;

function getAssignmentKey(id: string | null, name: string) {
  return name.trim().toLocaleLowerCase() || id?.trim() || "";
}

export function getSplitOrderFulfillmentIssue(
  orders: OrderFulfillmentAssignment[],
) {
  const ordersByMainOrderNo = new Map<string, OrderFulfillmentAssignment[]>();

  orders.forEach((order) => {
    const orderNo = order.order_no.trim();
    if (!orderNo) return;
    const group = ordersByMainOrderNo.get(orderNo) ?? [];
    group.push(order);
    ordersByMainOrderNo.set(orderNo, group);
  });

  for (const [orderNo, group] of ordersByMainOrderNo) {
    if (group.length < 2) continue;

    const warehouseKeys = new Set(
      group.map((order) => getAssignmentKey(order.warehouse_id, order.warehouse_name)),
    );
    const logisticsMethodKeys = new Set(
      group.map((order) =>
        getAssignmentKey(order.logistics_method_id, order.logistics_method),
      ),
    );

    if (warehouseKeys.size > 1) {
      return `主订单 ${orderNo} 含 ${group.length} 个子单，必须使用同一发货仓库，严禁拆单分仓。`;
    }
    if (logisticsMethodKeys.size > 1) {
      return `主订单 ${orderNo} 含 ${group.length} 个子单，必须使用同一发货方式，严禁拆单发货。`;
    }
  }

  return "";
}

export function getOrderStageDefinition(stage: OrderStage) {
  return (
    orderStageDefinitions.find((definition) => definition.key === stage) ??
    orderStageDefinitions[0]
  );
}
