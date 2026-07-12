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
    <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-950 via-slate-900 to-slate-950 px-4 py-8 text-slate-100 flex items-center justify-center relative overflow-hidden">
      {/* Background ambient glows */}
      <div className="absolute top-0 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-accentSoft0/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_440px] relative z-10">
        <section className="grid gap-6">
          <div className="inline-flex w-fit rounded-xl border border-white/10 bg-white/5 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-violet-400 backdrop-blur-md shadow-inner">
            ERP Operations Console
          </div>
          <div>
            <h1 className="max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl">
              Temu 日本站 <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">运营核算系统</span>
            </h1>
            <p className="mt-4 max-w-2xl text-base font-medium leading-7 text-slate-400">
              一站式集中管理商品、订单、采购、库存与利润数据，助力决策优化。
            </p>
          </div>
          <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
            {[
              { title: "商品管理", desc: "主参数与申报材质" },
              { title: "订单分配", desc: "仓储物流最优解" },
              { title: "利润分析", desc: "实销实退利润模型" }
            ].map((item) => (
              <div
                key={item.title}
                className="bg-white/5 border border-white/10 rounded-2xl p-4 backdrop-blur-md transition hover:bg-white/10 hover:border-white/20"
              >
                <p className="text-sm font-bold text-white">{item.title}</p>
                <p className="text-xs text-slate-400 mt-1">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="bg-white/90 backdrop-blur-xl border border-white/20 p-8 rounded-3xl shadow-2xl shadow-black/30 w-full text-slate-800">
          <div className="mb-6">
            <p className="text-2xl font-bold text-slate-900">账号登录</p>
            <p className="mt-2 text-sm text-slate-500 font-medium">
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
              className="btn-primary mt-2 w-full text-base py-3"
            >
              {busy ? "处理中..." : "安全登录"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
