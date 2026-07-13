import { getSupabaseClient } from "./supabase";

export type AppDiagnostic = {
  id: number;
  type: "error" | "slow-operation" | "navigation";
  context: string;
  message: string;
  durationMs?: number;
  requestKind?: string;
  cacheStatus?: string;
  rowCount?: number;
  retryCount?: number;
  traceId?: string;
  path: string;
  appVersion: string;
  createdAt: string;
  uploadStatus: "pending" | "uploaded";
};

export type DiagnosticMetadata = Pick<
  AppDiagnostic,
  "requestKind" | "cacheStatus" | "rowCount" | "retryCount" | "traceId"
>;

const maxDiagnostics = 50;
const diagnosticsStorageKey = "temu-jp:diagnostics:v1";

function getDiagnosticPath() {
  return typeof window === "undefined" ? "" : window.location.pathname.slice(0, 200);
}

function createTraceId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getAppVersion() {
  return String(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : import.meta.env.VITE_APP_VERSION ?? "dev",
  ).slice(0, 50);
}

let tracedPath = getDiagnosticPath();
let pageTraceId = createTraceId();

function getPageTraceId(path: string) {
  if (path !== tracedPath) {
    tracedPath = path;
    pageTraceId = createTraceId();
  }
  return pageTraceId;
}

function loadStoredDiagnostics(): AppDiagnostic[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.sessionStorage.getItem(diagnosticsStorageKey);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed)
      ? parsed.slice(-maxDiagnostics).map((item) => ({
          ...item,
          path: typeof item.path === "string" ? item.path : "",
          appVersion: typeof item.appVersion === "string" ? item.appVersion : "legacy",
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

      const extendedRows = pending.map((item) => ({
          user_id: session.user.id,
          event_type: item.type,
          context: sanitizeDiagnosticContext(item.context),
          message: sanitizeDiagnosticText(item.message),
          duration_ms: item.durationMs ?? null,
          path: item.path,
          app_version: item.appVersion,
          request_kind: sanitizeDiagnosticContext(item.requestKind ?? ""),
          cache_status: sanitizeDiagnosticContext(item.cacheStatus ?? ""),
          row_count: item.rowCount ?? null,
          retry_count: item.retryCount ?? 0,
          trace_id: sanitizeDiagnosticContext(item.traceId ?? ""),
        }));
      let { error } = await supabase.from("app_diagnostics").insert(extendedRows);
      if (error?.code === "PGRST204" || error?.code === "42703") {
        const legacyRows = extendedRows.map(({
          request_kind: _requestKind,
          cache_status: _cacheStatus,
          row_count: _rowCount,
          retry_count: _retryCount,
          trace_id: _traceId,
          ...row
        }) => row);
        ({ error } = await supabase.from("app_diagnostics").insert(legacyRows));
      }
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
  diagnostic: Omit<AppDiagnostic, "id" | "path" | "appVersion" | "createdAt" | "message" | "uploadStatus"> & {
    message: unknown;
  },
) {
  const path = getDiagnosticPath();
  diagnostics.push({
    ...diagnostic,
    id: nextDiagnosticId,
    path,
    appVersion: getAppVersion(),
    traceId: diagnostic.traceId || getPageTraceId(path),
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

export function reportAppError(
  error: unknown,
  context: string,
  metadata: DiagnosticMetadata = {},
) {
  appendDiagnostic({ type: "error", context, message: error, ...metadata });
  console.error(`[${context}]`, error);
}

export function reportSlowOperation(
  context: string,
  durationMs: number,
  metadata: DiagnosticMetadata = {},
) {
  appendDiagnostic({
    type: "slow-operation",
    context,
    message: `操作耗时 ${Math.round(durationMs)}ms`,
    durationMs: Math.round(durationMs),
    ...metadata,
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

  const observers: PerformanceObserver[] = [];
  let lcpMs = 0;
  let clsScore = 0;
  let inpMs = 0;
  let vitalsReported = false;

  function observe(entryType: string, handler: (entry: PerformanceEntry) => void) {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach(handler);
      });
      observer.observe({ type: entryType, buffered: true });
      observers.push(observer);
    } catch {
      // Older browsers may not support every performance entry type.
    }
  }

  observe("largest-contentful-paint", (entry) => {
    lcpMs = Math.max(lcpMs, entry.startTime);
  });
  observe("layout-shift", (entry) => {
    const layoutEntry = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (!layoutEntry.hadRecentInput) clsScore += Number(layoutEntry.value ?? 0);
  });
  observe("event", (entry) => {
    const eventEntry = entry as PerformanceEntry & { interactionId?: number };
    if (eventEntry.interactionId) inpMs = Math.max(inpMs, eventEntry.duration);
  });

  function reportWebVitals() {
    if (vitalsReported) return;
    vitalsReported = true;
    [
      { context: "web-vital:LCP", value: Math.round(lcpMs), message: `LCP ${Math.round(lcpMs)}ms` },
      { context: "web-vital:INP", value: Math.round(inpMs), message: `INP ${Math.round(inpMs)}ms` },
      { context: "web-vital:CLS", value: Math.round(clsScore * 1000), message: `CLS ${clsScore.toFixed(3)}` },
    ].forEach((metric) => {
      if (metric.value <= 0) return;
      appendDiagnostic({
        type: "navigation",
        context: metric.context,
        message: metric.message,
        durationMs: metric.value,
        requestKind: "browser",
      });
    });
  }

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
    if (navigation) {
      const durationMs = Math.round(navigation.duration || performance.now());
      if (durationMs <= 0) return;
      appendDiagnostic({
        type: "navigation",
        context: "initial-navigation",
        message: `首屏加载耗时 ${durationMs}ms`,
        durationMs,
        requestKind: "browser",
      });
    }
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") reportWebVitals();
  };
  const handleOnline = () => scheduleCentralUpload();

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  window.addEventListener("load", handleLoad, { once: true });
  window.addEventListener("online", handleOnline);
  window.addEventListener("pagehide", reportWebVitals, { once: true });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  scheduleCentralUpload();

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
    window.removeEventListener("load", handleLoad);
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("pagehide", reportWebVitals);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    observers.forEach((observer) => observer.disconnect());
  };
}
