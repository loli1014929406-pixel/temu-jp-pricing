import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadProjectEnv(projectDir) {
  const fileEnv = parseEnv(await readFile(path.join(projectDir, ".env"), "utf8"));
  return { ...fileEnv, ...process.env };
}

export async function createAuthenticatedClient({
  supabaseUrl,
  supabaseAnonKey,
  email,
  password,
  label,
}) {
  if (!supabaseUrl || !supabaseAnonKey || !email || !password) {
    throw new Error(`${label} 缺少 Supabase URL、anon key、邮箱或密码。`);
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${label} 登录失败：${error.message}`);
  return { client, user: data.user };
}
