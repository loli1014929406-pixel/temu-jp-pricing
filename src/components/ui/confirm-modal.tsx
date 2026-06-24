import { createRoot } from "react-dom/client";
import { AlertTriangle } from "lucide-react";

let confirmRoot: ReturnType<typeof createRoot> | null = null;
let confirmContainer: HTMLDivElement | null = null;

function ConfirmDialog({
  message,
  title,
  onConfirm,
  onCancel,
}: {
  message: string;
  title?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 animate-in zoom-in-95 duration-200">
        <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-4">
          <h3 className="flex items-center gap-2 text-base font-bold text-slate-800">
            <AlertTriangle className="text-amber-500" size={20} />
            {title || "操作确认"}
          </h3>
        </div>
        <div className="whitespace-pre-wrap break-words px-6 py-6 text-sm text-slate-600">
          {message}
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-100 bg-slate-50/80 px-6 py-4">
          <button onClick={onCancel} className="btn-secondary px-6">
            取消
          </button>
          <button onClick={onConfirm} className="btn-primary px-6">
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

export function showConfirm(message: string, title?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!confirmContainer) {
      confirmContainer = document.createElement("div");
      document.body.appendChild(confirmContainer);
      confirmRoot = createRoot(confirmContainer);
    }

    const cleanup = () => {
      confirmRoot?.render(<></>);
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    confirmRoot!.render(
      <ConfirmDialog
        message={message}
        title={title}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );
  });
}
