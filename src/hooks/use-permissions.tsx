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
import {
  accountPermissionLabels,
  fetchCurrentAccountPermission,
  getPermissionCapabilities,
  type AccountPermissionLevel,
} from "../lib/permissions";

type PermissionsContextValue = {
  permission: AccountPermissionLevel;
  label: string;
  canEdit: boolean;
  canDelete: boolean;
  loading: boolean;
  refreshPermission: () => Promise<void>;
};

const defaultPermission: AccountPermissionLevel = "viewer";

const PermissionsContext = createContext<PermissionsContextValue>({
  permission: defaultPermission,
  label: accountPermissionLabels[defaultPermission],
  canEdit: false,
  canDelete: false,
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

  const loadPermission = useCallback(async () => {
    if (!user) {
      setPermission(defaultPermission);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextPermission = await fetchCurrentAccountPermission();
      setPermission(nextPermission);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadPermission();
  }, [loadPermission]);

  const capabilities = getPermissionCapabilities(permission);
  const value = useMemo(
    () => ({
      permission,
      label: accountPermissionLabels[permission],
      ...capabilities,
      loading,
      refreshPermission: loadPermission,
    }),
    [capabilities, loading, loadPermission, permission],
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
  children: ReactNode;
};

export function PermissionGate({ action, children }: PermissionGateProps) {
  const { canEdit, canDelete, loading } = usePermissions();
  const allowed = action === "delete" ? canDelete : canEdit;

  if (loading) {
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
