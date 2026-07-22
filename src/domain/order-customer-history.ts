import type {
  OrderCustomerHistoryStatus,
  TemuOrderRecord,
} from "../types";

export type OrderCustomerHistoryMeta = {
  label: string;
  rowClassName: string;
  legendClassName: string;
};

export const orderCustomerHistoryMeta: Record<
  OrderCustomerHistoryStatus,
  OrderCustomerHistoryMeta
> = {
  normal: {
    label: "正常订单",
    rowClassName: "",
    legendClassName: "border-slate-200 bg-white",
  },
  repeat_customer: {
    label: "普通重复下单",
    rowClassName: "order-customer-repeat",
    legendClassName: "border-amber-300 bg-amber-100",
  },
  refund_order: {
    label: "实际退款订单",
    rowClassName: "order-customer-refund-order",
    legendClassName: "border-rose-300 bg-rose-100",
  },
  refund_customer: {
    label: "退款客户关联订单",
    rowClassName: "order-customer-refund-related",
    legendClassName: "border-violet-300 bg-violet-100",
  },
};

export const visibleOrderCustomerHistoryStatuses = [
  "refund_order",
  "refund_customer",
  "repeat_customer",
] as const satisfies readonly OrderCustomerHistoryStatus[];

export function getOrderCustomerHistoryMeta(
  status: OrderCustomerHistoryStatus | null | undefined,
) {
  return orderCustomerHistoryMeta[status ?? "normal"] ?? orderCustomerHistoryMeta.normal;
}

export function getOrderCustomerHistoryTitle(
  order: Pick<
    TemuOrderRecord,
    | "customer_history_status"
    | "customer_sales_reversal"
    | "customer_freight_reversal"
  >,
) {
  const meta = getOrderCustomerHistoryMeta(order.customer_history_status);
  if (order.customer_history_status !== "refund_order") return meta.label;

  const sales = Number(order.customer_sales_reversal ?? 0).toFixed(2);
  const freight = Number(order.customer_freight_reversal ?? 0).toFixed(2);
  return `${meta.label}：销售冲回 ¥${sales}，运费冲回 ¥${freight}`;
}
