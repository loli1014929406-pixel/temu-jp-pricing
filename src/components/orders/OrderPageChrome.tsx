import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useRef } from "react";
import {
  orderCustomerHistoryMeta,
  visibleOrderCustomerHistoryStatuses,
} from "../../domain/order-customer-history";
import { Badge } from "../ui";
import type { TemuTrackingAlert } from "../../lib/order-tracking";

type OrderFileActionsProps = {
  canEdit: boolean;
  busyKey: string;
  onOrderFile: (file: File | undefined) => void;
  onTrackingFile: (file: File | undefined) => void;
};

export function OrderFileActions({
  canEdit,
  busyKey,
  onOrderFile,
  onTrackingFile,
}: OrderFileActionsProps) {
  const orderInputRef = useRef<HTMLInputElement | null>(null);
  const trackingInputRef = useRef<HTMLInputElement | null>(null);
  if (!canEdit) return null;

  return (
    <>
      <input
        ref={orderInputRef}
        type="file"
        aria-label="选择 Temu 订单文件"
        accept=".xlsx,.csv,.tsv,.txt"
        className="hidden"
        onChange={(event) => {
          onOrderFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <input
        ref={trackingInputRef}
        type="file"
        aria-label="选择物流单号文件"
        accept=".xlsx,.csv,.tsv,.txt"
        className="hidden"
        onChange={(event) => {
          onTrackingFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busyKey === "tracking-import"}
        onClick={() => trackingInputRef.current?.click()}
        className="btn-secondary"
      >
        <Upload size={18} />
        上传物流单号
      </button>
      <button
        type="button"
        disabled={busyKey === "import"}
        onClick={() => orderInputRef.current?.click()}
        className="btn-primary"
      >
        <Upload size={18} />
        上传订单表
      </button>
    </>
  );
}

type OrderDataHeaderProps = {
  activeLabel: string;
  activeTone: "success" | "warning" | "danger" | "neutral" | "info";
  currentRowCount: number;
  totalRowCount: number;
  totalLineCount: number;
  canRefreshTracking: boolean;
  refreshing: boolean;
  onRefreshTracking: () => void;
};

export function OrderDataHeader({
  activeLabel,
  activeTone,
  currentRowCount,
  totalRowCount,
  totalLineCount,
  canRefreshTracking,
  refreshing,
  onRefreshTracking,
}: OrderDataHeaderProps) {
  return (
    <div className="grid gap-3 border-b border-[#e3e3e3] pb-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f1f1f1] text-[#616161]">
          <FileSpreadsheet size={18} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">Temu 订单数据</h2>
            <Badge tone={activeTone}>{activeLabel}</Badge>
          </div>
          <p className="mt-1 text-sm font-medium text-slate-500">
            当前显示 {currentRowCount} 行，共 {totalRowCount} 行，覆盖 {totalLineCount} 条订单明细
          </p>
        </div>
      </div>
      {canRefreshTracking && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto xl:justify-end">
          <button
            type="button"
            disabled={refreshing}
            onClick={onRefreshTracking}
            className="btn-secondary"
          >
            <RefreshCw size={18} />
            查询物流状态
          </button>
        </div>
      )}
    </div>
  );
}

export type TrackingAlertFilter = "unhandled" | "all" | "handled";

type OrderTrackingAlertsProps = {
  alerts: TemuTrackingAlert[];
  filter: TrackingAlertFilter;
  canEdit: boolean;
  handlingOrderNo: string;
  onFilterChange: (filter: TrackingAlertFilter) => void;
  onMarkHandled: (alert: TemuTrackingAlert) => void;
};

export function OrderTrackingAlerts({
  alerts,
  filter,
  canEdit,
  handlingOrderNo,
  onFilterChange,
  onMarkHandled,
}: OrderTrackingAlertsProps) {
  const unhandledCount = alerts.filter(
    (alert) => !alert.tracking_exception_handled_at,
  ).length;
  const handledCount = alerts.length - unhandledCount;
  const visibleAlerts = alerts.filter((alert) => {
    if (filter === "unhandled") return !alert.tracking_exception_handled_at;
    if (filter === "handled") return Boolean(alert.tracking_exception_handled_at);
    return true;
  });

  if (alerts.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-amber-200 bg-amber-50/70 p-3"
      aria-label="物流异常提醒"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <AlertTriangle size={17} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-amber-950">物流异常提醒</h3>
            <p className="text-xs text-amber-800">
              未处理 {unhandledCount} 单，已处理 {handledCount} 单
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-amber-200 bg-white p-1">
          {([
            ["unhandled", `未处理 ${unhandledCount}`],
            ["all", `全部 ${alerts.length}`],
            ["handled", `已处理 ${handledCount}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onFilterChange(value)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                filter === value
                  ? "bg-amber-600 text-white"
                  : "text-amber-800 hover:bg-amber-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {visibleAlerts.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-amber-200 bg-white/70 px-3 py-4 text-center text-sm text-amber-800">
          当前筛选下没有物流异常。
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {visibleAlerts.map((alert) => {
            const handled = Boolean(alert.tracking_exception_handled_at);
            return (
              <div
                key={`${alert.order_no}:${alert.tracking_exception_fingerprint}`}
                className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-900">
                      {alert.order_no}
                    </span>
                    <Badge tone={alert.stage === "uploaded_temu" ? "info" : "success"}>
                      {alert.stage === "uploaded_temu" ? "上传Temu" : "已发货"}
                    </Badge>
                    <Badge tone={handled ? "neutral" : "danger"}>
                      {handled ? "已处理" : "待处理"}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-sm font-semibold text-rose-700">
                    {alert.tracking_exception_reason ||
                      alert.logistics_status ||
                      "物流状态异常"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    物流单号 {alert.logistics_tracking_no || "--"}
                    {alert.logistics_method
                      ? ` · ${alert.logistics_method}`
                      : ""}
                    {alert.tracking_last_checked_at
                      ? ` · 查询于 ${formatTrackingAlertTime(
                          alert.tracking_last_checked_at,
                        )}`
                      : ""}
                  </p>
                </div>
                {canEdit && !handled && (
                  <button
                    type="button"
                    disabled={handlingOrderNo === alert.order_no}
                    onClick={() => onMarkHandled(alert)}
                    className="btn-secondary shrink-0"
                  >
                    <CheckCircle2 size={17} aria-hidden="true" />
                    {handlingOrderNo === alert.order_no
                      ? "处理中..."
                      : "标记为已处理"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatTrackingAlertTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function OrderCustomerHistoryLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600"
      aria-label="客户订单颜色说明"
    >
      <span className="font-semibold text-slate-700">客户订单颜色</span>
      {visibleOrderCustomerHistoryStatuses.map((status) => {
        const meta = orderCustomerHistoryMeta[status];
        return (
          <span key={status} className="inline-flex items-center gap-2">
            <span
              className={`h-3 w-5 rounded border ${meta.legendClassName}`}
              aria-hidden="true"
            />
            <span>{meta.label}</span>
          </span>
        );
      })}
    </div>
  );
}

export function OrderPageNotices({
  errorMessage,
  noticeMessage,
  draftNotice,
}: {
  errorMessage: string;
  noticeMessage: string;
  draftNotice: string;
}) {
  return (
    <>
      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {noticeMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {noticeMessage}
        </div>
      )}
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}
    </>
  );
}
