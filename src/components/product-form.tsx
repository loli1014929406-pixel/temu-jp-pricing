import { Copy, Plus, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { createEmptyItem, createEmptySpec } from "../lib/defaults";
import type {
  ProductDraft,
  ProductItem,
  ProductSkuDraft,
  ProductSpec,
} from "../types";
import { buildDefaultSkuCode } from "../utils/sku-code";
import { Field, TextArea, TextInput } from "./form-controls";

type ProductFormProps = {
  product: ProductDraft;
  items: ProductItem[];
  specs: ProductSpec[];
  skus: ProductSkuDraft[];
  submitLabel: string;
  busy?: boolean;
  onProductChange: (next: ProductDraft) => void;
  onItemsChange: (next: ProductItem[]) => void;
  onSpecsChange: (next: ProductSpec[]) => void;
  onSkusChange: (next: ProductSkuDraft[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function toNumber(value: string) {
  return Number(value || 0);
}

function getItemKey(item: ProductItem, index: number) {
  return item.id ?? `new-${index}`;
}

function buildSkuMatrix(specs: ProductSpec[]) {
  const groupedSpecs = specs.reduce<Record<string, string[]>>((groups, spec) => {
    const name = spec.name.trim();
    const values = spec.values.map((value) => value.trim()).filter(Boolean);
    if (!name || values.length === 0) return groups;

    groups[name] ??= [];
    groups[name].push(...values);
    return groups;
  }, {});

  const normalizedSpecs = Object.entries(groupedSpecs).map(([name, values]) => ({
    name,
    values: Array.from(new Set(values)),
  }));

  if (normalizedSpecs.length === 0) {
    return [{}] as Array<Record<string, string>>;
  }

  return normalizedSpecs.reduce<Array<Record<string, string>>>(
    (rows, spec) =>
      rows.flatMap((row) =>
        spec.values.map((value) => ({
          ...row,
          [spec.name]: value,
        })),
      ),
    [{}],
  );
}

export function ProductForm({
  product,
  items,
  specs,
  skus,
  submitLabel,
  busy = false,
  onProductChange,
  onItemsChange,
  onSpecsChange,
  onSkusChange,
  onSubmit,
}: ProductFormProps) {
  const updateProduct = <K extends keyof ProductDraft>(
    key: K,
    value: ProductDraft[K],
  ) => onProductChange({ ...product, [key]: value });

  const updateItem = <K extends keyof ProductItem>(
    index: number,
    key: K,
    value: ProductItem[K],
  ) =>
    onItemsChange(
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    );

  const duplicateItem = (index: number) => {
    const { id, product_id, owner_id, ...item } = items[index];
    void id;
    void product_id;
    void owner_id;
    onItemsChange([...items.slice(0, index + 1), { ...item }, ...items.slice(index + 1)]);
  };

  const removeItem = (index: number) => {
    const confirmed = window.confirm(`确认删除配件 ${index + 1} 吗？`);
    if (!confirmed) return;
    onItemsChange(items.filter((_, itemIndex) => itemIndex !== index));
  };

  const updateSpec = <K extends keyof ProductSpec>(
    index: number,
    key: K,
    value: ProductSpec[K],
  ) =>
    onSpecsChange(
      specs.map((spec, specIndex) =>
        specIndex === index ? { ...spec, [key]: value } : spec,
      ),
    );

  const updateSpecValue = (
    specIndex: number,
    valueIndex: number,
    value: string,
  ) =>
    onSpecsChange(
      specs.map((spec, currentSpecIndex) =>
        currentSpecIndex === specIndex
          ? {
              ...spec,
              values: spec.values.map((currentValue, currentValueIndex) =>
                currentValueIndex === valueIndex ? value : currentValue,
              ),
            }
          : spec,
      ),
    );

  const addSpecValue = (specIndex: number) =>
    onSpecsChange(
      specs.map((spec, currentSpecIndex) =>
        currentSpecIndex === specIndex
          ? { ...spec, values: [...spec.values, ""] }
          : spec,
      ),
    );

  const removeSpec = (index: number) => {
    const confirmed = window.confirm(`确认删除规格 ${index + 1} 吗？`);
    if (!confirmed) return;
    onSpecsChange(specs.filter((_, specIndex) => specIndex !== index));
  };

  const removeSpecValue = (specIndex: number, valueIndex: number) => {
    const confirmed = window.confirm(`确认删除规格 ${specIndex + 1} 的值 ${valueIndex + 1} 吗？`);
    if (!confirmed) return;
    onSpecsChange(
      specs.map((spec, currentSpecIndex) =>
        currentSpecIndex === specIndex
          ? {
              ...spec,
              values:
                spec.values.length > 1
                  ? spec.values.filter((_, currentValueIndex) => currentValueIndex !== valueIndex)
                  : spec.values,
            }
          : spec,
      ),
    );
  };

  const updateSku = <K extends keyof ProductSkuDraft>(
    index: number,
    key: K,
    value: ProductSkuDraft[K],
  ) =>
    onSkusChange(
      skus.map((sku, skuIndex) =>
        skuIndex === index ? { ...sku, [key]: value } : sku,
      ),
    );

  const updateSkuItemLink = (
    skuIndex: number,
    itemKey: string,
    checked: boolean,
  ) =>
    onSkusChange(
      skus.map((sku, currentSkuIndex) => {
        if (currentSkuIndex !== skuIndex) return sku;

        const existing = sku.component_links.find((link) => link.item_key === itemKey);
        if (checked && !existing) {
          return {
            ...sku,
            component_links: [
              ...sku.component_links,
              { item_key: itemKey, quantity: 1 },
            ],
          };
        }

        if (!checked && existing) {
          return {
            ...sku,
            component_links: sku.component_links.filter(
              (link) => link.item_key !== itemKey,
            ),
          };
        }

        return sku;
      }),
    );

  const updateSkuItemQuantity = (
    skuIndex: number,
    itemKey: string,
    quantity: number,
  ) =>
    onSkusChange(
      skus.map((sku, currentSkuIndex) =>
        currentSkuIndex === skuIndex
          ? {
              ...sku,
              component_links: sku.component_links.map((link) =>
                link.item_key === itemKey ? { ...link, quantity } : link,
              ),
            }
          : sku,
      ),
    );

  const generateSkuMatrix = () => {
    const matrix = buildSkuMatrix(specs);
    onSkusChange(
      matrix.map((attributes, index) => ({
        sku_code: buildDefaultSkuCode(product.product_code, index),
        temu_image_url: "",
        attributes,
        notes: "",
        component_links: items.map((item, index) => ({
          item_key: getItemKey(item, index),
          quantity: item.quantity,
        })),
      })),
    );
  };

  const getSkuMetrics = (sku: ProductSkuDraft) =>
    sku.component_links.reduce(
      (totals, link) => {
        const item = items.find(
          (candidate, itemIndex) => getItemKey(candidate, itemIndex) === link.item_key,
        );
        if (!item) return totals;

        return {
          cost: totals.cost + item.purchase_price_rmb * link.quantity,
          weight: totals.weight + item.item_weight_g * link.quantity,
        };
      },
      { cost: 0, weight: 0 },
    );

  return (
    <form onSubmit={onSubmit} className="grid gap-6">
      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <h2 className="text-base font-semibold text-ink">商品主信息</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="商品编号">
            <TextInput
              required
              value={product.product_code}
              onChange={(event) => updateProduct("product_code", event.target.value)}
            />
          </Field>
          <Field label="中文产品名称">
            <TextInput
              required
              value={product.product_name_cn}
              onChange={(event) =>
                updateProduct("product_name_cn", event.target.value)
              }
            />
          </Field>
          <Field label="英文品名">
            <TextInput
              required
              value={product.product_name_en}
              onChange={(event) =>
                updateProduct("product_name_en", event.target.value)
              }
            />
          </Field>
          <Field label="英文材质">
            <TextInput
              required
              value={product.material_en}
              onChange={(event) => updateProduct("material_en", event.target.value)}
            />
          </Field>
          <Field label="中文材质">
            <TextInput
              required
              value={product.material_cn}
              onChange={(event) => updateProduct("material_cn", event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={product.is_selling}
              onChange={(event) => updateProduct("is_selling", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            />
            售卖中
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="包装长 cm">
            <TextInput
              required
              min="0"
              step="0.01"
              type="number"
              value={product.package_length_cm}
              onChange={(event) =>
                updateProduct("package_length_cm", toNumber(event.target.value))
              }
            />
          </Field>
          <Field label="包装宽 cm">
            <TextInput
              required
              min="0"
              step="0.01"
              type="number"
              value={product.package_width_cm}
              onChange={(event) =>
                updateProduct("package_width_cm", toNumber(event.target.value))
              }
            />
          </Field>
          <Field label="包装高 cm">
            <TextInput
              required
              min="0"
              step="0.01"
              type="number"
              value={product.package_height_cm}
              onChange={(event) =>
                updateProduct("package_height_cm", toNumber(event.target.value))
              }
            />
          </Field>
          <Field label="包装重量 g">
            <TextInput
              required
              min="0"
              step="0.01"
              type="number"
              value={product.package_weight_g}
              onChange={(event) =>
                updateProduct("package_weight_g", toNumber(event.target.value))
              }
            />
          </Field>
          <Field label="3cm快递可发几个">
            <TextInput
              required
              min="1"
              step="1"
              type="number"
              value={product.max_units_per_parcel}
              onChange={(event) =>
                updateProduct("max_units_per_parcel", toNumber(event.target.value))
              }
            />
          </Field>
        </div>
        <Field label="备注">
          <TextArea
            value={product.notes ?? ""}
            onChange={(event) => updateProduct("notes", event.target.value)}
          />
        </Field>
      </section>

      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">组合配件库</h2>
          <button
            type="button"
            onClick={() => onItemsChange([...items, createEmptyItem()])}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm text-white"
          >
            <Plus size={18} />
            添加配件
          </button>
        </div>
        <div className="grid gap-4">
          {items.map((item, index) => (
            <div
              key={getItemKey(item, index)}
              className="grid gap-4 rounded-md border border-line p-4"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-700">配件 {index + 1}</p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => duplicateItem(index)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    aria-label={`复制配件 ${index + 1}`}
                    title="复制配件"
                  >
                    <Copy size={18} />
                  </button>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      aria-label={`删除配件 ${index + 1}`}
                      title="删除配件"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="配件名称">
                  <TextInput
                    required
                    value={item.item_name}
                    onChange={(event) => updateItem(index, "item_name", event.target.value)}
                  />
                </Field>
                <Field label="配件数量">
                  <TextInput
                    required
                    min="1"
                    step="1"
                    type="number"
                    value={item.quantity}
                    onChange={(event) => updateItem(index, "quantity", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="长 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_length_cm}
                    onChange={(event) => updateItem(index, "item_length_cm", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="宽 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_width_cm}
                    onChange={(event) => updateItem(index, "item_width_cm", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="高 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_height_cm}
                    onChange={(event) => updateItem(index, "item_height_cm", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="重量 g">
                  <TextInput
                    required
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_weight_g}
                    onChange={(event) => updateItem(index, "item_weight_g", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="单个采购价格">
                  <TextInput
                    required
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchase_price_rmb}
                    onChange={(event) => updateItem(index, "purchase_price_rmb", toNumber(event.target.value))}
                  />
                </Field>
                <Field label="采购运费/500g">
                  <TextInput
                    required
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchase_shipping_fee_per_500g_rmb}
                    onChange={(event) =>
                      updateItem(
                        index,
                        "purchase_shipping_fee_per_500g_rmb",
                        toNumber(event.target.value),
                      )
                    }
                  />
                </Field>
              </div>
              <Field label="采购链接">
                <TextInput
                  value={item.purchase_url}
                  onChange={(event) => updateItem(index, "purchase_url", event.target.value)}
                />
              </Field>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">销售规格生成矩阵</h2>
          <button
            type="button"
            onClick={() => onSpecsChange([...specs, createEmptySpec()])}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-slate-700"
          >
            <Plus size={18} />
            添加规格
          </button>
        </div>
        <div className="grid gap-4">
          {specs.map((spec, index) => (
            <div key={spec.id} className="grid gap-4 rounded-md border border-line p-4">
              <div className="flex items-end gap-3">
                <div className="min-w-64 flex-1">
                  <Field label="规格名">
                    <TextInput
                      placeholder="如：颜色"
                      value={spec.name}
                      onChange={(event) => updateSpec(index, "name", event.target.value)}
                    />
                  </Field>
                </div>
                {specs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSpec(index)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                    aria-label={`删除规格 ${index + 1}`}
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-700">规格值</p>
                  <button
                    type="button"
                    onClick={() => addSpecValue(index)}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-slate-700"
                  >
                    <Plus size={16} />
                    添加规格值
                  </button>
                </div>
                {spec.values.map((value, valueIndex) => (
                  <div key={`${spec.id}-${valueIndex}`} className="flex items-center gap-3">
                    <TextInput
                      placeholder="如：白色"
                      value={value}
                      onChange={(event) =>
                        updateSpecValue(index, valueIndex, event.target.value)
                      }
                    />
                    {spec.values.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeSpecValue(index, valueIndex)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                        aria-label={`删除规格 ${index + 1} 的值 ${valueIndex + 1}`}
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div>
          <button
            type="button"
            onClick={generateSkuMatrix}
            className="inline-flex h-11 items-center rounded-md bg-ink px-4 text-sm font-medium text-white"
          >
            生成 SKU 矩阵
          </button>
        </div>
      </section>

      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <h2 className="text-base font-semibold text-ink">最终 SKU 属性与 BOM 关联映射表</h2>
        {skus.length === 0 ? (
          <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-slate-500">
            请先生成 SKU 矩阵
          </div>
        ) : (
          <div className="grid gap-4">
            {skus.map((sku, skuIndex) => {
              const metrics = getSkuMetrics(sku);
              return (
                <section
                  key={sku.id ?? `sku-${skuIndex}`}
                  className="grid gap-4 rounded-md border border-line bg-slate-50/40 p-4"
                >
                  <div className="grid gap-4 lg:grid-cols-[220px_minmax(260px,1fr)_minmax(260px,1fr)_auto] lg:items-start">
                    <Field label="SKU编号">
                      <TextInput
                        required
                        value={sku.sku_code}
                        onChange={(event) =>
                          updateSku(skuIndex, "sku_code", event.target.value)
                        }
                      />
                    </Field>

                    <Field label="Temu图片链接">
                      <TextInput
                        type="url"
                        value={sku.temu_image_url}
                        onChange={(event) =>
                          updateSku(skuIndex, "temu_image_url", event.target.value)
                        }
                        placeholder="https://img.kwcdn.com/..."
                      />
                    </Field>

                    <div className="grid gap-2 text-sm text-slate-700">
                      <span className="font-medium">销售规格属性</span>
                      {Object.keys(sku.attributes).length === 0 ? (
                        <span className="text-slate-500">无规格</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(sku.attributes).map(([name, value]) => (
                            <span
                              key={name}
                              className="inline-flex rounded-md bg-white px-2.5 py-1 text-xs text-slate-700 ring-1 ring-line"
                            >
                              {name}：{value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <span className="text-sm font-medium text-slate-700">采购总成本</span>
                        <TextInput readOnly value={metrics.cost.toFixed(2)} />
                      </div>
                      <div className="grid gap-2">
                        <span className="text-sm font-medium text-slate-700">总重量</span>
                        <TextInput readOnly value={metrics.weight.toFixed(2)} />
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3">
                    <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3 px-1 text-xs font-medium text-slate-500">
                      <span>关联配件</span>
                      <span>配件数量</span>
                    </div>
                    <div className="grid gap-2">
                      {items.map((item, itemIndex) => {
                        const itemKey = getItemKey(item, itemIndex);
                        const link = sku.component_links.find(
                          (candidate) => candidate.item_key === itemKey,
                        );

                        return (
                          <div
                            key={itemKey}
                            className={`grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3 rounded-md border p-3 ${
                              link
                                ? "border-accent/30 bg-white"
                                : "border-line bg-white/70"
                            }`}
                          >
                            <label className="flex min-w-0 items-center gap-3">
                              <input
                                type="checkbox"
                                checked={Boolean(link)}
                                onChange={(event) =>
                                  updateSkuItemLink(skuIndex, itemKey, event.target.checked)
                                }
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-slate-700">
                                  {item.item_name || `配件 ${itemIndex + 1}`}
                                </span>
                                {item.item_spec && (
                                  <span className="block truncate text-xs text-slate-500">
                                    {item.item_spec}
                                  </span>
                                )}
                              </span>
                            </label>
                            {link ? (
                              <TextInput
                                min="1"
                                step="1"
                                type="number"
                                value={link.quantity}
                                onChange={(event) =>
                                  updateSkuItemQuantity(
                                    skuIndex,
                                    itemKey,
                                    toNumber(event.target.value),
                                  )
                                }
                              />
                            ) : (
                              <div className="h-11 rounded-md border border-dashed border-line bg-slate-50" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-11 items-center rounded-md bg-ink px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
