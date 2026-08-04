import { describe, expect, it } from "vitest";
import {
  buildTenantScopeKey,
  buildTenantStorageKey,
  getEffectiveShopId,
  normalizeMultitenantContext,
  type TenantBootstrap,
} from "./multitenancy";

describe("multitenant context", () => {
  it("normalizes role and scope values", () => {
    expect(
      normalizeMultitenantContext({
        user_id: "user-1",
        is_platform_owner: true,
        enterprise_owner_ids: ["enterprise-1", null],
        operator_shop_id: null,
        current_shop_id: "shop-1",
        permission_mode: "tenant",
      }),
    ).toEqual({
      userId: "user-1",
      isPlatformOwner: true,
      enterpriseOwnerIds: ["enterprise-1"],
      operatorShopId: null,
      currentShopId: "shop-1",
      permissionMode: "tenant",
    });
  });

  it("uses the sole enterprise-owner shop before an explicit context exists", () => {
    const bootstrap: TenantBootstrap = {
      context: {
        userId: "user-1",
        isPlatformOwner: false,
        enterpriseOwnerIds: ["enterprise-1"],
        operatorShopId: null,
        currentShopId: null,
        permissionMode: "tenant",
      },
      enterprises: [],
      shops: [
        {
          id: "shop-1",
          enterprise_id: "enterprise-1",
          code: "one",
          name: "One",
          platform: "temu",
          status: "active",
        },
      ],
      legacyFallback: false,
    };
    expect(getEffectiveShopId(bootstrap)).toBe("shop-1");
  });

  it("keeps cache and draft keys separated by shop", () => {
    expect(buildTenantScopeKey("user", "enterprise", "shop-a")).not.toBe(
      buildTenantScopeKey("user", "enterprise", "shop-b"),
    );
    expect(buildTenantStorageKey("orders", "user", "shop-a")).not.toBe(
      buildTenantStorageKey("orders", "user", "shop-b"),
    );
  });

  it("keeps a platform owner read-only until a shop context is explicit", () => {
    const bootstrap: TenantBootstrap = {
      context: {
        userId: "platform-user",
        isPlatformOwner: true,
        enterpriseOwnerIds: ["enterprise-1"],
        operatorShopId: null,
        currentShopId: null,
        permissionMode: "tenant",
      },
      enterprises: [],
      shops: [
        {
          id: "shop-1",
          enterprise_id: "enterprise-1",
          code: "one",
          name: "One",
          platform: "temu",
          status: "active",
        },
      ],
      legacyFallback: false,
    };
    expect(getEffectiveShopId(bootstrap)).toBeNull();
  });
});
