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
  created_at: string;
};

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
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
        .select("id,event_type,context,message,duration_ms,path,request_kind,cache_status,row_count,retry_count,trace_id,created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      let resultData: unknown = extendedResult.data;
      let resultError = extendedResult.error;
      if (resultError?.code === "PGRST204" || resultError?.code === "42703") {
        const legacyResult = await supabase
          .from("app_diagnostics")
          .select("id,event_type,context,message,duration_ms,path,created_at")
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
    const durations = rows.flatMap((row) => row.duration_ms == null ? [] : [row.duration_ms]);
    return {
      total: rows.length,
      errors: rows.filter((row) => row.event_type === "error").length,
      slow: rows.filter((row) => row.event_type === "slow-operation").length,
      p95: percentile(durations, 0.95),
    };
  }, [rows]);

  const summaries = useMemo(() => {
    const groups = new Map<string, CentralDiagnostic[]>();
    rows.forEach((row) => {
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
          ["慢操作", overview.slow],
          ["总体 P95", `${overview.p95}ms`],
        ].map(([label, value]) => (
          <div className="rounded-xl border border-line bg-white p-4" key={label}>
            <strong className="text-2xl">{value}</strong>
            <p className="mt-1 text-xs text-slate-500">{label}</p>
          </div>
        ))}
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
        <table className="data-table min-w-[1100px]">
          <thead><tr><th>时间</th><th>类型</th><th>上下文</th><th>耗时</th><th>请求</th><th>缓存</th><th>路径</th><th>信息</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td><td>{row.event_type}</td><td>{row.context}</td><td>{row.duration_ms == null ? "-" : `${row.duration_ms}ms`}</td><td>{row.request_kind || "-"}</td><td>{row.cache_status || "-"}</td><td>{row.path}</td><td>{row.message}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}
