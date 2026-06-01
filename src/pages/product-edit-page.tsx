import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProductForm } from "../components/product-form";
import { BackToParentAction } from "../components/ui";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
  updateProduct,
} from "../lib/products";
import {
  createEmptyItem,
  createEmptySku,
  createEmptySpec,
  emptyProductDraft,
} from "../lib/defaults";
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
  savedAt?: string;
};

const productEditDraftVersion = 2;
const legacyProductEditDraftVersion = 1;

function getProductEditDraftKey(productKey: string, version = productEditDraftVersion) {
  return `product-edit-draft:${version}:${productKey}`;
}

function getBrowserStorage(storageName: "localStorage" | "sessionStorage") {
  try {
    return typeof window === "undefined" ? null : window[storageName];
  } catch {
    return null;
  }
}

function parseProductEditDraft(rawValue: string | null) {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as Partial<ProductEditDraftCache>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readProductEditDraft(productKey: string): Partial<ProductEditDraftCache> | null {
  if (typeof window === "undefined" || !productKey) return null;

  const localStorage = getBrowserStorage("localStorage");
  const sessionStorage = getBrowserStorage("sessionStorage");
  const currentKey = getProductEditDraftKey(productKey);
  const legacyKey = getProductEditDraftKey(productKey, legacyProductEditDraftVersion);
  const candidates = [
    { storage: localStorage, key: currentKey },
    { storage: sessionStorage, key: currentKey },
    { storage: sessionStorage, key: legacyKey },
    { storage: localStorage, key: legacyKey },
  ];

  for (const candidate of candidates) {
    try {
      const parsed = parseProductEditDraft(candidate.storage?.getItem(candidate.key) ?? null);
      if (parsed) return parsed;
    } catch {
      // Ignore unavailable storage entries and keep checking the remaining fallbacks.
    }
  }

  return null;
}

function writeProductEditDraft(productKey: string, draft: ProductEditDraftCache) {
  if (typeof window === "undefined" || !productKey) return;

  const draftValue = JSON.stringify({
    ...draft,
    savedAt: new Date().toISOString(),
  });

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      getBrowserStorage(storageName)?.setItem(getProductEditDraftKey(productKey), draftValue);
    } catch {
      // Ignore storage quota/private-mode failures; the in-memory form state still works.
    }
  }
}

function clearProductEditDraft(productKey: string) {
  if (typeof window === "undefined" || !productKey) return;

  const keys = [
    getProductEditDraftKey(productKey),
    getProductEditDraftKey(productKey, legacyProductEditDraftVersion),
  ];

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    const storage = getBrowserStorage(storageName);
    for (const key of keys) {
      try {
        storage?.removeItem(key);
      } catch {
        // Ignore unavailable storage entries; a future successful save can overwrite them.
      }
    }
  }
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

function isCompleteProductEditDraft(
  draft: Partial<ProductEditDraftCache> | null,
): draft is ProductEditDraftCache {
  return Boolean(
    draft &&
      typeof draft.productId === "string" &&
      draft.product &&
      Array.isArray(draft.items) &&
      Array.isArray(draft.specs) &&
      Array.isArray(draft.skus),
  );
}

function sortRecord(record: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function getComparableDraft(draft: ProductEditDraftCache) {
  return {
    product: draft.product,
    items: draft.items.map(
      ({
        item_name,
        item_spec,
        quantity,
        item_length_cm,
        item_width_cm,
        item_height_cm,
        item_weight_g,
        purchase_price_rmb,
        purchase_shipping_fee_per_500g_rmb,
        purchase_url,
      }) => ({
        item_name,
        item_spec,
        quantity,
        item_length_cm,
        item_width_cm,
        item_height_cm,
        item_weight_g,
        purchase_price_rmb,
        purchase_shipping_fee_per_500g_rmb,
        purchase_url,
      }),
    ),
    specs: draft.specs.map(({ name, values }) => ({ name, values })),
    skus: draft.skus.map(({ sku_code, temu_image_url, attributes, notes, component_links }) => ({
      sku_code,
      temu_image_url,
      attributes: sortRecord(attributes),
      notes,
      component_links: component_links.map(({ item_key, quantity }) => ({
        item_key,
        quantity,
      })),
    })),
  };
}

function isDraftDifferentFromBase(
  baseDraft: ProductEditDraftCache,
  draft: ProductEditDraftCache,
) {
  return JSON.stringify(getComparableDraft(baseDraft)) !== JSON.stringify(getComparableDraft(draft));
}

export function ProductEditPage() {
  const { productId: productKey = "" } = useParams();
  const navigate = useNavigate();
  const draftRef = useRef<ProductEditDraftCache | null>(null);
  const draftDirtyRef = useRef(false);
  const [productId, setProductId] = useState("");
  const [product, setProduct] = useState<ProductDraft | null>(null);
  const [items, setItems] = useState<ProductItem[]>([]);
  const [specs, setSpecs] = useState<ProductSpec[]>([createEmptySpec()]);
  const [skus, setSkus] = useState<ProductSkuDraft[]>([]);
  const [loadingError, setLoadingError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoadingError("");
      setDraftNotice("");
      setMessage("");
      draftRef.current = null;
      draftDirtyRef.current = false;

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
        const cachedDraft = readProductEditDraft(productKey);
        const nextDraft = mergeCachedDraft(serverDraft, cachedDraft);
        const restoredDraft =
          cachedDraft?.productId === serverDraft.productId &&
          isDraftDifferentFromBase(serverDraft, nextDraft);
        if (!active) return;
        draftRef.current = nextDraft;
        draftDirtyRef.current = restoredDraft;
        setProductId(nextDraft.productId);
        setProduct(nextDraft.product);
        setItems(nextDraft.items);
        setSpecs(nextDraft.specs);
        setSkus(nextDraft.skus);
        setDraftNotice(restoredDraft ? "已恢复上次未保存的编辑草稿，保存编辑后会自动清除。" : "");
        if (restoredDraft) {
          writeProductEditDraft(productKey, nextDraft);
        } else if (cachedDraft) {
          clearProductEditDraft(productKey);
        }
      } catch (error) {
        if (!active) return;
        const cachedDraft = readProductEditDraft(productKey);
        if (isCompleteProductEditDraft(cachedDraft)) {
          const fallbackDraft = {
            ...cachedDraft,
            product: { ...emptyProductDraft, ...cachedDraft.product },
            skus: normalizeDraftSkus(cachedDraft.skus),
          };
          draftRef.current = fallbackDraft;
          draftDirtyRef.current = true;
          setProductId(fallbackDraft.productId);
          setProduct(fallbackDraft.product);
          setItems(fallbackDraft.items);
          setSpecs(fallbackDraft.specs);
          setSkus(fallbackDraft.skus);
          setMessage(getErrorMessage(error, "加载商品失败，已先显示本地草稿"));
          setDraftNotice("当前显示的是本地草稿；保存前请确认后台连接已恢复。");
          return;
        }
        setLoadingError(getErrorMessage(error, "加载商品失败"));
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [productKey]);

  const persistDraftNow = useCallback(
    (nextDraft: ProductEditDraftCache) => {
      draftDirtyRef.current = true;
      draftRef.current = nextDraft;
      writeProductEditDraft(productKey, nextDraft);
    },
    [productKey],
  );

  useEffect(() => {
    if (!product || !productId) return;
    const nextDraft = {
      productId,
      product,
      items,
      specs,
      skus,
    };
    draftRef.current = nextDraft;
    if (draftDirtyRef.current) {
      writeProductEditDraft(productKey, nextDraft);
    }
  }, [items, product, productId, productKey, skus, specs]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const flushDraft = () => {
      if (draftDirtyRef.current && draftRef.current) {
        writeProductEditDraft(productKey, draftRef.current);
      }
    };
    const flushHiddenDraft = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };

    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    document.addEventListener("visibilitychange", flushHiddenDraft);

    return () => {
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
      document.removeEventListener("visibilitychange", flushHiddenDraft);
    };
  }, [productKey]);

  const handleProductChange = useCallback(
    (nextProduct: ProductDraft) => {
      setProduct(nextProduct);
      if (!productId) return;
      persistDraftNow({
        productId,
        product: nextProduct,
        items,
        specs,
        skus,
      });
    },
    [items, persistDraftNow, productId, skus, specs],
  );

  const handleItemsChange = useCallback(
    (nextItems: ProductItem[]) => {
      setItems(nextItems);
      if (!product || !productId) return;
      persistDraftNow({
        productId,
        product,
        items: nextItems,
        specs,
        skus,
      });
    },
    [persistDraftNow, product, productId, skus, specs],
  );

  const handleSpecsChange = useCallback(
    (nextSpecs: ProductSpec[]) => {
      setSpecs(nextSpecs);
      if (!product || !productId) return;
      persistDraftNow({
        productId,
        product,
        items,
        specs: nextSpecs,
        skus,
      });
    },
    [items, persistDraftNow, product, productId, skus],
  );

  const handleSkusChange = useCallback(
    (nextSkus: ProductSkuDraft[]) => {
      setSkus(nextSkus);
      if (!product || !productId) return;
      persistDraftNow({
        productId,
        product,
        items,
        specs,
        skus: nextSkus,
      });
    },
    [items, persistDraftNow, product, productId, specs],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!product || !productId) return;
    setBusy(true);
    setMessage("");

    try {
      await updateProduct(productId, product, items, skus);
      draftDirtyRef.current = false;
      draftRef.current = null;
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
      {draftNotice && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-700">
          {draftNotice}
        </div>
      )}
      <ProductForm
        product={product}
        items={items}
        specs={specs}
        skus={skus}
        busy={busy}
        submitLabel="保存编辑"
        onProductChange={handleProductChange}
        onItemsChange={handleItemsChange}
        onSpecsChange={handleSpecsChange}
        onSkusChange={handleSkusChange}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
