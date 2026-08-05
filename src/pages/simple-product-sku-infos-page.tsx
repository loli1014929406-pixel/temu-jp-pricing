import { Download, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router";
import type { User } from "@supabase/supabase-js";
import { PageHeader, StatCard } from "../components/ui";
import { StandardTable } from "../components/ui/StandardTable";
import { usePermissions } from "../hooks/use-permissions";
import { useTenantContext } from "../hooks/use-tenant-context";
import {
  deleteSimpleProductSkuInfo,
  fetchSimpleProductSkuInfos,
  upsertSimpleProductSkuInfos,
} from "../lib/simple-product-sku-infos";
import {
  buildSimpleProductSkuTemplate,
  getSimpleProductSkuValidation,
  parseSimpleProductSkuFile,
} from "../lib/simple-product-sku-transfer";
import { downloadWorkbook } from "../lib/excel";
import { confirmAction, confirmCancelEdit, confirmDelete } from "../utils/confirmations";
import { getErrorMessage } from "../utils/errors";
import type {
  SimpleProductSkuInfo,
  SimpleProductSkuInfoDraft,
} from "../types";

type SimpleProductSkuInfosPageProps = { user: User };

const emptyDraft: SimpleProductSkuInfoDraft = {
  product_code: "",
  sku_code: "",
  product_name_cn: "",
  product_name_en: "",
  material: "",
  purchase_price_rmb: 0,
  purchase_url: "",
};

export function SimpleProductSkuInfosPage({ user }: SimpleProductSkuInfosPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const tenant = useTenantContext();
  const [records, setRecords] = useState<SimpleProductSkuInfo[]>([]);
  const [draft, setDraft] = useState<SimpleProductSkuInfoDraft>(emptyDraft);
  const [editingId, setEditingId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalRecordCount, setTotalRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [pendingImport, setPendingImport] = useState<{
    fileName: string;
    records: SimpleProductSkuInfoDraft[];
    errors: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (tenant.loading) return;
      setLoading(true);
      try {
        const result = await fetchSimpleProductSkuInfos({ page, pageSize, searchQuery });
        if (active) {
          setRecords(result.data);
          setTotalRecordCount(result.count);
        }
      } catch (error) {
        if (active) setErrorMessage(getErrorMessage(error, "加载简化商品资料失败"));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [tenant.loading, tenant.currentShop?.id, user.id, page, pageSize, searchQuery]);

  useEffect(() => setPage(1), [searchQuery, pageSize]);

  function resetDraft() {
    setDraft(emptyDraft);
    setEditingId("");
  }

  async function handleSave() {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限。");
      return;
    }
    const validation = getSimpleProductSkuValidation([draft]);
    if (!validation.valid) {
      setErrorMessage(validation.errors.join("；"));
      return;
    }
    setWorking(true);
    setErrorMessage("");
    try {
      await upsertSimpleProductSkuInfos(validation.records);
      resetDraft();
      setNoticeMessage("简化商品 SKU 资料已保存。");
      setPage(1);
      const result = await fetchSimpleProductSkuInfos({ page: 1, pageSize, searchQuery });
      setRecords(result.data);
      setTotalRecordCount(result.count);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "保存简化商品资料失败"));
    } finally {
      setWorking(false);
    }
  }

  function handleEdit(record: SimpleProductSkuInfo) {
    setEditingId(record.id);
    setDraft({
      product_code: record.product_code,
      sku_code: record.sku_code,
      product_name_cn: record.product_name_cn,
      product_name_en: record.product_name_en,
      material: record.material,
      purchase_price_rmb: record.purchase_price_rmb,
      purchase_url: record.purchase_url,
    });
  }

  async function handleDelete(record: SimpleProductSkuInfo) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }
    if (!(await confirmDelete(`SKU“${record.sku_code}”`))) return;
    setWorking(true);
    try {
      await deleteSimpleProductSkuInfo(record.id);
      setNoticeMessage(`已删除 SKU“${record.sku_code}”。`);
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setTotalRecordCount((current) => Math.max(0, current - 1));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "删除简化商品资料失败"));
    } finally {
      setWorking(false);
    }
  }

  async function handleDownloadTemplate() {
    setWorking(true);
    try {
      const workbook = await buildSimpleProductSkuTemplate();
      await downloadWorkbook(workbook, "simple-product-sku-template.xlsx");
      setNoticeMessage("简化商品 SKU 上传模板已下载。");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "下载模板失败"));
    } finally {
      setWorking(false);
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能上传简化商品资料。");
      return;
    }
    setWorking(true);
    try {
      const result = await parseSimpleProductSkuFile(file);
      setPendingImport({ fileName: file.name, records: result.records, errors: result.errors });
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "读取简化商品资料失败"));
    } finally {
      setWorking(false);
    }
  }

  async function confirmImport() {
    if (!pendingImport || pendingImport.errors.length > 0) return;
    if (!(await confirmAction(`确认导入 ${pendingImport.records.length} 个 SKU 吗？同 SKU 资料将更新。`))) return;
    setWorking(true);
    try {
      await upsertSimpleProductSkuInfos(pendingImport.records);
      setPendingImport(null);
      setNoticeMessage(`已导入 ${pendingImport.records.length} 个 SKU。`);
      setPage(1);
      const result = await fetchSimpleProductSkuInfos({ page: 1, pageSize, searchQuery });
      setRecords(result.data);
      setTotalRecordCount(result.count);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "导入简化商品资料失败"));
    } finally {
      setWorking(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalRecordCount / pageSize));

  return (
    <section className="page-stack">
      <PageHeader
        title="简化商品 SKU 资料"
        description="按 SKU 维护英文订货所需的商品资料，不影响现有完整商品信息"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/products" className="btn-secondary">返回完整商品</Link>
            <button type="button" onClick={() => void handleDownloadTemplate()} disabled={working} className="btn-secondary">
              <Download size={18} /> 下载上传模板
            </button>
            {canEdit && (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={working} className="btn-secondary">
                  <Upload size={18} /> 上传简化资料
                </button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.csv,.tsv" onChange={(event) => void handleImport(event)} className="hidden" />
              </>
            )}
          </div>
        }
      />

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <StatCard label="查询结果" value={String(totalRecordCount)} />
        <StatCard label="当前页码" value={`${page} / ${totalPages}`} />
      </div>

      {noticeMessage && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{noticeMessage}</div>}
      {errorMessage && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>}

      {pendingImport && (
        <div className="surface-card grid gap-3 p-4">
          <div>
            <p className="text-sm font-medium text-ink">导入预览</p>
            <p className="mt-1 text-sm text-slate-500">{pendingImport.fileName} · {pendingImport.records.length} 个 SKU</p>
          </div>
          {pendingImport.errors.length > 0 && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{pendingImport.errors.join("；")}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={() => void confirmImport()} disabled={working || pendingImport.errors.length > 0} className="btn-primary">确认导入</button>
            <button type="button" onClick={async () => { if (await confirmCancelEdit("确认取消本次导入吗？")) setPendingImport(null); }} className="btn-secondary">取消</button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="surface-card grid gap-3 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink">{editingId ? "编辑简化 SKU 资料" : "新增简化 SKU 资料"}</p>
            {editingId && <button type="button" onClick={resetDraft} className="btn-secondary h-9 px-3"><X size={16} />取消编辑</button>}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {(["product_code", "sku_code", "product_name_cn", "product_name_en", "material", "purchase_price_rmb", "purchase_url"] as const).map((key) => (
              <label key={key} className="grid gap-1 text-xs font-medium text-slate-600 md:col-span-1">
                {({ product_code: "商品编号", sku_code: "SKU编号", product_name_cn: "中文名称", product_name_en: "英文名称", material: "材质", purchase_price_rmb: "订货价格", purchase_url: "英文订货链接" } as Record<string, string>)[key]}
                <input
                  type={key === "purchase_price_rmb" ? "number" : key === "purchase_url" ? "url" : "text"}
                  min={key === "purchase_price_rmb" ? 0 : undefined}
                  step={key === "purchase_price_rmb" ? "0.000001" : undefined}
                  value={draft[key]}
                  onChange={(event) => setDraft((current) => ({ ...current, [key]: key === "purchase_price_rmb" ? Number(event.target.value) : event.target.value }))}
                  className="h-10 rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
                />
              </label>
            ))}
          </div>
          <div><button type="button" onClick={() => void handleSave()} disabled={working} className="btn-primary"><Plus size={18} />保存资料</button></div>
        </div>
      )}

      <div className="surface-card p-4">
        <input aria-label="搜索简化商品 SKU" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索商品编号、SKU、名称或材质..." className="h-10 w-full rounded-xl border border-line bg-white px-4 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/10" />
      </div>

      <StandardTable
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        totalRecordCount={totalRecordCount}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        loading={loading}
        empty={!loading && records.length === 0}
        emptyMessage="暂无简化商品 SKU 资料"
      >
        <thead><tr><th>商品编号</th><th>SKU编号</th><th>中文名称</th><th>英文名称</th><th>材质</th><th>订货价格</th><th>英文订货链接</th><th>操作</th></tr></thead>
        {!loading && records.length > 0 && <tbody>{records.map((record) => <tr key={record.id}>
          <td>{record.product_code}</td><td>{record.sku_code}</td><td>{record.product_name_cn}</td><td>{record.product_name_en}</td><td>{record.material}</td><td>{record.purchase_price_rmb}</td>
          <td className="max-w-[260px] truncate"><a href={record.purchase_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{record.purchase_url || "--"}</a></td>
          <td><div className="flex gap-2">{canEdit && <button type="button" onClick={() => handleEdit(record)} className="btn-secondary h-8 px-2"><Pencil size={14} />编辑</button>}{canDelete && <button type="button" onClick={() => void handleDelete(record)} disabled={working} className="btn-secondary h-8 px-2 text-rose-600"><Trash2 size={14} />删除</button>}</div></td>
        </tr>)}</tbody>}
      </StandardTable>
    </section>
  );
}
