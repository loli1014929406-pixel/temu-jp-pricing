import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Save, X } from "lucide-react";
import {
  fetchOrCreateCurrentAccountProfile,
  formatAccountProfileDisplay,
  updateCurrentAccountProfileUsername,
} from "../lib/account-profiles";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import type { AccountProfile } from "../types";
import { getErrorMessage } from "../utils/errors";
import { confirmCancelEdit, confirmSave } from "../utils/confirmations";

export function UserPage() {
  const { label } = usePermissions();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(message, () => setMessage(""));

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      setLoading(true);
      setErrorMessage("");
      try {
        const nextProfile = await fetchOrCreateCurrentAccountProfile();
        if (!active) return;
        setProfile(nextProfile);
        setUsername(nextProfile.username);
      } catch (error) {
        if (active) setErrorMessage(getErrorMessage(error, "加载用户资料失败"));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadProfile();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await confirmSave())) return;
    setSaving(true);
    setMessage("");
    setErrorMessage("");

    try {
      const nextProfile = await updateCurrentAccountProfileUsername(username);
      setProfile(nextProfile);
      setUsername(nextProfile.username);
      setMessage("保存成功");
      setIsEditing(false);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存用户名失败"));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelEdit() {
    if (!(await confirmCancelEdit())) return;
    setUsername(profile?.username ?? "");
    setIsEditing(false);
  }

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  return (
    <section className="grid gap-5">
      <div>
        <h1 className="page-title">用户资料</h1>
        <p className="mt-1 text-sm text-slate-500">
          用户ID由系统生成，用户名可修改；商品创建用户显示为“用户名（用户ID）”。
        </p>
      </div>

      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {message}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid gap-5 rounded-lg bg-white p-5 shadow-panel">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            用户名
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={!isEditing || saving}
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm font-medium outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
              placeholder="请输入用户名"
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            用户ID
            <input
              readOnly
              value={profile?.user_code ?? ""}
              className="h-11 rounded-xl border border-line bg-slate-50 px-3 text-sm font-medium text-slate-600 outline-none"
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            权限
            <input
              readOnly
              value={label}
              className="h-11 rounded-xl border border-line bg-slate-50 px-3 text-sm font-medium text-slate-600 outline-none"
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-slate-700">
            商品显示
            <input
              readOnly
              value={formatAccountProfileDisplay(profile)}
              className="h-11 rounded-xl border border-line bg-slate-50 px-3 text-sm font-medium text-slate-600 outline-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          {isEditing ? (
            <>
              <button type="button" disabled={saving} className="btn-secondary" onClick={handleCancelEdit}>
                <X size={18} />
                取消
              </button>
              <button type="submit" disabled={saving} className="btn-primary">
                <Save size={18} />
                {saving ? "保存中..." : "保存"}
              </button>
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setIsEditing(true)}>
              <Pencil size={18} />
              修改
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
