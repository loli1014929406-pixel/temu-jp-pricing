import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { fetchProducts } from "../lib/products";
import { getErrorMessage } from "../utils/errors";
import type { Product } from "../types";
import type { User } from "@supabase/supabase-js";

type ProductsPageProps = {
  user: User;
};

export function ProductsPage({ user }: ProductsPageProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const location = useLocation();
  const successMessage = (location.state as { message?: string } | null)?.message;

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const baseProducts = await fetchProducts();
        if (active) {
          setProducts(baseProducts);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error, "加载商品失败"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [user.id]);

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">商品列表</h1>
          <p className="mt-1 text-sm text-slate-500">按当前账号独立管理</p>
        </div>
        <Link
          to="/products/new"
          className="inline-flex h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white"
        >
          <Plus size={18} />
          新增商品
        </Link>
      </div>

      {successMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {successMessage}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-white shadow-panel">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">日语标题</th>
                <th className="px-4 py-3 font-medium">包装重量</th>
                <th className="px-4 py-3 font-medium">最低核价</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id} className="border-t border-line">
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">{product.title_jp}</td>
                    <td className="px-4 py-3">{product.package_weight_g} g</td>
                    <td className="px-4 py-3 text-slate-400">查看核价</td>
                    <td className="px-4 py-3">
                      {new Date(product.created_at).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-3">
                        <Link className="text-accent" to={`/products/${product.id}/pricing`}>
                          查看核价
                        </Link>
                        <Link className="text-slate-600" to={`/products/${product.id}/edit`}>
                          编辑
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
