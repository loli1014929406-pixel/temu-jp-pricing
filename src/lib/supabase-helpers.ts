import { getSupabaseClient } from "./supabase";
import { reportAppError, reportSlowOperation } from "./diagnostics";

export const requestTimeoutMs = 45000;


export async function withTimeout<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}超时，请稍后重试`)),
      requestTimeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (Date.now() - startedAt >= requestTimeoutMs) {
      reportAppError(error, `request-timeout:${label}`);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 5_000) reportSlowOperation(label, durationMs);
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
