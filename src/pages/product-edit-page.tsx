import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ProductForm } from "../components/product-form";
import {
  fetchProduct,
  fetchProductItems,
  fetchProductSkus,
  getProductRoutePath,
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
    async function load() {
      setLoadingError("");

      try {
        const nextProduct = await fetchProduct(productKey);
        const routeKey = nextProduct.product_code.trim() || nextProduct.id;
        if (productKey !== routeKey) {
          navigate(getProductRoutePath(nextProduct, "/edit"), { replace: true });
          return;
        }

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
        setProductId(nextProduct.id);
        setProduct(draft);
        setItems(nextItems.length > 0 ? nextItems : [createEmptyItem()]);
        setSkus(
          nextSkus.length > 0
            ? nextSkus.map((sku) => ({
                ...sku,
                component_links: sku.component_links.map((link) => ({
                  ...link,
                  item_key: link.item_id,
                })),
              }))
            : [createEmptySku()],
        );
      } catch (error) {
        setLoadingError(getErrorMessage(error, "加载商品失败"));
      }
    }

    void load();
  }, [navigate, productKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!product || !productId) return;
    setBusy(true);
    setMessage("");

    try {
      await updateProduct(productId, product, items, skus);
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
        <Link to="/products" className="text-sm text-accent">
          返回商品管理
        </Link>
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
