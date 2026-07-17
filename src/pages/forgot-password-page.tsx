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
    <main className="flex min-h-screen items-center justify-center bg-[#f1f1f1] px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-[#e3e3e3] bg-white p-8 shadow-[0_1px_0_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.08)]">
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-lg bg-[#303030] text-xs font-black text-white">JP</div>
        <h1 className="text-xl font-bold text-[#303030]">找回密码</h1>
        <p className="mt-1.5 text-sm text-[#616161]">输入登录邮箱，我们会发送 Supabase 密码恢复邮件。</p>
        <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
          <Field label="邮箱"><TextInput required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {message && <p className="whitespace-pre-line text-sm font-medium text-slate-600" role="status">{message}</p>}
          <button className="btn-primary w-full" disabled={busy || Boolean(supabaseConfigError)} type="submit">
            {busy ? "发送中…" : "发送恢复邮件"}
          </button>
        </form>
        <Link className="mt-5 inline-block text-sm font-semibold text-accent hover:underline" to="/login">返回登录</Link>
      </section>
    </main>
  );
}
