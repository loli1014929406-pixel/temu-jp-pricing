import type { FinanceOrderRow } from "./shared";
import { getCurrentMonthInputValue, getDateKey, getOrderDate, getReconciliationIssues } from "./shared";
import { TABLE_COLUMN_WIDTH } from "../../components/ui/table-layout";

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
  { key: "order_no", width: TABLE_COLUMN_WIDTH.standard },
  { key: "sku_code", width: TABLE_COLUMN_WIDTH.medium },
  { key: "product", width: TABLE_COLUMN_WIDTH.content },
  { key: "status", width: TABLE_COLUMN_WIDTH.standard },
  { key: "logistics", width: TABLE_COLUMN_WIDTH.medium },
  { key: "shipping_fee", width: TABLE_COLUMN_WIDTH.actions },
  { key: "actions", width: TABLE_COLUMN_WIDTH.standard },
] as const;

export const settlementIncomeColumns = [
  { key: "index", width: TABLE_COLUMN_WIDTH.index },
  { key: "order_no", width: TABLE_COLUMN_WIDTH.standard },
  { key: "sku_code", width: TABLE_COLUMN_WIDTH.standard },
  { key: "product", width: TABLE_COLUMN_WIDTH.content },
  { key: "product_cost", width: TABLE_COLUMN_WIDTH.actions },
  { key: "first_leg_shipping", width: TABLE_COLUMN_WIDTH.actions },
  { key: "last_leg_shipping", width: TABLE_COLUMN_WIDTH.actions },
  { key: "bill", width: TABLE_COLUMN_WIDTH.actions },
  { key: "revenue", width: TABLE_COLUMN_WIDTH.actions },
  { key: "profit", width: TABLE_COLUMN_WIDTH.actions },
  { key: "logistics", width: TABLE_COLUMN_WIDTH.medium },
  { key: "settlement", width: TABLE_COLUMN_WIDTH.short },
  { key: "accounting", width: TABLE_COLUMN_WIDTH.short },
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
