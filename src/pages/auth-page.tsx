import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";
import { Field, TextInput } from "../components/form-controls";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";

type AuthPageProps = {
  user: User | null;
};

export function AuthPage({ user }: AuthPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useAutoDismiss(message, () => setMessage(""));

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
    const { error } = await supabase.auth.signInWithPassword({
      email: nextEmail,
      password: nextPassword,
    });

    if (error) {
      setMessage(
        error.message === "Failed to fetch"
          ? "无法连接 Supabase。请检查 .env 中的 Project URL 与 Publishable key 是否正确。"
          : error.message,
      );
    } else {
      setMessage("登录成功");
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
    <div className="flex min-h-screen items-center justify-center bg-[#f1f1f1] px-4 py-10 text-[#303030]">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#303030] text-xs font-black text-white shadow-sm">JP</span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[#303030]">Temu 日本站运营核算系统</h1>
            <p className="mt-0.5 text-xs text-[#616161]">ERP Operations Console</p>
          </div>
        </div>

        <div className="w-full rounded-xl border border-[#e3e3e3] bg-white p-7 shadow-[0_1px_0_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.08)] sm:p-8">
          <div className="mb-6">
            <p className="text-xl font-bold text-[#303030]">账号登录</p>
            <p className="mt-1.5 text-sm text-[#616161]">
              登录后继续访问管理控制台
            </p>
          </div>
          {supabaseConfigError && (
            <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 font-medium">
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
            <div className="text-right">
              <Link className="text-sm font-semibold text-accent hover:underline" to="/forgot-password">
                忘记密码？
              </Link>
            </div>
            {message && <p className="text-sm text-warning font-semibold">{message}</p>}
            <button
              type="submit"
              disabled={busy || Boolean(supabaseConfigError)}
              className="btn-primary mt-2 w-full"
            >
              {busy ? "处理中..." : "安全登录"}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-[#8a8a8a]">
          一站式管理商品、订单、采购、库存与利润数据
        </p>
      </div>
    </div>
  );
}
