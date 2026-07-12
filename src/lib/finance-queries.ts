import { getSupabaseClient } from "./supabase";
import { requireSession, withTimeout } from "./supabase-helpers";
import type { FinanceOrderRow } from "../pages/finance/shared";

export type FinanceLedgerRow = {
  date: string;
  type: "订单回款" | "采购付款" | "其他费用";
  direction: "收入" | "支出";
  subject: string;
  amountRmb: number;
  remark: string;
  stableId: string;
};

type LedgerRpcRow = {
  entry_date: string;
  entry_type: FinanceLedgerRow["type"];
  direction: FinanceLedgerRow["direction"];
  subject: string;
  amount_rmb: number | string;
  remark: string;
  stable_id: string;
};

export async function fetchFinanceLedgerPage(options: {
  page: number;
  pageSize: number;
  type: "all" | FinanceLedgerRow["type"];
  month: string;
}) {
  await requireSession();
  const supabase = getSupabaseClient();
  const { data, error } = await withTimeout(
    supabase.rpc("get_finance_ledger_page", {
      p_page: Math.max(1, Math.trunc(options.page)),
      p_page_size: Math.min(100, Math.max(1, Math.trunc(options.pageSize))),
      p_type: options.type,
      p_month: options.month,
    }),
    "加载财务流水分页",
  );
  if (error) throw error;
  const payload = (Array.isArray(data) ? data[0] : data) as {
    rows?: unknown;
    total_count?: unknown;
    total_income?: unknown;
    total_expense?: unknown;
    months?: unknown;
  } | null;
  const rows = (Array.isArray(payload?.rows) ? payload.rows : []) as LedgerRpcRow[];
  return {
    rows: rows.map((row) => ({
      date: row.entry_date,
      type: row.entry_type,
      direction: row.direction,
      subject: row.subject,
      amountRmb: Number(row.amount_rmb),
      remark: row.remark,
      stableId: row.stable_id,
    })),
    totalCount: Number(payload?.total_count ?? 0),
    totalIncome: Number(payload?.total_income ?? 0),
    totalExpense: Number(payload?.total_expense ?? 0),
    months: (Array.isArray(payload?.months) ? payload.months : []).map(String),
  };
}

export type FinanceAnalysisSummary = {
  orderCount: number;
  quantity: number;
  productCost: number;
  firstLegShipping: number;
  lastLegShipping: number;
  shipping: number;
  cashShipping: number;
  bill: number;
  actualRevenue: number;
  profit: number;
  settledCount: number;
  unsettledCount: number;
  unmatchedCount: number;
  missingShippingCount: number;
  missingShippingAttentionCount: number;
};

export type FinanceAggregateRow = Record<string, string | number>;

export async function fetchFinanceOrderAnalysis(options: {
  page?: number;
  pageSize?: number;
  search?: string;
  dateStart?: string;
  dateEnd?: string;
  status?: "all" | "settled" | "unsettled";
  issue?: "all" | "unmatched" | "missing-shipping" | "settlement-overdue" | "warehouse-logistics-incomplete" | "reconciliation";
}) {
  await requireSession();
  const supabase = getSupabaseClient();
  const { data, error } = await withTimeout(
    supabase.rpc("get_finance_order_analysis", {
      p_page: Math.max(1, Math.trunc(options.page ?? 1)),
      p_page_size: Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 20))),
      p_search: options.search?.trim() ?? "",
      p_date_start: options.dateStart || null,
      p_date_end: options.dateEnd || null,
      p_status: options.status ?? "all",
      p_issue: options.issue ?? "all",
    }),
    "加载财务订单分页与汇总",
  );
  if (error) throw error;
  const payload = (Array.isArray(data) ? data[0] : data) as {
    rows?: unknown;
    total_count?: unknown;
    summary?: unknown;
    monthly?: unknown;
    products?: unknown;
    shipping_methods?: unknown;
  } | null;
  return {
    rows: (Array.isArray(payload?.rows) ? payload.rows : []) as FinanceOrderRow[],
    totalCount: Number(payload?.total_count ?? 0),
    summary: (payload?.summary ?? {}) as FinanceAnalysisSummary,
    monthly: (Array.isArray(payload?.monthly) ? payload.monthly : []) as FinanceAggregateRow[],
    products: (Array.isArray(payload?.products) ? payload.products : []) as FinanceAggregateRow[],
    shippingMethods: (Array.isArray(payload?.shipping_methods) ? payload.shipping_methods : []) as FinanceAggregateRow[],
  };
}
