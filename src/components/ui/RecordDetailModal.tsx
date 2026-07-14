import type { ReactNode } from "react";
import { X } from "lucide-react";

export type DetailModalRow = {
  label: string;
  value: ReactNode;
  wide?: boolean;
};

type RecordDetailModalProps = {
  title: string;
  subtitle?: string;
  rows?: readonly DetailModalRow[];
  children?: ReactNode;
  onClose: () => void;
  maxWidthClassName?: string;
};

function isEmptyValue(value: ReactNode) {
  return value === null || value === undefined || value === "";
}

export function RecordDetailModal({
  title,
  subtitle,
  rows = [],
  children,
  onClose,
  maxWidthClassName = "max-w-4xl",
}: RecordDetailModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={`grid max-h-[88vh] w-full ${maxWidthClassName} grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl`}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-950">{title}</h2>
            {subtitle && (
              <p className="mt-1 break-all text-xs font-medium text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn"
            aria-label="关闭详情"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 overflow-auto p-4">
          {children}
          {rows.length > 0 && (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {rows.map((row, index) => (
                <div
                  key={`${row.label}-${index}`}
                  className={`rounded-md border border-line bg-slate-50 px-3 py-2 ${row.wide ? "sm:col-span-2" : ""}`}
                >
                  <dt className="text-xs font-semibold text-slate-500">{row.label}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] font-medium leading-5 text-slate-900 [overflow-wrap:anywhere]">
                    {isEmptyValue(row.value) ? "--" : row.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
