import {
  ArrowLeftRight,
  BarChart3,
  Calculator,
  CircleDollarSign,
  ClipboardList,
  FileCheck,
  LogOut,
  PackageSearch,
  Receipt,
  ShoppingCart,
  Truck,
  Warehouse,
  WalletCards,
  ListOrdered,
  Settings,
  Activity,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient } from "../lib/supabase";
import { usePermissions } from "../hooks/use-permissions";
import { invalidateAsyncCache, setAsyncCacheScope } from "../lib/async-cache";
import {
  fetchOrCreateCurrentAccountProfile,
  formatAccountProfileDisplay,
} from "../lib/account-profiles";
import type { AccountProfile } from "../types";

const navSections = [
  {
    title: "销售履约",
    items: [
      { to: "/orders", label: "订单管理", icon: ListOrdered }
    ]
  },
  {
    title: "财务与报表",
    items: [
      { to: "/finance", label: "财务总览", icon: CircleDollarSign },
      { to: "/finance/ledger", label: "收支流水", icon: WalletCards },
      { to: "/finance/expenses", label: "费用管理", icon: Receipt },
      { to: "/finance/profit", label: "利润报表", icon: BarChart3 },
      { to: "/finance/settlement", label: "对账中心", icon: FileCheck }
    ]
  },
  {
    title: "定价与分析",
    items: [
      { to: "/products", label: "商品管理", icon: PackageSearch },
      { to: "/declaration-prices", label: "核算定价", icon: ClipboardList },
      { to: "/profit-calculation", label: "利润分析", icon: Calculator },
      { to: "/test-shipping", label: "直发测算", icon: Truck }
    ]
  },
  {
    title: "仓储管理",
    items: [
      { to: "/purchases/records", label: "采购管理", icon: ShoppingCart },
      { to: "/inventory", label: "仓储库存", icon: Warehouse },
      { to: "/inventory/transfer", label: "库存调拨", icon: ArrowLeftRight }
    ]
  },
  {
    title: "系统配置",
    items: [
      { to: "/parameter-settings", label: "参数设置", icon: Settings }
    ]
  }
];

function getCanonicalNavPath(pathname: string) {
  return pathname;
}

function isNavItemActive(pathname: string, itemTo: string, isActive: boolean) {
  const canonicalPathname = getCanonicalNavPath(pathname);
  if (itemTo === "/inventory") {
    return (
      pathname === "/inventory" ||
      (pathname.startsWith("/inventory/") && pathname !== "/inventory/transfer")
    );
  }
  if (itemTo === "/finance") {
    return canonicalPathname === "/finance";
  }
  return canonicalPathname === itemTo || canonicalPathname.startsWith(`${itemTo}/`) || isActive;
}

type PageShellProps = {
  user: User | null;
};

export function PageShell({ user }: PageShellProps) {
  const { label, canDelete } = usePermissions();
  const location = useLocation();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  async function handleSignOut() {
    invalidateAsyncCache();
    await getSupabaseClient().auth.signOut();
    setAsyncCacheScope(null);
  }

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      if (!user?.id) {
        setProfile(null);
        return;
      }
      try {
        const nextProfile = await fetchOrCreateCurrentAccountProfile();
        if (active) setProfile(nextProfile);
      } catch {
        if (active) {
          setProfile({
            owner_id: user.id,
            username: "",
            user_code: "未知",
          });
        }
      }
    }

    void loadProfile();
    return () => {
      active = false;
    };
  }, [user?.id]);

  const profileDisplay = formatAccountProfileDisplay(profile);
  const avatarText =
    profile?.username?.trim().slice(0, 2).toUpperCase() ||
    profile?.user_code?.trim().slice(0, 2).toUpperCase() ||
    "U";

  return (
    <div className="erp-shell min-h-screen bg-white text-slate-900">
      <aside className="erp-sidebar">
        <NavLink to="/orders" className="erp-sidebar-brand">
          <span className="erp-brand-mark">JP</span>
          <span className="font-extrabold text-slate-900">Temu JP 运营</span>
        </NavLink>

        <nav className="erp-side-nav" aria-label="主导航">
          {navSections.map((section) => (
            <div key={section.title} className="erp-side-section">
              <p className="erp-side-section-title">{section.title}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `erp-side-nav-item ${
                        isNavItemActive(location.pathname, item.to, isActive)
                          ? "erp-side-nav-item-active"
                          : ""
                      }`
                    }
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
          {canDelete && <div className="erp-side-section"><p className="erp-side-section-title">管理员</p><NavLink to="/admin/diagnostics" className={({isActive}) => `erp-side-nav-item ${isActive ? "erp-side-nav-item-active" : ""}`}><Activity size={16}/><span>集中诊断</span></NavLink></div>}
        </nav>

        {/* User Identity Profile Card at Sidebar Bottom */}
        <div className="erp-sidebar-profile border-t border-slate-100 p-4 hidden lg:flex items-center justify-between gap-2.5">
          <Link to="/user" className="flex min-w-0 flex-1 items-center gap-2.5 hover:no-underline">
            <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-tr from-violet-100 to-indigo-100 text-accentDeep flex items-center justify-center font-bold text-xs border border-accentSoft shadow-sm">
              {avatarText}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-slate-800" title={profileDisplay}>
                {profileDisplay}
              </p>
              <p className="truncate text-[10px] font-semibold text-slate-600">
                {label}
              </p>
            </div>
          </Link>
          <button
            type="button"
            aria-label="退出"
            onClick={() => void handleSignOut()}
            className="h-8 w-8 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-all duration-200 border border-transparent hover:border-rose-100 active:scale-95"
            title="退出登录"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <div className="erp-workspace">
        <main className="erp-main">
          <Suspense
            fallback={
              <div className="grid gap-3 p-6" aria-live="polite" aria-busy="true">
                <div className="h-8 w-48 animate-pulse rounded-lg bg-slate-100" />
                <div className="h-24 animate-pulse rounded-xl bg-slate-50" />
                <div className="h-64 animate-pulse rounded-xl bg-slate-50" />
                <span className="sr-only">页面加载中…</span>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
