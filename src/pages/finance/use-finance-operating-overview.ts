import { useCallback, useEffect, useState } from "react";
import {
  fetchFinanceOperatingOverview,
  type FinanceOperatingMonthlyRow,
  type FinanceOperatingOverviewSummary,
} from "../../lib/finance-queries";
import { getErrorMessage } from "../../utils/errors";

const emptySummary: FinanceOperatingOverviewSummary = {
  orderCount: 0,
  settledCount: 0,
  unsettledCount: 0,
  actualRevenue: 0,
  settledProductCost: 0,
  settledShipping: 0,
  settledProfit: 0,
  unsettledProductCost: 0,
  unsettledShipping: 0,
  unsettledCost: 0,
  unmatchedCount: 0,
  missingShippingAttentionCount: 0,
  missingActualShipTimeCount: 0,
};

export function useFinanceOperatingOverview(options: {
  dateStart?: string;
  dateEnd?: string;
}) {
  const [summary, setSummary] = useState(emptySummary);
  const [monthly, setMonthly] = useState<FinanceOperatingMonthlyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const key = JSON.stringify(options);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchFinanceOperatingOverview(options);
      setSummary(result.summary);
      setMonthly(result.monthly);
    } catch (loadError) {
      setSummary(emptySummary);
      setMonthly([]);
      setError(getErrorMessage(loadError, "加载财务经营总览失败"));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  return { summary, monthly, loading, error, reload: load };
}
