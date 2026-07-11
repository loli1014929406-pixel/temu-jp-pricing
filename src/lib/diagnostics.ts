export type AppDiagnostic = {
  id: number;
  type: "error" | "slow-operation" | "navigation";
  context: string;
  message: string;
  durationMs?: number;
  createdAt: string;
};

const maxDiagnostics = 50;
const diagnostics: AppDiagnostic[] = [];
const listeners = new Set<(items: AppDiagnostic[]) => void>();
let nextDiagnosticId = 1;

function sanitizeDiagnosticText(value: unknown) {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]")
    .replace(/\b\d{10,}\b/g, "[number]")
    .slice(0, 500);
}

function appendDiagnostic(
  diagnostic: Omit<AppDiagnostic, "id" | "createdAt" | "message"> & { message: unknown },
) {
  diagnostics.push({
    ...diagnostic,
    id: nextDiagnosticId,
    message: sanitizeDiagnosticText(diagnostic.message),
    createdAt: new Date().toISOString(),
  });
  nextDiagnosticId += 1;
  if (diagnostics.length > maxDiagnostics) diagnostics.splice(0, diagnostics.length - maxDiagnostics);
  const snapshot = getRecentDiagnostics();
  listeners.forEach((listener) => listener(snapshot));
}

export function reportAppError(error: unknown, context: string) {
  appendDiagnostic({ type: "error", context, message: error });
  console.error(`[${context}]`, error);
}

export function reportSlowOperation(context: string, durationMs: number) {
  appendDiagnostic({
    type: "slow-operation",
    context,
    message: `操作耗时 ${Math.round(durationMs)}ms`,
    durationMs: Math.round(durationMs),
  });
}

export function getRecentDiagnostics() {
  return diagnostics.slice().reverse();
}

export function clearDiagnostics() {
  diagnostics.length = 0;
  listeners.forEach((listener) => listener([]));
}

export function subscribeDiagnostics(listener: (items: AppDiagnostic[]) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function installGlobalDiagnostics() {
  if (typeof window === "undefined") return () => undefined;

  const handleError = (event: ErrorEvent) => {
    appendDiagnostic({
      type: "error",
      context: "window.error",
      message: event.error ?? event.message,
    });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    appendDiagnostic({
      type: "error",
      context: "window.unhandledrejection",
      message: event.reason,
    });
  };
  const handleLoad = () => {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (navigation && navigation.duration >= 3_000) {
      appendDiagnostic({
        type: "navigation",
        context: "initial-navigation",
        message: `首屏加载耗时 ${Math.round(navigation.duration)}ms`,
        durationMs: Math.round(navigation.duration),
      });
    }
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  window.addEventListener("load", handleLoad, { once: true });

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
    window.removeEventListener("load", handleLoad);
  };
}
