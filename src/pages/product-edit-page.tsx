import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ProductForm } from "../components/product-form";
import { fetchProduct, fetchProductItems, updateProduct } from "../lib/products";
import type { ProductDraft, ProductItem } from "../types";
import { getErrorMessage } from "../utils/errors";

export function ProductEditPage() {
  const { productId = "" } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<ProductDraft | null>(null);
  const [items, setItems] = useState<ProductItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function load() {
      const [nextProduct, nextItems] = await Promise.all([
        fetchProduct(productId),
        fetchProductItems(productId),
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
      setProduct(draft);
      setItems(nextItems);
    }

    void load();
  }, [productId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!product) return;
    setBusy(true);
    setMessage("");

    try {
      await updateProduct(productId, product, items);
      navigate("/products");
    } catch (error) {
      setMessage(getErrorMessage(error, "更新商品失败"));
    } finally {
      setBusy(false);
    }
  }

  if (!product) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">编辑商品</h1>
        <Link to="/products" className="text-sm text-accent">
          返回商品列表
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
        busy={busy}
        submitLabel="保存修改"
        onProductChange={setProduct}
        onItemsChange={setItems}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
