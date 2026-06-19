import { useEffect, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { Plus, Trash2 } from "lucide-react";
import { Field, TextInput } from "../components/form-controls";
import {
  clearDraft,
  isSameDraft,
  readDraft,
  useDraftPersistence,
} from "../hooks/use-draft-persistence";
import { usePermissions } from "../hooks/use-permissions";
import { fetchSettings, saveSettings } from "../lib/settings";
import { defaultFirstLegMethods, defaultLastLegMethods } from "../lib/defaults";
import type { PricingSettings, LogisticsMethodConfig } from "../types";
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
    title: "基础参数设置",
    fields: [
      { key: "packaging_cost_rmb", label: "包装成本 RMB", step: "0.01" },
      { key: "exchange_rate_rmb_per_jpy", label: "汇率 RMB/JPY", step: "0.0001" },
      { key: "temu_shipping_subsidy_jpy", label: "Temu 运费补贴 JPY", step: "1" },
    ],
  },
  {
    title: "目标利润设置",
    fields: [
      { key: "target_profit_rate", label: "目标利润率 %", step: "0.01" },
      { key: "target_post_ad_profit_rate", label: "目标广告后利润率 %", step: "0.01" },
    ],
  },
];

export function SettingsPage({ user }: SettingsPageProps) {
  const { canEdit } = usePermissions();
  const draftKey = `settings-draft:v3:${user.id}`;
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState("");

  // UI state for adding new methods
  const [newFirstLegFormula, setNewFirstLegFormula] = useState<LogisticsMethodConfig["formula"]>("flat_rmb");
  const [newFirstLegName, setNewFirstLegName] = useState("");

  const [newLastLegFormula, setNewLastLegFormula] = useState<LogisticsMethodConfig["formula"]>("flat_jpy");
  const [newLastLegName, setNewLastLegName] = useState("");

  useDraftPersistence(draftKey, settings, { enabled: Boolean(canEdit && settings) });

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const nextSettings = await fetchSettings(user.id);
        const cachedConfig = localStorage.getItem(`pricing-logistics-config:v1:${user.id}`);
        let dynamicConfig = cachedConfig ? JSON.parse(cachedConfig) : null;
        if (!dynamicConfig) {
          dynamicConfig = {
            first_leg_methods: defaultFirstLegMethods,
            last_leg_methods: defaultLastLegMethods,
          };
        }

        const mergedSettings: PricingSettings = {
          ...nextSettings,
          first_leg_methods: dynamicConfig.first_leg_methods,
          last_leg_methods: dynamicConfig.last_leg_methods,
        };

        const cachedDraft = readDraft<PricingSettings>(draftKey);
        const restoredSettings = cachedDraft ?? mergedSettings;

        if (active) {
          setSettings(restoredSettings);
          setDraftNotice(
            cachedDraft && !isSameDraft(cachedDraft, mergedSettings)
              ? "已恢复上次未保存的参数草稿。"
              : "",
          );
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
  }, [draftKey, user.id]);

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

      const dynamicConfig = {
        first_leg_methods: settings.first_leg_methods || defaultFirstLegMethods,
        last_leg_methods: settings.last_leg_methods || defaultLastLegMethods,
      };
      localStorage.setItem(`pricing-logistics-config:v1:${user.id}`, JSON.stringify(dynamicConfig));

      clearDraft(draftKey);
      setDraftNotice("");
      setSaved(true);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存参数失败"));
    } finally {
      setBusy(false);
    }
  }

  // CRUD utilities
  const handleAddFirstLeg = () => {
    if (!settings || !newFirstLegName.trim()) return;
    const name = newFirstLegName.trim();
    const newMethod: LogisticsMethodConfig = {
      id: `first-leg-${Date.now()}`,
      name,
      type: "first_leg",
      formula: newFirstLegFormula,
      params:
        newFirstLegFormula === "sf"
          ? { firstWeight: 1, firstPrice: 8, extraPrice: 2 }
          : newFirstLegFormula === "flat_rmb_tariff"
            ? { price: 20, tariffRate: 0 }
            : { price: 20 },
      isActive: true,
    };
    setSettings({
      ...settings,
      first_leg_methods: [...(settings.first_leg_methods || []), newMethod],
    });
    setNewFirstLegName("");
    setSaved(false);
  };

  const handleAddLastLeg = () => {
    if (!settings || !newLastLegName.trim()) return;
    const name = newLastLegName.trim();
    const newMethod: LogisticsMethodConfig = {
      id: `last-leg-${Date.now()}`,
      name,
      type: "last_leg",
      formula: newLastLegFormula,
      params:
        newLastLegFormula === "ocs_3cm"
          ? { firstPrice: 16.5, extraPrice: 1.5 }
          : newLastLegFormula === "ocs_small"
            ? { firstPrice: 36.5, extraPrice: 6 }
            : { price: 200 },
      isActive: true,
    };
    setSettings({
      ...settings,
      last_leg_methods: [...(settings.last_leg_methods || []), newMethod],
    });
    setNewLastLegName("");
    setSaved(false);
  };

  const handleDeleteFirstLeg = (id: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      first_leg_methods: (settings.first_leg_methods || []).filter((m) => m.id !== id),
    });
    setSaved(false);
  };

  const handleDeleteLastLeg = (id: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      last_leg_methods: (settings.last_leg_methods || []).filter((m) => m.id !== id),
    });
    setSaved(false);
  };

  const handleUpdateFirstLeg = (id: string, updates: Partial<LogisticsMethodConfig>) => {
    if (!settings) return;
    setSettings({
      ...settings,
      first_leg_methods: (settings.first_leg_methods || []).map((m) =>
        m.id === id ? { ...m, ...updates } : m,
      ),
    });
    setSaved(false);
  };

  const handleUpdateLastLeg = (id: string, updates: Partial<LogisticsMethodConfig>) => {
    if (!settings) return;
    setSettings({
      ...settings,
      last_leg_methods: (settings.last_leg_methods || []).map((m) =>
        m.id === id ? { ...m, ...updates } : m,
      ),
    });
    setSaved(false);
  };

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
      <PageHeader title="参数设置" description="独立配置系统参数及多维度物流规则" />
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
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}
      <form onSubmit={handleSubmit} className="grid gap-6">
        <div className="surface-card p-5 grid gap-5">
          {fieldGroups.map((group) => (
            <section key={group.title} className="grid gap-4 border-b border-line pb-5 last:border-0 last:pb-0">
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
                          ? (settings[field.key] as number) * 100
                          : (settings[field.key] as string | number) ?? ""
                      }
                      onChange={(event) => {
                        setSaved(false);
                        setSettings({
                          ...settings,
                          [field.key]:
                            field.key === "target_profit_rate" ||
                            field.key === "target_post_ad_profit_rate"
                              ? Number(event.target.value || 0) / 100
                              : Number(event.target.value || 0),
                        });
                      }}
                    />
                  </Field>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Dynamic logistics configurations */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* First Leg settings card */}
          <div className="surface-card p-5 grid gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h2 className="text-base font-bold text-ink">头程物流设置</h2>
              <span className="text-xs text-slate-500">用于计算从发货地到目的国或分拨仓的头程成本</span>
            </div>
            
            <div className="grid gap-4 max-h-[500px] overflow-y-auto pr-1">
              {(settings.first_leg_methods || []).map((method) => (
                <div key={method.id} className="p-4 rounded-lg border border-line bg-slate-50 relative group">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <input
                      type="text"
                      required
                      disabled={!canEdit}
                      className="bg-transparent border-0 border-b border-transparent focus:border-ink font-semibold text-sm text-ink w-2/3"
                      value={method.name}
                      onChange={(e) => handleUpdateFirstLeg(method.id, { name: e.target.value })}
                    />
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={method.isActive}
                          onChange={(e) => handleUpdateFirstLeg(method.id, { isActive: e.target.checked })}
                        />
                        启用
                      </label>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => handleDeleteFirstLeg(method.id)}
                          className="text-slate-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Formula specific dynamic parameters input fields */}
                  <div className="grid gap-3 grid-cols-2 text-xs">
                    {method.formula === "sf" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          首重 (kg)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.firstWeight ?? ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, firstWeight: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          首重价格 (RMB)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.firstPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, firstPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500 col-span-2">
                          续重价格 (RMB/kg)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.extraPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, extraPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                      </>
                    )}

                    {method.formula === "flat_rmb" && (
                      <label className="flex flex-col gap-1 text-slate-500 col-span-2">
                        价格 (RMB/kg)
                        <input
                          type="number"
                          required
                          disabled={!canEdit}
                          step="0.01"
                          className="text-input text-xs"
                          value={method.params.price ?? ""}
                          onChange={(e) =>
                            handleUpdateFirstLeg(method.id, {
                              params: { ...method.params, price: Number(e.target.value || 0) },
                            })
                          }
                        />
                      </label>
                    )}

                    {method.formula === "flat_rmb_tariff" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          价格 (RMB/kg)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.price ?? ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, price: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          关税率 (比率, 如0.1)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.001"
                            className="text-input text-xs"
                            value={method.params.tariffRate ?? ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, tariffRate: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Form to add a new First Leg */}
            {canEdit && (
              <div className="border-t border-line pt-4 mt-2">
                <p className="text-xs font-semibold text-slate-500 mb-2">添加头程运输方式</p>
                <div className="grid gap-3 grid-cols-[1.5fr_1fr_auto] items-end">
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    名称
                    <input
                      type="text"
                      className="text-input"
                      placeholder="如: OCS Air"
                      value={newFirstLegName}
                      onChange={(e) => setNewFirstLegName(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    类型/公式
                    <select
                      className="text-input"
                      value={newFirstLegFormula}
                      onChange={(e) => setNewFirstLegFormula(e.target.value as LogisticsMethodConfig["formula"])}
                    >
                      <option value="flat_rmb">按公斤计费 (RMB/kg)</option>
                      <option value="flat_rmb_tariff">单价+关税 (RMB/kg)</option>
                      <option value="sf">首重续重制 (RMB)</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleAddFirstLeg}
                    className="inline-flex h-11 items-center justify-center rounded-md bg-ink px-4 text-white hover:bg-slate-900 transition-colors"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Last Leg settings card */}
          <div className="surface-card p-5 grid gap-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h2 className="text-base font-bold text-ink">尾程物流设置</h2>
              <span className="text-xs text-slate-500">用于计算派送给买家的最后一公里成本</span>
            </div>

            <div className="grid gap-4 max-h-[500px] overflow-y-auto pr-1">
              {(settings.last_leg_methods || []).map((method) => (
                <div key={method.id} className="p-4 rounded-lg border border-line bg-slate-50 relative group">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <input
                      type="text"
                      required
                      disabled={!canEdit}
                      className="bg-transparent border-0 border-b border-transparent focus:border-ink font-semibold text-sm text-ink w-2/3"
                      value={method.name}
                      onChange={(e) => handleUpdateLastLeg(method.id, { name: e.target.value })}
                    />
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={method.isActive}
                          onChange={(e) => handleUpdateLastLeg(method.id, { isActive: e.target.checked })}
                        />
                        启用
                      </label>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => handleDeleteLastLeg(method.id)}
                          className="text-slate-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 grid-cols-2 text-xs">
                    {method.formula === "flat_jpy" && (
                      <label className="flex flex-col gap-1 text-slate-500 col-span-2">
                        固定价格 (JPY)
                        <input
                          type="number"
                          required
                          disabled={!canEdit}
                          step="1"
                          className="text-input text-xs"
                          value={method.params.price ?? ""}
                          onChange={(e) =>
                            handleUpdateLastLeg(method.id, {
                              params: { ...method.params, price: Number(e.target.value || 0) },
                            })
                          }
                        />
                      </label>
                    )}

                    {method.formula === "ocs_3cm" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          OCS Yamato 首重价格 (RMB)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.firstPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, firstPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          续重价格 (RMB/100g)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.extraPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, extraPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                      </>
                    )}

                    {method.formula === "ocs_small" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          OCS 小包首重价格 (RMB)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.firstPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, firstPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          续重价格 (RMB/500g)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.extraPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, extraPrice: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Form to add a new Last Leg */}
            {canEdit && (
              <div className="border-t border-line pt-4 mt-2">
                <p className="text-xs font-semibold text-slate-500 mb-2">添加尾程运输方式</p>
                <div className="grid gap-3 grid-cols-[1.5fr_1fr_auto] items-end">
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    名称
                    <input
                      type="text"
                      className="text-input"
                      placeholder="如: JP Post"
                      value={newLastLegName}
                      onChange={(e) => setNewLastLegName(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    类型/公式
                    <select
                      className="text-input"
                      value={newLastLegFormula}
                      onChange={(e) => setNewLastLegFormula(e.target.value as LogisticsMethodConfig["formula"])}
                    >
                      <option value="flat_jpy">固定日元 (JPY)</option>
                      <option value="ocs_3cm">OCS Yamato 3cm制 (RMB)</option>
                      <option value="ocs_small">OCS 小包制 (RMB)</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleAddLastLeg}
                    className="inline-flex h-11 items-center justify-center rounded-md bg-ink px-4 text-white hover:bg-slate-900 transition-colors"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 surface-card p-5">
          <span className="text-sm font-semibold text-emerald-700">{saved ? "已成功保存参数配置。" : ""}</span>
          <button
            type="submit"
            disabled={busy || !canEdit}
            className="btn-primary inline-flex h-11 px-8 font-medium shadow-soft"
          >
            {busy ? "保存中..." : "保存设置"}
          </button>
        </div>
      </form>
    </section>
  );
}
