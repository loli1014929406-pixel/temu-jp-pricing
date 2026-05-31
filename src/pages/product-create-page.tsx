import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { ProductForm } from "../components/product-form";
import { BackToParentAction } from "../components/ui";
import {
  clearDraft,
  readDraft,
  useDraftPersistence,
} from "../hooks/use-draft-persistence";
import {
  createEmptyItem,
  createEmptySku,
  createEmptySpec,
  emptyProductDraft,
} from "../lib/defaults";
import { createProduct } from "../lib/products";
import type { ProductDraft, ProductItem, ProductSkuDraft, ProductSpec } from "../types";
import { getErrorMessage } from "../utils/errors";

type ProductCreatePageProps = {
  user: User;
};

type ProductCreateDraft = {
  product: ProductDraft;
  items: ProductItem[];
  specs: ProductSpec[];
  skus: ProductSkuDraft[];
};

function createInitialProductDraft(): ProductCreateDraft {
  return {
    product: emptyProductDraft,
    items: [createEmptyItem()],
    specs: [createEmptySpec()],
    skus: [createEmptySku()],
  };
}

function isProductCreateDraftEmpty(draft: ProductCreateDraft) {
  const productIsEmpty = Object.values(draft.product).every((value) => {
    if (typeof value === "number") return value === 0;
    return !String(value ?? "").trim();
  });
  const itemsAreEmpty =
    draft.items.length === 0 ||
    draft.items.every((item) =>
      !item.item_name.trim() &&
      !item.item_spec.trim() &&
      !item.purchase_url.trim() &&
      item.quantity === 1 &&
      item.item_length_cm === 0 &&
      item.item_width_cm === 0 &&
      item.item_height_cm === 0 &&
      item.item_weight_g === 0 &&
      item.purchase_price_rmb === 0 &&
      item.purchase_shipping_fee_per_500g_rmb === 0,
    );
  const specsAreEmpty =
    draft.specs.length === 0 ||
    draft.specs.every((spec) => !spec.name.trim() && spec.values.every((value) => !value.trim()));
  const skusAreEmpty =
    draft.skus.length === 0 ||
    draft.skus.every(
      (sku) =>
        !sku.sku_code.trim() &&
        !sku.temu_image_url.trim() &&
        !sku.notes.trim() &&
        Object.keys(sku.attributes).length === 0 &&
        sku.component_links.length === 0,
    );

  return productIsEmpty && itemsAreEmpty && specsAreEmpty && skusAreEmpty;
}

export function ProductCreatePage({ user }: ProductCreatePageProps) {
  const navigate = useNavigate();
  const draftKey = `product-create-draft:v1:${user.id}`;
  const restoredDraftRef = useRef(
    (() => {
      const draft = readDraft<ProductCreateDraft>(draftKey);
      return draft && !isProductCreateDraftEmpty(draft) ? draft : null;
    })(),
  );
  const restoredDraft = restoredDraftRef.current;
  const [product, setProduct] = useState<ProductDraft>(
    restoredDraft?.product ?? emptyProductDraft,
  );
  const [items, setItems] = useState<ProductItem[]>(
    restoredDraft?.items ?? [createEmptyItem()],
  );
  const [specs, setSpecs] = useState<ProductSpec[]>(
    restoredDraft?.specs ?? [createEmptySpec()],
  );
  const [skus, setSkus] = useState<ProductSkuDraft[]>(
    restoredDraft?.skus ?? [createEmptySku()],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(
    restoredDraft ? "已恢复上次未保存的新商品草稿。" : "",
  );

  useDraftPersistence(
    draftKey,
    {
      product,
      items,
      specs,
      skus,
    },
    { enabled: Boolean(user.id), shouldPersist: (draft) => !isProductCreateDraftEmpty(draft) },
  );

  function resetDraft() {
    const nextDraft = createInitialProductDraft();
    setProduct(nextDraft.product);
    setItems(nextDraft.items);
    setSpecs(nextDraft.specs);
    setSkus(nextDraft.skus);
    clearDraft(draftKey);
    setDraftNotice("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) {
      setMessage("当前登录已失效，请重新登录");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      await createProduct(product, items, skus);
      clearDraft(draftKey);
      navigate("/products", { state: { message: "保存成功" } });
    } catch (error) {
      setMessage(getErrorMessage(error, "保存商品失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">新增商品</h1>
        <BackToParentAction fallbackTo="/products" />
      </div>
      {message && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {message}
        </div>
      )}
      {draftNotice && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          <span>{draftNotice}</span>
          <button type="button" onClick={resetDraft} className="text-sm font-semibold text-sky-800">
            清除草稿
          </button>
        </div>
      )}
      <ProductForm
        product={product}
        items={items}
        specs={specs}
        skus={skus}
        busy={busy}
        submitLabel="保存商品"
        onProductChange={setProduct}
        onItemsChange={setItems}
        onSpecsChange={setSpecs}
        onSkusChange={setSkus}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
