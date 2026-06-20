import { X } from "lucide-react";

type OrderDetailPanelProps = {
  orderNo: string;
  rows: ReadonlyArray<readonly [label: string, value: string]>;
  onClose: () => void;
};

export function OrderDetailPanel({
  orderNo,
  rows,
  onClose,
}: OrderDetailPanelProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="订单详情"
    >
      <div className="max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">订单详情</h2>
            <p className="mt-1 text-xs font-medium text-slate-500">{orderNo}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
            aria-label="关闭详情"
          >
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(86vh-72px)] overflow-auto p-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-line bg-slate-50 px-3 py-2"
              >
                <dt className="text-xs font-semibold text-slate-500">{label}</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-slate-900">
                  {value || "--"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
