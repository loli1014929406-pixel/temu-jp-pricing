const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'pages', 'settings-page.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

// Add custom_weight and custom_flat logic to first_leg_methods
const firstLegInsertion = `
                    {method.formula === "custom_weight" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          货币单位
                          <select
                            disabled={!canEdit}
                            className="text-input text-xs"
                            value={method.params.customCurrency || "RMB"}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, customCurrency: e.target.value },
                              })
                            }
                          >
                            <option value="RMB">RMB</option>
                            <option value="JPY">JPY</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          计费单位 (克)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="1"
                            className="text-input text-xs"
                            value={method.params.customUnitWeightG || ""}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, customUnitWeightG: Number(e.target.value || 1000) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          首重价格
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
                        <label className="flex flex-col gap-1 text-slate-500">
                          续重价格
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

                    {method.formula === "custom_flat" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          货币单位
                          <select
                            disabled={!canEdit}
                            className="text-input text-xs"
                            value={method.params.customCurrency || "RMB"}
                            onChange={(e) =>
                              handleUpdateFirstLeg(method.id, {
                                params: { ...method.params, customCurrency: e.target.value },
                              })
                            }
                          >
                            <option value="RMB">RMB</option>
                            <option value="JPY">JPY</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          固定价格
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
                      </>
                    )}
`;
content = content.replace('{method.formula === "flat_rmb_tariff" && (', firstLegInsertion + '{method.formula === "flat_rmb_tariff" && (');

// Add custom_weight and custom_flat logic to last_leg_methods
const lastLegInsertion = `
                    {method.formula === "custom_weight" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          货币单位
                          <select
                            disabled={!canEdit}
                            className="text-input text-xs"
                            value={method.params.customCurrency || "RMB"}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, customCurrency: e.target.value },
                              })
                            }
                          >
                            <option value="RMB">RMB</option>
                            <option value="JPY">JPY</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          计费单位 (克)
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="1"
                            className="text-input text-xs"
                            value={method.params.customUnitWeightG || ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, customUnitWeightG: Number(e.target.value || 1000) },
                              })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          首重价格
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
                          续重价格
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

                    {method.formula === "custom_flat" && (
                      <>
                        <label className="flex flex-col gap-1 text-slate-500">
                          货币单位
                          <select
                            disabled={!canEdit}
                            className="text-input text-xs"
                            value={method.params.customCurrency || "RMB"}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, customCurrency: e.target.value },
                              })
                            }
                          >
                            <option value="RMB">RMB</option>
                            <option value="JPY">JPY</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-slate-500">
                          固定价格
                          <input
                            type="number"
                            required
                            disabled={!canEdit}
                            step="0.01"
                            className="text-input text-xs"
                            value={method.params.price ?? ""}
                            onChange={(e) =>
                              handleUpdateLastLeg(method.id, {
                                params: { ...method.params, price: Number(e.target.value || 0) },
                              })
                            }
                          />
                        </label>
                      </>
                    )}
`;
content = content.replace('{method.formula === "ocs_small" && (', lastLegInsertion + '{method.formula === "ocs_small" && (');

// Update the Select dropdowns for "addingFirstLeg" and "addingLastLeg"
content = content.replace(
  '<option value="sf">首重续重制 (RMB)</option>',
  '<option value="sf">首重续重制 (RMB)</option>\n                      <option value="custom_weight">自定义首重续重</option>\n                      <option value="custom_flat">自定义固定运费</option>'
);

content = content.replace(
  '<option value="ocs_small">OCS 小包制 (RMB)</option>',
  '<option value="ocs_small">OCS 小包制 (RMB)</option>\n                      <option value="custom_weight">自定义首重续重</option>\n                      <option value="custom_flat">自定义固定运费</option>'
);

fs.writeFileSync(filePath, content, 'utf-8');
console.log('Script completed successfully.');
