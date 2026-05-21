import { useEffect, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { Field, TextInput } from "../components/form-controls";
import { usePermissions } from "../hooks/use-permissions";
import {
  accountPermissionLabels,
  accountPermissionLevels,
  deleteAccountPermission,
  fetchAccountPermissions,
  saveAccountPermission,
  type AccountPermission,
  type AccountPermissionLevel,
} from "../lib/permissions";
import { fetchSettings, saveSettings } from "../lib/settings";
import type { PricingSettings } from "../types";
import { getErrorMessage } from "../utils/errors";
import { PageHeader } from "../components/ui";

type SettingsPageProps = {
  user: User;
};

const fieldGroups: Array<{
  title: string;
  fields: Array<{
  key: keyof PricingSettings;
  label: string;
  step: string;
  }>;
}> = [
  {
    title: "基础设置",
    fields: [
      { key: "packaging_cost_rmb", label: "包装成本 RMB", step: "0.01" },
      { key: "exchange_rate_rmb_per_jpy", label: "汇率 RMB/JPY", step: "0.0001" },
      { key: "temu_shipping_subsidy_jpy", label: "Temu 运费补贴 JPY", step: "1" },
    ],
  },
  {
    title: "国内物流设置",
    fields: [
      { key: "sf_first_weight_kg", label: "顺丰首重 kg", step: "0.01" },
      { key: "sf_first_price_rmb", label: "顺丰首重价格 RMB", step: "0.01" },
      { key: "sf_extra_price_per_kg_rmb", label: "顺丰续重价格 RMB/kg", step: "0.01" },
    ],
  },
  {
    title: "正常阶段物流设置",
    fields: [
      { key: "huaian_air_price_per_kg_rmb", label: "淮安空运 RMB/kg", step: "0.01" },
      { key: "ocs_price_per_kg_rmb", label: "OCS RMB/kg", step: "0.01" },
      { key: "osaka_lastmile_jpy", label: "大阪尾程 JPY", step: "1" },
      { key: "fukuoka_lastmile_jpy", label: "福冈尾程 JPY", step: "1" },
    ],
  },
  {
    title: "测试阶段物流设置",
    fields: [
      { key: "test_ocs_3cm_first_price_rmb", label: "OCS 昆山 3cm 首重价格 RMB", step: "0.01" },
      {
        key: "test_ocs_3cm_extra_price_per_100g_rmb",
        label: "OCS 昆山 3cm 续重价格 RMB/100g",
        step: "0.01",
      },
      {
        key: "test_ocs_small_parcel_first_price_rmb",
        label: "OCS 昆山小包首重价格 RMB",
        step: "0.01",
      },
      {
        key: "test_ocs_small_parcel_extra_price_per_500g_rmb",
        label: "OCS 昆山小包续重价格 RMB/500g",
        step: "0.01",
      },
    ],
  },
  {
    title: "利润设置",
    fields: [
      { key: "target_profit_rate", label: "目标利润率 %", step: "0.01" },
      { key: "target_post_ad_profit_rate", label: "目标广告后利润率 %", step: "0.01" },
    ],
  },
];

function getAccountPermissionErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error, fallback);
  return message.includes("account_permissions")
    ? "账号权限数据库还没有初始化，请先执行最新的账号权限迁移。"
    : message;
}

export function SettingsPage({ user }: SettingsPageProps) {
  const { canEdit, canDelete, refreshPermission } = usePermissions();
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [accountPermissions, setAccountPermissions] = useState<AccountPermission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionBusyKey, setPermissionBusyKey] = useState("");
  const [permissionEmail, setPermissionEmail] = useState("");
  const [permissionLevel, setPermissionLevel] =
    useState<AccountPermissionLevel>("viewer");
  const [permissionMessage, setPermissionMessage] = useState("");
  const [permissionErrorMessage, setPermissionErrorMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const nextSettings = await fetchSettings(user.id);
        if (active) {
          setSettings(nextSettings);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载参数失败"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [user.id]);

  useEffect(() => {
    let active = true;

    async function loadPermissions() {
      if (!canDelete) {
        setAccountPermissions([]);
        return;
      }

      setPermissionsLoading(true);
      setPermissionErrorMessage("");

      try {
        const nextPermissions = await fetchAccountPermissions();
        if (active) {
          setAccountPermissions(nextPermissions);
        }
      } catch (error) {
        if (active) {
          setPermissionErrorMessage(
            getAccountPermissionErrorMessage(error, "加载账号权限失败"),
          );
        }
      } finally {
        if (active) {
          setPermissionsLoading(false);
        }
      }
    }

    void loadPermissions();
    return () => {
      active = false;
    };
  }, [canDelete]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存系统设置。");
      return;
    }

    setBusy(true);
    setErrorMessage("");

    try {
      await saveSettings(user.id, settings);
      setSaved(true);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存参数失败"));
    } finally {
      setBusy(false);
    }
  }

  async function reloadAccountPermissions() {
    const nextPermissions = await fetchAccountPermissions();
    setAccountPermissions(nextPermissions);
  }

  async function handleSaveAccountPermission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDelete) return;

    setPermissionBusyKey("save");
    setPermissionMessage("");
    setPermissionErrorMessage("");

    try {
      await saveAccountPermission(permissionEmail, permissionLevel);
      await reloadAccountPermissions();
      await refreshPermission();
      setPermissionEmail("");
      setPermissionLevel("viewer");
      setPermissionMessage("账号权限已保存");
    } catch (error) {
      setPermissionErrorMessage(
        getAccountPermissionErrorMessage(error, "保存账号权限失败"),
      );
    } finally {
      setPermissionBusyKey("");
    }
  }

  async function handleDeleteAccountPermission(email: string) {
    if (!canDelete) return;
    const confirmed = window.confirm(`确认删除账号“${email}”的权限设置吗？`);
    if (!confirmed) return;

    setPermissionBusyKey(`delete-${email}`);
    setPermissionMessage("");
    setPermissionErrorMessage("");

    try {
      await deleteAccountPermission(email);
      await reloadAccountPermissions();
      await refreshPermission();
      setPermissionMessage("账号权限已删除");
    } catch (error) {
      setPermissionErrorMessage(
        getAccountPermissionErrorMessage(error, "删除账号权限失败"),
      );
    } finally {
      setPermissionBusyKey("");
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  if (!settings) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        {errorMessage || "未能加载参数"}
      </div>
    );
  }

  return (
    <section className="grid gap-5">
      <PageHeader title="系统设置" description="每个账号保存独立系统参数" />
      {!canEdit && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          当前账号为只读权限，可以查看设置，不能保存修改。
        </div>
      )}
      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      <form onSubmit={handleSubmit} className="surface-card grid gap-5 p-5">
        <div className="grid gap-5">
          {fieldGroups.map((group) => (
            <section key={group.title} className="grid gap-4">
              <h2 className="text-base font-semibold text-ink">{group.title}</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.fields.map((field) => (
                  <Field key={field.key} label={field.label}>
                    <TextInput
                      required
                      disabled={!canEdit}
                      min="0"
                      step={field.step}
                      type="number"
                      value={
                        field.key === "target_profit_rate" ||
                        field.key === "target_post_ad_profit_rate"
                          ? settings[field.key] * 100
                          : settings[field.key] ?? ""
                      }
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          [field.key]:
                            field.key === "target_profit_rate" ||
                            field.key === "target_post_ad_profit_rate"
                              ? Number(event.target.value || 0) / 100
                              : Number(event.target.value || 0),
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-slate-500">{saved ? "已保存" : ""}</span>
          <button
            type="submit"
            disabled={busy || !canEdit}
            className="btn-primary"
          >
            {busy ? "保存中..." : "保存设置"}
          </button>
        </div>
      </form>

      {canDelete && (
        <section className="surface-card grid gap-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">账号权限</h2>
            <p className="mt-1 text-sm text-slate-500">
              按登录邮箱设置账号权限；未配置账号在已有配置后会按只读处理。
            </p>
          </div>

          {permissionMessage && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              {permissionMessage}
            </div>
          )}
          {permissionErrorMessage && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {permissionErrorMessage}
            </div>
          )}

          <form
            onSubmit={handleSaveAccountPermission}
            className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_220px_auto]"
          >
            <TextInput
              required
              type="email"
              value={permissionEmail}
              onChange={(event) => setPermissionEmail(event.target.value)}
              placeholder="账号邮箱"
            />
            <select
              value={permissionLevel}
              onChange={(event) =>
                setPermissionLevel(event.target.value as AccountPermissionLevel)
              }
              className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {accountPermissionLevels.map((level) => (
                <option key={level} value={level}>
                  {accountPermissionLabels[level]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={permissionBusyKey === "save"}
              className="btn-primary"
            >
              {permissionBusyKey === "save" ? "保存中..." : "保存权限"}
            </button>
          </form>

          {permissionsLoading ? (
            <div className="text-sm text-slate-500">加载账号权限中...</div>
          ) : accountPermissions.length === 0 ? (
            <div className="empty-state">暂无账号权限配置</div>
          ) : (
            <div className="table-card shadow-none">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 font-medium">账号邮箱</th>
                      <th className="px-4 py-3 font-medium">权限</th>
                      <th className="px-4 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountPermissions.map((item) => (
                      <tr key={item.email}>
                        <td className="px-4 py-3">{item.email}</td>
                        <td className="px-4 py-3">
                          {accountPermissionLabels[item.permission_level]}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => void handleDeleteAccountPermission(item.email)}
                            disabled={permissionBusyKey === `delete-${item.email}`}
                            className="text-sm font-medium text-rose-600 disabled:opacity-50"
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
