import { useEffect, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { Field, TextInput } from "../components/form-controls";
import { usePermissions } from "../hooks/use-permissions";
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

export function SettingsPage({ user }: SettingsPageProps) {
  const { canEdit } = usePermissions();
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存参数设置。");
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
      <PageHeader title="参数设置" description="每个账号保存独立系统参数" />
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
    </section>
  );
}
