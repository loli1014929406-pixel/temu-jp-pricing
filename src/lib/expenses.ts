import { getSupabaseClient } from "./supabase";
import { fetchAllPages } from "./paginated-fetch";
import type { FinanceExpense } from "../types";
import { withTimeout } from "./supabase-helpers";

const financeExpenseFields =
  "id, user_id, expense_date, category, amount_rmb, remark, created_at, updated_at";

export async function fetchExpenses(): Promise<FinanceExpense[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await fetchAllPages<FinanceExpense>(async (from, to) => {
    const { data: page, error: pageError } = await withTimeout(
      supabase
        .from("finance_expenses")
        .select(financeExpenseFields)
        .order("expense_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
      "加载费用记录",
    );
    return { data: (page ?? []) as FinanceExpense[], error: pageError };
  });

  if (error) {
    throw error;
  }
  return data ?? [];
}

export async function addExpense(
  expense: Omit<FinanceExpense, "id" | "user_id" | "created_at" | "updated_at">
): Promise<FinanceExpense> {
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw new Error("Unauthorized");

  const { data, error } = await supabase
    .from("finance_expenses")
    .insert([
      {
        ...expense,
        user_id: userData.user.id,
      },
    ])
    .select()
    .single();

  if (error) {
    throw error;
  }
  return data as FinanceExpense;
}

export async function addExpensesBulk(
  expenses: Omit<FinanceExpense, "id" | "user_id" | "created_at" | "updated_at">[]
): Promise<FinanceExpense[]> {
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw new Error("Unauthorized");

  const records = expenses.map(expense => ({
    ...expense,
    user_id: userData.user.id,
  }));

  const { data, error } = await supabase
    .from("finance_expenses")
    .insert(records)
    .select();

  if (error) {
    throw error;
  }
  return data as FinanceExpense[];
}

export async function updateExpense(
  id: string,
  expense: Partial<Omit<FinanceExpense, "id" | "user_id" | "created_at" | "updated_at">>
): Promise<FinanceExpense> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("finance_expenses")
    .update(expense)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    throw error;
  }
  return data as FinanceExpense;
}

export async function deleteExpense(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("finance_expenses")
    .delete()
    .eq("id", id);

  if (error) {
    throw error;
  }
}
