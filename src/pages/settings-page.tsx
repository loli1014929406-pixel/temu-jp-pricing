import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Pencil, Plus, Trash2, X, Save } from "lucide-react";
import { Field, TextInput } from "../components/form-controls";
import {
  clearDraft,
  isSameDraft,
  readDraft,
  useDraftPersistence,
} from "../hooks/use-draft-persistence";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { usePermissions } from "../hooks/use-permissions";
import { fetchSettings, saveSettings } from "../lib/settings";
import {
  resolveFirstLegMethods,
  resolveLastLegMethods,
} from "../lib/defaults";
import type { LogisticsMethodConfig, PricingSettings } from "../types";
import { getErrorMessage } from "../utils/errors";
import { PageHeader } from "../components/ui";
import { confirmCancelEdit, confirmDelete, confirmSave } from "../utils/confirmations";
import {
  resolveSettingsDraft,
  type SettingsDraftState,
} from "../lib/settings-draft";

type SettingsPageProps = {
  user: User;
};

type LogisticsSectionType = LogisticsMethodConfig["type"];
type LogisticsFormula = LogisticsMethodConfig["formula"];
type LogisticsParams = LogisticsMethodConfig["params"];
type LogisticsParamKey = Exclude<keyof LogisticsParams, "quantityPrices">;
type LogisticsCurrency = NonNullable<LogisticsParams["currency"]>;
type LogisticsBillingUnit = NonNullable<LogisticsParams["billingUnit"]>;

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

const formulaOptionsByType = {
  first_leg: [
    { value: "flat_rmb", label: "按重量计费" },
    { value: "fixed_rmb", label: "固定运费" },
    { value: "flat_rmb_tariff", label: "单价+关税" },
    { value: "sf", label: "首重续重" },
  ],
  last_leg: [
    { value: "flat_jpy", label: "固定日元" },
    { value: "fixed_rmb", label: "固定运费" },
    { value: "quantity_tier", label: "按件数分档" },
    { value: "ocs_3cm", label: "首重＋续重（每100g）" },
    { value: "ocs_small", label: "首重＋续重（每500g）" },
  ],
} satisfies Record<LogisticsSectionType, Array<{ value: LogisticsFormula; label: string }>>;

const currencyOptions: Array<{ value: LogisticsCurrency; label: string }> = [
  { value: "RMB", label: "RMB" },
  { value: "JPY", label: "JPY" },
];

const billingUnitOptions: Array<{ value: LogisticsBillingUnit; label: string }> = [
  { value: "ticket", label: "单票" },
  { value: "kg", label: "kg" },
  { value: "100g", label: "100g" },
  { value: "500g", label: "500g" },
];

function getFormulaLabel(type: LogisticsSectionType, formula: LogisticsFormula) {
  return formulaOptionsByType[type].find((option) => option.value === formula)?.label ?? formula;
}

function getDefaultFormula(type: LogisticsSectionType): LogisticsFormula {
  return type === "first_leg" ? "flat_rmb" : "flat_jpy";
}

function getDefaultParamsForFormula(formula: LogisticsFormula): LogisticsParams {
  if (formula === "sf") {
    return { firstWeight: 1, firstPrice: 8, extraPrice: 2, currency: "RMB", billingUnit: "kg" };
  }
  if (formula === "flat_rmb_tariff") {
    return { price: 20, tariffRate: 0, currency: "RMB", billingUnit: "kg" };
  }
  if (formula === "ocs_3cm") {
    return { firstPrice: 16.5, extraPrice: 1.5, currency: "RMB", billingUnit: "100g" };
  }
  if (formula === "ocs_small") {
    return { firstPrice: 36.5, extraPrice: 6, currency: "RMB", billingUnit: "500g" };
  }
  if (formula === "flat_jpy") {
    return { price: 200, currency: "JPY", billingUnit: "ticket" };
  }
  if (formula === "quantity_tier") {
    return { quantityPrices: [0], currency: "JPY", billingUnit: "ticket" };
  }
  if (formula === "fixed_rmb") {
    return { price: 20, currency: "RMB", billingUnit: "ticket" };
  }
  return { price: 20, currency: "RMB", billingUnit: "kg" };
}

function getParamFields(formula: LogisticsFormula, params: LogisticsParams) {
  const fields: Array<{ key: LogisticsParamKey; label: string; step: string }> = [];
  const currency = params.currency ?? (formula === "flat_jpy" ? "JPY" : "RMB");
  const billingUnit = params.billingUnit ?? "kg";
  const unitLabel = billingUnit === "ticket" ? "单票" : billingUnit;

  if (formula === "sf") {
    fields.push(
      { key: "firstWeight", label: "首重 (kg)", step: "0.01" },
      { key: "firstPrice", label: `首重价格 (${currency})`, step: "0.01" },
      { key: "extraPrice", label: `续重价格 (${currency}/${unitLabel})`, step: "0.01" },
    );
  } else if (formula === "flat_rmb") {
    fields.push({ key: "price", label: `单价 (${currency}/${unitLabel})`, step: "0.01" });
  } else if (formula === "flat_rmb_tariff") {
    fields.push(
      { key: "price", label: `单价 (${currency}/${unitLabel})`, step: "0.01" },
      { key: "tariffRate", label: "关税率 (比率, 如 0.1)", step: "0.001" },
    );
  } else if (formula === "flat_jpy") {
    fields.push({ key: "price", label: `固定运费 (${currency})`, step: "1" });
  } else if (formula === "fixed_rmb") {
    fields.push({ key: "price", label: `固定运费 (${currency})`, step: "0.01" });
  } else if (formula === "ocs_3cm") {
    fields.push(
      { key: "firstPrice", label: `首重价格 (${currency})`, step: "0.01" },
      { key: "extraPrice", label: `续重价格 (${currency}/${unitLabel})`, step: "0.01" },
    );
  } else if (formula === "ocs_small") {
    fields.push(
      { key: "firstPrice", label: `首重价格 (${currency})`, step: "0.01" },
      { key: "extraPrice", label: `续重价格 (${currency}/${unitLabel})`, step: "0.01" },
    );
  }

  return fields;
}

function SelectInput({
  children,
  disabled,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      disabled={disabled}
      className="h-10 rounded-xl border border-line bg-white px-3.5 text-sm outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 disabled:bg-slate-100 disabled:text-slate-500"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
}

function createLogisticsMethod(
  type: LogisticsSectionType,
  name: string,
  formula: LogisticsFormula,
  params: LogisticsParams,
): LogisticsMethodConfig {
  return {
    id: `${type}-${Date.now()}`,
    name,
    type,
    formula,
    params: { ...params },
    isActive: true,
  };
}

function LogisticsParamFields({
  disabled,
  formula,
  params,
  onChange,
}: {
  disabled: boolean;
  formula: LogisticsFormula;
  params: LogisticsParams;
  onChange: (params: LogisticsParams) => void;
}) {
  if (formula === "quantity_tier") {
    const currency = params.currency ?? "JPY";
    const quantityPrices = params.quantityPrices?.length ? params.quantityPrices : [0];

    return (
      <div className="grid gap-3">
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          {quantityPrices.map((price, index) => (
            <Field key={index} label={`${index + 1}件运费 (${currency})`}>
              <TextInput
                required
                disabled={disabled}
                min="0"
                step={currency === "JPY" ? "1" : "0.01"}
                type="number"
                value={price}
                onChange={(event) => {
                  const nextPrices = [...quantityPrices];
                  nextPrices[index] = Number(event.target.value || 0);
                  onChange({ ...params, quantityPrices: nextPrices });
                }}
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!disabled ? (
            <>
              <button
                type="button"
                className="btn-secondary h-9 px-3"
                onClick={() =>
                  onChange({
                    ...params,
                    quantityPrices: [
                      ...quantityPrices,
                      quantityPrices[quantityPrices.length - 1] ?? 0,
                    ],
                  })
                }
              >
                <Plus size={15} />
                增加下一件
              </button>
              {quantityPrices.length > 1 ? (
                <button
                  type="button"
                  className="btn-secondary h-9 px-3"
                  onClick={() =>
                    onChange({ ...params, quantityPrices: quantityPrices.slice(0, -1) })
                  }
                >
                  <Trash2 size={15} />
                  删除最后一档
                </button>
              ) : null}
            </>
          ) : null}
          <p className="text-xs text-muted">
            超过最后一个已设置件数时，自动沿用最后一档运费。
          </p>
        </div>
      </div>
    );
  }

  const fields = getParamFields(formula, params);

  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <TextInput
            required
            disabled={disabled}
            min="0"
            step={field.step}
            type="number"
            value={params[field.key] ?? ""}
            onChange={(event) =>
              onChange({
                ...params,
                [field.key]: Number(event.target.value || 0),
              })
            }
          />
        </Field>
      ))}
    </div>
  );
}

function LogisticsMetaFields({
  disabled,
  formula,
  params,
  type,
  onFormulaChange,
  onParamsChange,
}: {
  disabled: boolean;
  formula: LogisticsFormula;
  params: LogisticsParams;
  type: LogisticsSectionType;
  onFormulaChange: (formula: LogisticsFormula) => void;
  onParamsChange: (params: LogisticsParams) => void;
}) {
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      <Field label="运费方式">
        <SelectInput
          disabled={disabled}
          value={formula}
          onChange={(value) => onFormulaChange(value as LogisticsFormula)}
        >
          {formulaOptionsByType[type].map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="货币单位">
        <SelectInput
          disabled={disabled}
          value={params.currency ?? "RMB"}
          onChange={(value) =>
            onParamsChange({ ...params, currency: value as LogisticsCurrency })
          }
        >
          {currencyOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="计费单位">
        {formula === "quantity_tier" ? (
          <TextInput disabled value="订单总件数" />
        ) : (
          <SelectInput
            disabled={disabled}
            value={params.billingUnit ?? "ticket"}
            onChange={(value) =>
              onParamsChange({ ...params, billingUnit: value as LogisticsBillingUnit })
            }
          >
            {billingUnitOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        )}
      </Field>
    </div>
  );
}

function LogisticsMethodCard({
  canEdit,
  method,
  onDelete,
  onUpdate,
}: {
  canEdit: boolean;
  method: LogisticsMethodConfig;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<LogisticsMethodConfig>) => void;
}) {
  return (
    <article className="grid gap-5 rounded-lg border border-line bg-slate-50 p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-end">
        <Field label="名称">
          <TextInput
            required
            disabled={!canEdit}
            type="text"
            value={method.name}
            onChange={(event) => onUpdate(method.id, { name: event.target.value })}
          />
        </Field>
        <div className="flex h-10 items-center justify-between gap-3 lg:justify-end">
          <span className="inline-flex h-8 items-center rounded-full border border-line bg-white px-3 text-sm font-semibold text-slate-700">
            {getFormulaLabel(method.type, method.formula)}
          </span>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-600">
            <input
              disabled={!canEdit}
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={method.isActive}
              onChange={(event) => onUpdate(method.id, { isActive: event.target.checked })}
            />
            启用
          </label>
          {canEdit && (
            <button
              type="button"
              title="删除"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              onClick={() => onDelete(method.id)}
            >
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </div>

      <LogisticsMetaFields
        disabled={!canEdit}
        formula={method.formula}
        params={method.params}
        type={method.type}
        onFormulaChange={(formula) =>
          onUpdate(method.id, {
            formula,
            params: getDefaultParamsForFormula(formula),
          })
        }
        onParamsChange={(params) => onUpdate(method.id, { params })}
      />

      <LogisticsParamFields
        disabled={!canEdit}
        formula={method.formula}
        params={method.params}
        onChange={(params) => onUpdate(method.id, { params })}
      />
    </article>
  );
}

function NewLogisticsMethodPanel({
  canEdit,
  name,
  formula,
  params,
  type,
  onAdd,
  onCancel,
  onFormulaChange,
  onNameChange,
  onParamsChange,
}: {
  canEdit: boolean;
  name: string;
  formula: LogisticsFormula;
  params: LogisticsParams;
  type: LogisticsSectionType;
  onAdd: () => void;
  onCancel: () => void;
  onFormulaChange: (formula: LogisticsFormula) => void;
  onNameChange: (name: string) => void;
  onParamsChange: (params: LogisticsParams) => void;
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-dashed border-accent/40 bg-accent/5 p-4">
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <Field label="名称">
          <TextInput
            autoFocus
            disabled={!canEdit}
            type="text"
            placeholder={type === "first_leg" ? "如: OCS Air" : "如: JP Post"}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>
      </div>

      <LogisticsMetaFields
        disabled={!canEdit}
        formula={formula}
        params={params}
        type={type}
        onFormulaChange={(nextFormula) => onFormulaChange(nextFormula)}
        onParamsChange={onParamsChange}
      />

      <LogisticsParamFields
        disabled={!canEdit}
        formula={formula}
        params={params}
        onChange={onParamsChange}
      />

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary h-10 px-4" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn-primary h-10 px-5" onClick={onAdd}>
          保存新增
        </button>
      </div>
    </div>
  );
}

function LogisticsSection({
  canEdit,
  description,
  isAdding,
  methods,
  newFormula,
  newName,
  newParams,
  onAdd,
  onCancelAdd,
  onDelete,
  onNewFormulaChange,
  onNewNameChange,
  onNewParamsChange,
  onStartAdd,
  onUpdate,
  title,
  type,
}: {
  canEdit: boolean;
  description: string;
  isAdding: boolean;
  methods: LogisticsMethodConfig[];
  newFormula: LogisticsFormula;
  newName: string;
  newParams: LogisticsParams;
  onAdd: () => void;
  onCancelAdd: () => void;
  onDelete: (id: string) => void;
  onNewFormulaChange: (formula: LogisticsFormula) => void;
  onNewNameChange: (name: string) => void;
  onNewParamsChange: (params: LogisticsParams) => void;
  onStartAdd: () => void;
  onUpdate: (id: string, updates: Partial<LogisticsMethodConfig>) => void;
  title: string;
  type: LogisticsSectionType;
}) {
  const addButtonLabel = type === "first_leg" ? "新增头程方式" : "新增尾程方式";

  return (
    <section className="section-card">
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <h2 className="text-base font-bold text-ink">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="btn-secondary h-10 shrink-0 px-4"
            onClick={isAdding ? onCancelAdd : onStartAdd}
          >
            {isAdding ? <X size={16} /> : <Plus size={16} />}
            {isAdding ? "收起" : addButtonLabel}
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-4">
        {isAdding && (
          <NewLogisticsMethodPanel
            canEdit={canEdit}
            name={newName}
            formula={newFormula}
            params={newParams}
            type={type}
            onNameChange={onNewNameChange}
            onFormulaChange={onNewFormulaChange}
            onParamsChange={onNewParamsChange}
            onAdd={onAdd}
            onCancel={onCancelAdd}
          />
        )}

        {methods.length === 0 ? (
          <div className="rounded-md border border-line bg-slate-50 p-4 text-sm text-slate-500">
            暂无物流方式
          </div>
        ) : (
          methods.map((method) => (
            <LogisticsMethodCard
              key={method.id}
              canEdit={canEdit}
              method={method}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function SettingsPage({ user }: SettingsPageProps) {
  const { canEdit } = usePermissions();
  const legacyDraftKey = `settings-draft:v3:${user.id}`;
  const draftKey = `settings-draft:v4:${user.id}`;
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [settingsSnapshot, setSettingsSnapshot] = useState<PricingSettings | null>(null);

  const [addingFirstLeg, setAddingFirstLeg] = useState(false);
  const [newFirstLegFormula, setNewFirstLegFormula] = useState<LogisticsFormula>(
    getDefaultFormula("first_leg"),
  );
  const [newFirstLegName, setNewFirstLegName] = useState("");
  const [newFirstLegParams, setNewFirstLegParams] = useState<LogisticsParams>(
    getDefaultParamsForFormula(getDefaultFormula("first_leg")),
  );

  const [addingLastLeg, setAddingLastLeg] = useState(false);
  const [newLastLegFormula, setNewLastLegFormula] = useState<LogisticsFormula>(
    getDefaultFormula("last_leg"),
  );
  const [newLastLegName, setNewLastLegName] = useState("");
  const [newLastLegParams, setNewLastLegParams] = useState<LogisticsParams>(
    getDefaultParamsForFormula(getDefaultFormula("last_leg")),
  );

  useAutoDismiss(errorMessage, () => setErrorMessage(""));
  useAutoDismiss(draftNotice, () => setDraftNotice(""));
  useAutoDismiss(saved, () => setSaved(false));
  const settingsDraft = useMemo<SettingsDraftState | null>(
    () =>
      settings && settingsSnapshot
        ? { settings, baseSettings: settingsSnapshot }
        : null,
    [settings, settingsSnapshot],
  );
  useDraftPersistence(draftKey, settingsDraft, {
    enabled: Boolean(canEdit && isEditing && settingsDraft),
  });

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const nextSettings = await fetchSettings(user.id);
        clearDraft(legacyDraftKey);
        const cachedDraft = readDraft<SettingsDraftState>(draftKey);
        const restoredSettings = resolveSettingsDraft(cachedDraft, nextSettings);
        if (cachedDraft && !restoredSettings) clearDraft(draftKey);

        if (active) {
          setSettings(restoredSettings ?? nextSettings);
          setIsEditing(Boolean(restoredSettings));
          setSettingsSnapshot(restoredSettings ? nextSettings : null);
          setDraftNotice(
            restoredSettings && !isSameDraft(restoredSettings, nextSettings)
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
  }, [draftKey, legacyDraftKey, user.id]);

  function updateSettings(updates: Partial<PricingSettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
    setSaved(false);
  }

  function resetFirstLegAddForm() {
    const formula = getDefaultFormula("first_leg");
    setNewFirstLegName("");
    setNewFirstLegFormula(formula);
    setNewFirstLegParams(getDefaultParamsForFormula(formula));
    setAddingFirstLeg(false);
  }

  function resetLastLegAddForm() {
    const formula = getDefaultFormula("last_leg");
    setNewLastLegName("");
    setNewLastLegFormula(formula);
    setNewLastLegParams(getDefaultParamsForFormula(formula));
    setAddingLastLeg(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能保存参数设置。");
      return;
    }
    if (!(await confirmSave())) return;

    setBusy(true);
    setErrorMessage("");

    try {
      await saveSettings(user.id, settings);
      const nextSettings = await fetchSettings(user.id);
      setSettings(nextSettings);
      clearDraft(draftKey);
      setDraftNotice("");
      setSaved(true);
      setIsEditing(false);
      setSettingsSnapshot(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存参数失败"));
    } finally {
      setBusy(false);
    }
  }

  function handleStartEdit() {
    if (!settings) return;
    setSettingsSnapshot(settings);
    setIsEditing(true);
  }

  async function handleCancelEdit() {
    if (!(await confirmCancelEdit())) return;
    if (settingsSnapshot) {
      setSettings(settingsSnapshot);
      clearDraft(draftKey);
    }
    setSettingsSnapshot(null);
    resetFirstLegAddForm();
    resetLastLegAddForm();
    setIsEditing(false);
  }

  function handleAddFirstLeg() {
    if (!settings) return;
    const name = newFirstLegName.trim();
    if (!name) {
      setErrorMessage("请填写头程物流方式名称。");
      return;
    }

    updateSettings({
      first_leg_methods: [
        ...resolveFirstLegMethods(settings),
        createLogisticsMethod("first_leg", name, newFirstLegFormula, newFirstLegParams),
      ],
    });
    resetFirstLegAddForm();
  }

  function handleAddLastLeg() {
    if (!settings) return;
    const name = newLastLegName.trim();
    if (!name) {
      setErrorMessage("请填写尾程物流方式名称。");
      return;
    }

    updateSettings({
      last_leg_methods: [
        ...resolveLastLegMethods(settings),
        createLogisticsMethod("last_leg", name, newLastLegFormula, newLastLegParams),
      ],
    });
    resetLastLegAddForm();
  }

  async function handleDeleteFirstLeg(id: string) {
    if (!settings) return;
    const methods = resolveFirstLegMethods(settings);
    const method = methods.find((item) => item.id === id);
    if (!(await confirmDelete(`头程物流方式“${method?.name ?? id}”`))) return;
    updateSettings({
      first_leg_methods: methods.filter((method) => method.id !== id),
    });
  }

  async function handleDeleteLastLeg(id: string) {
    if (!settings) return;
    const methods = resolveLastLegMethods(settings);
    const method = methods.find((item) => item.id === id);
    if (!(await confirmDelete(`尾程物流方式“${method?.name ?? id}”`))) return;
    updateSettings({
      last_leg_methods: methods.filter((method) => method.id !== id),
    });
  }

  function handleUpdateFirstLeg(id: string, updates: Partial<LogisticsMethodConfig>) {
    if (!settings) return;
    updateSettings({
      first_leg_methods: resolveFirstLegMethods(settings).map((method) =>
        method.id === id ? { ...method, ...updates } : method,
      ),
    });
  }

  function handleUpdateLastLeg(id: string, updates: Partial<LogisticsMethodConfig>) {
    if (!settings) return;
    updateSettings({
      last_leg_methods: resolveLastLegMethods(settings).map((method) =>
        method.id === id ? { ...method, ...updates } : method,
      ),
    });
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
    <section className="page-stack relative">
      <PageHeader 
        title="参数设置" 
          description="独立配置系统参数及多维度物流规则" 
          actions={
            canEdit && (
              <div className="flex justify-end gap-2">
                {isEditing ? (
                  <>
                    <button type="button" className="btn-secondary" onClick={handleCancelEdit}>
                      <X size={16} />
                      取消
                    </button>
                    <button 
                      type="submit" 
                      form="settings-form"
                      disabled={busy} 
                      className="btn-primary"
                    >
                      <Save size={16} />
                      {busy ? "保存中..." : "保存"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-secondary" onClick={handleStartEdit}>
                    <Pencil size={16} />
                    修改
                  </button>
                )}
              </div>
            )
          }
        />

      <div className="flex flex-col gap-6">
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
        {saved && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            已成功保存参数配置。
          </div>
        )}

        <form id="settings-form" onSubmit={handleSubmit} className="grid gap-6">
        <div className="section-card">
          <div className="grid gap-5">
            {fieldGroups.map((group) => (
              <section
                key={group.title}
                className="grid gap-4 border-b border-line pb-5 last:border-0 last:pb-0"
              >
                <h2 className="text-base font-semibold text-ink">{group.title}</h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {group.fields.map((field) => (
                    <Field key={field.key} label={field.label}>
                      <TextInput
                        required
                        disabled={!canEdit || !isEditing}
                        min="0"
                        step={field.step}
                        type="number"
                        value={
                          field.key === "target_profit_rate" ||
                          field.key === "target_post_ad_profit_rate"
                            ? (settings[field.key] as number) * 100
                            : (settings[field.key] as string | number) ?? ""
                        }
                        onChange={(event) =>
                          updateSettings({
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
        </div>

        <div className="grid gap-6 xl:grid-cols-2 items-start">
          <LogisticsSection
            canEdit={canEdit && isEditing}
            type="first_leg"
            title="头程物流设置"
            description="用于计算从发货地到目的国或分拨仓的头程成本"
            methods={resolveFirstLegMethods(settings)}
            isAdding={addingFirstLeg}
            newName={newFirstLegName}
            newFormula={newFirstLegFormula}
            newParams={newFirstLegParams}
            onStartAdd={() => setAddingFirstLeg(true)}
            onCancelAdd={resetFirstLegAddForm}
            onNewNameChange={setNewFirstLegName}
            onNewFormulaChange={(formula) => {
              setNewFirstLegFormula(formula);
              setNewFirstLegParams(getDefaultParamsForFormula(formula));
            }}
            onNewParamsChange={setNewFirstLegParams}
            onAdd={handleAddFirstLeg}
            onUpdate={handleUpdateFirstLeg}
            onDelete={handleDeleteFirstLeg}
          />

          <LogisticsSection
            canEdit={canEdit && isEditing}
            type="last_leg"
            title="尾程物流设置"
            description="用于计算派送给买家的最后一公里成本"
            methods={resolveLastLegMethods(settings)}
            isAdding={addingLastLeg}
            newName={newLastLegName}
            newFormula={newLastLegFormula}
            newParams={newLastLegParams}
            onStartAdd={() => setAddingLastLeg(true)}
            onCancelAdd={resetLastLegAddForm}
            onNewNameChange={setNewLastLegName}
            onNewFormulaChange={(formula) => {
              setNewLastLegFormula(formula);
              setNewLastLegParams(getDefaultParamsForFormula(formula));
            }}
            onNewParamsChange={setNewLastLegParams}
            onAdd={handleAddLastLeg}
            onUpdate={handleUpdateLastLeg}
            onDelete={handleDeleteLastLeg}
          />
        </div>

        </form>
      </div>
    </section>
  );
}
