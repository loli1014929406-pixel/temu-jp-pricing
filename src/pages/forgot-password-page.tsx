import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Field, TextInput } from "../components/form-controls";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supabaseConfigError) return setMessage(supabaseConfigError);
    setBusy(true);
    setMessage("");
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, { redirectTo });
    setMessage(error ? error.message : "如果该邮箱已注册，恢复邮件将很快发送，请检查收件箱和垃圾邮件。\n");
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-8">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-slate-900">找回密码</h1>
        <p className="mt-2 text-sm text-slate-500">输入登录邮箱，我们会发送 Supabase 密码恢复邮件。</p>
        <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
          <Field label="邮箱"><TextInput required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {message && <p className="whitespace-pre-line text-sm font-medium text-slate-600" role="status">{message}</p>}
          <button className="btn-primary w-full py-3" disabled={busy || Boolean(supabaseConfigError)} type="submit">
            {busy ? "发送中…" : "发送恢复邮件"}
          </button>
        </form>
        <Link className="mt-5 inline-block text-sm font-semibold text-accent hover:underline" to="/login">返回登录</Link>
      </section>
    </main>
  );
}
