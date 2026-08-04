const SUPABASE_HOST_SUFFIXES = [".supabase.co", ".supabase.net"];

export function normalizeProjectRef(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function projectRefFromUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let hostname;
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error("Supabase URL 格式无效，已停止以避免连接错误环境。");
  }

  const suffix = SUPABASE_HOST_SUFFIXES.find((candidate) =>
    hostname.endsWith(candidate),
  );
  if (!suffix) {
    throw new Error("Supabase URL 不是可识别的 Supabase 项目地址，已停止。");
  }
  return hostname.slice(0, -suffix.length);
}

export function assertShadowEnvironment(env) {
  const productionRef = normalizeProjectRef(
    env.SUPABASE_PRODUCTION_PROJECT_REF,
  );
  const shadowRef = normalizeProjectRef(env.SUPABASE_SHADOW_PROJECT_REF);
  const targetUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const targetRef = projectRefFromUrl(targetUrl);

  if (!productionRef || !shadowRef) {
    throw new Error(
      "缺少 SUPABASE_PRODUCTION_PROJECT_REF 或 SUPABASE_SHADOW_PROJECT_REF，禁止运行多租户数据库验证。",
    );
  }
  if (productionRef === shadowRef) {
    throw new Error("影子项目与生产项目相同，已强制停止。");
  }
  if (targetRef === productionRef) {
    throw new Error("当前 Supabase URL 指向生产项目，已强制停止。");
  }
  if (targetRef !== shadowRef) {
    throw new Error(
      `当前 Supabase URL 指向 ${targetRef || "未知项目"}，不是声明的影子项目 ${shadowRef}。`,
    );
  }

  return { productionRef, shadowRef, targetRef };
}
