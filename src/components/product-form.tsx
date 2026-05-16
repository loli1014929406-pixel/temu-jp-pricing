import { Plus, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { Field, TextArea, TextInput } from "./form-controls";
import type { ProductDraft, ProductItem } from "../types";
import { createEmptyItem } from "../lib/defaults";

type ProductFormProps = {
  product: ProductDraft;
  items: ProductItem[];
  submitLabel: string;
  busy?: boolean;
  onProductChange: (next: ProductDraft) => void;
  onItemsChange: (next: ProductItem[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function toNumber(value: string) {
  return Number(value || 0);
}

export function ProductForm({
  product,
  items,
  submitLabel,
  busy = false,
  onProductChange,
  onItemsChange,
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

  return (
    <form onSubmit={onSubmit} className="grid gap-6">
      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-panel">
        <div>
          <h2 className="text-base font-semibold text-ink">商品主信息</h2>
        </div>
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
          <Field label="商品组合">
            <TextInput
              required
              value={product.combo_name}
              onChange={(event) => updateProduct("combo_name", event.target.value)}
            />
          </Field>
          <Field label="商品日语标题">
            <TextInput
              required
              value={product.title_jp}
              onChange={(event) => updateProduct("title_jp", event.target.value)}
            />
          </Field>
        </div>
        <Field label="组合内容">
          <TextArea
            required
            value={product.combo_description}
            onChange={(event) =>
              updateProduct("combo_description", event.target.value)
            }
          />
        </Field>
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
          <h2 className="text-base font-semibold text-ink">组合明细</h2>
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
            <div key={`${item.id ?? "new"}-${index}`} className="grid gap-4 rounded-md border border-line p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-700">配件 {index + 1}</p>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      onItemsChange(items.filter((_, itemIndex) => itemIndex !== index))
                    }
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                    aria-label={`删除配件 ${index + 1}`}
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="配件名称">
                  <TextInput
                    required
                    value={item.item_name}
                    onChange={(event) =>
                      updateItem(index, "item_name", event.target.value)
                    }
                  />
                </Field>
                <Field label="数量">
                  <TextInput
                    required
                    min="1"
                    step="1"
                    type="number"
                    value={item.quantity}
                    onChange={(event) =>
                      updateItem(index, "quantity", toNumber(event.target.value))
                    }
                  />
                </Field>
                <Field label="长 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_length_cm}
                    onChange={(event) =>
                      updateItem(index, "item_length_cm", toNumber(event.target.value))
                    }
                  />
                </Field>
                <Field label="宽 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_width_cm}
                    onChange={(event) =>
                      updateItem(index, "item_width_cm", toNumber(event.target.value))
                    }
                  />
                </Field>
                <Field label="高 cm">
                  <TextInput
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_height_cm}
                    onChange={(event) =>
                      updateItem(index, "item_height_cm", toNumber(event.target.value))
                    }
                  />
                </Field>
                <Field label="重量 g">
                  <TextInput
                    required
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.item_weight_g}
                    onChange={(event) =>
                      updateItem(index, "item_weight_g", toNumber(event.target.value))
                    }
                  />
                </Field>
                <Field label="单个采购价格">
                  <TextInput
                    required
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchase_price_rmb}
                    onChange={(event) =>
                      updateItem(index, "purchase_price_rmb", toNumber(event.target.value))
                    }
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
                  onChange={(event) =>
                    updateItem(index, "purchase_url", event.target.value)
                  }
                />
              </Field>
            </div>
          ))}
        </div>
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
