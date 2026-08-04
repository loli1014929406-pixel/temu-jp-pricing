import { describe, expect, it } from "vitest";
import type { FinanceExpense, PurchaseOrder } from "../../types";
import { buildFinanceMonthlyProfitRows } from "./monthly-profit";

function purchase(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "purchase-1",
    order_code: "PUR-1",
    owner_id: "user-1",
    warehouse_id: "warehouse-1",
    warehouse_name: "测试仓库",
    purchased_at: "2026-05-10",
    items_total_rmb: 20,
    total_cost_rmb: 20,
    notes: "",
    status: "received",
    received_at: "2026-05-11",
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-10T00:00:00Z",
    sources: [],
    items: [],
    packages: [],
    ...overrides,
  };
}

function expense(overrides: Partial<FinanceExpense> = {}): FinanceExpense {
  return {
    id: "expense-1",
    user_id: "user-1",
    expense_date: "2026-05-20",
    category: "ad",
    amount_rmb: 10,
    remark: "",
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

describe("buildFinanceMonthlyProfitRows", () => {
  it("uses confirmed actual first-leg cost and deducts monthly expenses", () => {
    const rows = buildFinanceMonthlyProfitRows({
      analysisMonthly: [{
        month: "2026-05",
        actual_revenue: 90,
        estimated_income: 100,
        product_cost: 20,
        first_leg_shipping: 5,
        shipping: 10,
        cash_shipping: 4,
      }],
      purchases: [purchase()],
      expenses: [expense()],
      logisticsMonthly: [{
        month: "2026-05",
        paidAmountRmb: 3,
        firstLegActualAmountRmb: 2,
        hasFirstLegActual: true,
      }],
    });

    expect(rows).toEqual([{
      month: "2026-05",
      settledIncome: 90,
      estimatedIncome: 100,
      purchase: 20,
      productCost: 20,
      shipping: 7,
      cashShipping: 4,
      logisticsPaid: 3,
      otherExpense: 10,
      cashProfit: 57,
      orderProfit: 63,
    }]);
  });

  it("keeps estimated first-leg cost when the month has no confirmed actual total", () => {
    const [row] = buildFinanceMonthlyProfitRows({
      analysisMonthly: [{
        month: "2026-06",
        actual_revenue: 70,
        estimated_income: 100,
        product_cost: 20,
        first_leg_shipping: 5,
        shipping: 10,
        cash_shipping: 4,
      }],
      purchases: [],
      expenses: [],
      logisticsMonthly: [],
    });

    expect(row.shipping).toBe(10);
    expect(row.orderProfit).toBe(70);
  });
});
