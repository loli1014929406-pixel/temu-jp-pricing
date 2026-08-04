import { useEffect, useMemo, useState } from "react";
import { Field, TextInput } from "../components/form-controls";
import { PageHeader } from "../components/ui";
import { useTenantContext } from "../hooks/use-tenant-context";
import { getSupabaseClient } from "../lib/supabase";
import { getErrorMessage } from "../utils/errors";

type Overview = {
  enterpriseId: string;
  summary: {
    orderCount: number;
    shippedCount: number;
    settledCount: number;
    actualRevenueRmb: number;
    settledProfitRmb: number;
  };
  shops: Array<{
    shop_id: string;
    shop_code: string;
    shop_name: string;
    order_count: number;
    shipped_count: number;
    settled_count: number;
    actual_revenue_rmb: number;
    settled_profit_rmb: number;
  }>;
};

function money(value: number) {
  return `¥ ${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function EnterpriseOverviewPage() {
  const tenant = useTenantContext();
  const allowedEnterpriseIds = useMemo(
    () => tenant.access.isPlatformOwner
      ? tenant.enterprises.map((enterprise) => enterprise.id)
      : tenant.access.enterpriseOwnerIds,
    [tenant.access.enterpriseOwnerIds, tenant.access.isPlatformOwner, tenant.enterprises],
  );
  const [enterpriseId, setEnterpriseId] = useState(
    tenant.currentEnterprise?.id ?? allowedEnterpriseIds[0] ?? "",
  );
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enterpriseId && allowedEnterpriseIds[0]) {
      setEnterpriseId(allowedEnterpriseIds[0]);
    }
  }, [allowedEnterpriseIds, enterpriseId]);

  useEffect(() => {
    if (!enterpriseId) return;
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const { data, error: rpcError } = await getSupabaseClient().rpc(
          "get_enterprise_operating_overview",
          {
            p_enterprise_id: enterpriseId,
            p_date_start: dateStart || null,
            p_date_end: dateEnd || null,
          },
        );
        if (!active) return;
        if (rpcError) setError(getErrorMessage(rpcError, "加载企业汇总失败"));
        else setOverview(data as Overview);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [dateEnd, dateStart, enterpriseId]);

  return (
    <section className="page-stack">
      <PageHeader
        title="企业经营汇总"
        description="只读汇总各店铺订单与已结算利润；不做跨店铺费用分摊。"
      />
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3">
        <Field label="企业">
          <select value={enterpriseId} onChange={(event) => setEnterpriseId(event.target.value)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
            {tenant.enterprises.filter((enterprise) => allowedEnterpriseIds.includes(enterprise.id)).map((enterprise) => <option key={enterprise.id} value={enterprise.id}>{enterprise.name}</option>)}
          </select>
        </Field>
        <Field label="开始日期"><TextInput type="date" value={dateStart} onChange={(event) => setDateStart(event.target.value)} /></Field>
        <Field label="结束日期"><TextInput type="date" value={dateEnd} onChange={(event) => setDateEnd(event.target.value)} /></Field>
      </div>
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {loading ? <p className="text-sm text-slate-500">加载中...</p> : overview && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {[
              ["订单数", overview.summary.orderCount],
              ["已发货", overview.summary.shippedCount],
              ["已结算", overview.summary.settledCount],
              ["实际收入", money(overview.summary.actualRevenueRmb)],
              ["已结算利润", money(overview.summary.settledProfitRmb)],
            ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-xl font-bold text-slate-900">{value}</p></div>)}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-4 py-3">店铺</th><th className="px-4 py-3">订单</th><th className="px-4 py-3">已发货</th><th className="px-4 py-3">已结算</th><th className="px-4 py-3">实际收入</th><th className="px-4 py-3">已结算利润</th></tr></thead>
              <tbody>{overview.shops.map((shop) => <tr key={shop.shop_id} className="border-t border-slate-100"><td className="px-4 py-3 font-semibold">{shop.shop_name}</td><td className="px-4 py-3">{shop.order_count}</td><td className="px-4 py-3">{shop.shipped_count}</td><td className="px-4 py-3">{shop.settled_count}</td><td className="px-4 py-3">{money(shop.actual_revenue_rmb)}</td><td className="px-4 py-3">{money(shop.settled_profit_rmb)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
