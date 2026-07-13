import { getSupabaseClient } from "./supabase";
import {
  reportAppError,
  reportSlowOperation,
  type DiagnosticMetadata,
} from "./diagnostics";

export const requestTimeoutMs = 45000;

function getResultRowCount(value: unknown) {
  if (!value || typeof value !== "object" || !("data" in value)) return undefined;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return data == null ? 0 : 1;
  const nestedRows = data.length === 1 && data[0] && typeof data[0] === "object"
    ? ["orders", "rows", "records"].map((key) => (data[0] as Record<string, unknown>)[key])
      .find(Array.isArray)
    : undefined;
  return Array.isArray(nestedRows) ? nestedRows.length : data.length;
}

export async function withTimeout<T>(
  promise: PromiseLike<T>,
  label: string,
  metadata: DiagnosticMetadata = { requestKind: "supabase" },
): Promise<T> {
  const startedAt = Date.now();
  let observedRowCount = metadata.rowCount;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}超时，请稍后重试`)),
      requestTimeoutMs,
    );
  });
  try {
    const result = await Promise.race([promise, timeout]);
    observedRowCount = getResultRowCount(result) ?? observedRowCount;
    return result;
  } catch (error) {
    if (Date.now() - startedAt >= requestTimeoutMs) {
      reportAppError(error, `request-timeout:${label}`, metadata);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 5_000) {
      reportSlowOperation(label, durationMs, { ...metadata, rowCount: observedRowCount });
    }
  }
}

export async function requireSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("当前登录已失效，请重新登录");
  return { supabase, session };
}
