import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useTenantContext } from "../hooks/use-tenant-context";

export function EnterpriseRoleRoute({ children }: { children: ReactNode }) {
  const tenant = useTenantContext();

  if (tenant.loading) {
    return <div className="text-sm text-slate-500">加载企业权限中...</div>;
  }

  if (
    tenant.legacyFallback ||
    tenant.access.isPlatformOwner ||
    tenant.access.enterpriseOwnerIds.length > 0
  ) {
    return children;
  }

  return <Navigate to="/orders" replace />;
}

export function PlatformRoleRoute({ children }: { children: ReactNode }) {
  const tenant = useTenantContext();

  if (tenant.loading) {
    return <div className="text-sm text-slate-500">加载平台权限中...</div>;
  }

  if (tenant.legacyFallback || tenant.access.isPlatformOwner) {
    return children;
  }

  return <Navigate to="/orders" replace />;
}
