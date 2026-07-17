import {
  ArrowLeftRight,
  BarChart3,
  Calculator,
  CircleDollarSign,
  ClipboardList,
  FileCheck,
  LogOut,
  Menu,
  PackageSearch,
  Receipt,
  ShoppingCart,
  Truck,
  Warehouse,
  WalletCards,
  ListOrdered,
  Settings,
  Activity,
  X,
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const profileDisplay = formatAccountProfileDisplay(profile);
  const avatarText =
    profile?.username?.trim().slice(0, 2).toUpperCase() ||
    profile?.user_code?.trim().slice(0, 2).toUpperCase() ||
    "U";

  const navigation = (
    <>
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
      {canDelete && (
        <div className="erp-side-section">
          <p className="erp-side-section-title">管理员</p>
          <NavLink
            to="/admin/diagnostics"
            className={({ isActive }) =>
              `erp-side-nav-item ${isActive ? "erp-side-nav-item-active" : ""}`
            }
          >
            <Activity size={16} />
            <span>集中诊断</span>
          </NavLink>
        </div>
      )}
    </>
  );

  const profileCard = (
    <div className="flex items-center justify-between gap-2.5 border-t border-slate-100 p-4">
      <Link to="/user" className="flex min-w-0 flex-1 items-center gap-2.5 hover:no-underline">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#d4d4d4] bg-white text-xs font-bold text-[#303030] shadow-sm">
          {avatarText}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-slate-800" title={profileDisplay}>
            {profileDisplay}
          </p>
          <p className="truncate text-[10px] font-semibold text-slate-600">{label}</p>
        </div>
      </Link>
      <button
        type="button"
        aria-label="退出"
        onClick={() => void handleSignOut()}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-400 transition-all duration-200 hover:border-rose-100 hover:bg-rose-50 hover:text-rose-600 active:scale-95"
        title="退出登录"
      >
        <LogOut size={16} />
      </button>
    </div>
  );

  return (
    <div className="erp-shell min-h-screen bg-white text-slate-900">
      <header className="fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between border-b border-slate-100 bg-white/95 px-4 backdrop-blur-md lg:hidden">
        <NavLink to="/orders" className="flex min-w-0 items-center gap-2.5">
          <span className="erp-brand-mark">JP</span>
          <span className="truncate text-sm font-extrabold text-slate-900">Temu JP 运营</span>
        </NavLink>
        <div className="flex items-center gap-2">
          <Link
            to="/user"
            aria-label="用户资料"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#d4d4d4] bg-white text-xs font-bold text-[#303030]"
          >
            {avatarText}
          </Link>
          <button
            type="button"
            aria-label={mobileNavOpen ? "关闭主导航" : "打开主导航"}
            aria-controls="mobile-main-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm"
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      {mobileNavOpen && (
        <div className="fixed inset-x-0 bottom-0 top-16 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭主导航"
            onClick={() => setMobileNavOpen(false)}
            className="absolute inset-0 bg-slate-950/35 backdrop-blur-[1px]"
          />
          <aside
            id="mobile-main-navigation"
            className="absolute bottom-0 right-0 top-0 flex w-[min(86vw,320px)] flex-col bg-white shadow-2xl"
          >
            <nav className="erp-side-nav" aria-label="移动端主导航">
              {navigation}
            </nav>
            {profileCard}
          </aside>
        </div>
      )}

      <aside className="erp-sidebar hidden lg:flex">
        <NavLink to="/orders" className="erp-sidebar-brand">
          <span className="erp-brand-mark">JP</span>
          <span className="font-extrabold text-slate-900">Temu JP 运营</span>
        </NavLink>

        <nav className="erp-side-nav" aria-label="主导航">{navigation}</nav>

        {/* User Identity Profile Card at Sidebar Bottom */}
        <div className="erp-sidebar-profile">{profileCard}</div>
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
