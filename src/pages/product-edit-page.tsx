import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProductForm } from "../components/product-form";
import { BackToParentAction } from "../components/ui";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
  updateProduct,
} from "../lib/products";
import { createEmptyItem, createEmptySku, createEmptySpec } from "../lib/defaults";
import type {
  ProductDraft,
  ProductItem,
  ProductSkuDraft,
  ProductSpec,
} from "../types";
import { getErrorMessage } from "../utils/errors";
import { buildDefaultSkuCode, isLegacyDefaultSkuCode } from "../utils/sku-code";

type ProductEditDraftCache = {
  productId: string;
  product: ProductDraft;
  items: ProductItem[];
  specs: ProductSpec[];
  skus: ProductSkuDraft[];
};

const productEditDraftVersion = 1;

function getProductEditDraftKey(productKey: string) {
  return `product-edit-draft:${productEditDraftVersion}:${productKey}`;
}

function readProductEditDraft(productKey: string): Partial<ProductEditDraftCache> | null {
  if (typeof window === "undefined" || !productKey) return null;

  try {
    const rawValue = window.sessionStorage.getItem(getProductEditDraftKey(productKey));
    if (!rawValue) return null;
    const parsed = JSON.parse(rawValue) as Partial<ProductEditDraftCache>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeProductEditDraft(productKey: string, draft: ProductEditDraftCache) {
  if (typeof window === "undefined" || !productKey) return;

  try {
    window.sessionStorage.setItem(getProductEditDraftKey(productKey), JSON.stringify(draft));
  } catch {
    // Ignore storage quota/private-mode failures; the in-memory form state still works.
  }
}

function clearProductEditDraft(productKey: string) {
  if (typeof window === "undefined" || !productKey) return;
  window.sessionStorage.removeItem(getProductEditDraftKey(productKey));
}

function normalizeDraftSkus(skus: ProductSkuDraft[]) {
  return skus.map((sku) => ({
    ...sku,
    temu_image_url: String(sku.temu_image_url ?? ""),
    component_links: Array.isArray(sku.component_links) ? sku.component_links : [],
  }));
}

function mergeCachedDraft(
  baseDraft: ProductEditDraftCache,
  cachedDraft: Partial<ProductEditDraftCache> | null,
): ProductEditDraftCache {
  if (!cachedDraft || cachedDraft.productId !== baseDraft.productId) return baseDraft;

  return {
    productId: baseDraft.productId,
    product: cachedDraft.product
      ? { ...baseDraft.product, ...cachedDraft.product }
      : baseDraft.product,
    items: Array.isArray(cachedDraft.items) ? cachedDraft.items : baseDraft.items,
    specs: Array.isArray(cachedDraft.specs) ? cachedDraft.specs : baseDraft.specs,
    skus: Array.isArray(cachedDraft.skus)
      ? normalizeDraftSkus(cachedDraft.skus)
      : baseDraft.skus,
  };
}

export function ProductEditPage() {
  const { productId: productKey = "" } = useParams();
  const navigate = useNavigate();
  const [productId, setProductId] = useState("");
  const [product, setProduct] = useState<ProductDraft | null>(null);
  const [items, setItems] = useState<ProductItem[]>([]);
  const [specs, setSpecs] = useState<ProductSpec[]>([createEmptySpec()]);
  const [skus, setSkus] = useState<ProductSkuDraft[]>([]);
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoadingError("");

      try {
        const nextProduct = await fetchProduct(productKey);

        const [nextItems, nextSkus] = await Promise.all([
          fetchProductItems(nextProduct.id),
          fetchProductSkus(nextProduct.id),
        ]);
        const {
          id,
          owner_id,
          created_at,
          updated_at,
          ...draft
        } = nextProduct;
        void id;
        void owner_id;
        void created_at;
        void updated_at;
        const serverDraft: ProductEditDraftCache = {
          productId: nextProduct.id,
          product: draft,
          items: nextItems.length > 0 ? nextItems : [createEmptyItem()],
          specs: [createEmptySpec()],
          skus:
            nextSkus.length > 0
              ? nextSkus.map((sku, skuIndex) => ({
                  ...sku,
                  temu_image_url: String(sku.temu_image_url ?? ""),
                  sku_code: isLegacyDefaultSkuCode(sku.sku_code)
                    ? buildDefaultSkuCode(nextProduct.product_code, skuIndex)
                    : sku.sku_code,
                  component_links: sku.component_links.map((link) => ({
                    ...link,
                    item_key: link.item_id,
                  })),
                }))
              : [createEmptySku()],
        };
        const nextDraft = mergeCachedDraft(serverDraft, readProductEditDraft(productKey));
        if (!active) return;
        setProductId(nextDraft.productId);
        setProduct(nextDraft.product);
        setItems(nextDraft.items);
        setSpecs(nextDraft.specs);
        setSkus(nextDraft.skus);
      } catch (error) {
        if (active) setLoadingError(getErrorMessage(error, "加载商品失败"));
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [productKey]);

  useEffect(() => {
    if (!product || !productId) return;
    writeProductEditDraft(productKey, {
      productId,
      product,
      items,
      specs,
      skus,
    });
  }, [items, product, productId, productKey, skus, specs]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!product || !productId) return;
    setBusy(true);
    setMessage("");

    try {
      await updateProduct(productId, product, items, skus);
      clearProductEditDraft(productKey);
      navigate("/products");
    } catch (error) {
      setMessage(getErrorMessage(error, "更新商品失败"));
    } finally {
      setBusy(false);
    }
  }

  if (loadingError) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        {loadingError}
      </div>
    );
  }

  if (!product) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">编辑商品</h1>
        <BackToParentAction fallbackTo="/products" />
      </div>
      {message && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {message}
        </div>
      )}
      <ProductForm
        product={product}
        items={items}
        specs={specs}
        skus={skus}
        busy={busy}
        submitLabel="保存编辑"
        onProductChange={setProduct}
        onItemsChange={setItems}
        onSpecsChange={setSpecs}
        onSkusChange={setSkus}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
