import {
  Calculator,
  CircleDollarSign,
  ClipboardList,
  LogOut,
  PackageSearch,
  ShoppingCart,
  Truck,
  Warehouse,
  WalletCards,
  ListOrdered,
  Settings,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { getSupabaseClient } from "../lib/supabase";
import { useAuth } from "../hooks/use-auth";

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
      { to: "/finance/expenses", label: "费用管理", icon: WalletCards },
      { to: "/finance/profit", label: "利润报表", icon: Calculator },
      { to: "/finance/settlement", label: "对账中心", icon: ClipboardList }
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
      { to: "/inventory/transfer", label: "库存调拨", icon: Warehouse }
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

const navItemsFlat = navSections.flatMap((section) => section.items) as { to: string; label: string; icon: any }[];

function getActiveModule(pathname: string) {
  const canonicalPathname = getCanonicalNavPath(pathname);
  return (
    [...navItemsFlat]
      .sort((left, right) => right.to.length - left.to.length)
      .find((item) => canonicalPathname === item.to || canonicalPathname.startsWith(`${item.to}/`)) ??
    navItemsFlat[0]
  );
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

export function PageShell() {
  const { user } = useAuth();
  const location = useLocation();
  const activeModule = getActiveModule(location.pathname);

  const activeSection = navSections.find((sec) =>
    sec.items.some((item) => item.to === activeModule.to)
  );
  const sectionLabel = activeSection?.title || "运营系统";

  async function handleSignOut() {
    await getSupabaseClient().auth.signOut();
  }

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
        </nav>

        {/* User Identity Profile Card at Sidebar Bottom */}
        <div className="erp-sidebar-profile border-t border-slate-100 p-4 hidden lg:flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-tr from-violet-100 to-indigo-100 text-violet-700 flex items-center justify-center font-bold text-xs border border-violet-200 shadow-sm">
              {user?.email ? user.email.slice(0, 2).toUpperCase() : "U"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-800 truncate" title={user?.email || ""}>
                {user?.email || "Unknown User"}
              </p>
              <p className="text-[10px] font-semibold text-slate-400">
                系统管理员
              </p>
            </div>
          </div>
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
        <header className="erp-workspace-topbar flex items-center justify-between">
          {/* Breadcrumbs Navigation */}
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
            <span>系统控制台</span>
            <span className="text-[10px] text-slate-300">/</span>
            <span>{sectionLabel}</span>
            <span className="text-[10px] text-slate-300">/</span>
            <span className="text-slate-900 font-bold text-sm">{activeModule.label}</span>
          </div>

          <div className="flex items-center gap-4">
            {/* Live Database Sync Badge */}
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-100 px-3 py-1 text-[11px] font-semibold text-emerald-700 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Supabase 联机</span>
            </div>
          </div>
        </header>

        <main className="erp-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
