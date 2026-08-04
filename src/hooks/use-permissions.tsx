import type { User } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  accountPermissionLabels,
  fetchCurrentAccountPermission,
  fetchShopOperatorPermissions,
  getPermissionCapabilities,
  getPermissionResourceForPath,
  getPrimaryEditAction,
  type AccountPermissionLevel,
  type PermissionResource,
  type ResourcePermission,
} from "../lib/permissions";
import { useTenantContext } from "./use-tenant-context";

type PermissionsContextValue = {
  permission: AccountPermissionLevel;
  label: string;
  canEdit: boolean;
  canDelete: boolean;
  can: (resource: PermissionResource, action: string) => boolean;
  currentResource: PermissionResource;
  loading: boolean;
  refreshPermission: () => Promise<void>;
};

const defaultPermission: AccountPermissionLevel = "viewer";

const PermissionsContext = createContext<PermissionsContextValue>({
  permission: defaultPermission,
  label: accountPermissionLabels[defaultPermission],
  canEdit: false,
  canDelete: false,
  can: () => false,
  currentResource: "products",
  loading: true,
  refreshPermission: async () => undefined,
});

type PermissionProviderProps = {
  user: User | null;
  children: ReactNode;
};

export function PermissionProvider({ user, children }: PermissionProviderProps) {
  const [permission, setPermission] =
    useState<AccountPermissionLevel>(defaultPermission);
  const [loading, setLoading] = useState(true);
  const [resourcePermissions, setResourcePermissions] = useState<ResourcePermission[]>([]);
  const tenant = useTenantContext();
  const location = useLocation();
  const userId = user?.id ?? "";

  const loadPermission = useCallback(async () => {
    if (!userId) {
      setPermission(defaultPermission);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (
        tenant.legacyFallback ||
        tenant.access.permissionMode === "legacy" ||
        !tenant.currentShop
      ) {
        const nextPermission = await fetchCurrentAccountPermission();
        setPermission(nextPermission);
        setResourcePermissions([]);
      } else {
        setPermission(defaultPermission);
        if (tenant.access.operatorShopId === tenant.currentShop.id) {
          setResourcePermissions(
            await fetchShopOperatorPermissions(userId, tenant.currentShop.id),
          );
        } else {
          setResourcePermissions([]);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [
    tenant.access.operatorShopId,
    tenant.access.permissionMode,
    tenant.currentShop,
    tenant.legacyFallback,
    userId,
  ]);

  useEffect(() => {
    void loadPermission();
  }, [loadPermission]);

  const legacyCapabilities = getPermissionCapabilities(permission);
  const currentResource = getPermissionResourceForPath(location.pathname);
  const tenantPermissionsEnabled =
    !tenant.legacyFallback && tenant.access.permissionMode === "tenant";
  const permissionKeys = useMemo(
    () =>
      new Set(
        resourcePermissions
          .filter((item) => item.allowed)
          .map((item) => `${item.resource}.${item.action}`),
      ),
    [resourcePermissions],
  );
  const can = useCallback(
    (resource: PermissionResource, action: string) => {
      if (!tenantPermissionsEnabled) {
        if (action === "view") return true;
        if (action === "delete") return legacyCapabilities.canDelete;
        return legacyCapabilities.canEdit;
      }
      if (resource === "diagnostics") {
        return tenant.access.isPlatformOwner;
      }
      if (tenant.access.isPlatformOwner) {
        if (action === "view") return true;
        return Boolean(
          tenant.currentShop &&
            tenant.access.currentShopId === tenant.currentShop.id,
        );
      }
      if (
        !tenant.currentShop &&
        tenant.access.enterpriseOwnerIds.length > 0 &&
        (resource === "shops" || resource === "members")
      ) {
        return true;
      }
      if (
        tenant.currentShop &&
        tenant.access.enterpriseOwnerIds.includes(tenant.currentShop.enterprise_id)
      ) {
        return true;
      }
      return permissionKeys.has(`${resource}.${action}`);
    },
    [
      legacyCapabilities.canDelete,
      legacyCapabilities.canEdit,
      permissionKeys,
      tenant.access.currentShopId,
      tenant.access.enterpriseOwnerIds,
      tenant.access.isPlatformOwner,
      tenant.currentShop,
      tenantPermissionsEnabled,
    ],
  );
  const canEdit = can(currentResource, getPrimaryEditAction(currentResource));
  const canDelete = can(currentResource, "delete");
  const label = tenantPermissionsEnabled
    ? tenant.access.isPlatformOwner
      ? tenant.access.currentShopId
        ? "平台所有者 · 店铺编辑上下文"
        : "平台所有者 · 跨企业只读"
      : tenant.currentEnterprise &&
          tenant.access.enterpriseOwnerIds.includes(tenant.currentEnterprise.id)
        ? "企业主"
        : "店铺操作员"
    : accountPermissionLabels[permission];
  const value = useMemo(
    () => ({
      permission,
      label,
      canEdit,
      canDelete,
      can,
      currentResource,
      loading: loading || tenant.loading,
      refreshPermission: loadPermission,
    }),
    [
      can,
      canDelete,
      canEdit,
      currentResource,
      label,
      loading,
      loadPermission,
      permission,
      tenant.loading,
    ],
  );

  return (
    <PermissionsContext.Provider value={value}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionsContext);
}

type PermissionGateProps = {
  action: "edit" | "delete";
  resource?: PermissionResource;
  children: ReactNode;
};

export function PermissionGate({ action, resource, children }: PermissionGateProps) {
  const permissions = usePermissions();
  const targetResource = resource ?? permissions.currentResource;
  const allowed =
    action === "delete"
      ? permissions.can(targetResource, "delete")
      : permissions.can(targetResource, getPrimaryEditAction(targetResource));

  if (permissions.loading) {
    return <div className="text-sm text-slate-500">加载权限中...</div>;
  }

  if (!allowed) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        当前账号没有{action === "delete" ? "删除" : "编辑"}权限。
      </div>
    );
  }

  return <>{children}</>;
}
