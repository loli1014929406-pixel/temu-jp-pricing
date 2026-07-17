import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { AlertTriangle, CheckCircle2, Search, Upload, X } from "lucide-react";
import { StandardTable } from "../ui/StandardTable";
import { readXlsxWorkbook } from "../../lib/tabular-parser";
import {
  parseActualShippingFeeWorkbook,
  type ActualShippingCarrier,
  type ActualShippingFeeParseResult,
} from "../../lib/actual-shipping-fee-parser";
import {
  fetchActualShippingFeeReport,
  importActualShippingFees,
  previewActualShippingFeeImport,
  type ActualShippingFeeImportPreview,
  type ActualShippingFeePreviewStatus,
  type ActualShippingFeeReport,
} from "../../lib/actual-shipping-fees";
import { confirmAction } from "../../utils/confirmations";
import { getErrorMessage } from "../../utils/errors";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notifications";

type Props = {
  canEdit: boolean;
  onImported: () => Promise<void> | void;
};

type PendingImport = {
  fileName: string;
  parsed: ActualShippingFeeParseResult;
  preview: ActualShippingFeeImportPreview;
};

const emptyReport: ActualShippingFeeReport = {
  rows: [],
  totalCount: 0,
  summary: { shipmentCount: 0, totalAmountRmb: 0, missingActualShipTimeCount: 0 },
  months: [],
};

function formatPreciseRmb(value: number) {
  return `¥${value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function carrierLabel(carrier: ActualShippingCarrier) {
  return carrier === "japan_post" ? "福冈仓日本邮便" : "苏州仓 OCS Yamato";
}

function statusMeta(status: ActualShippingFeePreviewStatus) {
  if (status === "importable") return { label: "可导入", className: "bg-emerald-50 text-emerald-700" };
  if (status === "existing") return { label: "已有运费，跳过", className: "bg-amber-50 text-amber-700" };
  if (status === "conflict") return { label: "对应多个订单，跳过", className: "bg-rose-50 text-rose-700" };
  return { label: "未匹配，跳过", className: "bg-slate-100 text-slate-600" };
}

export function ActualShippingFeesPanel({ canEdit, onImported }: Props) {
  const [report, setReport] = useState<ActualShippingFeeReport>(emptyReport);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [month, setMonth] = useState("");
  const [carrier, setCarrier] = useState<"all" | ActualShippingCarrier>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextReport = await fetchActualShippingFeeReport({ page, pageSize, month, carrier, search });
      setReport(nextReport);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "加载实际运费月结失败"));
      setReport(emptyReport);
    } finally {
      setLoading(false);
    }
  }, [carrier, month, page, pageSize, search]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    setPage(1);
  }, [carrier, month, pageSize, search]);

  const totalPages = Math.max(1, Math.ceil(report.totalCount / pageSize));
  const importStats = useMemo(() => {
    if (!pendingImport) return null;
    return [
      ["表格有效记录", pendingImport.preview.parsedRecordCount],
      ["可导入", pendingImport.preview.importableRecordCount],
      ["已有运费跳过", pendingImport.preview.existingRecordCount],
      ["未匹配跳过", pendingImport.preview.unmatchedRecordCount],
      ["匹配冲突", pendingImport.preview.conflictRecordCount],
      ["异常/汇总行", pendingImport.parsed.issues.length],
    ] as const;
  }, [pendingImport]);

  async function handleSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setParsing(true);
    setPendingImport(null);
    try {
      const workbook = await readXlsxWorkbook(file);
      const parsed = parseActualShippingFeeWorkbook(workbook);
      if (parsed.records.length === 0) {
        throw new Error(parsed.issues[0]?.reason || "表格中没有可核对的物流单号和实际运费");
      }
      const preview = await previewActualShippingFeeImport(parsed.records);
      setPendingImport({ fileName: file.name, parsed, preview });
    } catch (parseError) {
      notifyError(getErrorMessage(parseError, "解析实际运费表格失败"));
    } finally {
      setParsing(false);
    }
  }

  async function handleConfirmImport() {
    if (!pendingImport || pendingImport.preview.importableRecordCount === 0) return;
    if (!confirmAction(
      `确认导入 ${pendingImport.preview.importableRecordCount} 个物流单号的实际尾程运费吗？已有运费不会覆盖。`,
    )) return;

    setImporting(true);
    try {
      const result = await importActualShippingFees({
        fileName: pendingImport.fileName,
        carrier: pendingImport.parsed.carrier,
        records: pendingImport.parsed.records,
      });
      if (result.importedRecordCount === 0) {
        notifyWarning("没有新增实际运费，匹配记录可能已由其他导入写入。");
      } else {
        notifySuccess(
          `成功导入 ${result.importedRecordCount} 票实际尾程运费，合计 ${formatPreciseRmb(result.importedTotalAmountRmb)}。` +
          (result.missingActualShipTimeCount > 0
            ? ` 其中 ${result.missingActualShipTimeCount} 票待补实际发货时间。`
            : ""),
        );
      }
      setPendingImport(null);
      setPage(1);
      await Promise.all([loadReport(), onImported()]);
    } catch (importError) {
      notifyError(getErrorMessage(importError, "导入实际运费失败"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="animate-in fade-in space-y-5 duration-300">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">物流商月结运费</h3>
          <p className="mt-1 text-xs text-slate-500">
            仅按物流单号匹配；月份统一取网站订单的实际发货时间，同一物流单号只计算一次。
          </p>
        </div>
        <label className="btn-primary inline-flex h-10 cursor-pointer items-center gap-2 px-4 text-xs font-bold">
          <Upload size={16} />
          {parsing ? "解析中..." : "上传真实运费"}
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            disabled={!canEdit || parsing || importing}
            onChange={(event) => void handleSelectFile(event)}
          />
        </label>
      </div>

      {pendingImport && importStats && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <CheckCircle2 size={17} className="text-sky-600" />
                导入前核对 · {pendingImport.parsed.carrierLabel}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {pendingImport.fileName} · 工作表 {pendingImport.parsed.sheetName}
              </p>
            </div>
            <button
              type="button"
              className="icon-btn h-8 w-8"
              onClick={() => setPendingImport(null)}
              disabled={importing}
              aria-label="关闭导入预览"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            {importStats.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white bg-white/90 p-3">
                <div className="text-[11px] font-semibold text-slate-500">{label}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_2fr]">
            <div className="rounded-lg border border-white bg-white/90 p-3">
              <div className="text-xs font-bold text-slate-700">可导入运费合计</div>
              <div className="mt-1 text-xl font-bold text-emerald-700">
                {formatPreciseRmb(pendingImport.preview.importableTotalAmountRmb)}
              </div>
              <div className="mt-3 space-y-1.5 text-xs text-slate-600">
                {pendingImport.preview.months.map((item) => (
                  <div key={item.month || "missing"} className="flex justify-between gap-3">
                    <span>{item.month || "待补实际发货时间"} · {item.shipmentCount}票</span>
                    <span className="font-semibold">{formatPreciseRmb(item.totalAmountRmb)}</span>
                  </div>
                ))}
              </div>
              {pendingImport.preview.missingActualShipTimeCount > 0 && (
                <div className="mt-3 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-700">
                  {pendingImport.preview.missingActualShipTimeCount} 票会保存运费，但暂不归入月份。
                </div>
              )}
            </div>

            <div className="max-h-72 overflow-auto rounded-lg border border-white bg-white/90">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-2">行</th>
                    <th className="px-3 py-2">物流单号</th>
                    <th className="px-3 py-2">网站订单号</th>
                    <th className="px-3 py-2">实际发货月份</th>
                    <th className="px-3 py-2 text-right">实际尾程运费</th>
                    <th className="px-3 py-2">处理结果</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingImport.preview.rows.map((row) => {
                    const meta = statusMeta(row.status);
                    return (
                      <tr key={`${row.sourceRowNumber}-${row.trackingNo}`} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-400">{row.sourceRowNumber}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-700">{row.trackingNo}</td>
                        <td className="px-3 py-2 font-mono text-slate-600">{row.orderNo || "--"}</td>
                        <td className="px-3 py-2 text-slate-600">{row.settlementMonth || "待补"}</td>
                        <td className="px-3 py-2 text-right font-bold text-slate-900">{formatPreciseRmb(row.amountRmb)}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-2 py-1 font-bold ${meta.className}`}>{meta.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {pendingImport.parsed.issues.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <div className="font-bold">已排除 {pendingImport.parsed.issues.length} 条异常或汇总行</div>
              <div className="mt-1">{pendingImport.parsed.issues.slice(0, 5).map((issue) => `第${issue.rowNumber}行：${issue.reason}`).join("；")}</div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setPendingImport(null)} disabled={importing}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleConfirmImport()}
              disabled={importing || pendingImport.preview.importableRecordCount === 0}
            >
              {importing ? "导入中..." : `确认导入 ${pendingImport.preview.importableRecordCount} 票`}
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">当前筛选物流单数</div>
          <div className="mt-1 text-lg font-bold text-slate-900">{report.summary.shipmentCount}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">应付实际尾程运费</div>
          <div className="mt-1 text-lg font-bold text-emerald-700">{formatPreciseRmb(report.summary.totalAmountRmb)}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold text-slate-500">待补实际发货时间</div>
          <div className={`mt-1 text-lg font-bold ${report.summary.missingActualShipTimeCount > 0 ? "text-amber-700" : "text-slate-900"}`}>
            {report.summary.missingActualShipTimeCount}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
        <label className="flex min-w-44 flex-col gap-1 text-xs font-semibold text-slate-600">
          结算月份（实际发货月）
          <select value={month} onChange={(event) => setMonth(event.target.value)} className="h-9 rounded-lg border border-line bg-white px-3">
            <option value="">全部月份</option>
            {report.months.map((item) => (
              <option key={item.month || "missing"} value={item.month || "__missing__"}>
                {item.month || "待补实际发货时间"} · {item.shipmentCount}票
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-44 flex-col gap-1 text-xs font-semibold text-slate-600">
          物流商
          <select value={carrier} onChange={(event) => setCarrier(event.target.value as "all" | ActualShippingCarrier)} className="h-9 rounded-lg border border-line bg-white px-3">
            <option value="all">全部物流商</option>
            <option value="japan_post">福冈仓日本邮便</option>
            <option value="ocs_yamato">苏州仓 OCS Yamato</option>
          </select>
        </label>
        <form
          className="flex min-w-64 flex-1 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
            搜索物流单号、订单号或文件名
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="h-9 rounded-lg border border-line bg-white px-3" />
          </label>
          <button type="submit" className="btn-secondary h-9 px-3"><Search size={15} /> 搜索</button>
        </form>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <StandardTable
        minWidth="min-w-max"
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        totalRecordCount={report.totalCount}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        loading={loading}
        empty={!loading && !error && report.rows.length === 0}
        emptyMessage="暂无已导入的实际尾程运费"
      >
        {!loading && report.rows.length > 0 && (
          <>
            <thead>
              <tr>
                <th className="bg-slate-50">实际发货月份</th>
                <th className="bg-slate-50">物流商</th>
                <th className="bg-slate-50">物流单号</th>
                <th className="bg-slate-50">网站订单号</th>
                <th className="bg-slate-50">实际发货时间</th>
                <th className="number-cell bg-slate-50 px-3 py-2">实际尾程运费</th>
                <th className="bg-slate-50">来源文件</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/50">
                  <td className={row.settlementMonth ? "font-bold text-slate-700" : "font-bold text-amber-700"}>{row.settlementMonth || "待补"}</td>
                  <td className="font-semibold text-slate-700">{carrierLabel(row.carrier)}</td>
                  <td className="font-mono text-xs font-semibold text-slate-700">{row.trackingNo}</td>
                  <td className="font-mono text-xs text-slate-600">{row.orderNo || "--"}</td>
                  <td className="text-xs text-slate-500">{row.actualShipTime || "待补实际发货时间"}</td>
                  <td className="number-cell px-3 py-2 font-bold text-emerald-700">{formatPreciseRmb(row.amountRmb)}</td>
                  <td className="max-w-64 truncate text-xs text-slate-500" title={row.sourceFileName}>{row.sourceFileName}</td>
                </tr>
              ))}
            </tbody>
          </>
        )}
      </StandardTable>
    </div>
  );
}
