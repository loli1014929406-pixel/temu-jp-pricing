import type { FinanceLogisticsCashSummary } from "../../lib/actual-shipping-fees";
import type { FinanceAggregateRow } from "../../lib/finance-queries";
import type { FinanceExpense, PurchaseOrder } from "../../types";
import {
  formatDate,
  getMonthKey,
  isDateInPeriod,
  roundMoney,
  type FinancePeriod,
} from "./shared";

export type FinanceMonthlyProfitRow = {
  month: string;
  settledIncome: number;
  estimatedIncome: number;
  purchase: number;
  productCost: number;
  shipping: number;
  cashShipping: number;
  logisticsPaid: number;
  otherExpense: number;
  cashProfit: number;
  orderProfit: number;
};

type FinanceMonthlyProfitInput = {
  analysisMonthly: FinanceAggregateRow[];
  purchases: PurchaseOrder[];
  expenses: FinanceExpense[];
  logisticsMonthly: FinanceLogisticsCashSummary["monthly"];
  period?: FinancePeriod;
};

const allPeriod: FinancePeriod = {
  mode: "all",
  start: "",
  end: "",
  label: "全部数据",
};

export function buildFinanceMonthlyProfitRows({
  analysisMonthly,
  purchases,
  expenses,
  logisticsMonthly,
  period = allPeriod,
}: FinanceMonthlyProfitInput): FinanceMonthlyProfitRow[] {
  const rows = new Map<string, Omit<FinanceMonthlyProfitRow, "cashProfit" | "orderProfit">>();
  const ensure = (month: string) => {
    const existing = rows.get(month);
    if (existing) return existing;

    const created = {
      month,
      settledIncome: 0,
      estimatedIncome: 0,
      purchase: 0,
      productCost: 0,
      shipping: 0,
      cashShipping: 0,
      logisticsPaid: 0,
      otherExpense: 0,
    };
    rows.set(month, created);
    return created;
  };

  analysisMonthly.forEach((raw) => {
    const row = ensure(String(raw.month));
    row.settledIncome = Number(raw.actual_revenue ?? 0);
    row.estimatedIncome = Number(raw.estimated_income ?? 0);
    row.productCost = Number(raw.product_cost ?? 0);
    row.shipping = Number(raw.shipping ?? 0);
    row.cashShipping = Number(raw.cash_shipping ?? 0);
  });

  purchases.forEach((purchase) => {
    const date = formatDate(purchase.purchased_at);
    if (period.mode !== "all" && !isDateInPeriod(date, period)) return;
    ensure(getMonthKey(date)).purchase += Number(purchase.total_cost_rmb || 0);
  });

  expenses.forEach((expense) => {
    if (period.mode !== "all" && !isDateInPeriod(expense.expense_date, period)) return;
    ensure(getMonthKey(expense.expense_date)).otherExpense += expense.amount_rmb;
  });

  logisticsMonthly.forEach((payment) => {
    const paymentDate = `${payment.month}-01`;
    if (period.mode !== "all" && !isDateInPeriod(paymentDate, period)) return;
    const row = ensure(payment.month);
    row.logisticsPaid += payment.paidAmountRmb;
    if (payment.hasFirstLegActual) {
      const estimatedFirstLeg = Number(
        analysisMonthly.find((item) => String(item.month) === payment.month)?.first_leg_shipping ?? 0,
      );
      row.shipping = row.shipping - estimatedFirstLeg + payment.firstLegActualAmountRmb;
    }
  });

  return Array.from(rows.values())
    .sort((left, right) => right.month.localeCompare(left.month))
    .map((row) => ({
      ...row,
      settledIncome: roundMoney(row.settledIncome),
      estimatedIncome: roundMoney(row.estimatedIncome),
      purchase: roundMoney(row.purchase),
      productCost: roundMoney(row.productCost),
      shipping: roundMoney(row.shipping),
      cashShipping: roundMoney(row.cashShipping),
      logisticsPaid: roundMoney(row.logisticsPaid),
      otherExpense: roundMoney(row.otherExpense),
      cashProfit: roundMoney(row.settledIncome - row.purchase - row.logisticsPaid - row.otherExpense),
      orderProfit: roundMoney(row.estimatedIncome - row.productCost - row.shipping - row.otherExpense),
    }));
}
