import { useCallback, useEffect, useState } from "react";
import {
  fetchFinanceLogisticsCashSummary,
  type FinanceLogisticsCashSummary,
} from "../../lib/actual-shipping-fees";
import { getErrorMessage } from "../../utils/errors";

const emptySummary: FinanceLogisticsCashSummary = {
  payableAmountRmb: 0,
  paidAmountRmb: 0,
  outstandingAmountRmb: 0,
  monthly: [],
};

export function useFinanceLogisticsCash() {
  const [data, setData] = useState(emptySummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchFinanceLogisticsCashSummary());
    } catch (loadError) {
      setData(emptySummary);
      setError(getErrorMessage(loadError, "加载物流现金汇总失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}
