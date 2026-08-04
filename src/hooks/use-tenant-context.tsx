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
import { invalidateAsyncCache, setAsyncCacheScope } from "../lib/async-cache";
import {
  buildTenantScopeKey,
  clearCurrentShopContext,
  fetchTenantBootstrap,
  getEffectiveShopId,
  setCurrentShopContext,
  type Enterprise,
  type MultitenantContext,
  type Shop,
  type TenantBootstrap,
} from "../lib/multitenancy";

type TenantContextValue = {
  access: MultitenantContext;
  enterprises: Enterprise[];
  shops: Shop[];
  currentShop: Shop | null;
  currentEnterprise: Enterprise | null;
  storageScopeKey: string;
  dataScope: {
    shopId: string | null;
    storageScopeKey: string;
    tenantMode: boolean;
  };
  legacyFallback: boolean;
  loading: boolean;
  switchShop: (shopId: string | null) => Promise<void>;
  refreshTenantContext: () => Promise<void>;
};

const emptyAccess: MultitenantContext = {
  userId: "",
  isPlatformOwner: false,
  enterpriseOwnerIds: [],
  operatorShopId: null,
  currentShopId: null,
  permissionMode: "legacy",
};

const TenantContext = createContext<TenantContextValue>({
  access: emptyAccess,
  enterprises: [],
  shops: [],
  currentShop: null,
  currentEnterprise: null,
  storageScopeKey: buildTenantScopeKey("", null, null),
  dataScope: {
    shopId: null,
    storageScopeKey: buildTenantScopeKey("", null, null),
    tenantMode: false,
  },
  legacyFallback: true,
  loading: true,
  switchShop: async () => undefined,
  refreshTenantContext: async () => undefined,
});

export function TenantContextProvider({
  user,
  children,
}: {
  user: User | null;
  children: ReactNode;
}) {
  const [bootstrap, setBootstrap] = useState<TenantBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const userId = user?.id ?? "";

  const load = useCallback(async () => {
    if (!userId) {
      setBootstrap(null);
      setLoading(false);
      setAsyncCacheScope(null);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchTenantBootstrap(userId);
      setBootstrap(next);
      const shopId = getEffectiveShopId(next);
      const enterpriseId = next.shops.find((shop) => shop.id === shopId)?.enterprise_id ?? null;
      setAsyncCacheScope(buildTenantScopeKey(userId, enterpriseId, shopId));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchShop = useCallback(
    async (shopId: string | null) => {
      if (!bootstrap || bootstrap.legacyFallback) return;
      if (shopId) await setCurrentShopContext(shopId);
      else await clearCurrentShopContext();
      invalidateAsyncCache();
      await load();
    },
    [bootstrap, load],
  );

  const effectiveShopId = bootstrap ? getEffectiveShopId(bootstrap) : null;
  const currentShop =
    bootstrap?.shops.find((shop) => shop.id === effectiveShopId) ?? null;
  const currentEnterprise =
    bootstrap?.enterprises.find(
      (enterprise) => enterprise.id === currentShop?.enterprise_id,
    ) ?? null;

  const value = useMemo<TenantContextValue>(
    () => {
      const storageScopeKey = buildTenantScopeKey(
        userId,
        currentEnterprise?.id ?? null,
        currentShop?.id ?? null,
      );
      return {
      access: bootstrap?.context ?? emptyAccess,
      enterprises: bootstrap?.enterprises ?? [],
      shops: bootstrap?.shops ?? [],
      currentShop,
      currentEnterprise,
      storageScopeKey,
      dataScope: {
        shopId: currentShop?.id ?? null,
        storageScopeKey,
        tenantMode: bootstrap?.context.permissionMode === "tenant",
      },
      legacyFallback: bootstrap?.legacyFallback ?? true,
      loading,
      switchShop,
      refreshTenantContext: load,
    };
    },
    [bootstrap, currentEnterprise, currentShop, load, loading, switchShop, userId],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenantContext() {
  return useContext(TenantContext);
}
