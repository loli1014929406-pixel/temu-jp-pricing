import { Download, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  deleteProduct,
  exportProductsData,
  fetchProducts,
  importProductsData,
} from "../lib/products";
import {
  buildWorkbook,
  getTransferValidation,
  parseTransferFile,
} from "../lib/product-transfer";
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
  const [deletingProductId, setDeletingProductId] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [pendingImport, setPendingImport] = useState<{
    fileName: string;
    records: Parameters<typeof importProductsData>[0];
    errors: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  async function handleDelete(product: Product) {
    const confirmed = window.confirm(`确认删除商品“${product.product_name_cn}”吗？`);
    if (!confirmed) return;

    setDeletingProductId(product.id);
    setErrorMessage("");

    try {
      await deleteProduct(product.id);
      setProducts((current) => current.filter((item) => item.id !== product.id));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "删除商品失败"));
    } finally {
      setDeletingProductId("");
    }
  }

  const allSelected =
    products.length > 0 && selectedProductIds.length === products.length;

  function toggleSelectAll() {
    setSelectedProductIds(allSelected ? [] : products.map((product) => product.id));
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId],
    );
  }

  async function handleBulkDelete() {
    if (selectedProductIds.length === 0) return;
    const confirmed = window.confirm(`确认删除已选中的 ${selectedProductIds.length} 个商品吗？`);
    if (!confirmed) return;

    setTransferring(true);
    setErrorMessage("");
    try {
      await Promise.all(selectedProductIds.map((productId) => deleteProduct(productId)));
      setProducts((current) =>
        current.filter((product) => !selectedProductIds.includes(product.id)),
      );
      setSelectedProductIds([]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "批量删除商品失败"));
    } finally {
      setTransferring(false);
    }
  }

  async function handleExcelExport() {
    setTransferring(true);
    setErrorMessage("");

    try {
      const data = await exportProductsData(selectedProductIds);
      const workbook = await buildWorkbook(data);
      const XLSX = await import("xlsx");
      XLSX.writeFile(workbook, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "导出 Excel 失败"));
    } finally {
      setTransferring(false);
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setTransferring(true);
    setErrorMessage("");

    try {
      const data = await parseTransferFile(file);
      const validation = getTransferValidation(data);
      if (!Array.isArray(data)) {
        throw new Error("导入文件格式不正确");
      }
      setPendingImport({
        fileName: file.name,
        records: data as Parameters<typeof importProductsData>[0],
        errors: validation.errors,
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "导入商品失败"));
    } finally {
      setTransferring(false);
      event.target.value = "";
    }
  }

  async function confirmImport() {
    if (!pendingImport || pendingImport.errors.length > 0) return;

    setTransferring(true);
    setErrorMessage("");
    try {
      await importProductsData(pendingImport.records);
      window.location.reload();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "导入商品失败"));
    } finally {
      setTransferring(false);
    }
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">商品列表</h1>
          <p className="mt-1 text-sm text-slate-500">按当前账号独立管理</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExcelExport()}
            disabled={transferring}
            className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            <Download size={18} />
            下载 Excel
          </button>
          <button
            type="button"
            onClick={() => void handleBulkDelete()}
            disabled={selectedProductIds.length === 0 || transferring}
            className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            <Trash2 size={18} />
            批量删除
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={transferring}
            className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            <Upload size={18} />
            上传 Excel
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void handleImport(event)}
            className="hidden"
          />
          <Link
            to="/products/new"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white"
          >
            <Plus size={18} />
            新增商品
          </Link>
        </div>
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

      {pendingImport && (
        <div className="grid gap-3 rounded-lg border border-line bg-white p-4 shadow-panel">
          <div>
            <p className="text-sm font-medium text-ink">导入预览</p>
            <p className="mt-1 text-sm text-slate-500">
              {pendingImport.fileName} · {pendingImport.records.length} 个商品
            </p>
          </div>
          <div className="grid gap-2 text-sm text-slate-700">
            {pendingImport.records.slice(0, 5).map((record, index) => (
              <div key={`${record.product_code}-${index}`} className="flex flex-wrap gap-4">
                <span>{record.product_code}</span>
                <span>{record.product_name_cn}</span>
                <span>{record.items.length} 个配件</span>
                <span>{record.skus.length} 个 SKU</span>
              </div>
            ))}
          </div>
          {pendingImport.errors.length > 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {pendingImport.errors.join("；")}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void confirmImport()}
              disabled={pendingImport.errors.length > 0 || transferring}
              className="inline-flex h-10 items-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-60"
            >
              确认导入
            </button>
            <button
              type="button"
              onClick={() => setPendingImport(null)}
              className="inline-flex h-10 items-center rounded-md border border-line px-4 text-sm text-slate-700"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-white shadow-panel">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="全选商品"
                  />
                </th>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="px-4 py-3 font-medium">产品名称</th>
                <th className="px-4 py-3 font-medium">包装长</th>
                <th className="px-4 py-3 font-medium">包装宽</th>
                <th className="px-4 py-3 font-medium">包装高</th>
                <th className="px-4 py-3 font-medium">包装重量</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedProductIds.includes(product.id)}
                        onChange={() => toggleProduct(product.id)}
                        aria-label={`选择商品 ${product.product_code}`}
                      />
                    </td>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">{product.package_length_cm} cm</td>
                    <td className="px-4 py-3">{product.package_width_cm} cm</td>
                    <td className="px-4 py-3">{product.package_height_cm} cm</td>
                    <td className="px-4 py-3">{product.package_weight_g} g</td>
                    <td className="px-4 py-3">
                      {new Date(product.created_at).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-40 items-center gap-6">
                        <Link className="text-slate-600" to={`/products/${product.id}/edit`}>
                          编辑
                        </Link>
                        <button
                          type="button"
                          onClick={() => void handleDelete(product)}
                          disabled={deletingProductId === product.id}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                          aria-label={`删除${product.product_name_cn}`}
                          title="删除商品"
                        >
                          <Trash2 size={16} />
                        </button>
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
