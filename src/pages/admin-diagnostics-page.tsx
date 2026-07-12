import { useEffect, useMemo, useState } from "react";
import { usePermissions } from "../hooks/use-permissions";
import { getSupabaseClient } from "../lib/supabase";

type CentralDiagnostic = { id: string; event_type: string; context: string; message: string; duration_ms: number | null; path: string; created_at: string };

export function AdminDiagnosticsPage() {
  const { canDelete, loading: permissionLoading } = usePermissions();
  const [rows, setRows] = useState<CentralDiagnostic[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (permissionLoading) return;
    if (!canDelete) { setLoading(false); return; }
    void getSupabaseClient().from("app_diagnostics")
      .select("id,event_type,context,message,duration_ms,path,created_at")
      .order("created_at", { ascending: false }).limit(500)
      .then(({ data, error: queryError }) => {
        setRows((data ?? []) as CentralDiagnostic[]);
        setError(queryError?.message ?? "");
        setLoading(false);
      });
  }, [canDelete, permissionLoading]);

  const summary = useMemo(() => rows.reduce<Record<string, number>>((result, row) => {
    const key = `${row.event_type} · ${row.context || "未分类"}`;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {}), [rows]);

  if (permissionLoading || loading) return <p className="p-6 text-sm text-slate-500">加载诊断记录中…</p>;
  if (!canDelete) return <p className="m-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">仅管理员可以查看集中诊断。</p>;
  return <section className="grid gap-5 p-6">
    <div><h1 className="text-2xl font-bold">集中诊断</h1><p className="mt-1 text-sm text-slate-500">最近 500 条；数据库每天自动删除 90 天前记录。</p></div>
    {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Object.entries(summary).sort((a,b) => b[1] - a[1]).map(([key, count]) => <div className="rounded-xl border border-line bg-white p-4" key={key}><strong className="text-2xl">{count}</strong><p className="mt-1 break-words text-xs text-slate-500">{key}</p></div>)}
    </div>
    <div className="overflow-x-auto rounded-xl border border-line"><table className="data-table min-w-[900px]"><thead><tr><th>时间</th><th>类型</th><th>上下文</th><th>耗时</th><th>路径</th><th>信息</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td><td>{row.event_type}</td><td>{row.context}</td><td>{row.duration_ms == null ? "-" : `${row.duration_ms}ms`}</td><td>{row.path}</td><td>{row.message}</td></tr>)}</tbody></table></div>
  </section>;
}
