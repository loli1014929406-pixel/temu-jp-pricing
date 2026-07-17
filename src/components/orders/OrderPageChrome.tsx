import { FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { useRef } from "react";
import { Badge } from "../ui";

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
