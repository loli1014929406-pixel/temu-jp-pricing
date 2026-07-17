import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Field, TextInput } from "../components/form-controls";
import { getSupabaseClient, supabaseConfigError } from "../lib/supabase";

export function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) return setMessage("两次输入的密码不一致。");
    if (supabaseConfigError) return setMessage(supabaseConfigError);
    setBusy(true);
    setMessage("");
    const { error } = await getSupabaseClient().auth.updateUser({ password });
    if (error) setMessage(error.message);
    else {
      setCompleted(true);
      setMessage("密码已更新，请使用新密码登录。");
      await getSupabaseClient().auth.signOut();
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f1f1f1] px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-[#e3e3e3] bg-white p-8 shadow-[0_1px_0_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.08)]">
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-lg bg-[#303030] text-xs font-black text-white">JP</div>
        <h1 className="text-xl font-bold text-[#303030]">设置新密码</h1>
        <p className="mt-1.5 text-sm text-[#616161]">请从恢复邮件进入此页面，然后设置新的登录密码。</p>
        {!completed && <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
          <Field label="新密码"><TextInput required minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="确认新密码"><TextInput required minLength={8} type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
          <button className="btn-primary w-full" disabled={busy || Boolean(supabaseConfigError)} type="submit">{busy ? "更新中…" : "更新密码"}</button>
        </form>}
        {message && <p className="mt-4 text-sm font-medium text-slate-600" role="status">{message}</p>}
        <Link className="mt-5 inline-block text-sm font-semibold text-accent hover:underline" to="/login">返回登录</Link>
      </section>
    </main>
  );
}
