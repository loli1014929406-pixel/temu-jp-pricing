import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";
import { Field, TextInput } from "../components/form-controls";

type AuthPageProps = {
  user: User | null;
};

const signUpEnabled = import.meta.env.VITE_ENABLE_SIGNUP === "true";

export function AuthPage({ user }: AuthPageProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function authenticate(
    nextEmail: string,
    nextPassword: string,
  ) {
    if (supabaseConfigError) {
      setMessage(supabaseConfigError);
      return;
    }

    setBusy(true);
    setMessage("");

    const supabase = getSupabaseClient();
    const isRegister = mode === "register" && signUpEnabled;
    const action = isRegister
      ? supabase.auth.signUp({ email: nextEmail, password: nextPassword })
      : supabase.auth.signInWithPassword({ email: nextEmail, password: nextPassword });
    const { error } = await action;

    if (error) {
      setMessage(
        error.message === "Failed to fetch"
          ? "无法连接 Supabase。请检查 .env 中的 Project URL 与 Publishable key 是否正确。"
          : error.message,
      );
    } else {
      setMessage(isRegister ? "注册成功，请检查邮箱验证状态" : "登录成功");
    }
    setBusy(false);
  }

  if (user) {
    return <Navigate to="/products" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await authenticate(email, password);
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-900">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="grid gap-6">
          <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-wide text-sky-700 shadow-soft">
            ERP Operations Console
          </div>
          <div>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-normal text-slate-950 sm:text-5xl">
              Temu日本站运营核算系统
            </h1>
            <p className="mt-4 max-w-2xl text-base font-medium leading-7 text-slate-600">
              商品、订单、采购、库存与利润数据集中管理。
            </p>
          </div>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {["商品", "订单", "利润"].map((item) => (
              <div
                key={item}
                className="erp-kpi-card px-4 py-3 text-sm font-semibold text-slate-700"
              >
                {item}
              </div>
            ))}
          </div>
        </section>

        <div className="surface-card w-full p-6">
          <div className="mb-6">
            <p className="text-2xl font-semibold text-ink">账号登录</p>
            <p className="mt-2 text-sm font-medium text-slate-500">
              {mode === "login" ? "登录后继续" : "创建账号"}
            </p>
          </div>
          <div className="mb-5 grid grid-cols-2 rounded-md border border-slate-200 bg-slate-100 p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`h-10 rounded-md transition ${mode === "login" ? "bg-white text-sky-700 shadow-soft" : "text-slate-500"} ${signUpEnabled ? "" : "col-span-2"}`}
          >
            登录
          </button>
          {signUpEnabled && (
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`h-10 rounded-md transition ${mode === "register" ? "bg-white text-sky-700 shadow-soft" : "text-slate-500"}`}
            >
              注册
            </button>
          )}
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
            className="btn-primary mt-2 w-full"
          >
            {busy ? "处理中..." : mode === "login" ? "登录" : "注册"}
          </button>
        </form>
        </div>
      </div>
    </div>
  );
}
