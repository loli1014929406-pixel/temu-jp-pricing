import { useEffect, useMemo, useState } from "react";
import { usePermissions } from "../hooks/use-permissions";
import { isCredibleWebVitalValue } from "../lib/diagnostics";
import { getSupabaseClient } from "../lib/supabase";
import { PageHeader } from "../components/ui";

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
  const [versionFilter, setVersionFilter] = useState("");
  const [pathFilter, setPathFilter] = useState("");

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

  const versionOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.app_version || "legacy"))).sort()
  ), [rows]);
  const pathOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.path || "未记录"))).sort()
  ), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => (
    (!versionFilter || (row.app_version || "legacy") === versionFilter) &&
    (!pathFilter || (row.path || "未记录") === pathFilter)
  )), [pathFilter, rows, versionFilter]);

  const overview = useMemo(() => {
    const slowDurations = filteredRows.flatMap((row) =>
      row.event_type === "slow-operation" && row.duration_ms != null ? [row.duration_ms] : [],
    );
    const navigationDurations = filteredRows.flatMap((row) =>
      row.context === "initial-navigation" && row.duration_ms != null ? [row.duration_ms] : [],
    );
    return {
      total: filteredRows.length,
      errors: filteredRows.filter((row) => row.event_type === "error").length,
      slow: filteredRows.filter((row) => row.event_type === "slow-operation").length,
      slowP95: percentile(slowDurations, 0.95),
      navigationP95: percentile(navigationDurations, 0.95),
    };
  }, [filteredRows]);

  const summaries = useMemo(() => {
    const groups = new Map<string, CentralDiagnostic[]>();
    filteredRows.filter((row) => !isWebVital(row) && row.context !== "initial-navigation").forEach((row) => {
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
  }, [filteredRows]);

  const vitalSummaries = useMemo(() => {
    return ["web-vital:LCP", "web-vital:INP", "web-vital:CLS"].map((context) => {
      const matchingRows = filteredRows.filter((row) => (
        row.context === context && row.duration_ms != null
      ));
      const values = matchingRows.flatMap((row) => (
        isCredibleWebVitalValue(context, row.duration_ms as number)
          ? [row.duration_ms as number]
          : []
      ));
      return {
        context,
        label: context.replace("web-vital:", ""),
        count: values.length,
        invalidCount: matchingRows.length - values.length,
        p50: percentile(values, 0.5),
        p75: percentile(values, 0.75),
        p95: percentile(values, 0.95),
      };
    });
  }, [filteredRows]);

  if (permissionLoading || loading) {
    return <p className="p-6 text-sm text-slate-500">加载诊断记录中…</p>;
  }
  if (!canDelete) {
    return <p className="status-banner border-amber-200 bg-amber-50 text-amber-800">仅管理员可以查看集中诊断。</p>;
  }

  return (
    <section className="page-stack">
      <PageHeader title="集中诊断" description="最近 500 条；按操作展示耗时分位数，数据库每天自动删除 90 天前记录。" />
      {error && <p className="status-banner border-rose-200 bg-rose-50 text-rose-700">{error}</p>}
      <div className="section-card grid gap-4 p-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          版本
          <select
            className="h-10 rounded-xl border border-line bg-white px-3 text-sm"
            value={versionFilter}
            onChange={(event) => setVersionFilter(event.target.value)}
          >
            <option value="">全部版本</option>
            {versionOptions.map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          页面路径
          <select
            className="h-10 rounded-xl border border-line bg-white px-3 text-sm"
            value={pathFilter}
            onChange={(event) => setPathFilter(event.target.value)}
          >
            <option value="">全部路径</option>
            {pathOptions.map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["记录", overview.total],
          ["错误", overview.errors],
          ["慢操作", `${overview.slow}（P95 ${overview.slowP95}ms）`],
          ["首屏 P95", `${overview.navigationP95}ms`],
        ].map(([label, value]) => (
          <div className="section-card p-4" key={label}>
            <strong className="text-2xl">{value}</strong>
            <p className="mt-1 text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-semibold">Web Vitals</h2>
        <p className="mt-1 text-xs text-slate-500">LCP、INP 使用毫秒；CLS 使用无单位分数。异常样本会显示数量，但不计入分位数。</p>
      </div>
      <div className="table-card overflow-x-auto">
        <table className="data-table min-w-[720px]">
          <thead><tr><th>指标</th><th>有效样本</th><th>已排除异常</th><th>P50</th><th>P75</th><th>P95</th></tr></thead>
          <tbody>{vitalSummaries.map((item) => (
            <tr key={item.context}>
              <td>{item.label}</td><td>{item.count}</td><td>{item.invalidCount}</td>
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
      <div className="table-card overflow-x-auto">
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
      <div className="table-card overflow-x-auto">
        <table className="data-table min-w-[1360px]">
          <thead><tr><th>时间</th><th>版本</th><th>类型</th><th>上下文</th><th>耗时</th><th>请求</th><th>缓存</th><th>路径</th><th>Trace</th><th>信息</th></tr></thead>
          <tbody>{filteredRows.map((row) => {
            const invalidVital = isWebVital(row) && row.duration_ms != null &&
              !isCredibleWebVitalValue(row.context, row.duration_ms);
            return <tr key={row.id}><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td><td>{row.app_version || "-"}</td><td>{row.event_type}</td><td>{row.context}</td><td>{row.duration_ms == null ? "-" : isWebVital(row) ? `${formatVitalValue(row.context, row.duration_ms)}${invalidVital ? "（异常，已排除）" : ""}` : `${row.duration_ms}ms`}</td><td>{row.request_kind || "-"}</td><td>{row.cache_status || "-"}</td><td>{row.path}</td><td>{row.trace_id || "-"}</td><td>{row.message}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  );
}
