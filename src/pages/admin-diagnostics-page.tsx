import { useEffect, useMemo, useState } from "react";
import { usePermissions } from "../hooks/use-permissions";
import { getSupabaseClient } from "../lib/supabase";

type CentralDiagnostic = {
  id: string;
  event_type: string;
  context: string;
  message: string;
  duration_ms: number | null;
  path: string;
  request_kind?: string;
  cache_status?: string;
  row_count?: number | null;
  retry_count?: number;
  trace_id?: string;
  app_version?: string;
  created_at: string;
};

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function isWebVital(row: CentralDiagnostic) {
  return row.context.startsWith("web-vital:");
}

function formatVitalValue(context: string, value: number) {
  return context === "web-vital:CLS" ? (value / 1000).toFixed(3) : `${value}ms`;
}

export function AdminDiagnosticsPage() {
  const { canDelete, loading: permissionLoading } = usePermissions();
  const [rows, setRows] = useState<CentralDiagnostic[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (permissionLoading) return;
    if (!canDelete) {
      setLoading(false);
      return;
    }
    let active = true;
    async function load() {
      const supabase = getSupabaseClient();
      const extendedResult = await supabase
        .from("app_diagnostics")
        .select("id,event_type,context,message,duration_ms,path,app_version,request_kind,cache_status,row_count,retry_count,trace_id,created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      let resultData: unknown = extendedResult.data;
      let resultError = extendedResult.error;
      if (resultError?.code === "PGRST204" || resultError?.code === "42703") {
        const legacyResult = await supabase
          .from("app_diagnostics")
          .select("id,event_type,context,message,duration_ms,path,app_version,created_at")
          .order("created_at", { ascending: false })
          .limit(500);
        resultData = legacyResult.data;
        resultError = legacyResult.error;
      }
      if (!active) return;
      setRows((resultData ?? []) as CentralDiagnostic[]);
      setError(resultError?.message ?? "");
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, [canDelete, permissionLoading]);

  const overview = useMemo(() => {
    const slowDurations = rows.flatMap((row) =>
      row.event_type === "slow-operation" && row.duration_ms != null ? [row.duration_ms] : [],
    );
    const navigationDurations = rows.flatMap((row) =>
      row.context === "initial-navigation" && row.duration_ms != null ? [row.duration_ms] : [],
    );
    return {
      total: rows.length,
      errors: rows.filter((row) => row.event_type === "error").length,
      slow: rows.filter((row) => row.event_type === "slow-operation").length,
      slowP95: percentile(slowDurations, 0.95),
      navigationP95: percentile(navigationDurations, 0.95),
    };
  }, [rows]);

  const summaries = useMemo(() => {
    const groups = new Map<string, CentralDiagnostic[]>();
    rows.filter((row) => !isWebVital(row) && row.context !== "initial-navigation").forEach((row) => {
      const key = [
        row.context || "未分类",
        row.request_kind || "未标记",
        row.cache_status || "-",
      ].join("\u0000");
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    });
    return Array.from(groups.entries()).map(([key, group]) => {
      const [context, requestKind, cacheStatus] = key.split("\u0000");
      const durations = group.flatMap((row) => row.duration_ms == null ? [] : [row.duration_ms]);
      return {
        key,
        context,
        requestKind,
        cacheStatus,
        count: group.length,
        errorCount: group.filter((row) => row.event_type === "error").length,
        average: durations.length > 0
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : 0,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        maximum: Math.max(0, ...durations),
      };
    }).sort((a, b) => b.p95 - a.p95 || b.count - a.count);
  }, [rows]);

  const vitalSummaries = useMemo(() => {
    return ["web-vital:LCP", "web-vital:INP", "web-vital:CLS"].map((context) => {
      const values = rows.flatMap((row) =>
        row.context === context && row.duration_ms != null ? [row.duration_ms] : [],
      );
      return {
        context,
        label: context.replace("web-vital:", ""),
        count: values.length,
        p50: percentile(values, 0.5),
        p75: percentile(values, 0.75),
        p95: percentile(values, 0.95),
      };
    });
  }, [rows]);

  if (permissionLoading || loading) {
    return <p className="p-6 text-sm text-slate-500">加载诊断记录中…</p>;
  }
  if (!canDelete) {
    return <p className="m-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">仅管理员可以查看集中诊断。</p>;
  }

  return (
    <section className="grid gap-5 p-6">
      <div>
        <h1 className="text-2xl font-bold">集中诊断</h1>
        <p className="mt-1 text-sm text-slate-500">最近 500 条；按操作展示耗时分位数，数据库每天自动删除 90 天前记录。</p>
      </div>
      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["记录", overview.total],
          ["错误", overview.errors],
          ["慢操作", `${overview.slow}（P95 ${overview.slowP95}ms）`],
          ["首屏 P95", `${overview.navigationP95}ms`],
        ].map(([label, value]) => (
          <div className="rounded-xl border border-line bg-white p-4" key={label}>
            <strong className="text-2xl">{value}</strong>
            <p className="mt-1 text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-semibold">Web Vitals</h2>
        <p className="mt-1 text-xs text-slate-500">LCP、INP 使用毫秒；CLS 使用无单位分数，分别统计，避免混入业务请求耗时。</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="data-table min-w-[720px]">
          <thead><tr><th>指标</th><th>样本</th><th>P50</th><th>P75</th><th>P95</th></tr></thead>
          <tbody>{vitalSummaries.map((item) => (
            <tr key={item.context}>
              <td>{item.label}</td><td>{item.count}</td>
              <td>{formatVitalValue(item.context, item.p50)}</td>
              <td>{formatVitalValue(item.context, item.p75)}</td>
              <td>{formatVitalValue(item.context, item.p95)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div>
        <h2 className="text-lg font-semibold">业务请求与错误</h2>
        <p className="mt-1 text-xs text-slate-500">仅按业务操作分组，不混入浏览器性能指标和首屏导航。</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="data-table min-w-[960px]">
          <thead>
            <tr><th>操作</th><th>请求类型</th><th>缓存</th><th>次数</th><th>错误</th><th>平均</th><th>P50</th><th>P95</th><th>最大</th></tr>
          </thead>
          <tbody>
            {summaries.map((item) => (
              <tr key={item.key}>
                <td>{item.context}</td><td>{item.requestKind}</td><td>{item.cacheStatus}</td>
                <td>{item.count}</td><td>{item.errorCount}</td><td>{item.average}ms</td>
                <td>{item.p50}ms</td><td>{item.p95}ms</td><td>{item.maximum}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="data-table min-w-[1200px]">
          <thead><tr><th>时间</th><th>版本</th><th>类型</th><th>上下文</th><th>耗时</th><th>请求</th><th>缓存</th><th>路径</th><th>信息</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td><td>{row.app_version || "-"}</td><td>{row.event_type}</td><td>{row.context}</td><td>{row.duration_ms == null ? "-" : isWebVital(row) ? formatVitalValue(row.context, row.duration_ms) : `${row.duration_ms}ms`}</td><td>{row.request_kind || "-"}</td><td>{row.cache_status || "-"}</td><td>{row.path}</td><td>{row.message}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}
