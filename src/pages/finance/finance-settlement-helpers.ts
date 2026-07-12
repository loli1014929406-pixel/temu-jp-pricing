import type { FinanceOrderRow } from "./shared";
import { getCurrentMonthInputValue, getDateKey, getOrderDate, getReconciliationIssues } from "./shared";

export type IncomeDateFilterMode = "all" | "month" | "custom";

export type IncomeShippingMethodRow = {
  method: string;
  orderCount: number;
  quantity: number;
  actualShipping: number;
  estimatedShipping: number;
  totalShipping: number;
  missingShippingCount: number;
  averagePerOrder: number;
};

export const settlementReconColumns = [
  { key: "order_no", width: "13rem" },
  { key: "sku_code", width: "11rem" },
  { key: "product", width: "18rem" },
  { key: "status", width: "16rem" },
  { key: "logistics", width: "13rem" },
  { key: "shipping_fee", width: "10rem" },
  { key: "actions", width: "14rem" },
] as const;

export const settlementIncomeColumns = [
  { key: "index", width: "4rem" },
  { key: "order_no", width: "13rem" },
  { key: "sku_code", width: "13rem" },
  { key: "product", width: "18rem" },
  { key: "product_cost", width: "10rem" },
  { key: "first_leg_shipping", width: "9rem" },
  { key: "last_leg_shipping", width: "9rem" },
  { key: "bill", width: "10rem" },
  { key: "revenue", width: "10rem" },
  { key: "profit", width: "9rem" },
  { key: "logistics", width: "13rem" },
  { key: "settlement", width: "8rem" },
  { key: "accounting", width: "8rem" },
] as const;

export function getReconciliationIssueLabel(issue: ReturnType<typeof getReconciliationIssues>[number]) {
  if (issue === "unmatched") return "SKU 货号未匹配";
  if (issue === "warehouse-logistics-incomplete") return "仓库物流配置不完整";
  if (issue === "settlement-overdue") return "签收超一个月未结算";
  if (issue === "shipping-method-missing") return "缺发货方式 (无法估算运费)";
  return "运费缺失 (无法估算)";
}

export function getCurrentMonthValue() {
  return getCurrentMonthInputValue();
}

export function normalizeDatePart(value: string) {
  return getDateKey(value);
}

export function getIncomeOrderDate(row: Pick<FinanceOrderRow, "order">) {
  return normalizeDatePart(getOrderDate(row.order));
}

export function getShippingMethodDisplay(value: unknown) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ");
  return label || "未填写发货方式";
}

