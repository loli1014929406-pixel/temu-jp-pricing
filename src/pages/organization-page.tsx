import { useEffect, useState } from "react";
import { Field, TextInput } from "../components/form-controls";
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";
import { useTenantContext } from "../hooks/use-tenant-context";
import { getSupabaseClient } from "../lib/supabase";
import { getErrorMessage } from "../utils/errors";

type CatalogPermission = {
  resource: string;
  action: string;
  description: string;
};

export function OrganizationPage() {
  const tenant = useTenantContext();
  const permissions = usePermissions();
  const [catalog, setCatalog] = useState<CatalogPermission[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [enterpriseCode, setEnterpriseCode] = useState("");
  const [enterpriseName, setEnterpriseName] = useState("");
  const [shopEnterpriseId, setShopEnterpriseId] = useState(tenant.currentEnterprise?.id ?? "");
  const [shopCode, setShopCode] = useState("");
  const [shopName, setShopName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberShopId, setMemberShopId] = useState(tenant.currentShop?.id ?? "");
  const [memberRole, setMemberRole] = useState<"enterprise_owner" | "shop_operator">("shop_operator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    getSupabaseClient()
      .from("permission_catalog")
      .select("resource, action, description")
      .order("resource")
      .order("action")
      .then(({ data, error: catalogError }) => {
        if (catalogError) {
          setError(getErrorMessage(catalogError, "加载权限目录失败"));
          return;
        }
        const next = (data ?? []) as CatalogPermission[];
        setCatalog(next);
        setSelectedPermissions(
          new Set(
            next
              .filter((item) => !["shops", "members", "diagnostics"].includes(item.resource) && item.action !== "delete")
              .map((item) => `${item.resource}.${item.action}`),
          ),
        );
      });
  }, []);

  useEffect(() => {
    if (!shopEnterpriseId && tenant.currentEnterprise?.id) {
      setShopEnterpriseId(tenant.currentEnterprise.id);
    }
    if (!memberShopId && tenant.currentShop?.id) {
      setMemberShopId(tenant.currentShop.id);
    }
  }, [memberShopId, shopEnterpriseId, tenant.currentEnterprise?.id, tenant.currentShop?.id]);

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: actionError } = await action();
      if (actionError) throw actionError;
      setNotice(success);
      await tenant.refreshTenantContext();
    } catch (actionError) {
      setError(getErrorMessage(actionError, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  const canManageShops = permissions.can("shops", "manage");
  const canManageMembers = permissions.can("members", "manage");

  return (
    <section className="page-stack">
      <PageHeader
        title="企业、店铺与成员"
        description="账号必须先完成网站注册，再由企业主按邮箱分配身份。店铺操作员只能归属一个店铺。"
      />
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-4 xl:grid-cols-3">
        {tenant.access.isPlatformOwner && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-bold">新建企业</h2>
            <div className="grid gap-3">
              <Field label="企业编号"><TextInput value={enterpriseCode} onChange={(event) => setEnterpriseCode(event.target.value)} /></Field>
              <Field label="企业名称"><TextInput value={enterpriseName} onChange={(event) => setEnterpriseName(event.target.value)} /></Field>
              <button type="button" disabled={busy || !enterpriseCode.trim() || !enterpriseName.trim()} className="btn-primary" onClick={() => void run(() => getSupabaseClient().rpc("create_enterprise", { p_code: enterpriseCode.trim(), p_name: enterpriseName.trim() }), "企业已创建。")}>创建企业</button>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold">新建店铺</h2>
          <div className="grid gap-3">
            <Field label="所属企业">
              <select value={shopEnterpriseId} onChange={(event) => setShopEnterpriseId(event.target.value)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="">请选择</option>
                {tenant.enterprises.map((enterprise) => <option key={enterprise.id} value={enterprise.id}>{enterprise.name}</option>)}
              </select>
            </Field>
            <Field label="店铺编号"><TextInput value={shopCode} onChange={(event) => setShopCode(event.target.value)} /></Field>
            <Field label="店铺名称"><TextInput value={shopName} onChange={(event) => setShopName(event.target.value)} /></Field>
            <button type="button" disabled={busy || !canManageShops || !shopEnterpriseId || !shopCode.trim() || !shopName.trim()} className="btn-primary" onClick={() => void run(() => getSupabaseClient().rpc("create_shop", { p_enterprise_id: shopEnterpriseId, p_code: shopCode.trim(), p_name: shopName.trim(), p_platform: "temu" }), "店铺已创建。")}>创建店铺</button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-1">
          <h2 className="mb-3 text-sm font-bold">分配现有账号</h2>
          <div className="grid gap-3">
            <Field label="登录邮箱"><TextInput type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} /></Field>
            <Field label="店铺 / 所属企业">
              <select value={memberShopId} onChange={(event) => setMemberShopId(event.target.value)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="">请选择</option>
                {tenant.shops.map((shop) => <option key={shop.id} value={shop.id}>{tenant.enterprises.find((enterprise) => enterprise.id === shop.enterprise_id)?.name} / {shop.name}</option>)}
              </select>
            </Field>
            <Field label="身份">
              <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as typeof memberRole)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="shop_operator">店铺操作员</option>
                <option value="enterprise_owner">企业主</option>
              </select>
            </Field>
          </div>
        </div>
      </div>

      {memberRole === "shop_operator" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold">操作员资源 / 动作权限</h2>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {catalog.filter((item) => !["shops", "members", "diagnostics"].includes(item.resource)).map((item) => {
              const key = `${item.resource}.${item.action}`;
              return <label key={key} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-sm"><input type="checkbox" checked={selectedPermissions.has(key)} onChange={(event) => setSelectedPermissions((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} /><span>{item.description}</span></label>;
            })}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" disabled={busy || !canManageMembers || !memberEmail.trim() || !memberShopId} className="btn-primary" onClick={() => void run(() => getSupabaseClient().rpc("assign_existing_user_membership", {
          p_email: memberEmail.trim(),
          p_shop_id: memberShopId,
          p_role: memberRole,
          p_permissions: memberRole === "shop_operator" ? catalog.filter((item) => selectedPermissions.has(`${item.resource}.${item.action}`)).map((item) => ({ resource: item.resource, action: item.action, allowed: true })) : [],
        }), "账号身份和权限已保存。")}>保存账号身份</button>
      </div>
    </section>
  );
}
