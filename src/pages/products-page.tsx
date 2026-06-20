import { Download, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  deleteProduct,
  exportProductsData,
  fetchProductsPaginated,
  getProductRoutePath,
  importProductsData,
  updateProductSellingStatus,
} from "../lib/products";
import {
  fetchAccountProfilesByOwnerIds,
  formatAccountProfileDisplay,
} from "../lib/account-profiles";
import {
  buildWorkbook,
  getTransferValidation,
  parseTransferFile,
} from "../lib/product-transfer";
import { downloadWorkbook } from "../lib/excel";
import { usePermissions } from "../hooks/use-permissions";
import { useAutoDismiss } from "../hooks/use-auto-dismiss";
import { getErrorMessage } from "../utils/errors";
import type { AccountProfile, Product } from "../types";
import type { User } from "@supabase/supabase-js";
import { PageHeader, StatCard } from "../components/ui";
import { StandardTable } from "../components/ui/StandardTable";

type ProductsPageProps = {
  user: User;
};

type ProductSellingFilter = "selling" | "not_selling" | "all";

export function ProductsPage({ user }: ProductsPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [profilesByOwnerId, setProfilesByOwnerId] = useState<Map<string, AccountProfile>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [deletingProductId, setDeletingProductId] = useState("");
  const [updatingSellingProductId, setUpdatingSellingProductId] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState("");
  const [pendingImport, setPendingImport] = useState<{
    fileName: string;
    records: Parameters<typeof importProductsData>[0];
    errors: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const successMessage = (location.state as { message?: string } | null)?.message;

  const [searchQuery, setSearchQuery] = useState("");
  const [sellingFilter, setSellingFilter] = useState<ProductSellingFilter>("selling");
  useAutoDismiss(errorMessage, () => setErrorMessage(""));

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalRecordCount, setTotalRecordCount] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");

      try {
        const { data, count } = await fetchProductsPaginated({
          page,
          pageSize,
          searchQuery,
          sellingFilter,
        });

        if (active) {
          setProducts(data);
          setTotalRecordCount(count);
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
  }, [user.id, page, pageSize, searchQuery, sellingFilter, refreshToken]);

  useEffect(() => {
    let active = true;

    async function loadProfiles() {
      const ownerIds = products.map((product) => product.owner_id).filter(Boolean);
      try {
        const nextProfiles = await fetchAccountProfilesByOwnerIds(ownerIds);
        if (active) setProfilesByOwnerId(nextProfiles);
      } catch (error) {
        if (active) setErrorMessage(getErrorMessage(error, "加载创建用户失败"));
      }
    }

    void loadProfiles();
    return () => {
      active = false;
    };
  }, [products]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, sellingFilter, pageSize]);

  const filteredProducts = products;

  useEffect(() => {
    if (!successMessage) return;

    setNoticeMessage(successMessage);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate, successMessage]);

  useEffect(() => {
    if (!noticeMessage) return;

    const timer = window.setTimeout(() => {
      setNoticeMessage("");
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [noticeMessage]);

  async function handleDelete(product: Product) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }

    const firstConfirmed = window.confirm(`确认删除商品“${product.product_name_cn}”吗？`);
    if (!firstConfirmed) return;

    const secondConfirmed = window.confirm("再次确认：删除后不可恢复，确定继续删除吗？");
    if (!secondConfirmed) return;

    setDeletingProductId(product.id);
    setErrorMessage("");

    try {
      await deleteProduct(product.id);
      setProducts((current) => current.filter((item) => item.id !== product.id));
      setTotalRecordCount((current) => Math.max(0, current - 1));
      setNoticeMessage(`已删除商品“${product.product_name_cn}”。`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "删除商品失败"));
    } finally {
      setDeletingProductId("");
    }
  }

  async function handleSellingStatusChange(product: Product, isSelling: boolean) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新商品售卖状态。");
      return;
    }

    setUpdatingSellingProductId(product.id);
    setErrorMessage("");

    try {
      const nextProduct = await updateProductSellingStatus(product.id, isSelling);
      setProducts((current) =>
        current.map((item) => (item.id === product.id ? nextProduct : item)),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "更新商品售卖状态失败"));
    } finally {
      setUpdatingSellingProductId("");
    }
  }

  async function handleExcelExport() {
    setTransferring(true);
    setErrorMessage("");

    try {
      const data = await exportProductsData();
      const workbook = await buildWorkbook(data);
      await downloadWorkbook(workbook, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      setPendingImport(null);
      setPage(1);
      setRefreshToken((current) => current + 1);
      setNoticeMessage(`已导入 ${pendingImport.records.length} 个商品。`);
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

      {/* 统计指标卡片 */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <StatCard label="查询结果" value={String(totalRecordCount)} />
        <StatCard label="当前页码" value={`${page} / ${Math.max(1, Math.ceil(totalRecordCount / pageSize))}`} />
      </div>

      {/* 搜索与过滤工具栏 */}
      <div className="surface-card p-4 grid gap-4 sm:grid-cols-[1fr_180px] items-center">
        <div className="relative">
          <input
            type="text"
            placeholder="搜索商品编号、名称或材质..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 rounded-xl border border-line bg-white px-4 text-sm outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
        </div>
        <div>
          <select
            value={sellingFilter}
            onChange={(e) => setSellingFilter(e.target.value as ProductSellingFilter)}
            className="w-full h-10 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 text-slate-750 font-medium"
          >
            <option value="selling">售卖中</option>
            <option value="not_selling">不售卖</option>
            <option value="all">全部状态</option>
          </select>
        </div>
      </div>

      {noticeMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {noticeMessage}
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
              className="btn-primary"
            >
              确认导入
            </button>
            <button
              type="button"
              onClick={() => setPendingImport(null)}
              className="btn-secondary"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:hidden">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : filteredProducts.length === 0 ? (
          <div className="empty-state">暂无商品</div>
        ) : (
          filteredProducts.map((product) => (
            <article key={product.id} className="mobile-summary-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mobile-summary-title">{product.product_code}</p>
                  <p className="mobile-summary-subtitle">{product.product_name_cn}</p>
                </div>
              </div>
              <div className="mobile-summary-grid">
                <div className="mobile-summary-cell">英文材质：{product.material_en || "--"}</div>
                <div className="mobile-summary-cell">中文材质：{product.material_cn || "--"}</div>
                <div className="mobile-summary-cell">长：{product.package_length_cm} cm</div>
                <div className="mobile-summary-cell">宽：{product.package_width_cm} cm</div>
                <div className="mobile-summary-cell">高：{product.package_height_cm} cm</div>
                <div className="mobile-summary-cell">重：{product.package_weight_g} g</div>
                <div className="mobile-summary-cell">
                  状态：{product.is_selling ? "售卖中" : "不售卖"}
                </div>
                <div className="mobile-summary-cell">
                  创建用户：{formatAccountProfileDisplay(profilesByOwnerId.get(product.owner_id))}
                </div>
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
                  <button
                    type="button"
                    onClick={() => void handleSellingStatusChange(product, !product.is_selling)}
                    disabled={updatingSellingProductId === product.id}
                    className="btn-secondary h-9 px-3"
                  >
                    {product.is_selling ? "设为不售卖" : "恢复售卖"}
                  </button>
                )}
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

      <div className="hidden md:block">
        <StandardTable
          page={page}
          pageSize={pageSize}
          totalPages={Math.max(1, Math.ceil(totalRecordCount / pageSize))}
          totalRecordCount={totalRecordCount}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          loading={loading}
          empty={filteredProducts.length === 0}
        >
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">商品编号</th>
                <th className="product-name-col px-4 py-3 font-medium">中文名称</th>
                <th className="px-4 py-3 font-medium">英文材质</th>
                <th className="px-4 py-3 font-medium">中文材质</th>
                <th className="px-4 py-3 font-medium">包装长</th>
                <th className="px-4 py-3 font-medium">包装宽</th>
                <th className="px-4 py-3 font-medium">包装高</th>
                <th className="px-4 py-3 font-medium">包装重量</th>
                <th className="px-4 py-3 font-medium">是否售卖</th>
                <th className="px-4 py-3 font-medium">创建用户</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {(!loading && filteredProducts.length > 0) && (
                filteredProducts.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">{product.product_code}</td>
                    <td className="product-name-col px-4 py-3">{product.product_name_cn}</td>
                    <td className="px-4 py-3">{product.material_en || "--"}</td>
                    <td className="px-4 py-3">{product.material_cn || "--"}</td>
                    <td className="number-cell">{product.package_length_cm} cm</td>
                    <td className="number-cell">{product.package_width_cm} cm</td>
                    <td className="number-cell">{product.package_height_cm} cm</td>
                    <td className="number-cell">{product.package_weight_g} g</td>
                    <td className="px-4 py-3">
                      {canEdit ? (
                        <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                          <input
                            type="checkbox"
                            checked={product.is_selling}
                            disabled={updatingSellingProductId === product.id}
                            onChange={(event) =>
                              void handleSellingStatusChange(product, event.target.checked)
                            }
                            aria-label={`${product.product_code} 是否售卖`}
                          />
                          {product.is_selling ? "售卖" : "不售卖"}
                        </label>
                      ) : (
                        product.is_selling ? "售卖" : "不售卖"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {formatAccountProfileDisplay(profilesByOwnerId.get(product.owner_id))}
                    </td>
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
                          <Link className="text-sm font-semibold text-slate-700 hover:text-accent hover:no-underline" to={getProductRoutePath(product, "/edit")}>
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
                ))
              )}
            </tbody>
        </StandardTable>
      </div>
    </section>
  );
}
