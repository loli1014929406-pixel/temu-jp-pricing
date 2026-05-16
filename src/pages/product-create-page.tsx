import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { ProductForm } from "../components/product-form";
import { createEmptyItem, emptyProductDraft } from "../lib/defaults";
import { createProduct } from "../lib/products";
import type { ProductDraft, ProductItem } from "../types";
import { getErrorMessage } from "../utils/errors";

type ProductCreatePageProps = {
  user: User;
};

export function ProductCreatePage({ user }: ProductCreatePageProps) {
  const navigate = useNavigate();
  const [product, setProduct] = useState<ProductDraft>(emptyProductDraft);
  const [items, setItems] = useState<ProductItem[]>([createEmptyItem()]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) {
      setMessage("当前登录已失效，请重新登录");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      await createProduct(product, items);
      navigate("/products", { state: { message: "保存成功" } });
    } catch (error) {
      setMessage(getErrorMessage(error, "保存商品失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">新增商品</h1>
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
        submitLabel="保存商品"
        onProductChange={setProduct}
        onItemsChange={setItems}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
