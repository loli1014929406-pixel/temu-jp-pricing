import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigError =
  !supabaseUrl || !supabaseAnonKey
    ? "缺少 Supabase 配置。请在项目根目录创建 .env，并填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY。"
    : null;

export const supabase =
  supabaseConfigError === null
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export function getSupabaseClient() {
  if (!supabase) {
    throw new Error(supabaseConfigError ?? "Supabase 尚未初始化");
  }

  return supabase;
}
