import { useCallback, useEffect, useState } from "react";
import {
  fetchFinanceOrderAnalysis,
  type FinanceAggregateRow,
  type FinanceAnalysisSummary,
} from "../../lib/finance-queries";
import type { FinanceOrderRow } from "./shared";
import { getErrorMessage } from "../../utils/errors";

const emptySummary: FinanceAnalysisSummary = {
  orderCount: 0, quantity: 0, productCost: 0, firstLegShipping: 0,
  lastLegShipping: 0, shipping: 0, cashShipping: 0, bill: 0,
  actualRevenue: 0, profit: 0, settledCount: 0, unsettledCount: 0,
  unmatchedCount: 0, missingShippingCount: 0,
  missingShippingAttentionCount: 0,
};

export function useFinanceAnalysis(options: Parameters<typeof fetchFinanceOrderAnalysis>[0]) {
  const [rows, setRows] = useState<FinanceOrderRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState(emptySummary);
  const [monthly, setMonthly] = useState<FinanceAggregateRow[]>([]);
  const [products, setProducts] = useState<FinanceAggregateRow[]>([]);
  const [shippingMethods, setShippingMethods] = useState<FinanceAggregateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const key = JSON.stringify(options);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchFinanceOrderAnalysis(options);
      setRows(result.rows);
      setTotalCount(result.totalCount);
      setSummary({ ...emptySummary, ...result.summary });
      setMonthly(result.monthly);
      setProducts(result.products);
      setShippingMethods(result.shippingMethods);
    } catch (err) {
      setError(getErrorMessage(err, "加载财务订单失败"));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { void load(); }, [load]);
  return { rows, totalCount, summary, monthly, products, shippingMethods, loading, error, reload: load };
}
