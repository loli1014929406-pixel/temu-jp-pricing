const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'pages', 'settings-page.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

const oldFormula = `const formulaOptionsByType: Record<LogisticsMethodConfig["type"], FormulaOption[]> = {
  first_leg: [
    { value: "sf", label: "首重续重", currency: "RMB", unit: "kg" },
    { value: "flat_rmb", label: "按公斤计费", currency: "RMB", unit: "kg" },
    { value: "flat_rmb_tariff", label: "按公斤计费 + 关税", currency: "RMB", unit: "kg" },
    { value: "fixed_rmb", label: "固定运费", currency: "RMB", unit: "单票" },
  ],
  last_leg: [
    { value: "flat_jpy", label: "固定运费", currency: "JPY", unit: "单票" },
    { value: "fixed_rmb", label: "固定运费", currency: "RMB", unit: "单票" },
    { value: "ocs_3cm", label: "首重续重", currency: "RMB", unit: "100g" },
    { value: "ocs_small", label: "首重续重", currency: "RMB", unit: "500g" },
  ],
};`;

const newFormula = `const formulaOptionsByType: Record<LogisticsMethodConfig["type"], FormulaOption[]> = {
  first_leg: [
    { value: "sf", label: "首重续重 (kg)", currency: "RMB", unit: "kg" },
    { value: "flat_rmb", label: "按公斤计费 (RMB)", currency: "RMB", unit: "kg" },
    { value: "flat_rmb_tariff", label: "按公斤计费 + 关税", currency: "RMB", unit: "kg" },
    { value: "fixed_rmb", label: "固定运费 (RMB)", currency: "RMB", unit: "单票" },
    { value: "custom_weight", label: "自定义首重续重", currency: "RMB", unit: "自定义" },
    { value: "custom_flat", label: "自定义固定运费", currency: "RMB", unit: "自定义" },
  ],
  last_leg: [
    { value: "flat_jpy", label: "固定运费 (JPY)", currency: "JPY", unit: "单票" },
    { value: "fixed_rmb", label: "固定运费 (RMB)", currency: "RMB", unit: "单票" },
    { value: "ocs_3cm", label: "首重续重 (100g计费)", currency: "RMB", unit: "100g" },
    { value: "ocs_small", label: "首重续重 (500g计费)", currency: "RMB", unit: "500g" },
    { value: "custom_weight", label: "自定义首重续重", currency: "RMB", unit: "自定义" },
    { value: "custom_flat", label: "自定义固定运费", currency: "RMB", unit: "自定义" },
  ],
};`;
content = content.replace(oldFormula, newFormula);

const oldDefault = `    case "ocs_small":
      return { firstPrice: 36.5, extraPrice: 6 };
    default:
      return { price: 0 };`;

const newDefault = `    case "ocs_small":
      return { firstPrice: 36.5, extraPrice: 6 };
    case "custom_weight":
      return { firstPrice: 0, extraPrice: 0, customCurrency: "RMB", customUnitWeightG: 1000 };
    case "custom_flat":
      return { price: 0, customCurrency: "RMB" };
    default:
      return { price: 0 };`;
content = content.replace(oldDefault, newDefault);

const oldFields = `    case "ocs_small":
      return [
        { key: "firstPrice", label: "首重价格 (RMB)", step: "0.01" },
        { key: "extraPrice", label: "续重价格 (RMB/500g)", step: "0.01" },
      ];
    default:
      return [];`;

const newFields = `    case "ocs_small":
      return [
        { key: "firstPrice", label: "首重价格 (RMB)", step: "0.01" },
        { key: "extraPrice", label: "续重价格 (RMB/500g)", step: "0.01" },
      ];
    case "custom_weight":
      return [
        { key: "firstPrice", label: "首重价格", step: "0.01" },
        { key: "extraPrice", label: "续重价格", step: "0.01" },
      ];
    case "custom_flat":
      return [{ key: "price", label: "固定价格", step: "0.01" }];
    default:
      return [];`;
content = content.replace(oldFields, newFields);

content = content.replace('<div className="grid gap-6 xl:grid-cols-2">', '<div className="grid gap-6 xl:grid-cols-2 items-start">');

const oldParamInputs = `function ParameterInputs({ formula, params, disabled, onChange }: ParameterInputsProps) {
  return (
    <>
      {getParameterFields(formula).map((field) => (
        <label key={field.key} className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">{field.label}</span>
          <input
            type="number"
            required
            disabled={disabled}
            step={field.step}
            className={inputClassName}`;

const newParamInputs = `function ParameterInputs({ formula, params, disabled, onChange }: ParameterInputsProps) {
  return (
    <>
      {getParameterFields(formula).map((field) => (
        <label key={field.key} className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">{field.label}</span>
          <input
            type="number"
            required
            disabled={disabled}
            step={field.step}
            className={\`\${inputClassName} bg-cyan-50 border-cyan-300 text-cyan-900 placeholder:text-cyan-400 focus:border-cyan-500 focus:ring-cyan-500/20\`}`;
content = content.replace(oldParamInputs, newParamInputs);

const oldCardLayout = `      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">运费方式</span>
          <select
            disabled={!canEdit}
            className={selectClassName}
            value={method.formula}
            onChange={(event) => {
              const formula = event.target.value as LogisticsMethodConfig["formula"];
              onUpdate(method.id, {
                formula,
                params: getDefaultParamsForFormula(formula),
              });
            }}
          >
            {formulaOptionsByType[method.type].map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <ReadonlyInfoField label="货币单位" value={option.currency} />
        <ReadonlyInfoField label="计费单位" value={option.unit} />
        <ParameterInputs
          formula={method.formula}
          params={method.params}
          disabled={!canEdit}
          onChange={(params) => onUpdate(method.id, { params })}
        />
      </div>`;

const newCardLayout = `      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ParameterInputs
          formula={method.formula}
          params={method.params}
          disabled={!canEdit}
          onChange={(params) => onUpdate(method.id, { params })}
        />
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">运费方式</span>
          <select
            disabled={!canEdit}
            className={selectClassName}
            value={method.formula}
            onChange={(event) => {
              const formula = event.target.value as LogisticsMethodConfig["formula"];
              onUpdate(method.id, {
                formula,
                params: getDefaultParamsForFormula(formula),
              });
            }}
          >
            {formulaOptionsByType[method.type].map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {method.formula === "custom_weight" || method.formula === "custom_flat" ? (
          <>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-semibold">货币单位</span>
              <select
                disabled={!canEdit}
                className={selectClassName}
                value={method.params.customCurrency || "RMB"}
                onChange={(e) =>
                  onUpdate(method.id, { params: { ...method.params, customCurrency: e.target.value as "RMB" | "JPY" } })
                }
              >
                <option value="RMB">RMB</option>
                <option value="JPY">JPY</option>
              </select>
            </label>
            {method.formula === "custom_weight" ? (
              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-semibold">计费单位(克)</span>
                <input
                  type="number"
                  disabled={!canEdit}
                  required
                  min="1"
                  step="1"
                  className={inputClassName}
                  value={method.params.customUnitWeightG || ""}
                  onChange={(e) =>
                    onUpdate(method.id, { params: { ...method.params, customUnitWeightG: Number(e.target.value) || 1000 } })
                  }
                />
              </label>
            ) : (
              <ReadonlyInfoField label="计费单位" value="单票" />
            )}
          </>
        ) : (
          <>
            <ReadonlyInfoField label="货币单位" value={option.currency} />
            <ReadonlyInfoField label="计费单位" value={option.unit} />
          </>
        )}
      </div>`;
content = content.replace(oldCardLayout, newCardLayout);

const oldPanelLayout = `      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">名称</span>
          <input
            type="text"
            className={inputClassName}
            placeholder={type === "first_leg" ? "如: OCS Air" : "如: JP Post"}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">运费方式</span>
          <select
            className={selectClassName}
            value={formula}
            onChange={(event) => {
              const nextFormula = event.target.value as LogisticsMethodConfig["formula"];
              onFormulaChange(nextFormula);
            }}
          >
            {formulaOptionsByType[type].map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <ReadonlyInfoField label="货币单位" value={option.currency} />
        <ReadonlyInfoField label="计费单位" value={option.unit} />
        <ParameterInputs
          formula={formula}
          params={params}
          disabled={false}
          onChange={onParamsChange}
        />
      </div>`;

const newPanelLayout = `      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ParameterInputs
          formula={formula}
          params={params}
          disabled={false}
          onChange={onParamsChange}
        />
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">名称</span>
          <input
            type="text"
            className={inputClassName}
            placeholder={type === "first_leg" ? "如: OCS Air" : "如: JP Post"}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-semibold">运费方式</span>
          <select
            className={selectClassName}
            value={formula}
            onChange={(event) => {
              const nextFormula = event.target.value as LogisticsMethodConfig["formula"];
              onFormulaChange(nextFormula);
            }}
          >
            {formulaOptionsByType[type].map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {formula === "custom_weight" || formula === "custom_flat" ? (
          <>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-semibold">货币单位</span>
              <select
                className={selectClassName}
                value={params.customCurrency || "RMB"}
                onChange={(e) =>
                  onParamsChange({ ...params, customCurrency: e.target.value as "RMB" | "JPY" })
                }
              >
                <option value="RMB">RMB</option>
                <option value="JPY">JPY</option>
              </select>
            </label>
            {formula === "custom_weight" ? (
              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-semibold">计费单位(克)</span>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  className={inputClassName}
                  value={params.customUnitWeightG || ""}
                  onChange={(e) =>
                    onParamsChange({ ...params, customUnitWeightG: Number(e.target.value) || 1000 })
                  }
                />
              </label>
            ) : (
              <ReadonlyInfoField label="计费单位" value="单票" />
            )}
          </>
        ) : (
          <>
            <ReadonlyInfoField label="货币单位" value={option.currency} />
            <ReadonlyInfoField label="计费单位" value={option.unit} />
          </>
        )}
      </div>`;
content = content.replace(oldPanelLayout, newPanelLayout);

fs.writeFileSync(filePath, content, 'utf-8');
console.log('done!');
