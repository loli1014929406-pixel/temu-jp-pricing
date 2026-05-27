import { Download, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  deleteProduct,
  exportProductsData,
  fetchProducts,
  getProductRoutePath,
  importProductsData,
} from "../lib/products";
import {
  buildWorkbook,
  getTransferValidation,
  parseTransferFile,
} from "../lib/product-transfer";
import { usePermissions } from "../hooks/use-permissions";
import { getErrorMessage } from "../utils/errors";
import type { Product } from "../types";
import type { User } from "@supabase/supabase-js";
import { PageHeader } from "../components/ui";

type ProductsPageProps = {
  user: User;
};

export function ProductsPage({ user }: ProductsPageProps) {
  const { canEdit, canDelete } = usePermissions();
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
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

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
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

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
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入商品。");
      event.target.value = "";
      return;
    }

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
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入商品。");
      return;
    }

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
      <PageHeader
        title="商品管理"
        description="管理商品尺寸、重量与申报材质"
        actions={
          <>
          <button
            type="button"
            onClick={() => void handleExcelExport()}
            disabled={transferring}
            className="btn-secondary"
          >
            <Download size={18} />
            下载 Excel
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => void handleBulkDelete()}
              disabled={selectedProductIds.length === 0 || transferring}
              className={selectedProductIds.length > 0 ? "btn-danger" : "btn-secondary"}
            >
              <Trash2 size={18} />
              批量删除
            </button>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={transferring}
                className="btn-secondary"
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
                className="btn-primary"
              >
                <Plus size={18} />
                新增商品
              </Link>
            </>
          )}
          </>
        }
      />

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
        <div className="surface-card grid gap-3 p-4">
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

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          products.map((product) => (
            <article key={product.id} className="mobile-summary-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mobile-summary-title">{product.product_code}</p>
                  <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedProductIds.includes(product.id)}
                  onChange={() => toggleProduct(product.id)}
                  aria-label={`选择商品 ${product.product_code}`}
                />
              </div>
              <div className="mobile-summary-grid">
                <div className="mobile-summary-cell">英文材质：{product.material_en || "--"}</div>
                <div className="mobile-summary-cell">中文材质：{product.material_cn || "--"}</div>
                <div className="mobile-summary-cell">长：{product.package_length_cm} cm</div>
                <div className="mobile-summary-cell">宽：{product.package_width_cm} cm</div>
                <div className="mobile-summary-cell">高：{product.package_height_cm} cm</div>
                <div className="mobile-summary-cell">重：{product.package_weight_g} g</div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                创建时间：
                {new Date(product.created_at).toLocaleString("zh-CN", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <div className="mobile-summary-actions">
                {canEdit && (
                  <Link className="btn-secondary h-9 px-3" to={getProductRoutePath(product, "/edit")}>
                    编辑
                  </Link>
                )}
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => void handleDelete(product)}
                    disabled={deletingProductId === product.id}
                    className="icon-btn-danger h-9 w-9"
                    aria-label={`删除${product.product_name_cn}`}
                    title="删除商品"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <div className="table-card hidden md:block">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
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
                <th className="product-name-col px-4 py-3 font-medium">中文名称</th>
                <th className="px-4 py-3 font-medium">英文材质</th>
                <th className="px-4 py-3 font-medium">中文材质</th>
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
                  <td colSpan={11} className="px-4 py-10 text-center text-slate-500">
                    加载中...
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-slate-500">
                    暂无商品
                  </td>
                </tr>
              ) : (
                products.map((product) => {
                  const isSelected = selectedProductIds.includes(product.id);

                  return (
                  <tr key={product.id} className={isSelected ? "is-selected" : undefined}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleProduct(product.id)}
                        aria-label={`选择商品 ${product.product_code}`}
                      />
                    </td>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">{product.material_en || "--"}</td>
                    <td className="px-4 py-3">{product.material_cn || "--"}</td>
                    <td className="number-cell">{product.package_length_cm} cm</td>
                    <td className="number-cell">{product.package_width_cm} cm</td>
                    <td className="number-cell">{product.package_height_cm} cm</td>
                    <td className="number-cell">{product.package_weight_g} g</td>
                    <td className="px-4 py-3">
                      {new Date(product.created_at).toLocaleString("zh-CN", {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-28 items-center gap-3">
                        {canEdit && (
                          <Link className="text-action text-slate-600 hover:no-underline" to={getProductRoutePath(product, "/edit")}>
                            编辑
                          </Link>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => void handleDelete(product)}
                            disabled={deletingProductId === product.id}
                            className="icon-btn-danger"
                            aria-label={`删除${product.product_name_cn}`}
                            title="删除商品"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
