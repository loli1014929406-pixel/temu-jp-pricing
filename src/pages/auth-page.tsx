import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";
import { Field, TextInput } from "../components/form-controls";

type AuthPageProps = {
  user: User | null;
};

export function AuthPage({ user }: AuthPageProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (user) {
    return <Navigate to="/products" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supabaseConfigError) {
      setMessage(supabaseConfigError);
      return;
    }

    setBusy(true);
    setMessage("");

    const supabase = getSupabaseClient();
    const action =
      mode === "login"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error } = await action;

    if (error) {
      setMessage(
        error.message === "Failed to fetch"
          ? "无法连接 Supabase。请检查 .env 中的 Project URL 与 Publishable key 是否正确。"
          : error.message,
      );
    } else {
      setMessage(mode === "login" ? "登录成功" : "注册成功，请检查邮箱验证状态");
    }
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-mist px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-panel">
        <div className="mb-6">
          <p className="text-2xl font-semibold text-ink">Temu日本站申报核算</p>
          <p className="mt-2 text-sm text-slate-500">
            {mode === "login" ? "登录后继续" : "创建账号"}
          </p>
        </div>
        <div className="mb-5 grid grid-cols-2 rounded-md bg-slate-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`h-10 rounded-md ${mode === "login" ? "bg-white shadow-sm" : ""}`}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => setMode("register")}
            className={`h-10 rounded-md ${mode === "register" ? "bg-white shadow-sm" : ""}`}
          >
            注册
          </button>
        </div>
        {supabaseConfigError && (
          <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {supabaseConfigError}
          </div>
        )}
        <form onSubmit={handleSubmit} className="grid gap-4">
          <Field label="邮箱">
            <TextInput
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="密码">
            <TextInput
              required
              minLength={6}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {message && <p className="text-sm text-warning">{message}</p>}
          <button
            type="submit"
            disabled={busy || Boolean(supabaseConfigError)}
            className="mt-2 h-11 rounded-md bg-ink text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? "处理中..." : mode === "login" ? "登录" : "注册"}
          </button>
        </form>
      </div>
    </div>
  );
}
