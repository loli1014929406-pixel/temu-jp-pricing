import { getSupabaseClient } from "./supabase";

export type AppDiagnostic = {
  id: number;
  type: "error" | "slow-operation" | "navigation";
  context: string;
  message: string;
  durationMs?: number;
  createdAt: string;
  uploadStatus: "pending" | "uploaded";
};

const maxDiagnostics = 50;
const diagnosticsStorageKey = "temu-jp:diagnostics:v1";

function loadStoredDiagnostics(): AppDiagnostic[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.sessionStorage.getItem(diagnosticsStorageKey);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed)
      ? parsed.slice(-maxDiagnostics).map((item) => ({
          ...item,
          uploadStatus: item.uploadStatus === "uploaded" ? "uploaded" : "pending",
        }))
      : [];
  } catch {
    return [];
  }
}

const diagnostics: AppDiagnostic[] = loadStoredDiagnostics();
const listeners = new Set<(items: AppDiagnostic[]) => void>();
let nextDiagnosticId = Math.max(0, ...diagnostics.map((item) => item.id)) + 1;
let uploadTimer: ReturnType<typeof setTimeout> | undefined;
let uploadInFlight: Promise<void> | null = null;
let centralDiagnosticsUnavailable = false;

function persistDiagnostics() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(diagnosticsStorageKey, JSON.stringify(diagnostics));
  } catch {
    // Diagnostics must never interrupt the business workflow.
  }
}

export function sanitizeDiagnosticText(value: unknown) {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token]")
    .replace(/([?&](?:token|key|password|secret|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]")
    .replace(/\b\d{10,}\b/g, "[number]")
    .slice(0, 500);
}

function sanitizeDiagnosticContext(value: unknown) {
  return sanitizeDiagnosticText(value).replace(/[\r\n]+/g, " ").slice(0, 120);
}

function getDiagnosticPath() {
  return typeof window === "undefined" ? "" : window.location.pathname.slice(0, 200);
}

function scheduleCentralUpload() {
  if (typeof window === "undefined" || centralDiagnosticsUnavailable || uploadTimer) return;
  uploadTimer = setTimeout(() => {
    uploadTimer = undefined;
    void flushCentralDiagnostics();
  }, 500);
}

export async function flushCentralDiagnostics() {
  if (uploadInFlight) return uploadInFlight;
  if (centralDiagnosticsUnavailable) return;

  const pending = diagnostics.filter((item) => item.uploadStatus === "pending").slice(0, 20);
  if (pending.length === 0) return;

  uploadInFlight = (async () => {
    try {
      const supabase = getSupabaseClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) return;

      const { error } = await supabase.from("app_diagnostics").insert(
        pending.map((item) => ({
          user_id: session.user.id,
          event_type: item.type,
          context: sanitizeDiagnosticContext(item.context),
          message: sanitizeDiagnosticText(item.message),
          duration_ms: item.durationMs ?? null,
          path: getDiagnosticPath(),
          app_version: String(import.meta.env.VITE_APP_VERSION ?? "web").slice(0, 50),
        })),
      );
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") {
          centralDiagnosticsUnavailable = true;
        }
        return;
      }

      const uploadedIds = new Set(pending.map((item) => item.id));
      diagnostics.forEach((item) => {
        if (uploadedIds.has(item.id)) item.uploadStatus = "uploaded";
      });
      persistDiagnostics();
      const snapshot = getRecentDiagnostics();
      listeners.forEach((listener) => listener(snapshot));
      if (diagnostics.some((item) => item.uploadStatus === "pending")) {
        scheduleCentralUpload();
      }
    } catch {
      // Monitoring must never interrupt business operations or create recursive errors.
    } finally {
      uploadInFlight = null;
    }
  })();

  return uploadInFlight;
}

function appendDiagnostic(
  diagnostic: Omit<AppDiagnostic, "id" | "createdAt" | "message" | "uploadStatus"> & {
    message: unknown;
  },
) {
  diagnostics.push({
    ...diagnostic,
    id: nextDiagnosticId,
    message: sanitizeDiagnosticText(diagnostic.message),
    createdAt: new Date().toISOString(),
    uploadStatus: "pending",
  });
  nextDiagnosticId += 1;
  if (diagnostics.length > maxDiagnostics) diagnostics.splice(0, diagnostics.length - maxDiagnostics);
  persistDiagnostics();
  const snapshot = getRecentDiagnostics();
  listeners.forEach((listener) => listener(snapshot));
  scheduleCentralUpload();
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
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = undefined;
  persistDiagnostics();
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
  const handleOnline = () => scheduleCentralUpload();

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  window.addEventListener("load", handleLoad, { once: true });
  window.addEventListener("online", handleOnline);
  scheduleCentralUpload();

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
    window.removeEventListener("load", handleLoad);
    window.removeEventListener("online", handleOnline);
  };
}
